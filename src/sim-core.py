"""
evosim — Python simulation core
Runs inside Pyodide. Reads config from JS globals, writes state to SharedArrayBuffer.

All math lives here. JS never touches simulation logic.
"""

import json
import math
import random
import numpy as np
from js import _shared_buffer, _grid_size, _seed, _layout

# ── CONSTANTS ──────────────────────────────────────────────────────────────────

GRID_SIZE = int(_grid_size)
G2 = GRID_SIZE * GRID_SIZE
NUM_SPECIES = 5
NUM_TRAITS = 6  # 5 universal + 1 species-specific

# Species indices
VELOTHRIX = 0
LEVIATHAN = 1
CRAWLER = 2
CRAB = 3
WORM = 4

SPECIES_NAMES = ['Velothrix', 'Leviathan', 'Crawler', 'Crab', 'Worm']

# Trait indices
T_CLUTCH = 0
T_LONGEVITY = 1
T_MUTATION = 2
T_METABOLISM = 3
T_MIGRATION = 4
T_SPECIFIC = 5

# Biome codes (match Uint8 values in buffer)
BIOME_DEEP_WATER = 0
BIOME_SHALLOW_MARSH = 1
BIOME_REED_BEDS = 2
BIOME_TIDAL_FLATS = 3
BIOME_ROCKY_SHORE = 4

# Season cycle (generations per full cycle)
SEASON_PERIOD = 100

# LOD level: 0 = full, 1 = simplified
lod_level = 0

# ── SHARED BUFFER SETUP ──────────────────────────────────────────────────────

# Parse layout from JS
_layout_py = _layout.to_py()

def _make_view(name, dtype):
    info = _layout_py[name]
    return np.frombuffer(_shared_buffer, dtype=dtype, offset=info['offset'], count=info['count'])

# Create numpy views on the shared buffer
buf_globals    = _make_view('globals', np.float64)
buf_elevations = _make_view('elevations', np.float32)
buf_biomes     = _make_view('biomes', np.uint8)
buf_vegetation = _make_view('vegetation', np.float32)
buf_populations = _make_view('populations', np.uint16).reshape((GRID_SIZE, GRID_SIZE, NUM_SPECIES))
buf_trait_means = _make_view('traitMeans', np.float32).reshape((GRID_SIZE, GRID_SIZE, NUM_SPECIES, NUM_TRAITS))
buf_trait_var   = _make_view('traitVar', np.float32).reshape((GRID_SIZE, GRID_SIZE, NUM_SPECIES, NUM_TRAITS))
buf_tile_flags  = _make_view('tileFlags', np.uint8)
buf_river_paths = _make_view('riverPaths', np.int16).reshape((-1, 2))
buf_river_meta  = _make_view('riverMeta', np.float32).reshape((-1, 4))

# Elevation and biome as 2D views
elev_grid = buf_elevations.reshape((GRID_SIZE, GRID_SIZE))
biome_grid = buf_biomes.reshape((GRID_SIZE, GRID_SIZE))
veg_grid = buf_vegetation.reshape((GRID_SIZE, GRID_SIZE))
flags_grid = buf_tile_flags.reshape((GRID_SIZE, GRID_SIZE))

# ── SIMULATION STATE (Python-only, not in shared buffer) ─────────────────────

generation = 0
events_buffer = []  # cold data — flushed to JS on request

# Habitat suitability per species per biome [species][biome] → 0.0–1.0
HABITAT_SUITABILITY = np.array([
    # deep_water  shallow_marsh  reed_beds  tidal_flats  rocky_shore
    [0.0,         0.7,           1.0,       0.6,         0.2],   # Velothrix
    [0.8,         1.0,           0.3,       0.5,         0.3],   # Leviathan
    [0.0,         0.5,           1.0,       0.8,         0.3],   # Crawler
    [0.1,         0.4,           0.5,       1.0,         0.8],   # Crab
    [0.6,         0.8,           0.7,       0.5,         0.4],   # Worm
], dtype=np.float32)

# Base carrying capacity per species (on a perfect tile)
BASE_K = np.array([60, 45, 55, 50, 58], dtype=np.float32)

# Base growth rates
GROWTH_RATES = np.array([0.08, 0.06, 0.07, 0.065, 0.07], dtype=np.float32)

# Heritability (fraction of trait variance passed to offspring)
HERITABILITY = 0.5

