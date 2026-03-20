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

    Generates on an oversized canvas (2× GRID_SIZE) so geology can spread
    freely. After the sim, applies a smooth radial falloff centered on the
    land mass that tapers elevation into ocean — no hard crop boundaries.
    The result is resampled down to GRID_SIZE.

    1. Start with flat ocean floor (negative elevation + noise)
    2. Place hotspot mantle plumes clustered along fault lines
    3. Simulate N epochs of geological time:
       a. Each hotspot erupts: deposits elevation with squared falloff
       b. Plate drift: builds trail of decreasing deposits behind hotspot
       c. Erosion: flat subtraction + weighted blur smoothing
    4. Snapshot at a random epoch for terrain diversity
    5. Crop to land bounding box + ocean padding, resample to GRID_SIZE
    """
    from scipy.ndimage import gaussian_filter, zoom

    seed_val = sum(ord(c) * (i + 1) for i, c in enumerate(seed_str))
    random.seed(seed_val)
    np.random.seed(seed_val % (2**31))
    rng = np.random.RandomState(seed_val)

    gs = GRID_SIZE
    # Work on an oversized canvas so land can grow freely in any direction
    igs = gs * 2  # internal generation size

    # ── Ocean floor baseline: very shallow, most will become land ──
    grid = rng.uniform(-0.06, -0.01, (igs, igs)).astype(np.float32)
    floor_noise = rng.rand(igs, igs).astype(np.float32)
    floor_noise = gaussian_filter(floor_noise, sigma=igs * 0.12, mode='wrap')
    fn_lo, fn_hi = floor_noise.min(), floor_noise.max()
    if fn_hi > fn_lo:
        floor_noise = (floor_noise - fn_lo) / (fn_hi - fn_lo)
    grid += (floor_noise - 0.5) * 0.06

    # ── Plate drift ──
    drift_angle = rng.uniform(0, 2 * math.pi)
    drift_dx = math.cos(drift_angle)
    drift_dy = math.sin(drift_angle)
    drift_speed = rng.uniform(0.3, 0.6)

    # ── Tectonic fault lines — hotspots cluster along 1-3 plate boundaries ──
    num_faults = rng.randint(1, 4)
    faults = []
    for _ in range(num_faults):
        fx = rng.uniform(igs * 0.2, igs * 0.8)
        fy = rng.uniform(igs * 0.2, igs * 0.8)
        fangle = rng.uniform(0, math.pi)
        faults.append((fx, fy, math.cos(fangle), math.sin(fangle)))

    # ── Hotspots: clustered near fault lines ──
    num_hotspots = max(6, igs // 5)
    hotspots = []
    for i in range(num_hotspots):
        if rng.random() < 0.8 and faults:
            fault = faults[rng.randint(0, len(faults))]
            fx, fy, fdx, fdy = fault
            t = rng.uniform(-igs * 0.4, igs * 0.4)
            perp = rng.uniform(-igs * 0.06, igs * 0.06)
            hx = fx + fdx * t + fdy * perp
            hy = fy + fdy * t - fdx * perp
        else:
            hx = rng.uniform(igs * 0.1, igs * 0.9)
            hy = rng.uniform(igs * 0.1, igs * 0.9)

        hx = max(1, min(igs - 2, hx))
        hy = max(1, min(igs - 2, hy))
        power = rng.uniform(0.10, 0.22)
        radius = rng.uniform(igs * 0.06, igs * 0.18)
        hotspots.append({'x': hx, 'y': hy, 'power': power, 'radius': radius})

    # ── Fault ridge uplift ──
    rows_grid, cols_grid = np.meshgrid(np.arange(igs), np.arange(igs), indexing='ij')
    for fault in faults:
        fx, fy, fdx, fdy = fault
        ridge_width = igs * rng.uniform(0.03, 0.07)
        ridge_power = rng.uniform(0.03, 0.08)
        dx = rows_grid - fx
        dy = cols_grid - fy
        perp = np.abs(dx * fdy - dy * fdx)
        mask = perp < ridge_width
        t = 1 - perp / ridge_width
        grid[mask] += ridge_power * (t[mask] ** 2)

    # ── Simulate geological epochs ──
    num_epochs = rng.randint(80, 200)
    snapshot_epoch = rng.randint(int(num_epochs * 0.6), num_epochs)

    # Pre-build distance grids for each hotspot
    hs_masks = []
    for hs in hotspots:
        cx, cy = int(hs['x']), int(hs['y'])
        max_r = int(hs['radius'] * 1.3) + 2
        r_lo, r_hi = max(0, cx - max_r), min(igs, cx + max_r + 1)
        c_lo, c_hi = max(0, cy - max_r), min(igs, cy + max_r + 1)
        local_rows = np.arange(r_lo, r_hi)[:, None]
        local_cols = np.arange(c_lo, c_hi)[None, :]
        dist = np.sqrt((local_rows - cx) ** 2 + (local_cols - cy) ** 2).astype(np.float32)
        hs_masks.append((r_lo, r_hi, c_lo, c_hi, dist))

    for epoch in range(num_epochs):
        # ── Eruptions from each hotspot (vectorized) ──
        for idx, hs in enumerate(hotspots):
            if rng.random() < 0.7:
                erupt_power = hs['power'] * rng.uniform(0.6, 1.4)
                erupt_radius = hs['radius'] * rng.uniform(0.7, 1.3)
                r_lo, r_hi, c_lo, c_hi, dist = hs_masks[idx]
                in_range = dist < erupt_radius
                t = 1 - dist / erupt_radius
                grid[r_lo:r_hi, c_lo:c_hi] += np.where(in_range, erupt_power * t * t, 0)

            # ── Island chain trail ──
            trail_len = int(epoch * drift_speed * 0.6)
            if trail_len > 1:
                trail_r = max(2, int(hs['radius'] * 0.6))
                steps = np.arange(1, min(trail_len, igs))
                trs = (hs['x'] - drift_dx * steps * 1.2).astype(int)
                tcs = (hs['y'] - drift_dy * steps * 1.2).astype(int)
                valid = (trs >= trail_r) & (trs < igs - trail_r) & (tcs >= trail_r) & (tcs < igs - trail_r)
                # Pre-build trail kernel once
                if epoch == 0 or not hasattr(_generate_terrain, '_trail_kernel') or _generate_terrain._trail_r != trail_r:
                    kr = np.arange(-trail_r, trail_r + 1)
                    kc = np.arange(-trail_r, trail_r + 1)
                    kd = np.sqrt(kr[:, None] ** 2 + kc[None, :] ** 2).astype(np.float32)
                    k_mask = kd < trail_r
                    k_falloff = np.where(k_mask, (1 - kd / trail_r) ** 2, 0).astype(np.float32)
                    _generate_terrain._trail_kernel = k_falloff
                    _generate_terrain._trail_r = trail_r
                k_falloff = _generate_terrain._trail_kernel
                for si in range(len(steps)):
                    if not valid[si]:
                        continue
                    tr, tc = int(trs[si]), int(tcs[si])
                    strength = hs['power'] * 0.5 / (1 + steps[si] * 0.1) * 0.15
                    noise = rng.uniform(0.6, 1.0)
                    grid[tr - trail_r:tr + trail_r + 1, tc - trail_r:tc + trail_r + 1] += k_falloff * (strength * noise)

        # ── Erosion (vectorized) ──
        land = grid > 0
        rates = np.where(grid > 0.85, 0.008, 0.002)
        grid[land] -= rates[land]

        # ── Smoothing ──
        blurred = gaussian_filter(grid, sigma=0.6, mode='nearest')
        grid = grid * 0.85 + blurred * 0.15

        # ── Save snapshot ──
        if epoch == snapshot_epoch:
            snapshot = grid.copy()

    # Use the snapshot (or final state if snapshot wasn't reached)
    if 'snapshot' in dir():
        grid = snapshot

    # ── Radial falloff: smoothly taper land into ocean around the land mass ──
    # Find the land center of mass and max extent, then apply a smooth
    # multiplier that fades elevation to ocean beyond the land perimeter.
    # This creates natural coastlines with no hard boundaries.
    land_mask = grid > 0
    if np.any(land_mask):
        land_coords = np.argwhere(land_mask)
        # Elevation-weighted center of mass
        weights_flat = grid[land_mask]
        total_weight = weights_flat.sum()
        cm_r = (land_coords[:, 0] * weights_flat).sum() / total_weight
        cm_c = (land_coords[:, 1] * weights_flat).sum() / total_weight

        # Max distance from center to any land tile
        dists = np.sqrt((land_coords[:, 0] - cm_r) ** 2 +
                        (land_coords[:, 1] - cm_c) ** 2)
        max_land_dist = dists.max()

        # Falloff starts just beyond the land edge, reaches full ocean
        # at inner_r + fade_width. This means all land is preserved (multiplier=1)
        # and terrain smoothly transitions to ocean beyond.
        inner_r = max_land_dist * 1.05  # small buffer past furthest land
        fade_width = max_land_dist * 0.3  # smooth transition zone

        rows_v = np.arange(igs)[:, None]
        cols_v = np.arange(igs)[None, :]
        dist_from_cm = np.sqrt((rows_v - cm_r) ** 2 + (cols_v - cm_c) ** 2)

        # Smoothstep: 1.0 inside inner_r, fades to 0.0 at inner_r + fade_width
        t = np.clip((dist_from_cm - inner_r) / max(1, fade_width), 0, 1)
        falloff = 1 - t * t * (3 - 2 * t)  # smoothstep

        # Apply: multiply positive elevation by falloff, push falloff=0 regions
        # to negative (ocean). Existing ocean stays ocean.
        grid = np.where(grid > 0, grid * falloff, grid)
        # Also push the transition zone below sea level where falloff is low
        grid -= (1 - falloff) * 0.08

    # ── Crop centered on land mass + resample to GRID_SIZE ──
    # Use the land center of mass (already computed) as crop center.
    # Size the crop so land fills roughly 60-70% of the final grid,
    # leaving natural ocean around the edges from the radial falloff.
    land_coords_crop = np.argwhere(grid > 0)
    if len(land_coords_crop) > 0:
        lr_min, lc_min = land_coords_crop.min(axis=0)
        lr_max, lc_max = land_coords_crop.max(axis=0)
        land_extent = max(lr_max - lr_min + 1, lc_max - lc_min + 1)
        # Target: land occupies ~65% of the crop → crop = land / 0.65
        crop_size = int(land_extent / 0.65)
        crop_size = max(crop_size, gs)  # never smaller than output
        # Center on land center of mass
        r_center = (lr_min + lr_max) // 2
        c_center = (lc_min + lc_max) // 2
    else:
        crop_size = igs
        r_center = igs // 2
        c_center = igs // 2

    # Position crop window, clamped to canvas
    half = crop_size // 2
    crop_r0 = max(0, min(igs - crop_size, r_center - half))
    crop_c0 = max(0, min(igs - crop_size, c_center - half))
    crop_r1 = min(igs, crop_r0 + crop_size)
    crop_c1 = min(igs, crop_c0 + crop_size)
    cropped = grid[crop_r0:crop_r1, crop_c0:crop_c1]

    # Resample to GRID_SIZE
    actual_h, actual_w = cropped.shape
    if actual_h != gs or actual_w != gs:
        zoom_r = gs / actual_h
        zoom_c = gs / actual_w
        grid = zoom(cropped, (zoom_r, zoom_c), order=1, mode='nearest').astype(np.float32)
        # Force exact size
        if grid.shape[0] != gs or grid.shape[1] != gs:
            final = np.full((gs, gs), grid.min(), dtype=np.float32)
            cr = min(gs, grid.shape[0])
            cc = min(gs, grid.shape[1])
            final[:cr, :cc] = grid[:cr, :cc]
            grid = final
    else:
        grid = cropped.copy()

    # ── Detail noise pass — multi-octave for natural terrain texture ──
    # Fine detail: ridges, gullies, surface roughness
    detail = rng.rand(gs, gs).astype(np.float32)
    detail = gaussian_filter(detail, sigma=gs * 0.015, mode='wrap')
    detail_lo, detail_hi = detail.min(), detail.max()
    if detail_hi > detail_lo:
        detail = (detail - detail_lo) / (detail_hi - detail_lo)

    # Medium: rolling hills and valleys
    medium = rng.rand(gs, gs).astype(np.float32)
    medium = gaussian_filter(medium, sigma=gs * 0.05, mode='wrap')
    med_lo, med_hi = medium.min(), medium.max()
    if med_hi > med_lo:
        medium = (medium - med_lo) / (med_hi - med_lo)

    # Coarse: broad elevation undulation
    coarse = rng.rand(gs, gs).astype(np.float32)
    coarse = gaussian_filter(coarse, sigma=gs * 0.12, mode='wrap')
    co_lo, co_hi = coarse.min(), coarse.max()
    if co_hi > co_lo:
        coarse = (coarse - co_lo) / (co_hi - co_lo)

    # Blend — land gets all three octaves, ocean gets subtle fine detail
    land_shallow = grid > -0.05
    grid += np.where(land_shallow,
        (detail - 0.5) * 0.08 + (medium - 0.5) * 0.06 + (coarse - 0.5) * 0.04,
        (detail - 0.5) * 0.02)

    # ── Volcanoes — sharp conical peaks on the highest terrain ──
    # Find the top N elevation tiles and place steep volcanic cones there.
    # These are the geological hotspots that built the island — their peaks
    # should visibly rise above the surrounding terrain.
    land_elev = np.where(grid > 0, grid, 0)
    if land_elev.max() > 0:
        # Number of volcanoes scales with grid size
        num_volcanoes = max(2, gs // 12)
        # Find peak candidates — local maxima above 70th percentile of land
        land_vals = grid[grid > 0]
        if len(land_vals) > 0:
            threshold = np.percentile(land_vals, 70)
            peak_mask = grid > threshold
            peak_coords = np.argwhere(peak_mask)
            if len(peak_coords) > num_volcanoes:
                # Spread them out — pick peaks with maximum spacing
                chosen = [peak_coords[rng.randint(0, len(peak_coords))]]
                for _ in range(num_volcanoes - 1):
                    dists = np.array([
                        min(abs(p[0] - c[0]) + abs(p[1] - c[1]) for c in chosen)
                        for p in peak_coords
                    ])
                    chosen.append(peak_coords[np.argmax(dists)])
                peak_coords = np.array(chosen)

            rows_v = np.arange(gs)[:, None]
            cols_v = np.arange(gs)[None, :]
            for pr, pc in peak_coords[:num_volcanoes]:
                pr, pc = int(pr), int(pc)
                # Volcano radius and height scale with local elevation
                local_elev = grid[pr, pc]
                v_radius = rng.uniform(gs * 0.08, gs * 0.16)
                v_height = rng.uniform(0.08, 0.18) * (0.5 + local_elev)
                dist = np.sqrt((rows_v - pr) ** 2 + (cols_v - pc) ** 2).astype(np.float32)
                in_cone = dist < v_radius
                # Smooth bell-shaped profile (gentler than squared falloff)
                t = 1 - dist / v_radius
                cone = v_height * t * t * (3 - 2 * t)  # smoothstep profile
                # Slight caldera depression at the very peak
                caldera_r = v_radius * 0.2
                caldera_dip = np.where(dist < caldera_r,
                    v_height * 0.1 * (1 - dist / caldera_r), 0)
                grid += np.where(in_cone, cone - caldera_dip, 0)
                # Mark the summit tile as volcanic
                if 0 <= pr < gs and 0 <= pc < gs:
                    tile_flags[pr, pc] |= 2

    # ── Edge ramp — smoothly slope terrain into ocean near grid edges ──
    # Applied on raw grid (before normalization) so the terrain itself
    # gradually descends, creating natural coastlines at the border.
    edge_band = max(4, gs // 4)  # wide band: 8 tiles at 32, 16 at 64
    row_d = np.minimum(np.arange(gs), np.arange(gs - 1, -1, -1)).astype(np.float32)
    col_d = np.minimum(np.arange(gs), np.arange(gs - 1, -1, -1)).astype(np.float32)
    edge_dist = np.minimum(row_d[:, None], col_d[None, :])
    edge_t = np.clip(edge_dist / edge_band, 0, 1)
    # Smoothstep for natural ramp
    edge_factor = edge_t * edge_t * (3 - 2 * edge_t)
    # Blend raw elevation toward deep ocean floor at edges
    ocean_floor = grid.min()
    grid = grid * edge_factor + ocean_floor * (1 - edge_factor)

    # ── Map to elevation array ──
    lo, hi = grid.min(), grid.max()
    if hi <= lo:
        hi = lo + 1

    # Normalize to 0-1. Sea level is where the raw grid crosses 0.
    zero_norm = (0 - lo) / (hi - lo)

    # Map so that raw 0 (sea level) → 0.20 in our output
    raw_norm = (grid - lo) / (hi - lo)
    underwater = raw_norm <= zero_norm
    elevations[:] = np.where(underwater,
        (raw_norm / max(0.001, zero_norm)) * 0.20,
        0.20 + (raw_norm - zero_norm) / max(0.001, 1 - zero_norm) * 0.80)

    _assign_biomes()

    vegetation[:] = np.minimum(1.0, VEG_REGROWTH[biomes] * 10)


def _update_biomes_incremental():
    """
    Lightweight biome update — only handles clear-cut transitions.
    Preserves forest/beach assignments. Never re-randomizes.
    """
    SEA_LEVEL = 0.20
    gs = GRID_SIZE

    # Only submerge land tiles that are significantly below water AND
    # adjacent to existing water. Prevents inland forest from drowning
    # during temporary elevation dips (tidal surge, etc.)
    is_water = (biomes <= 1)
    padded = np.pad(is_water.astype(np.float32), 1, mode='constant', constant_values=1)
    water_adj = (padded[:-2, 1:-1] + padded[2:, 1:-1] +
                 padded[1:-1, :-2] + padded[1:-1, 2:]) > 0

    # Land tiles that sank well below water AND are next to water → submerge
    deep_sunk = (biomes >= 2) & (elevations < SEA_LEVEL - 0.02) & water_adj
    biomes[deep_sunk] = BIOME_SHALLOW_MARSH

    # Very deep stays deep
    biomes[elevations < 0.08] = BIOME_DEEP_WATER

    # Water tiles that rose above land → become beach
    rose = (biomes <= 1) & (elevations >= SEA_LEVEL)
    biomes[rose] = BIOME_TIDAL_FLATS

    # Volcanic summit tiles → rocky
    volcanic = (tile_flags & 2) > 0
    biomes[volcanic & (elevations >= SEA_LEVEL)] = BIOME_ROCKY_SHORE


def _assign_biomes():
    """
    Classify biomes via probabilistic BFS from coastline.

    Rules:
    - Underwater → deep water / shallow marsh
    - Coastal land → beach (mandatory first ring)
    - Inland: forest probability increases exponentially per tile from coast.
      Cliffs (high elevation gain) skip straight to forest.
      Once one forest tile rolls, next tile is 95% forest.
      Once two consecutive forest tiles roll, everything beyond is forest.
    - Very high elevation → rocky shore
    """
    from collections import deque

    gs = GRID_SIZE
    SEA_LEVEL = 0.20
    CLIFF_RISE = 0.10  # elevation gain that counts as a cliff → instant forest

    is_land = elevations >= SEA_LEVEL

    # Water: deep vs shallow
    base = np.where(elevations < 0.08, BIOME_DEEP_WATER,
                    BIOME_SHALLOW_MARSH).astype(np.uint8)

    # Default all land to forest
    base[is_land] = BIOME_REED_BEDS
    base[elevations >= 0.55] = BIOME_ROCKY_SHORE

    # Find coastal tiles (land adjacent to water, 8-neighbor)
    is_water = (~is_land).astype(np.float32)
    padded = np.pad(is_water, 1, mode='constant', constant_values=0)
    water_neighbors = (padded[:-2, 1:-1] + padded[2:, 1:-1] +
                       padded[1:-1, :-2] + padded[1:-1, 2:] +
                       padded[:-2, :-2] + padded[:-2, 2:] +
                       padded[2:, :-2] + padded[2:, 2:])

    # BFS from coastline with probabilistic forest transition
    visited = np.zeros((gs, gs), dtype=bool)
    coast_baseline = np.zeros((gs, gs), dtype=np.float32)
    forest_streak = np.zeros((gs, gs), dtype=np.int32)  # consecutive forest parents
    tile_depth = np.zeros((gs, gs), dtype=np.int32)      # distance from coast in tiles
    queue = deque()

    # Seed: all water-adjacent land tiles are beach (depth 0)
    coastal_mask = is_land & (water_neighbors > 0)
    for r, c in np.argwhere(coastal_mask):
        r, c = int(r), int(c)
        elev_here = float(elevations[r, c])
        rise = elev_here - SEA_LEVEL
        # Cliff exception: if first land tile is way above water, match forest
        if rise >= CLIFF_RISE:
            base[r, c] = BIOME_REED_BEDS
            forest_streak[r, c] = 1
        else:
            base[r, c] = BIOME_TIDAL_FLATS
        visited[r, c] = True
        coast_baseline[r, c] = elev_here
        tile_depth[r, c] = 0
        queue.append((r, c))

    # Use deterministic random for reproducibility (seeded by terrain seed)
    rng_biome = random.Random(int(np.sum(elevations * 1000)))

    dirs = [(-1,0),(1,0),(0,-1),(0,1),(-1,-1),(-1,1),(1,-1),(1,1)]
    while queue:
        r, c = queue.popleft()
        parent_streak = int(forest_streak[r, c])
        parent_depth = int(tile_depth[r, c])
        baseline = float(coast_baseline[r, c])

        for dr, dc in dirs:
            nr, nc = r + dr, c + dc
            if 0 <= nr < gs and 0 <= nc < gs and not visited[nr, nc] and is_land[nr, nc]:
                visited[nr, nc] = True
                n_elev = float(elevations[nr, nc])
                depth = parent_depth + 1
                tile_depth[nr, nc] = depth
                coast_baseline[nr, nc] = baseline
                rise = n_elev - baseline

                # Determine if this tile is forest or beach
                is_forest = False

                if parent_streak >= 2:
                    # Two consecutive forest tiles already → all forest from here
                    is_forest = True
                elif rise >= CLIFF_RISE:
                    # Cliff: steep rise from coast → forest
                    is_forest = True
                elif parent_streak == 1:
                    # One forest parent → 95% chance of forest
                    is_forest = rng_biome.random() < 0.95
                else:
                    # Exponential probability based on depth from coast
                    # depth 1: ~8%, depth 2: ~25%, depth 3: ~50%, depth 4: ~75%
                    prob = 1.0 - math.exp(-0.35 * depth)
                    # Elevation boost: higher tiles more likely to be forest
                    elev_boost = min(0.3, rise * 3.0)
                    prob = min(1.0, prob + elev_boost)
                    is_forest = rng_biome.random() < prob

                if is_forest:
                    base[nr, nc] = BIOME_REED_BEDS
                    forest_streak[nr, nc] = parent_streak + 1
                else:
                    base[nr, nc] = BIOME_TIDAL_FLATS
                    forest_streak[nr, nc] = 0

                queue.append((nr, nc))

    biomes[:] = base


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



def _compute_k_grid(season):
    """Vectorized carrying capacity for all tiles and species. Returns (gs, gs, NUM_SPECIES) array."""
    gs = GRID_SIZE
    k_grid = np.zeros((gs, gs, NUM_SPECIES), dtype=np.float32)
    suit_grid = HABITAT_SUIT[:, biomes].T  # (gs, gs, NUM_SPECIES) — lookup biome suitability
    # Reshape so suit_grid is (gs, gs, NUM_SPECIES)
    # HABITAT_SUIT is (NUM_SPECIES, NUM_BIOMES), biomes is (gs, gs)
    # HABITAT_SUIT[:, biomes] gives (NUM_SPECIES, gs, gs), transpose to (gs, gs, NUM_SPECIES)
    suit_grid = np.transpose(HABITAT_SUIT[:, biomes.ravel()].reshape(NUM_SPECIES, gs, gs), (1, 2, 0))

    met = traits[:, :, :, T_METABOLISM]  # (gs, gs, NUM_SPECIES)
    veg = vegetation[:, :, np.newaxis]   # (gs, gs, 1)

    # Food availability per species
    food = np.zeros((gs, gs, NUM_SPECIES), dtype=np.float32)
    food[:, :, CRAWLER] = veg[:, :, 0]
    food[:, :, CRAB] = veg[:, :, 0] * 0.4 + 0.4
    food[:, :, VELOTHRIX] = veg[:, :, 0] * 0.6 + 0.2
    worm_food = np.minimum(1.0, 0.3 + total_deaths_last / max(1, G2 * 3))
    food[:, :, WORM] = worm_food
    food[:, :, LEVIATHAN] = 0.5

    food_mod = np.maximum(0.05, 0.3 + 0.7 * food)
    met_amp = food_mod ** (0.7 + met * 0.6)
    k_grid = BASE_K[np.newaxis, np.newaxis, :] * suit_grid * met_amp * (0.85 + 0.15 * season)

    # Algal bloom modifier
    if _has_active_event('algal_bloom'):
        k_grid[:, :, WORM] *= 1.15
        k_grid[:, :, VELOTHRIX] *= 1.15
        k_grid[:, :, LEVIATHAN] *= 0.8

    # Floor: where suit < 0.05, k = 0; elsewhere min 1
    low_suit = suit_grid < 0.05
    k_grid[low_suit] = 0
    k_grid = np.where(low_suit, 0, np.maximum(1, k_grid))
    np.nan_to_num(k_grid, copy=False, nan=1.0)
    return k_grid


def _step_all_tiles(season):
    """Vectorized per-tile updates: growth, predation, competition, vegetation, traits."""
    global total_deaths_last
    gs = GRID_SIZE
    total_deaths = 0

    pop_f = pops.astype(np.float32)  # (gs, gs, NUM_SPECIES)
    k_grid = _compute_k_grid(season)

    # ── Growth (vectorized per species) ──
    for s in range(NUM_SPECIES):
        pop_s = pop_f[:, :, s]
        k_s = k_grid[:, :, s]
        alive = pop_s > 0

        # Tiles with no K — decay 10%
        no_k = alive & (k_s <= 0)
        decay = np.round(pop_s * 0.1).astype(np.int32)
        pop_s_new = pop_s.copy()
        pop_s_new[no_k] = np.maximum(0, pop_s[no_k] - decay[no_k])

        # Tiles with K — logistic growth + mortality
        has_k = alive & (k_s > 0)
        if np.any(has_k):
            clutch = traits[:, :, s, T_CLUTCH]
            longevity = traits[:, :, s, T_LONGEVITY]
            r_eff = BASE_R[s] * (0.5 + clutch)
            growth = r_eff * pop_s * (1 - pop_s / np.maximum(k_s, 1))
            mort_rate = 0.02 + 0.08 * (1 - longevity)
            mort = np.round(pop_s * mort_rate).astype(np.float32)
            # Probabilistic rounding for growth
            growth_floor = np.floor(growth).astype(np.float32)
            growth_frac = growth - growth_floor
            growth_rounded = growth_floor + (np.random.random((gs, gs)) < np.abs(growth_frac)).astype(np.float32) * np.sign(growth_frac)
            new_pop = pop_s + growth_rounded - mort
            new_pop = np.clip(new_pop, 0, 65535)
            pop_s_new[has_k] = new_pop[has_k]
            total_deaths += int(np.sum(mort[has_k]))

        total_deaths += int(np.sum(decay[no_k]))
        pops[:, :, s] = np.clip(pop_s_new, 0, 65535).astype(np.uint16)

    # ── Predation (vectorized per pair) ──
    for pred, prey, base_atk, h_time in PREDATION:
        pp = pops[:, :, pred].astype(np.float32)
        qp = pops[:, :, prey].astype(np.float32)
        active = (pp > 0) & (qp > 0)
        if not np.any(active):
            continue
        atk = np.full((gs, gs), base_atk, dtype=np.float32)
        if pred == LEVIATHAN:
            atk *= (0.5 + traits[:, :, LEVIATHAN, T_SPECIFIC])
        if prey == VELOTHRIX:
            atk *= (0.7 + 0.6 * traits[:, :, VELOTHRIX, T_SPECIFIC])
        elif prey == WORM:
            atk *= (0.7 + 0.6 * traits[:, :, WORM, T_SPECIFIC])
        if prey == CRAWLER:
            atk *= (1.0 - traits[:, :, CRAWLER, T_SPECIFIC] * 0.6)
        ks = np.ones((gs, gs), dtype=np.float32)
        if prey == CRAB:
            ks = 1.0 - traits[:, :, CRAB, T_SPECIFIC] * 0.5
        kills = atk * pp * qp / (1 + h_time * qp) * ks
        kills = np.minimum(kills, qp * 0.5)
        kills = np.round(kills).astype(np.int32)
        kills[~active] = 0
        pops[:, :, prey] = np.maximum(0, pops[:, :, prey].astype(np.int32) - kills).astype(np.uint16)
        total_deaths += int(np.sum(kills))

    # ── Competition (vectorized per pair) ──
    for sa, sb, coeff in COMPETITION:
        pa = pops[:, :, sa].astype(np.float32)
        pb = pops[:, :, sb].astype(np.float32)
        active = (pa > 0) & (pb > 0)
        if not np.any(active):
            continue
        losses = np.round(coeff * pa * pb).astype(np.int32)
        losses[~active] = 0
        pops[:, :, sa] = np.maximum(0, pops[:, :, sa].astype(np.int32) - losses).astype(np.uint16)
        pops[:, :, sb] = np.maximum(0, pops[:, :, sb].astype(np.int32) - losses).astype(np.uint16)
        total_deaths += int(np.sum(losses)) * 2

    # ── Vegetation (vectorized) ──
    veg_rates = np.array([0, 0, 0, 0, 0], dtype=np.float32)  # per species consumption multiplier
    veg_rates[CRAWLER] = 1.0
    veg_rates[CRAB] = 0.3
    veg_rates[VELOTHRIX] = 0.5
    for s in [CRAWLER, CRAB, VELOTHRIX]:
        pop_s = pops[:, :, s].astype(np.float32)
        met = traits[:, :, s, T_METABOLISM]
        rate = 0.001 * (0.5 + met) * veg_rates[s]
        vegetation[:] -= rate * pop_s
    regrowth = VEG_REGROWTH[biomes]
    vegetation[:] += regrowth * (1 - vegetation) * season
    np.clip(vegetation, 0.0, 1.0, out=vegetation)

    # ── Traits (vectorized per species) ──
    for s in range(NUM_SPECIES):
        pop_s = pops[:, :, s].astype(np.float32)
        alive = pop_s >= 2
        if not np.any(alive):
            continue
        mut = 0.001 + traits[:, :, s, T_MUTATION] * 0.049
        for t in range(NUM_TRAITS):
            mean = traits[:, :, s, t].copy()
            var = trait_var[:, :, s, t].copy()
            drift_v = mean * (1 - mean) / (2 * np.maximum(pop_s, 1))
            drift_std = np.sqrt(np.maximum(0, drift_v))
            mean += np.random.normal(0, 1, (gs, gs)).astype(np.float32) * drift_std
            var += mut * MUTATION_STEP
            var *= 0.99
            np.nan_to_num(mean, copy=False, nan=0.5)
            np.nan_to_num(var, copy=False, nan=0.04)
            np.clip(mean, 0.001, 0.999, out=mean)
            np.clip(var, 0.001, 0.25, out=var)
            # Only write alive tiles
            traits[:, :, s, t] = np.where(alive, mean, traits[:, :, s, t])
            trait_var[:, :, s, t] = np.where(alive, var, trait_var[:, :, s, t])

    return total_deaths


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
        coords = np.argwhere(pops[:, :, target] > 10)
        candidates = [(int(r), int(c)) for r, c in coords]
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
            coords = np.argwhere((biomes == BIOME_SHALLOW_MARSH) | (biomes == BIOME_TIDAL_FLATS))
            candidates = [(int(r), int(c)) for r, c in coords]
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
            vegetation *= 0.998

        elif evt['type'] == 'disease':
            s = evt['species']
            er, ec = evt['epicenter']
            rows = np.arange(GRID_SIZE)[:, None]
            cols = np.arange(GRID_SIZE)[None, :]
            dist = np.abs(rows - er) + np.abs(cols - ec)
            severity = np.maximum(0, 1 - dist / (GRID_SIZE * 0.5))
            pop_s = pops[:, :, s].astype(np.float32)
            kills = np.round(pop_s * 0.05 * severity).astype(np.int32)
            pops[:, :, s] = np.maximum(0, pops[:, :, s].astype(np.int32) - kills).astype(np.uint16)

        elif evt['type'] == 'algal_bloom':
            # Boost Worm K, reduce Leviathan predation effectiveness
            # (handled via modifier in _k and _step_predation — simplified here)
            pass  # effect is checked in _k via active_events list

        elif evt['type'] == 'tidal_surge':
            # Temporarily lower coastal tile elevations
            if age == 0:  # apply once at start
                coastal = elevations < 0.35
                elevations[coastal] = np.maximum(0, elevations[coastal] - 0.05)

    for evt in expired:
        active_events.remove(evt)
        # Restore tidal surge elevation
        if evt['type'] == 'tidal_surge':
            low = elevations < 0.30
            elevations[low] += 0.05


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
    gs = GRID_SIZE
    # Compute mean neighbor elevation using shifted arrays
    # Pad with edge values for boundary handling
    padded = np.pad(elevations, 1, mode='edge')
    mean_n = (padded[:-2, 1:-1] + padded[2:, 1:-1] +
              padded[1:-1, :-2] + padded[1:-1, 2:]) / 4.0
    high = elevations >= 0.3
    diff = elevations - mean_n
    erode_mask = high & (diff > 0)
    elevations[erode_mask] -= EROSION_RATE * diff[erode_mask]
    np.maximum(elevations, 0, out=elevations)
    # Reclassify biomes after elevation changes
    _update_biomes_incremental()


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
    """Stochastically spawn a river at mid-to-high elevation (not peaks)."""
    global _next_river_id
    if random.random() > RIVER_SPAWN_PROB:
        return
    # Find mid-elevation tiles: above forest line but below mountain peaks
    # Rivers originate from inland hills/ridges, not volcanic summits
    candidates = (elevations > 0.35) & (elevations < 0.65) & ((tile_flags & 1) == 0)
    if not np.any(candidates):
        # Fallback: any elevated tile that's not a peak
        candidates = (elevations > 0.30) & (elevations < 0.80) & ((tile_flags & 1) == 0)
    if not np.any(candidates):
        return
    # Pick the highest candidate (but still not a peak)
    masked = np.where(candidates, elevations, -1)
    idx = np.unravel_index(np.argmax(masked), masked.shape)
    r, c = int(idx[0]), int(idx[1])
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

        # Split into north/south subpopulations (vectorized)
        pop_s = pops[:, :, s].astype(np.float32)
        trait_s = traits[:, :, s, T_SPECIFIC]
        weighted = trait_s * pop_s
        north_pop = int(pop_s[:mid, :].sum())
        south_pop = int(pop_s[mid:, :].sum())
        north_sum = float(weighted[:mid, :].sum())
        south_sum = float(weighted[mid:, :].sum())

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
            coords = np.argwhere(pops[:, :, s] > 0)
            if len(coords) > 0:
                last_seen_tile[s] = (int(coords[-1, 0]), int(coords[-1, 1]))

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

    # Assign each tile to nearest seed (Voronoi) — vectorized
    rows_v = np.arange(GRID_SIZE)[:, None]
    cols_v = np.arange(GRID_SIZE)[None, :]
    min_dist = np.full((GRID_SIZE, GRID_SIZE), 999, dtype=np.int32)
    closest = np.zeros((GRID_SIZE, GRID_SIZE), dtype=np.int32)
    for i, (sr, sc) in enumerate(seeds):
        d = np.abs(rows_v - sr) + np.abs(cols_v - sc)
        better = d < min_dist
        min_dist[better] = d[better]
        closest[better] = i
    plate_tiles = [[] for _ in range(PLATE_COUNT)]
    for i in range(PLATE_COUNT):
        coords = np.argwhere(closest == i)
        plate_tiles[i] = [(int(r), int(c)) for r, c in coords]

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
    gs = GRID_SIZE
    # Build plate ID map as numpy array
    plate_id_map = np.full((gs, gs), -1, dtype=np.int32)
    for plate in tectonic_plates:
        for r, c in plate['tiles']:
            plate_id_map[r, c] = plate['id']

    # Check 4-neighbors via shifted arrays
    padded = np.pad(plate_id_map, 1, mode='constant', constant_values=-1)
    diff_up = plate_id_map != padded[:-2, 1:-1]
    diff_down = plate_id_map != padded[2:, 1:-1]
    diff_left = plate_id_map != padded[1:-1, :-2]
    diff_right = plate_id_map != padded[1:-1, 2:]
    # Neighbor must be a valid plate (not -1)
    valid_up = padded[:-2, 1:-1] >= 0
    valid_down = padded[2:, 1:-1] >= 0
    valid_left = padded[1:-1, :-2] >= 0
    valid_right = padded[1:-1, 2:] >= 0
    is_boundary = ((diff_up & valid_up) | (diff_down & valid_down) |
                   (diff_left & valid_left) | (diff_right & valid_right))
    coords = np.argwhere(is_boundary)
    return [(int(r), int(c), int(plate_id_map[r, c])) for r, c in coords]


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
    _update_biomes_incremental()

    events_buffer.append({'gen': generation, 'type': 'volcanic',
        'text': f'Gen {generation}. Eruption at ({vr},{vc})! '
                f'The earth splits. Ash rains. Elevation spikes. '
                f'Life within two tiles is devastated.'})

    # Spawn a lava flow from the eruption site
    _spawn_lava_flow(vr, vc)


# ── LAVA FLOWS ───────────────────────────────────────────────────────────────
# Lava advances progressively — one tile at a time, like rivers.
# It destroys vegetation and life along its path, deposits elevation
# everywhere it flows, converts biomes to rocky, and creates new land
# when it reaches water.

lava_flows = []
_next_lava_id = 0

LAVA_DEPOSIT_PATH = 0.003  # elevation thickening along existing path per advance
LAVA_DEPOSIT_TIP = 0.008   # elevation deposited at the advancing front
LAVA_COOLING_RATE = 80     # generations until lava solidifies
LAVA_ADVANCE_INTERVAL = 3  # advance one tile every N generations
LAVA_MAX_PATH = 30         # max tiles a flow can reach


def _spawn_lava_flow(vr, vc):
    """Create a lava flow at eruption site. Only the origin — advances over time."""
    global _next_lava_id
    lava = {
        'id': _next_lava_id,
        'path': [(vr, vc)],
        'path_set': {(vr, vc)},
        'age': 0,
        'width': 2,
        'active': True,
        'stalled': 0,
    }
    _next_lava_id += 1
    tile_flags[vr, vc] |= 2
    lava_flows.append(lava)


def _advance_lava(lava):
    """Extend lava one tile downhill. Destroys everything in its path."""
    if not lava['active']:
        return
    r, c = lava['path'][-1]

    # Find lowest neighbor not already in the flow (8-directional)
    best = None
    best_elev = elevations[r, c]
    for dr, dc in [(-1,0),(1,0),(0,-1),(0,1),(-1,-1),(-1,1),(1,-1),(1,1)]:
        nr, nc = r + dr, c + dc
        if 0 <= nr < GRID_SIZE and 0 <= nc < GRID_SIZE and (nr, nc) not in lava['path_set']:
            e = elevations[nr, nc]
            if e < best_elev:
                best = (nr, nc)
                best_elev = e

    if best is None:
        # Nowhere downhill — lava pools, builds up slowly
        lava['stalled'] += 1
        elevations[r, c] = min(1.0, elevations[r, c] + LAVA_DEPOSIT_TIP * 0.5)
        if lava['stalled'] > 10:
            lava['active'] = False
        return

    lava['stalled'] = 0
    nr, nc = best

    # Lava-water interaction: create new land
    if elevations[nr, nc] < 0.20:
        elevations[nr, nc] = 0.22
        biomes[nr, nc] = BIOME_ROCKY_SHORE
        events_buffer.append({'gen': generation, 'type': 'lava_land',
            'text': f'Gen {generation}. Lava meets sea at ({nr},{nc}). New rock forms.'})

    # Deposit elevation at the new tile
    elevations[nr, nc] = min(1.0, elevations[nr, nc] + LAVA_DEPOSIT_TIP)

    # Destroy vegetation and life on the new tile
    vegetation[nr, nc] = 0
    for s in range(NUM_SPECIES):
        pops[nr, nc, s] = 0

    # Convert to rocky and flag as volcanic
    biomes[nr, nc] = BIOME_ROCKY_SHORE
    tile_flags[nr, nc] |= 2

    # Extend path
    lava['path'].append((nr, nc))
    lava['path_set'].add((nr, nc))

    # Thicken existing path slightly (lava deposits as it flows)
    for pr, pc in lava['path'][:-1]:
        if 0 <= pr < GRID_SIZE and 0 <= pc < GRID_SIZE:
            elevations[pr, pc] = min(1.0, elevations[pr, pc] + LAVA_DEPOSIT_PATH * 0.1)


def _step_lava_flows():
    """Advance and age all active lava flows. Called every generation."""
    for lava in lava_flows:
        if not lava['active']:
            continue
        lava['age'] += 1

        # Advance one tile periodically
        if lava['age'] % LAVA_ADVANCE_INTERVAL == 0:
            _advance_lava(lava)

        # Max length cap
        if len(lava['path']) >= LAVA_MAX_PATH:
            lava['active'] = False

        # Solidify after cooling
        if lava['age'] > LAVA_COOLING_RATE:
            lava['active'] = False

    # Clean up old inactive flows (keep last 5 for rendering)
    inactive = [lf for lf in lava_flows if not lf['active']]
    if len(inactive) > 5:
        for old in inactive[:-5]:
            lava_flows.remove(old)


def _sync_lava_to_buffer():
    """Write lava flow path data to shared buffer for JS rendering."""
    from js import _js_lava_paths, _js_lava_meta
    from pyodide.ffi import to_js

    # Lava paths: same sentinel format as rivers
    path_data = []
    for lava in lava_flows:
        for r, c in lava['path']:
            path_data.append(r)
            path_data.append(c)
        path_data.append(-1)
        path_data.append(-1)

    max_vals = 256 * 2  # MAX_LAVA_POINTS * 2
    while len(path_data) < max_vals:
        path_data.append(-1)
    path_data = path_data[:max_vals]

    _js_lava_paths.set(to_js(np.array(path_data, dtype=np.int16)))

    # Lava meta: [id, age, width, active] per flow
    meta_data = []
    max_flows = 10
    for lava in lava_flows[:max_flows]:
        meta_data.extend([lava['id'], lava['age'], lava['width'], 1.0 if lava['active'] else 0.0])
    while len(meta_data) < max_flows * 4:
        meta_data.extend([-1, 0, 0, 0])

    _js_lava_meta.set(to_js(np.array(meta_data[:max_flows * 4], dtype=np.float32)))


def _sync_flow_dirs():
    """Compute per-tile entry/exit directions for rivers and lava."""
    from js import _js_flow_dirs
    from pyodide.ffi import to_js
    gs = GRID_SIZE
    dirs = np.zeros((gs, gs, 4), dtype=np.uint8)
    dir_map = {
        (-1, -1): 1, (-1, 0): 2, (-1, 1): 3,
        (0, 1): 4, (1, 1): 5, (1, 0): 6,
        (1, -1): 7, (0, -1): 8,
    }
    def _encode_paths(flow_list, entry_ch, exit_ch):
        for flow in flow_list:
            path = flow['path']
            for i, (r, c) in enumerate(path):
                if r < 0 or r >= gs or c < 0 or c >= gs:
                    continue
                if i > 0:
                    pr, pc = path[i - 1]
                    dr, dc = pr - r, pc - c
                    d = dir_map.get((dr, dc), 0)
                    if d > 0:
                        dirs[r, c, entry_ch] = d
                if i < len(path) - 1:
                    nr, nc = path[i + 1]
                    dr, dc = nr - r, nc - c
                    d = dir_map.get((dr, dc), 0)
                    if d > 0:
                        dirs[r, c, exit_ch] = d
    _encode_paths(rivers, 0, 1)
    _encode_paths(lava_flows, 2, 3)
    _js_flow_dirs.set(to_js(dirs.ravel()))


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
    _sync_lava_to_buffer()
    _sync_flow_dirs()


def step_simulation(n=1):
    global generation, total_deaths_last
    for _ in range(n):
        generation += 1
        season = _season()
        total_deaths_last = _step_all_tiles(season)

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
        _step_lava_flows()
        _update_tectonics()

        # Detection systems
        _check_extinction()
        if generation % 10 == 0:  # check speciation every 10 gens (expensive)
            _check_speciation()
        if generation % 20 == 0:  # epoch classification
            _classify_epoch()

    _sync_to_buffer()
    _sync_rivers_to_buffer()
    _sync_lava_to_buffer()
    _sync_flow_dirs()


def flush_events():
    global events_buffer
    out = json.dumps(events_buffer)
    events_buffer = []
    return out


def set_lod(level):
    global lod_level
    lod_level = level


# ── DEBUG API ────────────────────────────────────────────────────────────────

def debug_spawn_river():
    """Force-spawn a river immediately."""
    global _next_river_id
    candidates = (elevations > 0.35) & (elevations < 0.65) & ((tile_flags & 1) == 0)
    if not np.any(candidates):
        candidates = (elevations > 0.30) & (elevations < 0.80) & ((tile_flags & 1) == 0)
    if not np.any(candidates):
        return 'No valid spawn point'
    masked = np.where(candidates, elevations, -1)
    idx = np.unravel_index(np.argmax(masked), masked.shape)
    r, c = int(idx[0]), int(idx[1])
    river = {
        'id': _next_river_id, 'path': [(r, c)], 'path_set': {(r, c)},
        'age': 0, 'width': 1, 'active': True, 'stall_gens': 0,
    }
    _next_river_id += 1
    tile_flags[r, c] |= 1
    rivers.append(river)
    events_buffer.append({'gen': generation, 'type': 'river_spawn',
        'text': f'Gen {generation}. [DEBUG] River spawned at ({r},{c}).'})
    _sync_rivers_to_buffer()
    return f'River spawned at ({r},{c})'


def debug_trigger_event(event_type):
    """Force-trigger an environmental event."""
    season = _season()
    if event_type == 'drought':
        duration = random.randint(30, 80)
        active_events.append({'type': 'drought', 'start': generation, 'duration': duration})
        events_buffer.append({'gen': generation, 'type': 'drought',
            'text': f'Gen {generation}. [DEBUG] Drought triggered. Duration: {duration} gens.'})
    elif event_type == 'disease':
        target = random.randint(0, NUM_SPECIES - 1)
        coords = np.argwhere(pops[:, :, target] > 10)
        if len(coords) > 0:
            er, ec = coords[random.randint(0, len(coords) - 1)]
            er, ec = int(er), int(ec)
            active_events.append({'type': 'disease', 'start': generation, 'duration': 20,
                'species': target, 'epicenter': (er, ec)})
            events_buffer.append({'gen': generation, 'type': 'disease',
                'text': f'Gen {generation}. [DEBUG] Disease targeting species {target} at ({er},{ec}).'})
    elif event_type == 'algal_bloom':
        active_events.append({'type': 'algal_bloom', 'start': generation, 'duration': 40})
        events_buffer.append({'gen': generation, 'type': 'algal_bloom',
            'text': f'Gen {generation}. [DEBUG] Algal bloom triggered.'})
    elif event_type == 'tidal_surge':
        active_events.append({'type': 'tidal_surge', 'start': generation, 'duration': 25})
        events_buffer.append({'gen': generation, 'type': 'tidal_surge',
            'text': f'Gen {generation}. [DEBUG] Tidal surge triggered.'})
    elif event_type == 'eruption':
        # Force eruption on a random plate
        if tectonic_plates:
            plate = random.choice(tectonic_plates)
            _volcanic_eruption(plate)
            events_buffer.append({'gen': generation, 'type': 'debug',
                'text': f'Gen {generation}. [DEBUG] Volcanic eruption forced.'})
            _sync_to_buffer()
            _sync_lava_to_buffer()
            _sync_flow_dirs()
    return f'{event_type} triggered'


def debug_get_tile_info(r, c):
    """Return detailed info about a specific tile."""
    r, c = int(r), int(c)
    if r < 0 or r >= GRID_SIZE or c < 0 or c >= GRID_SIZE:
        return '{}'
    biome_names = ['Deep Water', 'Shallow Marsh', 'Forest', 'Beach', 'Rocky Shore']
    info = {
        'r': r, 'c': c,
        'elevation': round(float(elevations[r, c]), 3),
        'biome': biome_names[int(biomes[r, c])],
        'vegetation': round(float(vegetation[r, c]), 3),
        'flags': int(tile_flags[r, c]),
        'has_river': bool(tile_flags[r, c] & 1),
        'volcanic': bool(tile_flags[r, c] & 2),
        'populations': {},
    }
    species_names = ['Velothrix', 'Leviathan', 'Crawler', 'Crab', 'Worm']
    for s in range(NUM_SPECIES):
        pop = int(pops[r, c, s])
        if pop > 0:
            info['populations'][species_names[s]] = pop
    return json.dumps(info)


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
    _sync_lava_to_buffer()
    _sync_flow_dirs()
