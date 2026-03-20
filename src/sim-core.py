"""
evosim — Python simulation core
Runs inside Pyodide. All math lives here. JS never touches simulation logic.

Data flow:
  Python owns all simulation state as numpy arrays.
  At the end of each step, _sync_to_buffer() writes state into JS typed arrays
  that share memory with the SharedArrayBuffer (via Pyodide's JsProxy).
  JS reads the SharedArrayBuffer for rendering.
"""

import json
import math
import random
import numpy as np

# ── READ JS GLOBALS ───────────────────────────────────────────────────────────

from js import _grid_size, _seed, _species_count, _traits_per_species, _layout_json

GRID_SIZE = int(_grid_size)
G2 = GRID_SIZE * GRID_SIZE
NUM_SPECIES = int(_species_count)
NUM_TRAITS = int(_traits_per_species)

VELOTHRIX, LEVIATHAN, CRAWLER, CRAB, WORM = 0, 1, 2, 3, 4
T_CLUTCH, T_LONGEVITY, T_MUTATION, T_METABOLISM, T_MIGRATION, T_SPECIFIC = 0, 1, 2, 3, 4, 5
BIOME_DEEP_WATER, BIOME_SHALLOW_MARSH, BIOME_REED_BEDS, BIOME_TIDAL_FLATS, BIOME_ROCKY_SHORE = 0, 1, 2, 3, 4

SEASON_PERIOD = 100

# ── PYTHON-OWNED STATE ────────────────────────────────────────────────────────
# These are the authoritative sim state. SharedArrayBuffer is a read-only mirror for JS.

elevations = np.zeros((GRID_SIZE, GRID_SIZE), dtype=np.float32)
biomes     = np.zeros((GRID_SIZE, GRID_SIZE), dtype=np.uint8)
vegetation = np.zeros((GRID_SIZE, GRID_SIZE), dtype=np.float32)
pops       = np.zeros((GRID_SIZE, GRID_SIZE, NUM_SPECIES), dtype=np.uint16)
traits     = np.zeros((GRID_SIZE, GRID_SIZE, NUM_SPECIES, NUM_TRAITS), dtype=np.float32)
trait_var  = np.zeros((GRID_SIZE, GRID_SIZE, NUM_SPECIES, NUM_TRAITS), dtype=np.float32)
tile_flags = np.zeros((GRID_SIZE, GRID_SIZE), dtype=np.uint8)

generation = 0
lod_level = 0
events_buffer = []
total_deaths_last = 0

# Speciation tracking
# A species is "speciated" when its species-specific trait diverges >0.3
# between two spatial subpopulations for >100 consecutive generations.
speciation_detected = [False] * NUM_SPECIES
speciation_gens = [0] * NUM_SPECIES  # consecutive gens with divergence >threshold

# Extinction tracking
extinctions = []  # list of {species, gen, peak_pop, gens_survived, cause, last_tile}
species_alive = [True] * NUM_SPECIES
peak_pops = [0] * NUM_SPECIES
first_seen_gen = [0] * NUM_SPECIES
last_seen_tile = [(0, 0)] * NUM_SPECIES
pop_history_window = [[0] * 100 for _ in range(NUM_SPECIES)]  # rolling 100-gen window

# Epoch system
current_epoch = 'the_quiet'
epoch_since = 0
EPOCH_NAMES = {
    'the_quiet': 'The Quiet',
    'expansion': 'Age of Expansion',
    'drought': 'The Great Drought',
    'predator_reign': "Predator's Reign",
    'divergence': 'The Divergence',
    'twilight': 'Twilight',
    'last_stand': 'Last Stand',
    'equilibrium': 'The Long Equilibrium',
}

# ── JS BUFFER VIEWS (for syncing) ────────────────────────────────────────────
# These are JsProxy objects pointing to typed arrays on the SharedArrayBuffer.
# We write to them at the end of each step via _sync_to_buffer().

_js_views = {}  # populated in init_simulation()

# ── ECOLOGICAL PARAMETERS ─────────────────────────────────────────────────────

HABITAT_SUIT = np.array([
    [0.0, 0.7, 1.0, 0.6, 0.2],   # Velothrix
    [0.8, 1.0, 0.3, 0.5, 0.3],   # Leviathan
    [0.0, 0.5, 1.0, 0.8, 0.3],   # Crawler
    [0.1, 0.4, 0.5, 1.0, 0.8],   # Crab
    [0.6, 0.8, 0.7, 0.5, 0.4],   # Worm
], dtype=np.float32)

BASE_K = np.array([60, 45, 55, 50, 58], dtype=np.float32)
BASE_R = np.array([0.08, 0.06, 0.07, 0.065, 0.07], dtype=np.float32)
VEG_REGROWTH = np.array([0.01, 0.04, 0.06, 0.03, 0.01], dtype=np.float32)
HERITABILITY = 0.5
MUTATION_STEP = 0.015

PREDATION = [
    (LEVIATHAN, VELOTHRIX, 0.008, 0.10),
    (LEVIATHAN, WORM,      0.005, 0.15),
    (VELOTHRIX, WORM,      0.003, 0.20),
]

COMPETITION = [
    (VELOTHRIX, CRAWLER, 0.0003),
    (CRAB,     CRAWLER, 0.0002),
]


# ── TERRAIN ───────────────────────────────────────────────────────────────────
# Hotspot volcanism model — based on Hawaiian chain formation.
# A fixed mantle plume erupts repeatedly while the plate drifts over it,
# creating a chain of islands. Older islands erode and subside.