# Base mutation step size (scaled by mutation rate trait)
MUTATION_STEP = 0.015

# Predation pairs: (predator_species, prey_species, base_attack_rate, handling_time)
PREDATION_PAIRS = [
    (LEVIATHAN, VELOTHRIX, 0.008, 0.1),
    (LEVIATHAN, WORM, 0.005, 0.15),
    (VELOTHRIX, WORM, 0.003, 0.2),
]

# Competition pairs: (species_a, species_b, competition_coefficient)
COMPETITION_PAIRS = [
    (VELOTHRIX, CRAWLER, 0.0003),
    (CRAB, CRAWLER, 0.0002),
]

# River barrier gene flow scaling
RIVER_BARRIER_K = 0.01

# ── TERRAIN GENERATION ────────────────────────────────────────────────────────

def _value_noise_2d(size, seed_val, octaves=4, persistence=0.5):
    """Multi-octave value noise for terrain generation."""
    rng = np.random.RandomState(seed_val)
    result = np.zeros((size, size), dtype=np.float32)
    amplitude = 1.0
    total_amp = 0.0

    for octave in range(octaves):
        freq = 2 ** octave + 1
        grid = rng.rand(freq, freq).astype(np.float32)

        # Bilinear interpolation to full size
        from_r = np.linspace(0, freq - 1, size)
        from_c = np.linspace(0, freq - 1, size)
        r_idx = np.clip(from_r.astype(int), 0, freq - 2)
        c_idx = np.clip(from_c.astype(int), 0, freq - 2)
        r_frac = from_r - r_idx
        c_frac = from_c - c_idx

        interp = np.zeros((size, size), dtype=np.float32)
        for i in range(size):
            for j in range(size):
                ri, ci = r_idx[i], c_idx[j]
                rf, cf = r_frac[i], c_frac[j]
                interp[i, j] = (
                    grid[ri, ci] * (1 - rf) * (1 - cf) +
                    grid[ri + 1, ci] * rf * (1 - cf) +
                    grid[ri, ci + 1] * (1 - rf) * cf +
                    grid[ri + 1, ci + 1] * rf * cf
                )

        result += interp * amplitude
        total_amp += amplitude
        amplitude *= persistence

    result /= total_amp
    return result


def _generate_terrain(seed_str):
    """Generate elevation grid and assign biomes."""
    seed_val = sum(ord(c) * (i + 1) for i, c in enumerate(seed_str))
    random.seed(seed_val)
    np.random.seed(seed_val % (2**31))

    noise = _value_noise_2d(GRID_SIZE, seed_val)

    # Island mask — lower edges to create coastline
    cx, cy = GRID_SIZE / 2, GRID_SIZE / 2
    max_dist = math.sqrt(cx**2 + cy**2)
    for r in range(GRID_SIZE):
        for c in range(GRID_SIZE):
            dist = math.sqrt((r - cy)**2 + (c - cx)**2) / max_dist
            falloff = max(0, 1 - dist * 1.4)
            noise[r, c] *= falloff

    # Normalize to 0–1
    lo, hi = noise.min(), noise.max()
    if hi > lo:
        noise = (noise - lo) / (hi - lo)

    # Write to shared buffer
    elev_grid[:] = noise

    # Assign biomes based on elevation
    for r in range(GRID_SIZE):
        for c in range(GRID_SIZE):
            e = elev_grid[r, c]
            if e < 0.15:
                biome_grid[r, c] = BIOME_DEEP_WATER
            elif e < 0.30:
                biome_grid[r, c] = BIOME_SHALLOW_MARSH
            elif e < 0.50:
                biome_grid[r, c] = BIOME_REED_BEDS
            elif e < 0.70:
                biome_grid[r, c] = BIOME_TIDAL_FLATS
            else:
                biome_grid[r, c] = BIOME_ROCKY_SHORE

    # Initialize vegetation based on biome
    veg_rates = {
        BIOME_DEEP_WATER: 0.1,
        BIOME_SHALLOW_MARSH: 0.6,
        BIOME_REED_BEDS: 0.9,
        BIOME_TIDAL_FLATS: 0.5,
        BIOME_ROCKY_SHORE: 0.2,
    }
    for r in range(GRID_SIZE):
        for c in range(GRID_SIZE):
            veg_grid[r, c] = veg_rates.get(biome_grid[r, c], 0.5)


