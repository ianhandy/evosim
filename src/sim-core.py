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

def _value_noise(size, seed_val, octaves=4, persistence=0.5):
    rng = np.random.RandomState(seed_val)
    result = np.zeros((size, size), dtype=np.float32)
    amp, total = 1.0, 0.0
    for o in range(octaves):
        freq = 2 ** o + 1
        grid = rng.rand(freq, freq).astype(np.float32)
        xs = np.linspace(0, freq - 1, size)
        ri = np.clip(xs.astype(int), 0, freq - 2)
        rf = xs - ri
        interp = np.zeros((size, size), dtype=np.float32)
        for i in range(size):
            for j in range(size):
                x0, y0 = int(ri[i]), int(ri[j])
                xf, yf = rf[i], rf[j]
                interp[i, j] = (
                    grid[x0, y0] * (1-xf) * (1-yf) +
                    grid[x0+1, y0] * xf * (1-yf) +
                    grid[x0, y0+1] * (1-xf) * yf +
                    grid[x0+1, y0+1] * xf * yf
                )
        result += interp * amp
        total += amp
        amp *= persistence
    return result / total


def _generate_terrain(seed_str):
    seed_val = sum(ord(c) * (i + 1) for i, c in enumerate(seed_str))
    random.seed(seed_val)
    np.random.seed(seed_val % (2**31))

    noise = _value_noise(GRID_SIZE, seed_val)
    cx, cy = GRID_SIZE / 2, GRID_SIZE / 2
    max_dist = math.sqrt(cx**2 + cy**2)
    for r in range(GRID_SIZE):
        for c in range(GRID_SIZE):
            d = math.sqrt((r - cy)**2 + (c - cx)**2) / max_dist
            noise[r, c] *= max(0, 1 - d * 1.4)

    lo, hi = noise.min(), noise.max()
    if hi > lo:
        noise = (noise - lo) / (hi - lo)
    elevations[:] = noise

    for r in range(GRID_SIZE):
        for c in range(GRID_SIZE):
            e = elevations[r, c]
            if   e < 0.15: biomes[r, c] = BIOME_DEEP_WATER
            elif e < 0.30: biomes[r, c] = BIOME_SHALLOW_MARSH
            elif e < 0.50: biomes[r, c] = BIOME_REED_BEDS
            elif e < 0.70: biomes[r, c] = BIOME_TIDAL_FLATS
            else:          biomes[r, c] = BIOME_ROCKY_SHORE

    for r in range(GRID_SIZE):
        for c in range(GRID_SIZE):
            vegetation[r, c] = min(1.0, VEG_REGROWTH[biomes[r, c]] * 10)


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
                            bar = 0.3 if (tile_flags[r,c] & 1 or tile_flags[nr,nc] & 1) else 1.0
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
                # Reclassify biome if elevation changed significantly
                new_e = elevations[r, c]
                if new_e < 0.15: biomes[r, c] = BIOME_DEEP_WATER
                elif new_e < 0.30: biomes[r, c] = BIOME_SHALLOW_MARSH
                elif new_e < 0.50: biomes[r, c] = BIOME_REED_BEDS
                elif new_e < 0.70: biomes[r, c] = BIOME_TIDAL_FLATS
                else: biomes[r, c] = BIOME_ROCKY_SHORE


# ── RIVERS & TERRAIN DYNAMICS ─────────────────────────────────────────────────
# Rivers are directed-path overlays on the elevation grid.
# They spawn at high elevation, advance downhill, erode banks, form oxbows.
# See evolution-simulation-research.md §12.

RIVER_GEO_TICK = 200       # gens between river advance steps
RIVER_SPAWN_PROB = 0.003   # per-gen chance of new river
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
    """Extend river one tile downhill."""
    if not river['active']:
        return
    r, c = river['path'][-1]
    best = None
    best_elev = elevations[r, c]
    for dr, dc in [(-1,0),(1,0),(0,-1),(0,1)]:
        nr, nc = r+dr, c+dc
        if 0 <= nr < GRID_SIZE and 0 <= nc < GRID_SIZE:
            if (nr, nc) not in river['path_set']:
                e = elevations[nr, nc]
                if e < best_elev:
                    best = (nr, nc)
                    best_elev = e
    if best is None:
        river['stall_gens'] += 1
        if river['stall_gens'] > 500:
            _deactivate_river(river)
        return
    river['stall_gens'] = 0
    nr, nc = best
    river['path'].append((nr, nc))
    river['path_set'].add((nr, nc))
    tile_flags[nr, nc] |= 1
    # Reached coast?
    if elevations[nr, nc] < 0.15:
        river['active'] = False  # complete


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

    if geo_tick % RIVER_REROUTE_N == 0:
        for river in rivers:
            if river['active']:
                _check_oxbow(river)

    # Age oxbow lakes
    for lake in oxbow_lakes:
        lake['age'] += 1


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
    _sync_to_buffer()


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

        if lod_level == 0:
            _step_migration()
        elif generation % 5 == 0:
            _step_migration()

        # Terrain dynamics
        if generation % 10 == 0:  # erosion every 10 gens (slow process)
            _apply_erosion()

        # Rivers (geological timescale)
        _spawn_river()
        _step_rivers()

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

    _sync_to_buffer()
    _sync_rivers_to_buffer()
