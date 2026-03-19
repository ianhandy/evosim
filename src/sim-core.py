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
        if lod_level == 0:
            _step_migration()
        elif generation % 5 == 0:
            _step_migration()
    _sync_to_buffer()


def flush_events():
    global events_buffer
    out = json.dumps(events_buffer)
    events_buffer = []
    return out


def set_lod(level):
    global lod_level
    lod_level = level