# ── POPULATION INITIALIZATION ────────────────────────────────────────────────

def _init_populations():
    """Seed initial populations based on habitat suitability."""
    for r in range(GRID_SIZE):
        for c in range(GRID_SIZE):
            biome = biome_grid[r, c]
            for s in range(NUM_SPECIES):
                suit = HABITAT_SUITABILITY[s, biome]
                if suit > 0.2:
                    pop = int(BASE_K[s] * suit * 0.3 * random.uniform(0.5, 1.0))
                    buf_populations[r, c, s] = max(0, pop)
                else:
                    buf_populations[r, c, s] = 0

                # Initialize traits at midpoint with some variance
                for t in range(NUM_TRAITS):
                    buf_trait_means[r, c, s, t] = 0.5 + random.uniform(-0.1, 0.1)
                    buf_trait_var[r, c, s, t] = 0.04  # initial genetic variance


# ── CORE SIMULATION STEP ─────────────────────────────────────────────────────

def _get_season():
    """Returns season factor 0–1 (0=harsh winter, 1=peak summer)."""
    return 0.5 + 0.5 * math.sin(2 * math.pi * generation / SEASON_PERIOD)


def _carrying_capacity(r, c, s):
    """Effective K for species s on tile (r,c)."""
    biome = biome_grid[r, c]
    suit = HABITAT_SUITABILITY[s, biome]
    food = veg_grid[r, c]
    season = _get_season()
    metabolism = buf_trait_means[r, c, s, T_METABOLISM]

    # Food contribution depends on diet:
    if s == CRAWLER:
        food_factor = food  # direct herbivore
    elif s == CRAB:
        food_factor = food * 0.5 + 0.3  # omnivore, less food-dependent
    elif s == VELOTHRIX:
        food_factor = food * 0.7 + 0.2  # invertebrates scale with vegetation
    elif s == WORM:
        # Detritivore — food is death, not vegetation
        total_deaths = buf_globals[12]  # TOTAL_DEATHS
        food_factor = min(1.0, 0.3 + total_deaths / (G2 * 5))
    else:  # LEVIATHAN
        # Predator — food is prey population, handled in predation
        food_factor = 0.5  # baseline

    k = BASE_K[s] * suit * (0.5 + 0.5 * food_factor) * (0.85 + 0.15 * season)

    # High metabolism increases K when food is abundant, decreases when scarce
    if food_factor > 0.5:
        k *= (1.0 + metabolism * 0.2)
    else:
        k *= (1.0 - metabolism * 0.3)

    return max(1, k)