def _generate_terrain(seed_str):
    """
    Generate terrain via hotspot volcanism + plate drift + erosion.

    1. Start with flat ocean floor (negative elevation, ~-0.45 + noise)
    2. Place 1-3 hotspot mantle plumes at fixed positions
    3. Simulate N epochs of geological time:
       a. Each hotspot erupts: deposits elevation with squared falloff
       b. Plate drift: builds trail of decreasing deposits behind hotspot
       c. Erosion: flat subtraction + weighted blur smoothing
    4. Snapshot at a random epoch for terrain diversity
    """
    from scipy.ndimage import gaussian_filter

    seed_val = sum(ord(c) * (i + 1) for i, c in enumerate(seed_str))
    random.seed(seed_val)
    np.random.seed(seed_val % (2**31))
    rng = np.random.RandomState(seed_val)

    gs = GRID_SIZE

    # ── Ocean floor baseline: varied noise, all negative ──
    grid = rng.uniform(-0.25, -0.08, (gs, gs)).astype(np.float32)
    # Add low-frequency undulation to the ocean floor
    floor_noise = rng.rand(gs, gs).astype(np.float32)
    floor_noise = gaussian_filter(floor_noise, sigma=gs * 0.12, mode='wrap')
    fn_lo, fn_hi = floor_noise.min(), floor_noise.max()
    if fn_hi > fn_lo:
        floor_noise = (floor_noise - fn_lo) / (fn_hi - fn_lo)
    grid += (floor_noise - 0.5) * 0.08  # +/- 0.04 undulation

    # ── Plate drift direction (single plate, random direction) ──
    drift_angle = rng.uniform(0, 2 * math.pi)
    drift_dx = math.cos(drift_angle)
    drift_dy = math.sin(drift_angle)
    drift_speed = rng.uniform(0.3, 0.6)

    # ── Hotspots: many plumes spread across the grid ──
    # More hotspots + higher power = more land coverage (target 70-90%)
    num_hotspots = max(4, gs // 8)  # 4 at 32, 8 at 64
    hotspots = []
    for _ in range(num_hotspots):
        hx = rng.uniform(gs * 0.08, gs * 0.92)
        hy = rng.uniform(gs * 0.08, gs * 0.92)
        power = rng.uniform(0.08, 0.18)
        radius = rng.uniform(gs * 0.06, gs * 0.15)
        hotspots.append({'x': hx, 'y': hy, 'power': power, 'radius': radius})

    # ── Simulate geological epochs ──
    # More epochs = more eruptions = more land
    num_epochs = rng.randint(80, 200)
    snapshot_epoch = rng.randint(int(num_epochs * 0.6), num_epochs)

    for epoch in range(num_epochs):
        # ── Eruptions from each hotspot ──
        for hs in hotspots:
            if rng.random() < 0.7:  # 70% chance of eruption per tick
                # Jitter eruption strength and radius for organic feel
                erupt_power = hs['power'] * rng.uniform(0.6, 1.4)
                erupt_radius = hs['radius'] * rng.uniform(0.7, 1.3)

                # Deposit elevation with squared falloff from hotspot center
                cx, cy = int(hs['x']), int(hs['y'])
                ir = int(erupt_radius) + 1
                for dr in range(-ir, ir + 1):
                    for dc in range(-ir, ir + 1):
                        r, c = cx + dr, cy + dc
                        if 0 <= r < gs and 0 <= c < gs:
                            dist = math.sqrt(dr * dr + dc * dc)
                            if dist < erupt_radius:
                                # Squared falloff: steep conical profile
                                t = 1 - (dist / erupt_radius)
                                deposit = erupt_power * t * t
                                grid[r, c] += deposit

            # ── Island chain trail: walk backward along drift vector ──
            trail_len = int(epoch * drift_speed * 0.6)
            for step in range(1, min(trail_len, gs)):
                tr = int(hs['x'] - drift_dx * step * 1.2)
                tc = int(hs['y'] - drift_dy * step * 1.2)
                if 0 <= tr < gs and 0 <= tc < gs:
                    strength = hs['power'] * 0.5 / (1 + step * 0.1)
                    trail_r = max(2, int(hs['radius'] * 0.6))
                    for dr in range(-trail_r, trail_r + 1):
                        for dc in range(-trail_r, trail_r + 1):
                            rr, cc = tr + dr, tc + dc
                            if 0 <= rr < gs and 0 <= cc < gs:
                                d = math.sqrt(dr*dr + dc*dc)
                                if d < trail_r:
                                    t = 1 - d / trail_r
                                    grid[rr, cc] += strength * t * t * rng.uniform(0.6, 1.0) * 0.15

        # ── Erosion: flat subtraction ──
        for r in range(gs):
            for c in range(gs):
                if grid[r, c] > 0:
                    # Land erodes slowly; fresh lava erodes faster
                    rate = 0.008 if grid[r, c] > 0.85 else 0.002
                    grid[r, c] -= rate

        # ── Smoothing: weighted blur (6:1:1:1:1 kernel) ──
        # Spreads material outward, softens peaks, widens coastlines
        blurred = gaussian_filter(grid, sigma=0.6, mode='nearest')
        grid = grid * 0.85 + blurred * 0.15

        # ── Save snapshot ──
        if epoch == snapshot_epoch:
            snapshot = grid.copy()

    # Use the snapshot (or final state if snapshot wasn't reached)
    if 'snapshot' in dir():
        grid = snapshot

    # ── Detail noise pass — break up the smooth volcanic slopes ──
    # FBM noise adds natural terrain roughness: ridges, gullies, uneven surfaces
    detail = rng.rand(gs, gs).astype(np.float32)
    detail = gaussian_filter(detail, sigma=gs * 0.02, mode='wrap')  # fine detail
    detail_lo, detail_hi = detail.min(), detail.max()
    if detail_hi > detail_lo:
        detail = (detail - detail_lo) / (detail_hi - detail_lo)

    # Medium-scale noise for hills and valleys
    medium = rng.rand(gs, gs).astype(np.float32)
    medium = gaussian_filter(medium, sigma=gs * 0.06, mode='wrap')
    med_lo, med_hi = medium.min(), medium.max()
    if med_hi > med_lo:
        medium = (medium - med_lo) / (med_hi - med_lo)

    # Blend noise into the terrain — more effect on land, less on deep ocean
    for r in range(gs):
        for c in range(gs):
            if grid[r, c] > -0.05:
                # Land and shallow water: add roughness
                grid[r, c] += (detail[r, c] - 0.5) * 0.06
                grid[r, c] += (medium[r, c] - 0.5) * 0.04
            else:
                # Deep ocean: subtle seafloor variation
                grid[r, c] += (detail[r, c] - 0.5) * 0.02

    # ── Edge-to-interior gradient ──
    # Push edges down (ocean), push interior up (land).
    # Noise-modulated edge distance creates irregular coastlines.
    edge_noise = rng.rand(gs, gs).astype(np.float32)
    edge_noise = gaussian_filter(edge_noise, sigma=gs * 0.08, mode='wrap')
    en_lo, en_hi = edge_noise.min(), edge_noise.max()
    if en_hi > en_lo:
        edge_noise = (edge_noise - en_lo) / (en_hi - en_lo)

    border_depth = gs * 0.18  # how deep the ocean border extends
    for r in range(gs):
        for c in range(gs):
            # Distance from nearest edge
            edge_dist = min(r, c, gs - 1 - r, gs - 1 - c)
            # Noise-modulated border width — creates bays and peninsulas
            local_border = border_depth * (0.6 + edge_noise[r, c] * 0.8)
            if edge_dist < local_border:
                # Smooth cubic falloff toward edges
                t = edge_dist / local_border
                push = (1 - t) ** 2 * 0.25  # strong downward push at edge
                grid[r, c] -= push
            else:
                # Interior gets a mild upward push
                interior_t = (edge_dist - local_border) / max(1, gs * 0.5 - local_border)
                grid[r, c] += interior_t * 0.02

    # ── Map to elevation array ──
    lo, hi = grid.min(), grid.max()
    if hi <= lo:
        hi = lo + 1

    # Normalize to 0-1. Sea level is where the raw grid crosses 0.
    # Find where 0 sits in the normalized range
    zero_norm = (0 - lo) / (hi - lo)

    # Map so that raw 0 (sea level) → 0.20 in our output
    for r in range(gs):
        for c in range(gs):
            raw_norm = (grid[r, c] - lo) / (hi - lo)
            if raw_norm <= zero_norm:
                # Underwater: [0, zero_norm] → [0, 0.20]
                elevations[r, c] = (raw_norm / max(0.001, zero_norm)) * 0.20
            else:
                # Land: [zero_norm, 1] → [0.20, 1.0]
                elevations[r, c] = 0.20 + (raw_norm - zero_norm) / max(0.001, 1 - zero_norm) * 0.80

    _assign_biomes()

    for r in range(gs):
        for c in range(gs):
            vegetation[r, c] = min(1.0, VEG_REGROWTH[biomes[r, c]] * 10)


def _assign_biomes():
    """
    Classify biomes from elevation. Sea level is at ~0.20.
    Below 0.20 = underwater. Above = land types by elevation.
    """
    for r in range(GRID_SIZE):
        for c in range(GRID_SIZE):
            e = elevations[r, c]
            if   e < 0.08: biomes[r, c] = BIOME_DEEP_WATER      # deep ocean
            elif e < 0.20: biomes[r, c] = BIOME_SHALLOW_MARSH    # shallow water
            elif e < 0.28: biomes[r, c] = BIOME_TIDAL_FLATS      # beach / sand
            elif e < 0.55: biomes[r, c] = BIOME_REED_BEDS        # lowland forest
            else:          biomes[r, c] = BIOME_ROCKY_SHORE       # highland / volcanic peak


# ── POPULATION SEEDING ────────────────────────────────────────────────────────

def _init_populations():
    for r in range(GRID_SIZE):
        for c in range(GRID_SIZE):
            biome = biomes[r, c]
            for s in range(NUM_SPECIES):
                suit = HABITAT_SUIT[s, biome]
                pops[r, c, s] = max(0, int(BASE_K[s] * suit * 0.3 * random.uniform(0.5, 1.0))) if suit > 0.2 else 0
                for t in range(NUM_TRAITS):
                    traits[r, c, s, t] = 0.5 + random.uniform(-0.1, 0.1)
                    trait_var[r, c, s, t] = 0.04


# ── SIM STEP FUNCTIONS ────────────────────────────────────────────────────────

def _season():
    return 0.5 + 0.5 * math.sin(2 * math.pi * generation / SEASON_PERIOD)


def _prob_round(x):
    base = int(x)
    frac = x - base
    if frac > 0: return base + (1 if random.random() < frac else 0)
    elif frac < 0: return base - (1 if random.random() < -frac else 0)
    return base


def _k(r, c, s, season):
    biome = biomes[r, c]
    suit = HABITAT_SUIT[s, biome]
    if suit < 0.05: return 0
    veg = vegetation[r, c]
    met = traits[r, c, s, T_METABOLISM]

    if   s == CRAWLER:   food = veg
    elif s == CRAB:      food = veg * 0.4 + 0.4
    elif s == VELOTHRIX: food = veg * 0.6 + 0.2
    elif s == WORM:      food = min(1.0, 0.3 + total_deaths_last / max(1, G2 * 3))
    else:                food = 0.5  # Leviathan — prey-driven

    food_mod = max(0.05, 0.3 + 0.7 * food)
    met_amp = food_mod ** (0.7 + met * 0.6)
    result = BASE_K[s] * suit * met_amp * (0.85 + 0.15 * season)

    # Algal bloom: boost Worm/Velothrix K 15%, penalize Leviathan
    if _has_active_event('algal_bloom'):
        if s in (WORM, VELOTHRIX):
            result *= 1.15
        elif s == LEVIATHAN:
            result *= 0.8

    return max(1, result) if not math.isnan(result) else 1


def _step_growth(r, c, season):
    deaths = 0
    for s in range(NUM_SPECIES):
        pop = int(pops[r, c, s])
        if pop <= 0: continue
        k = _k(r, c, s, season)
        if k <= 0:
            d = _prob_round(pop * 0.1)
            pops[r, c, s] = max(0, pop - d)
            deaths += d
            continue
        clutch = traits[r, c, s, T_CLUTCH]
        longevity = traits[r, c, s, T_LONGEVITY]
        r_eff = BASE_R[s] * (0.5 + clutch)
        growth = r_eff * pop * (1 - pop / k)
        mort = 0.02 + 0.08 * (1 - longevity)
        d = _prob_round(pop * mort)
        new_pop = max(0, min(65535, pop + _prob_round(growth) - d))
        deaths += d + max(0, pop - new_pop + d)
        pops[r, c, s] = new_pop
    return deaths


def _step_predation(r, c):
    deaths = 0
    for pred, prey, base_atk, h_time in PREDATION:
        pp = int(pops[r, c, pred])
        qp = int(pops[r, c, prey])
        if pp <= 0 or qp <= 0: continue
        atk = base_atk
        if pred == LEVIATHAN: atk *= (0.5 + traits[r, c, LEVIATHAN, T_SPECIFIC])
        if prey == VELOTHRIX: atk *= (0.7 + 0.6 * traits[r, c, VELOTHRIX, T_SPECIFIC])
        elif prey == WORM: atk *= (0.7 + 0.6 * traits[r, c, WORM, T_SPECIFIC])
        if prey == CRAWLER: atk *= (1.0 - traits[r, c, CRAWLER, T_SPECIFIC] * 0.6)
        ks = 1.0
        if prey == CRAB: ks = 1.0 - traits[r, c, CRAB, T_SPECIFIC] * 0.5
        kills = atk * pp * qp / (1 + h_time * qp)
        kills = _prob_round(min(kills * ks, qp * 0.5))
        pops[r, c, prey] = max(0, qp - kills)
        deaths += kills
    return deaths


def _step_competition(r, c):
    deaths = 0
    for sa, sb, coeff in COMPETITION:
        pa, pb = int(pops[r, c, sa]), int(pops[r, c, sb])
        if pa > 0 and pb > 0:
            la = _prob_round(coeff * pa * pb)
            lb = _prob_round(coeff * pa * pb)
            pops[r, c, sa] = max(0, pa - la)
            pops[r, c, sb] = max(0, pb - lb)
            deaths += la + lb
    return deaths


def _step_vegetation(r, c, season):
    for s in [CRAWLER, CRAB, VELOTHRIX]:
        pop = int(pops[r, c, s])
        if pop <= 0: continue
        met = traits[r, c, s, T_METABOLISM]
        rate = 0.001 * (0.5 + met)
        if s == CRAB: rate *= 0.3
        elif s == VELOTHRIX: rate *= 0.5
        vegetation[r, c] -= rate * pop
    biome = biomes[r, c]
    vegetation[r, c] += VEG_REGROWTH[biome] * (1 - vegetation[r, c]) * season
    vegetation[r, c] = max(0.0, min(1.0, float(vegetation[r, c])))


def _step_traits(r, c):
    for s in range(NUM_SPECIES):
        pop = int(pops[r, c, s])
        if pop < 2: continue
        mut = 0.001 + traits[r, c, s, T_MUTATION] * 0.049
        for t in range(NUM_TRAITS):
            mean = float(traits[r, c, s, t])
            var = float(trait_var[r, c, s, t])
            drift_v = mean * (1 - mean) / (2 * pop)
            mean += random.gauss(0, math.sqrt(max(0, drift_v)))
            var += mut * MUTATION_STEP
            var *= 0.99
            if math.isnan(mean): mean = 0.5
            if math.isnan(var): var = 0.04
            traits[r, c, s, t] = max(0.001, min(0.999, mean))
            trait_var[r, c, s, t] = max(0.001, min(0.25, var))


def _step_migration():
    snap = np.array(pops, dtype=np.int32)
    for r in range(GRID_SIZE):
        for c in range(GRID_SIZE):
            for s in range(NUM_SPECIES):
                pop = int(snap[r, c, s])
                if pop < 5: continue
                mig = traits[r, c, s, T_MIGRATION]
                rate = 0.02 + mig * 0.08
                if s == CRAB: rate *= (1 - traits[r, c, s, T_SPECIFIC] * 0.4)
                migrants = _prob_round(pop * rate)
                if migrants <= 0: continue
                nbrs = []
                for dr, dc in [(-1,0),(1,0),(0,-1),(0,1)]:
                    nr, nc = r+dr, c+dc
                    if 0 <= nr < GRID_SIZE and 0 <= nc < GRID_SIZE:
                        suit = HABITAT_SUIT[s, biomes[nr, nc]]
                        if suit > 0.1:
                            bar = _river_barrier_factor(r, c, nr, nc)
                            nbrs.append((nr, nc, suit * bar))
                if not nbrs: continue
                tw = sum(w for _,_,w in nbrs)
                for nr, nc, w in nbrs:
                    moved = _prob_round(migrants * w / tw)
                    moved = min(moved, int(pops[r, c, s]))
                    if moved <= 0: continue
                    pops[r, c, s] = max(0, int(pops[r, c, s]) - moved)
                    pops[nr, nc, s] = min(65535, int(pops[nr, nc, s]) + moved)
                    dp = max(1, int(pops[nr, nc, s]))
                    frac = moved / dp
                    for t in range(NUM_TRAITS):
                        traits[nr, nc, s, t] = (1-frac) * traits[nr, nc, s, t] + frac * traits[r, c, s, t]


# ── ENVIRONMENTAL EVENTS ──────────────────────────────────────────────────────
# Stochastic events that disrupt the ecosystem. Each has a probability per gen
# and a mechanical effect. No event is purely cosmetic — each changes numbers
# that feed into growth, predation, or carrying capacity.

EVENT_PROBS = {
    'drought': 0.002,
    'disease': 0.001,
    'algal_bloom': 0.003,
    'tidal_surge': 0.002,
    'reef_formation': 0.001,
}

active_events = []  # list of {type, start_gen, duration, data}


def _check_events(season):
    """Roll for new events each generation."""
    # Drought — reduces vegetation regrowth across the grid
    if random.random() < EVENT_PROBS['drought'] and season > 0.3:
        duration = random.randint(30, 80)
        active_events.append({
            'type': 'drought', 'start': generation, 'duration': duration,
        })
        events_buffer.append({'gen': generation, 'type': 'drought',
            'text': f'Gen {generation}. Drought. The marshes dry. Vegetation regrowth will slow for {duration} generations.'})

    # Disease — targets one species at a spatial epicenter
    if random.random() < EVENT_PROBS['disease']:
        target = random.randint(0, NUM_SPECIES - 1)
        # Find a tile where this species has significant population
        candidates = [(r,c) for r in range(GRID_SIZE) for c in range(GRID_SIZE) if pops[r,c,target] > 10]
        if candidates:
            er, ec = random.choice(candidates)
            duration = random.randint(10, 30)
            active_events.append({
                'type': 'disease', 'start': generation, 'duration': duration,
                'species': target, 'epicenter': (er, ec),
            })
            events_buffer.append({'gen': generation, 'type': 'disease',
                'text': f'Gen {generation}. Disease strikes {SPECIES_NAMES[target]} near ({er},{ec}). Mortality will spike for {duration} generations.'})

    # Algal bloom — boosts Worm/Velothrix, hurts Leviathan
    if random.random() < EVENT_PROBS['algal_bloom'] and season > 0.5:
        duration = random.randint(20, 60)
        active_events.append({
            'type': 'algal_bloom', 'start': generation, 'duration': duration,
        })
        events_buffer.append({'gen': generation, 'type': 'algal_bloom',
            'text': f'Gen {generation}. Algal bloom chokes the shallows. Predators struggle. Decomposers feast.'})

    # Tidal surge — temporarily lowers coastal elevation
    if random.random() < EVENT_PROBS['tidal_surge']:
        duration = random.randint(15, 40)
        active_events.append({
            'type': 'tidal_surge', 'start': generation, 'duration': duration,
        })
        events_buffer.append({'gen': generation, 'type': 'tidal_surge',
            'text': f'Gen {generation}. Tidal surge. Coastal elevations drop. Deep water expands inland.'})

    # Reef formation — permanent terrain change
    if random.random() < EVENT_PROBS['reef_formation']:
        # Count current rocky_shore tiles
        rocky_count = int(np.sum(biomes == BIOME_ROCKY_SHORE))
        if rocky_count < G2 * 0.25:  # cap at 25%
            # Find a shallow/tidal tile to convert
            candidates = [(r,c) for r in range(GRID_SIZE) for c in range(GRID_SIZE)
                          if biomes[r,c] in (BIOME_SHALLOW_MARSH, BIOME_TIDAL_FLATS)]
            if candidates:
                r, c = random.choice(candidates)
                elevations[r, c] = min(1.0, elevations[r, c] + 0.15)
                biomes[r, c] = BIOME_ROCKY_SHORE
                events_buffer.append({'gen': generation, 'type': 'reef',
                    'text': f'Gen {generation}. Calcium deposits harden at ({r},{c}). New reef rises from the seabed.'})


def _apply_active_events(season):
    """Apply effects of ongoing events. Remove expired ones."""
    expired = []
    for evt in active_events:
        age = generation - evt['start']
        if age > evt['duration']:
            expired.append(evt)
            continue

        if evt['type'] == 'drought':
            # Reduce vegetation regrowth by 60%
            for r in range(GRID_SIZE):
                for c in range(GRID_SIZE):
                    vegetation[r, c] *= 0.998  # slow drain

        elif evt['type'] == 'disease':
            s = evt['species']
            er, ec = evt['epicenter']
            for r in range(GRID_SIZE):
                for c in range(GRID_SIZE):
                    if pops[r, c, s] <= 0:
                        continue
                    dist = abs(r - er) + abs(c - ec)
                    severity = max(0, 1 - dist / (GRID_SIZE * 0.5))
                    if severity > 0:
                        kills = _prob_round(pops[r, c, s] * 0.05 * severity)
                        pops[r, c, s] = max(0, int(pops[r, c, s]) - kills)

        elif evt['type'] == 'algal_bloom':
            # Boost Worm K, reduce Leviathan predation effectiveness
            # (handled via modifier in _k and _step_predation — simplified here)
            pass  # effect is checked in _k via active_events list

        elif evt['type'] == 'tidal_surge':
            # Temporarily lower coastal tile elevations
            if age == 0:  # apply once at start
                for r in range(GRID_SIZE):
                    for c in range(GRID_SIZE):
                        if elevations[r, c] < 0.35:
                            elevations[r, c] = max(0, elevations[r, c] - 0.05)

    for evt in expired:
        active_events.remove(evt)
        # Restore tidal surge elevation
        if evt['type'] == 'tidal_surge':
            for r in range(GRID_SIZE):
                for c in range(GRID_SIZE):
                    if elevations[r, c] < 0.30:
                        elevations[r, c] += 0.05


def _has_active_event(event_type):
    """Check if an event of the given type is currently active."""
    return any(e['type'] == event_type for e in active_events)


# ── BACKGROUND EROSION ────────────────────────────────────────────────────────

EROSION_RATE = 0.0003  # elevation loss per gen for high tiles

def _apply_erosion():
    """
    Slow background erosion of high-elevation tiles.
    Over geological time, mountains wear down.
    Equation: Δelev = -ε × max(0, elev - mean_neighbor_elev)
    See evolution-simulation-research.md §12.8
    """
    for r in range(GRID_SIZE):
        for c in range(GRID_SIZE):
            e = elevations[r, c]
            if e < 0.3:
                continue  # don't erode low tiles
            # Mean neighbor elevation
            neighbors = []
            for dr, dc in [(-1,0),(1,0),(0,-1),(0,1)]:
                nr, nc = r+dr, c+dc
                if 0 <= nr < GRID_SIZE and 0 <= nc < GRID_SIZE:
                    neighbors.append(elevations[nr, nc])
            if not neighbors:
                continue
            mean_n = sum(neighbors) / len(neighbors)
            diff = e - mean_n
            if diff > 0:
                elevations[r, c] -= EROSION_RATE * diff
                elevations[r, c] = max(0, elevations[r, c])
    # Reclassify biomes after elevation changes
    _assign_biomes()


# ── RIVERS & TERRAIN DYNAMICS ─────────────────────────────────────────────────
# Rivers are directed-path overlays on the elevation grid.
# They spawn at high elevation, advance downhill, erode banks, form oxbows.
# See evolution-simulation-research.md §12.

# Scale geological timings with grid size — larger grids need more gens between ticks
# because each gen already processes more tiles
RIVER_GEO_TICK = max(100, 50 * GRID_SIZE // 8)  # ~200 at 32, ~400 at 64
RIVER_SPAWN_PROB = 0.005   # slightly higher for larger grids with more high terrain
RIVER_EROSION = 0.008      # outer-bank erosion per geo tick
RIVER_DEPOSIT = 0.004      # inner-bank deposition per geo tick
RIVER_REROUTE_N = 3        # re-path every N geo ticks

rivers = []       # list of river dicts
oxbow_lakes = []   # list of {tiles: [(r,c),...], age: int}
_next_river_id = 0


def _spawn_river():
    """Stochastically spawn a river at high elevation."""
    global _next_river_id
    if random.random() > RIVER_SPAWN_PROB:
        return
    # Find high-elevation tiles without rivers
    candidates = []
    for r in range(GRID_SIZE):
        for c in range(GRID_SIZE):
            if elevations[r, c] > 0.7 and not (tile_flags[r, c] & 1):
                candidates.append((r, c, float(elevations[r, c])))
    if not candidates:
        return
    # Weight by elevation
    candidates.sort(key=lambda x: -x[2])
    r, c, _ = candidates[0]
    river = {
        'id': _next_river_id,
        'path': [(r, c)],
        'path_set': {(r, c)},
        'age': 0,
        'width': 1,
        'active': True,
        'stall_gens': 0,
    }
    _next_river_id += 1
    tile_flags[r, c] |= 1  # has_river flag
    rivers.append(river)
    events_buffer.append({'gen': generation, 'type': 'river_spawn',
        'text': f'Gen {generation}. A new river springs from the highlands at ({r},{c}).'})


def _advance_river(river):
    """Extend river one tile downhill. Erosion force scales with drainage area (path length)."""
    if not river['active']:
        return
    r, c = river['path'][-1]
    best = None
    best_elev = elevations[r, c]

    # Stream power: erosion scales with upstream drainage area (proxy: path length)
    erosion_force = RIVER_EROSION * (1 + len(river['path']) * 0.3)

    for dr, dc in [(-1,0),(1,0),(0,-1),(0,1)]:
        nr, nc = r+dr, c+dc
        if 0 <= nr < GRID_SIZE and 0 <= nc < GRID_SIZE:
            if (nr, nc) not in river['path_set']:
                e = elevations[nr, nc]
                if e < best_elev:
                    best = (nr, nc)
                    best_elev = e

    if best is None:
        # Try eroding the lowest neighbor to carve a path
        lowest_n = None
        lowest_e = 999
        for dr, dc in [(-1,0),(1,0),(0,-1),(0,1)]:
            nr, nc = r+dr, c+dc
            if 0 <= nr < GRID_SIZE and 0 <= nc < GRID_SIZE:
                if (nr, nc) not in river['path_set'] and elevations[nr, nc] < lowest_e:
                    lowest_n = (nr, nc)
                    lowest_e = elevations[nr, nc]
        if lowest_n:
            nr, nc = lowest_n
            elevations[nr, nc] = max(0, elevations[nr, nc] - erosion_force)
            if elevations[nr, nc] < elevations[r, c]:
                best = (nr, nc)

        if best is None:
            river['stall_gens'] += RIVER_GEO_TICK
            if river['stall_gens'] >= 500:
                _deactivate_river(river)
            return

    river['stall_gens'] = 0
    nr, nc = best
    river['path'].append((nr, nc))
    river['path_set'].add((nr, nc))
    tile_flags[nr, nc] |= 1
    if elevations[nr, nc] < 0.15:
        river['active'] = False


def _deactivate_river(river):
    """Dry up a river."""
    river['active'] = False
    for r, c in river['path']:
        # Only clear flag if no other active river uses this tile
        other = any(rv['active'] and (r,c) in rv['path_set'] for rv in rivers if rv['id'] != river['id'])
        if not other:
            tile_flags[r, c] &= ~1


def _river_erode_deposit():
    """Lateral erosion-deposition at river bends. Creates emergent meandering."""
    for river in rivers:
        if not river['active'] or len(river['path']) < 3:
            continue
        path = river['path']
        for i in range(1, len(path) - 1):
            pr, pc = path[i-1]
            cr, cc = path[i]
            nr, nc = path[i+1]
            # Flow direction vectors
            dr_in, dc_in = cr - pr, cc - pc
            dr_out, dc_out = nr - cr, nc - cc
            # Detect bend (direction change)
            if (dr_in, dc_in) == (dr_out, dc_out):
                continue  # straight segment
            # Outer bank: perpendicular to bend, on the outside
            # Simple: the tile opposite to the bend direction
            outer_r = cr + (dr_in + dr_out)
            outer_c = cc + (dc_in + dc_out)
            inner_r = cr - (dr_in + dr_out)
            inner_c = cc - (dc_in + dc_out)
            # Erode outer bank
            if 0 <= outer_r < GRID_SIZE and 0 <= outer_c < GRID_SIZE:
                elevations[outer_r, outer_c] = max(0, elevations[outer_r, outer_c] - RIVER_EROSION)
            # Deposit inner bank
            if 0 <= inner_r < GRID_SIZE and 0 <= inner_c < GRID_SIZE:
                elevations[inner_r, inner_c] = min(1, elevations[inner_r, inner_c] + RIVER_DEPOSIT)


def _check_oxbow(river):
    """Detect meander cutoff — when path loops close."""
    path = river['path']
    if len(path) < 6:
        return
    for i in range(len(path)):
        for j in range(i + 4, len(path)):
            ri, ci = path[i]
            rj, cj = path[j]
            if abs(ri - rj) + abs(ci - cj) == 1:
                # Loop detected — cut it
                loop = path[i+1:j]
                river['path'] = path[:i+1] + path[j:]
                river['path_set'] = set(river['path'])
                # Clear river flags on loop tiles
                for lr, lc in loop:
                    tile_flags[lr, lc] &= ~1
                # Create oxbow lake
                if loop:
                    oxbow_lakes.append({'tiles': loop, 'age': 0})
                    events_buffer.append({'gen': generation, 'type': 'oxbow',
                        'text': f'Gen {generation}. The river bends too far. An oxbow lake forms — isolation follows.'})
                return  # one cutoff per step


def _reroute_river(river):
    """
    Re-trace river path from source following steepest descent.
    Called after erosion-deposition reshapes terrain.
    This is how meandering actually works — the river follows the NEW terrain gradient.
    """
    if not river['active'] or len(river['path']) < 2:
        return

    source = river['path'][0]

    # Clear old flags
    for r, c in river['path']:
        other = any(rv['active'] and (r,c) in rv['path_set'] for rv in rivers if rv['id'] != river['id'])
        if not other:
            tile_flags[r, c] &= ~1

    # Rebuild path greedily from source
    new_path = [source]
    visited = {source}
    r, c = source
    tile_flags[r, c] |= 1

    max_steps = GRID_SIZE * 3  # prevent infinite loops
    for _ in range(max_steps):
        best = None
        best_elev = elevations[r, c]
        for dr, dc in [(-1,0),(1,0),(0,-1),(0,1)]:
            nr, nc = r+dr, c+dc
            if 0 <= nr < GRID_SIZE and 0 <= nc < GRID_SIZE and (nr,nc) not in visited:
                e = elevations[nr, nc]
                if e < best_elev:
                    best = (nr, nc)
                    best_elev = e
        if best is None:
            break
        r, c = best
        new_path.append((r, c))
        visited.add((r, c))
        tile_flags[r, c] |= 1
        if elevations[r, c] < 0.15:
            break  # reached coast

    river['path'] = new_path
    river['path_set'] = set(new_path)


# River barrier cache — pre-compute barrier strength per tile pair
_river_barrier_cache = {}

def _build_river_barrier_cache():
    """Rebuild barrier strength cache from active rivers."""
    global _river_barrier_cache
    _river_barrier_cache = {}
    for river in rivers:
        if not river['active']:
            continue
        strength = 0.01 * river['width'] * river['age']
        for r, c in river['path']:
            _river_barrier_cache[(r, c)] = max(
                _river_barrier_cache.get((r, c), 0), strength
            )


def _river_barrier_factor(r1, c1, r2, c2):
    """
    Gene flow reduction factor for migration between two tiles.
    Returns 0-1 where 1 = no barrier, 0 = complete barrier.
    Model: m_effective = m / (1 + k × width × age)
    See evolution-simulation-research.md §12.7
    """
    s1 = _river_barrier_cache.get((r1, c1), 0)
    s2 = _river_barrier_cache.get((r2, c2), 0)
    strength = max(s1, s2)
    if strength <= 0:
        return 1.0
    return 1.0 / (1.0 + strength)


def _step_rivers():
    """Master river update — called on geological ticks."""
    geo_tick = generation // RIVER_GEO_TICK
    if generation % RIVER_GEO_TICK != 0:
        return

    for river in rivers:
        if river['active']:
            _advance_river(river)
            river['age'] += 1
            river['width'] = 1 + river['age'] // 5

    _river_erode_deposit()

    # Reroute and check oxbow every N geological ticks
    if geo_tick % RIVER_REROUTE_N == 0:
        for river in rivers:
            if river['active']:
                _reroute_river(river)
                _check_oxbow(river)

    # Rebuild barrier cache after any river changes
    _build_river_barrier_cache()

    # Age oxbow lakes (slow infill)
    for lake in oxbow_lakes:
        lake['age'] += 1
        # Very slow elevation rise (lake fills in over time)
        if lake['age'] % 10 == 0:
            for r, c in lake['tiles']:
                elevations[r, c] = min(0.3, elevations[r, c] + 0.002)


def _sync_rivers_to_buffer():
    """Write river path data to shared buffer for JS rendering."""
    from js import _js_river_paths, _js_river_meta

    # River paths: flatten all paths with -1 sentinel between rivers
    path_data = []
    for river in rivers:
        for r, c in river['path']:
            path_data.append(r)
            path_data.append(c)
        path_data.append(-1)  # sentinel: end of this river
        path_data.append(-1)

    # Pad or truncate to buffer size
    max_vals = 512 * 2  # MAX_RIVER_POINTS * 2
    while len(path_data) < max_vals:
        path_data.append(-1)
    path_data = path_data[:max_vals]

    from pyodide.ffi import to_js
    _js_river_paths.set(to_js(np.array(path_data, dtype=np.int16)))

    # River meta: [id, age, width, active] per river
    meta_data = []
    max_rivers = 20
    for river in rivers[:max_rivers]:
        meta_data.extend([river['id'], river['age'], river['width'], 1.0 if river['active'] else 0.0])
    while len(meta_data) < max_rivers * 4:
        meta_data.extend([-1, 0, 0, 0])

    _js_river_meta.set(to_js(np.array(meta_data[:max_rivers * 4], dtype=np.float32)))


# ── SPECIATION DETECTION ──────────────────────────────────────────────────────

SPECIATION_THRESHOLD = 0.3   # trait divergence between subpopulations
SPECIATION_GENS_REQUIRED = 100  # consecutive gens above threshold

def _check_speciation():
    """
    Detect speciation via spatial trait divergence.
    Split tiles into two groups by geography (above/below median row),
    compare mean species-specific trait between groups.
    If divergence > threshold for > N gens → speciation.

    This mirrors how real biologists detect speciation: measuring FST
    (fixation index) between spatially separated populations.
    """
    mid = GRID_SIZE // 2
    for s in range(NUM_SPECIES):
        if speciation_detected[s] or not species_alive[s]:
            continue

        # Split into north/south subpopulations
        north_sum, north_pop = 0.0, 0
        south_sum, south_pop = 0.0, 0
        for r in range(GRID_SIZE):
            for c in range(GRID_SIZE):
                p = int(pops[r, c, s])
                if p <= 0:
                    continue
                t = traits[r, c, s, T_SPECIFIC]
                if r < mid:
                    north_sum += t * p
                    north_pop += p
                else:
                    south_sum += t * p
                    south_pop += p

        if north_pop < 10 or south_pop < 10:
            speciation_gens[s] = 0
            continue

        north_mean = north_sum / north_pop
        south_mean = south_sum / south_pop
        divergence = abs(north_mean - south_mean)

        if divergence > SPECIATION_THRESHOLD:
            speciation_gens[s] += 1
            if speciation_gens[s] >= SPECIATION_GENS_REQUIRED:
                speciation_detected[s] = True
                events_buffer.append({'gen': generation, 'type': 'speciation',
                    'text': f'Gen {generation}. Speciation confirmed in {SPECIES_FULL[s]}. '
                            f'Northern and southern populations have diverged beyond recognition. '
                            f'Trait divergence: {divergence:.3f}. '
                            f'Two distinct forms now exist.'})
        else:
            speciation_gens[s] = max(0, speciation_gens[s] - 1)


# ── EXTINCTION DETECTION ─────────────────────────────────────────────────────

def _check_extinction():
    """
    Detect when a species reaches zero total population.
    Determine cause of death by analyzing recent population history.
    """
    for s in range(NUM_SPECIES):
        if not species_alive[s]:
            continue

        total = int(np.sum(pops[:, :, s]))

        # Track peak and last-seen
        if total > peak_pops[s]:
            peak_pops[s] = total
        if total > 0:
            # Find a tile where they exist (for last_seen_tile)
            for r in range(GRID_SIZE):
                for c in range(GRID_SIZE):
                    if pops[r, c, s] > 0:
                        last_seen_tile[s] = (r, c)

        # Rolling pop history
        pop_history_window[s][generation % 100] = total

        if total == 0:
            species_alive[s] = False
            cause = _determine_cause(s)
            lr, lc = last_seen_tile[s]
            ext = {
                'species': s,
                'gen': generation,
                'peak_pop': peak_pops[s],
                'gens_survived': generation - first_seen_gen[s],
                'cause': cause,
                'last_tile': [lr, lc],
            }
            extinctions.append(ext)
            events_buffer.append({'gen': generation, 'type': 'extinction',
                'text': f'Gen {generation}. {SPECIES_FULL[s]} — extinct. '
                        f'Peak population: {peak_pops[s]}. Survived {ext["gens_survived"]} generations. '
                        f'Cause: {cause}. Last seen at ({lr},{lc}).',
                'data': ext})


def _determine_cause(s):
    """
    Analyze recent history to determine likely cause of extinction.
    Looks at what was happening in the ecosystem when the decline began.
    """
    # Check predation pressure — were predators high while this species declined?
    for pred, prey, _, _ in PREDATION:
        if prey == s:
            pred_total = int(np.sum(pops[:, :, pred]))
            if pred_total > 50:
                return 'predation'

    # Check if disease was active targeting this species
    for evt in active_events:
        if evt['type'] == 'disease' and evt.get('species') == s:
            return 'disease'

    # Check vegetation (habitat quality)
    mean_veg = float(np.mean(vegetation))
    if mean_veg < 0.2 and s in (CRAWLER, VELOTHRIX):
        return 'habitat_loss'

    # Check if competitor populations are high
    for sa, sb, _ in COMPETITION:
        competitor = sb if sa == s else (sa if sb == s else None)
        if competitor is not None:
            comp_total = int(np.sum(pops[:, :, competitor]))
            if comp_total > 200:
                return 'competition'

    # Small population for a long time → drift
    recent = pop_history_window[s]
    if max(recent) < 30:
        return 'genetic_drift'

    return 'unknown'


# ── EPOCH CLASSIFICATION ─────────────────────────────────────────────────────

def _classify_epoch():
    """
    Determine the current epoch based on ecosystem state.
    Priority order: most dramatic state wins.
    """
    global current_epoch, epoch_since

    alive_count = sum(1 for a in species_alive if a)
    total_pop = sum(int(np.sum(pops[:, :, s])) for s in range(NUM_SPECIES))
    any_speciation = any(speciation_detected)

    # Priority order
    if alive_count <= 1:
        new = 'last_stand'
    elif alive_count <= 3:
        new = 'twilight'
    elif _has_active_event('drought'):
        new = 'drought'
    elif any(int(np.sum(pops[:, :, LEVIATHAN])) > total_pop * 0.4 for _ in [0] if total_pop > 0):
        new = 'predator_reign'
    elif any_speciation:
        new = 'divergence'
    elif generation < 50:
        new = 'the_quiet'
    elif total_pop > 0:
        # Check if populations are stable (low variance over 100 gens)
        # Simplified: if all 5 alive and gen > 500
        if alive_count == 5 and generation > 500:
            new = 'equilibrium'
        else:
            new = 'expansion'
    else:
        new = 'the_quiet'

    if new != current_epoch:
        old_name = EPOCH_NAMES.get(current_epoch, current_epoch)
        new_name = EPOCH_NAMES.get(new, new)
        events_buffer.append({'gen': generation, 'type': 'epoch',
            'text': f'Gen {generation}. A new era begins: {new_name}.'})
        current_epoch = new
        epoch_since = generation


# ── TECTONIC PLATES & VOLCANISM ────────────────────────────────────────────────
# Plates drift slowly, accumulate stress at boundaries, and release
# stress through volcanic events that transform terrain.
# See evolution-simulation-research.md §12.9-12.10

TECTONIC_TICK = max(200, 100 * GRID_SIZE // 8)  # ~400 at 32, ~800 at 64
VOLCANIC_PROB = 0.002     # per-gen chance of eruption when stress is high
PLATE_COUNT = max(3, GRID_SIZE // 16)  # 3 at 32, 4 at 64, 8 at 128

tectonic_plates = []  # list of {id, tiles: [(r,c),...], drift: (dr,dc), stress: float}


def _init_tectonics():
    """Assign tiles to tectonic plates via random seed points + flood fill."""
    global tectonic_plates
    tectonic_plates = []

    # Seed points
    seeds = []
    for i in range(PLATE_COUNT):
        sr = random.randint(1, GRID_SIZE - 2)
        sc = random.randint(1, GRID_SIZE - 2)
        seeds.append((sr, sc))

    # Assign each tile to nearest seed (Voronoi)
    plate_tiles = [[] for _ in range(PLATE_COUNT)]
    for r in range(GRID_SIZE):
        for c in range(GRID_SIZE):
            min_dist = 999
            closest = 0
            for i, (sr, sc) in enumerate(seeds):
                d = abs(r - sr) + abs(c - sc)
                if d < min_dist:
                    min_dist = d
                    closest = i
            plate_tiles[closest].append((r, c))

    # Random drift directions
    drifts = [(0, 0)] * PLATE_COUNT
    for i in range(PLATE_COUNT):
        drifts[i] = random.choice([(-1,0),(1,0),(0,-1),(0,1),(0,0)])

    for i in range(PLATE_COUNT):
        tectonic_plates.append({
            'id': i,
            'tiles': plate_tiles[i],
            'tile_set': set(plate_tiles[i]),
            'drift': drifts[i],
            'stress': 0.0,
        })


def _get_plate_boundaries():
    """Find tiles at plate boundaries (adjacent to a different plate's tile)."""
    boundaries = []
    plate_map = {}
    for plate in tectonic_plates:
        for r, c in plate['tiles']:
            plate_map[(r, c)] = plate['id']

    for r in range(GRID_SIZE):
        for c in range(GRID_SIZE):
            pid = plate_map.get((r, c), -1)
            for dr, dc in [(-1,0),(1,0),(0,-1),(0,1)]:
                nr, nc = r+dr, c+dc
                if 0 <= nr < GRID_SIZE and 0 <= nc < GRID_SIZE:
                    npid = plate_map.get((nr, nc), -1)
                    if npid != pid and npid >= 0:
                        boundaries.append((r, c, pid))
                        break
    return boundaries


def _update_tectonics():
    """Update tectonic stress and check for volcanic events."""
    if generation % TECTONIC_TICK != 0 or generation == 0:
        return

    boundaries = _get_plate_boundaries()

    # Accumulate stress at boundaries
    for plate in tectonic_plates:
        boundary_count = sum(1 for _, _, pid in boundaries if pid == plate['id'])
        if plate['drift'] != (0, 0):
            plate['stress'] += 0.1 * (1 + boundary_count * 0.05)
        else:
            plate['stress'] = max(0, plate['stress'] - 0.05)

    # Boundary uplift — slow elevation increase at convergent boundaries
    for r, c, pid in boundaries:
        plate = tectonic_plates[pid]
        if plate['stress'] > 0.5:
            elevations[r, c] = min(1.0, elevations[r, c] + 0.01 * plate['stress'])

    # Check for volcanic eruption
    for plate in tectonic_plates:
        if plate['stress'] > 2.0 and random.random() < VOLCANIC_PROB * plate['stress']:
            _volcanic_eruption(plate)
            plate['stress'] *= 0.3  # release stress


def _volcanic_eruption(plate):
    """
    Volcanic event at a random boundary tile.
    Instant terrain transform: elevation spike, temperature spike, food crash.
    See evolution-simulation-research.md §12.9
    """
    boundaries = _get_plate_boundaries()
    plate_boundaries = [(r, c) for r, c, pid in boundaries if pid == plate['id']]
    if not plate_boundaries:
        return

    vr, vc = random.choice(plate_boundaries)

    # Elevation spike at epicenter
    elevations[vr, vc] = min(1.0, elevations[vr, vc] + 0.3)
    biomes[vr, vc] = BIOME_ROCKY_SHORE

    # Radius of effect (2 tiles)
    for dr in range(-2, 3):
        for dc in range(-2, 3):
            nr, nc = vr + dr, vc + dc
            if 0 <= nr < GRID_SIZE and 0 <= nc < GRID_SIZE:
                dist = abs(dr) + abs(dc)
                if dist == 0:
                    continue
                # Elevation boost decreases with distance
                boost = 0.15 / dist
                elevations[nr, nc] = min(1.0, elevations[nr, nc] + boost)
                # Vegetation destruction
                vegetation[nr, nc] *= max(0, 1 - 0.8 / dist)
                # Population damage (heat/ash)
                for s in range(NUM_SPECIES):
                    damage = 0.4 / dist
                    pop = int(pops[nr, nc, s])
                    pops[nr, nc, s] = max(0, int(pop * (1 - damage)))

    # Set volcanic tile flag (bit 1)
    tile_flags[vr, vc] |= 2

    # Reclassify biomes after terrain change
    _assign_biomes()

    events_buffer.append({'gen': generation, 'type': 'volcanic',
        'text': f'Gen {generation}. Eruption at ({vr},{vc})! '
                f'The earth splits. Ash rains. Elevation spikes. '
                f'Life within two tiles is devastated.'})


# ── BUFFER SYNC ───────────────────────────────────────────────────────────────

def _sync_to_buffer():
    """
    Write Python-owned state into JS typed arrays on the SharedArrayBuffer.
    This is the ONLY place Python writes to JS memory.
    Called once at the end of each step_simulation() batch.

    Uses Pyodide's JsProxy.assign() or element-by-element as fallback.
    Each typed array write goes directly to SharedArrayBuffer memory.
    """
    from js import _js_globals, _js_elevations, _js_biomes, _js_vegetation
    from js import _js_populations, _js_trait_means, _js_trait_var, _js_tile_flags
    from pyodide.ffi import to_js

    # Globals (small — element access is fine)
    _js_globals[0] = float(generation)
    _js_globals[1] = _season()
    _js_globals[2] = float(list(EPOCH_NAMES.keys()).index(current_epoch))  # epoch_id
    for s in range(NUM_SPECIES):
        _js_globals[6 + s] = float(np.sum(pops[:, :, s]))
    _js_globals[12] = float(total_deaths_last)
    _js_globals[13] = float(np.mean(vegetation))

    # Grid data — use .set() with a JS typed array created from numpy
    # to_js converts numpy arrays to JS typed arrays efficiently
    _js_elevations.set(to_js(elevations.ravel()))
    _js_biomes.set(to_js(biomes.ravel()))
    _js_vegetation.set(to_js(vegetation.ravel()))
    _js_populations.set(to_js(pops.ravel().astype(np.uint16)))
    _js_trait_means.set(to_js(traits.ravel()))
    _js_trait_var.set(to_js(trait_var.ravel()))
    _js_tile_flags.set(to_js(tile_flags.ravel()))


# ── PUBLIC API ────────────────────────────────────────────────────────────────

def init_simulation():
    global generation
    generation = 0
    _generate_terrain(str(_seed))
    _init_populations()
    _init_tectonics()
    _sync_to_buffer()
    _sync_rivers_to_buffer()


def step_simulation(n=1):
    global generation, total_deaths_last
    for _ in range(n):
        generation += 1
        season = _season()
        td = 0
        for r in range(GRID_SIZE):
            for c in range(GRID_SIZE):
                td += _step_growth(r, c, season)
                td += _step_predation(r, c)
                td += _step_competition(r, c)
                _step_vegetation(r, c, season)
                _step_traits(r, c)
        total_deaths_last = td

        # Environmental events
        _check_events(season)
        _apply_active_events(season)

        # Migration frequency scales with LOD and grid size
        if lod_level == 0:
            _step_migration()
        else:
            # Simplified: migrate less often on larger grids
            interval = max(2, G2 // 500)
            if generation % interval == 0:
                _step_migration()

        # Terrain dynamics
        if generation % 10 == 0:  # erosion every 10 gens (slow process)
            _apply_erosion()

        # Geological processes
        _spawn_river()
        _step_rivers()
        _update_tectonics()

        # Detection systems
        _check_extinction()
        if generation % 10 == 0:  # check speciation every 10 gens (expensive)
            _check_speciation()
        if generation % 20 == 0:  # epoch classification
            _classify_epoch()

    _sync_to_buffer()
    _sync_rivers_to_buffer()


def flush_events():
    global events_buffer
    out = json.dumps(events_buffer)
    events_buffer = []
    return out


def set_lod(level):
    global lod_level
    lod_level = level


def get_save_state():
    """Serialize full simulation state to JSON for localStorage save."""
    state = {
        'version': 1,
        'generation': generation,
        'grid_size': GRID_SIZE,
        'seed': str(_seed),
        'lod_level': lod_level,
        'elevations': elevations.ravel().tolist(),
        'biomes': biomes.ravel().tolist(),
        'vegetation': vegetation.ravel().tolist(),
        'populations': pops.ravel().tolist(),
        'traits': traits.ravel().tolist(),
        'trait_var': trait_var.ravel().tolist(),
        'tile_flags': tile_flags.ravel().tolist(),
        'species_alive': species_alive,
        'peak_pops': peak_pops,
        'speciation_detected': speciation_detected,
        'current_epoch': current_epoch,
        'epoch_since': epoch_since,
        'extinctions': extinctions,
        'rivers': [{'id': r['id'], 'path': r['path'], 'age': r['age'],
                     'width': r['width'], 'active': r['active']} for r in rivers],
        'tectonic_plates': [{'id': p['id'], 'tiles': p['tiles'], 'drift': p['drift'],
                              'stress': p['stress']} for p in tectonic_plates],
    }
    return json.dumps(state)


def load_save_state(state_json):
    """Restore simulation state from JSON."""
    global generation, lod_level, species_alive, peak_pops
    global speciation_detected, speciation_gens, current_epoch, epoch_since
    global extinctions, rivers, _next_river_id, first_seen_gen

    state = json.loads(state_json)
    if state.get('version') != 1:
        return

    generation = state['generation']
    lod_level = state.get('lod_level', 0)

    elevations[:] = np.array(state['elevations'], dtype=np.float32).reshape(GRID_SIZE, GRID_SIZE)
    biomes[:] = np.array(state['biomes'], dtype=np.uint8).reshape(GRID_SIZE, GRID_SIZE)
    vegetation[:] = np.array(state['vegetation'], dtype=np.float32).reshape(GRID_SIZE, GRID_SIZE)
    pops[:] = np.array(state['populations'], dtype=np.uint16).reshape(GRID_SIZE, GRID_SIZE, NUM_SPECIES)
    traits[:] = np.array(state['traits'], dtype=np.float32).reshape(GRID_SIZE, GRID_SIZE, NUM_SPECIES, NUM_TRAITS)
    trait_var[:] = np.array(state['trait_var'], dtype=np.float32).reshape(GRID_SIZE, GRID_SIZE, NUM_SPECIES, NUM_TRAITS)
    tile_flags[:] = np.array(state['tile_flags'], dtype=np.uint8).reshape(GRID_SIZE, GRID_SIZE)

    species_alive = state.get('species_alive', [True] * NUM_SPECIES)
    peak_pops = state.get('peak_pops', [0] * NUM_SPECIES)
    speciation_detected = state.get('speciation_detected', [False] * NUM_SPECIES)
    speciation_gens = [0] * NUM_SPECIES
    current_epoch = state.get('current_epoch', 'the_quiet')
    epoch_since = state.get('epoch_since', 0)
    extinctions = state.get('extinctions', [])
    first_seen_gen = [0] * NUM_SPECIES

    # Restore rivers
    rivers.clear()
    for rd in state.get('rivers', []):
        rivers.append({
            'id': rd['id'],
            'path': [tuple(p) for p in rd['path']],
            'path_set': {tuple(p) for p in rd['path']},
            'age': rd['age'],
            'width': rd['width'],
            'active': rd['active'],
            'stall_gens': 0,
        })
    _next_river_id = max((r['id'] for r in rivers), default=-1) + 1

    # Restore tectonic plates
    tectonic_plates.clear()
    for pd in state.get('tectonic_plates', []):
        tectonic_plates.append({
            'id': pd['id'],
            'tiles': [tuple(t) for t in pd['tiles']],
            'tile_set': {tuple(t) for t in pd['tiles']},
            'drift': tuple(pd['drift']),
            'stress': pd['stress'],
        })
    if not tectonic_plates:
        _init_tectonics()

    _build_river_barrier_cache()
    _sync_to_buffer()
    _sync_rivers_to_buffer()