def _step_tile(r, c, season):
    """Process one tile for one generation."""
    total_tile_deaths = 0

    for s in range(NUM_SPECIES):
        pop = int(buf_populations[r, c, s])
        if pop <= 0:
            buf_populations[r, c, s] = 0
            continue

        k = _carrying_capacity(r, c, s)

        # ── Logistic growth ──
        clutch = buf_trait_means[r, c, s, T_CLUTCH]
        longevity = buf_trait_means[r, c, s, T_LONGEVITY]

        # Clutch size scales reproduction rate
        effective_r = GROWTH_RATES[s] * (0.5 + clutch)

        # Growth: logistic with carrying capacity
        growth = effective_r * pop * (1 - pop / k)

        # Longevity affects mortality — longer-lived = lower baseline death rate
        # But long-lived individuals keep consuming resources
        mortality_rate = 0.02 + 0.08 * (1 - longevity)  # 2–10% baseline mortality
        deaths = int(pop * mortality_rate)

        # Net population change
        new_pop = pop + _prob_round(growth) - deaths
        new_pop = max(0, min(65535, new_pop))  # Uint16 cap

        total_tile_deaths += max(0, pop - new_pop) if new_pop < pop else deaths

        buf_populations[r, c, s] = new_pop

    # ── Predation (Lotka-Volterra with Holling Type II) ──
    for pred_s, prey_s, base_attack, handling_time in PREDATION_PAIRS:
        pred_pop = int(buf_populations[r, c, pred_s])
        prey_pop = int(buf_populations[r, c, prey_s])
        if pred_pop <= 0 or prey_pop <= 0:
            continue

        # Attack rate modified by hunting range (Leviathan) or species-specific trait
        attack_mod = 1.0
        if pred_s == LEVIATHAN:
            attack_mod = 0.5 + buf_trait_means[r, c, pred_s, T_SPECIFIC]  # hunting range

        # Prey defense modifiers
        defense_mod = 1.0
        if prey_s == WORM:
            # Glow attracts predators (higher glow = easier to find)
            defense_mod = 0.7 + 0.6 * buf_trait_means[r, c, prey_s, T_SPECIFIC]
        elif prey_s == VELOTHRIX:
            # Crest brightness attracts predators
            defense_mod = 0.7 + 0.6 * buf_trait_means[r, c, prey_s, T_SPECIFIC]

        # Crawler: burrowing depth reduces encounter rate
        if prey_s == CRAWLER:
            burrow = buf_trait_means[r, c, CRAWLER, T_SPECIFIC]
            defense_mod *= (1.0 - burrow * 0.6)

        # Crab: shell thickness reduces kill success
        if prey_s == CRAB:
            shell = buf_trait_means[r, c, CRAB, T_SPECIFIC]
            defense_mod *= (1.0 - shell * 0.5)

        # Holling Type II functional response
        effective_attack = base_attack * attack_mod * defense_mod
        prey_killed = effective_attack * pred_pop * prey_pop / (1 + handling_time * prey_pop)
        prey_killed = _prob_round(min(prey_killed, prey_pop * 0.5))  # cap at 50% per gen

        buf_populations[r, c, prey_s] = max(0, int(buf_populations[r, c, prey_s]) - prey_killed)
        total_tile_deaths += prey_killed

    # ── Competition ──
    for sa, sb, coeff in COMPETITION_PAIRS:
        pa = int(buf_populations[r, c, sa])
        pb = int(buf_populations[r, c, sb])
        if pa > 0 and pb > 0:
            loss_a = _prob_round(coeff * pa * pb)
            loss_b = _prob_round(coeff * pa * pb)
            buf_populations[r, c, sa] = max(0, pa - loss_a)
            buf_populations[r, c, sb] = max(0, pb - loss_b)
            total_tile_deaths += loss_a + loss_b

    # ── Vegetation consumption ──
    total_herbivore_demand = 0
    for s in [CRAWLER, CRAB, VELOTHRIX]:
        pop = int(buf_populations[r, c, s])
        if pop <= 0:
            continue
        metabolism = buf_trait_means[r, c, s, T_METABOLISM]
        rate = 0.001 * (0.5 + metabolism)
        if s == CRAB:
            rate *= 0.3  # omnivore, eats less vegetation
        elif s == VELOTHRIX:
            rate *= 0.5  # eats invertebrates, indirect veg impact
        total_herbivore_demand += rate * pop

    veg_grid[r, c] = max(0, veg_grid[r, c] - total_herbivore_demand)

    # ── Vegetation regrowth ──
    biome = biome_grid[r, c]
    regrowth_base = [0.01, 0.04, 0.06, 0.03, 0.01][biome]
    veg_grid[r, c] += regrowth_base * (1 - veg_grid[r, c]) * season
    veg_grid[r, c] = min(1.0, max(0.0, veg_grid[r, c]))

    # ── Trait evolution ──
    for s in range(NUM_SPECIES):
        pop = int(buf_populations[r, c, s])
        if pop < 2:
            continue

        mutation_rate_trait = buf_trait_means[r, c, s, T_MUTATION]
        effective_mutation = 0.001 + mutation_rate_trait * 0.049  # maps 0–1 → 0.001–0.05

        for t in range(NUM_TRAITS):
            mean = buf_trait_means[r, c, s, t]
            var = buf_trait_var[r, c, s, t]

            # Mutation: add variance proportional to mutation rate
            var += effective_mutation * MUTATION_STEP

            # Drift: variance from finite population
            drift_var = mean * (1 - mean) / (2 * pop) if pop > 0 else 0
            mean += random.gauss(0, math.sqrt(drift_var + 1e-10))

            # Clamp to valid range
            mean = max(0.001, min(0.999, mean))
            var = max(0.001, min(0.25, var))

            buf_trait_means[r, c, s, t] = mean
            buf_trait_var[r, c, s, t] = var

    return total_tile_deaths


def _step_migration():
    """Move individuals between adjacent tiles based on migration tendency."""
    # Work on a snapshot to avoid order-dependent artifacts
    pop_snapshot = np.array(buf_populations, dtype=np.int32)

    for r in range(GRID_SIZE):
        for c in range(GRID_SIZE):
            for s in range(NUM_SPECIES):
                pop = pop_snapshot[r, c, s]
                if pop < 5:
                    continue

                migration_trait = buf_trait_means[r, c, s, T_MIGRATION]
                base_migration = 0.02 + migration_trait * 0.08  # 2–10% migrate

                # Shell thickness slows crab migration
                if s == CRAB:
                    shell = buf_trait_means[r, c, s, T_SPECIFIC]
                    base_migration *= (1 - shell * 0.4)

                migrants = _prob_round(pop * base_migration)
                if migrants <= 0:
                    continue

                # Distribute to valid neighbors
                neighbors = []
                for dr, dc in [(-1, 0), (1, 0), (0, -1), (0, 1)]:
                    nr, nc = r + dr, c + dc
                    if 0 <= nr < GRID_SIZE and 0 <= nc < GRID_SIZE:
                        suit = HABITAT_SUITABILITY[s, biome_grid[nr, nc]]
                        if suit > 0.1:
                            # River barrier
                            barrier = 1.0
                            if flags_grid[r, c] & 1 or flags_grid[nr, nc] & 1:
                                barrier = 0.3  # simplified river barrier
                            neighbors.append((nr, nc, suit * barrier))

                if not neighbors:
                    continue

                total_weight = sum(w for _, _, w in neighbors)
                per_neighbor = migrants / len(neighbors)

                for nr, nc, w in neighbors:
                    moved = _prob_round(per_neighbor * w / (total_weight / len(neighbors)))
                    moved = min(moved, int(buf_populations[r, c, s]))
                    if moved <= 0:
                        continue

                    buf_populations[r, c, s] = max(0, int(buf_populations[r, c, s]) - moved)
                    buf_populations[nr, nc, s] = min(65535, int(buf_populations[nr, nc, s]) + moved)

                    # Blend traits via migration
                    src_pop = max(1, int(buf_populations[r, c, s]))
                    dst_pop = max(1, int(buf_populations[nr, nc, s]))
                    m_frac = moved / dst_pop
                    for t in range(NUM_TRAITS):
                        src_mean = buf_trait_means[r, c, s, t]
                        dst_mean = buf_trait_means[nr, nc, s, t]
                        buf_trait_means[nr, nc, s, t] = (1 - m_frac) * dst_mean + m_frac * src_mean


def _prob_round(x):
    """Probabilistic rounding: 3.7 → 4 with 70% chance, 3 with 30% chance."""
    base = int(x)
    frac = x - base
    return base + (1 if random.random() < frac else 0)


# ── GLOBAL STATE UPDATE ──────────────────────────────────────────────────────

def _update_globals():
    """Write summary stats to globals section of shared buffer."""
    buf_globals[0] = generation  # GENERATION
    buf_globals[1] = _get_season()  # SEASON_FACTOR

    total_deaths = 0
    for s in range(NUM_SPECIES):
        total = int(np.sum(buf_populations[:, :, s]))
        buf_globals[6 + s] = total  # TOTAL_POP_0..4

    buf_globals[13] = float(np.mean(veg_grid))  # VEGETATION_MEAN


# ── PUBLIC API ────────────────────────────────────────────────────────────────

def init_simulation():
    """Called once at startup. Generates terrain, seeds populations."""
    global generation
    generation = 0
    _generate_terrain(str(_seed))
    _init_populations()
    _update_globals()


def step_simulation(n=1):
    """Advance the simulation by n generations."""
    global generation

    for _ in range(n):
        generation += 1
        season = _get_season()
        total_deaths = 0

        for r in range(GRID_SIZE):
            for c in range(GRID_SIZE):
                total_deaths += _step_tile(r, c, season)

        buf_globals[12] = total_deaths  # TOTAL_DEATHS for detritus calc

        if lod_level == 0:
            _step_migration()
        else:
            # Simplified: only migrate every 5th gen
            if generation % 5 == 0:
                _step_migration()

        _update_globals()


def flush_events():
    """Return queued events as JSON and clear the buffer."""
    global events_buffer
    result = json.dumps(events_buffer)
    events_buffer = []
    return result


def set_lod(level):
    """Set level of detail. 0 = full, 1 = simplified."""
    global lod_level
    lod_level = level
