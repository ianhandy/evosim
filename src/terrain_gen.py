"""
terrain_gen.py — 11-stage terrain generation pipeline for evosim.

Pure function: generate(seed, grid_size, params) → TerrainResult
No global state. No side effects. All output via TerrainResult.

Stage 1  — Tectonic Skeleton: rift geometry, vent catalog
Stage 2  — Volcanic Edifice: p*(1-d/R)^2 summation over all vents
Stage 3  — Ridge Network: Gaussian cross-sections along rift lines
Stage 4  — Ocean Floor: flat baseline + Perlin undulation
Stage 5  — Composite + Radial Boundary: sum layers, apply island falloff
Stage 6  — Geological Erosion: slope-weighted smoothing, flat passes
Stage 7  — Sea Level Calibration: percentile shift → target_land_fraction
Stage 8  — Land Elevation Curve: gamma correction expands midtones
Stage 9  — Fine Detail Noise: 3-octave Perlin, slope-suppressed, land only
Stage 10 — Drainage Basin Routing: D8 flow direction + accumulation
Stage 11 — Biome Seeding: uses slope + drainage, same 5 biome IDs
"""

import math
import numpy as np
from scipy.ndimage import gaussian_filter, zoom

# ── Default parameters ────────────────────────────────────────────────────────

TERRAIN_PARAMS = {
    'num_rifts':            (2, 4),    # min/max number of rift arms
    'plate_speed':          (0.3, 0.8),
    'rift_curvature':       0.30,      # amplitude of rift curve (fraction of length)
    'eruption_count':       (120, 250),# total number of vents generated
    'eruption_power':       (0.05, 0.30),
    'eruption_radius':      (3, 12),   # vent radius in gs-space tiles
    'ridge_height':         0.15,      # max ridge elevation contribution
    'ridge_sigma':          2.0,       # ridge Gaussian sigma (in gs-space tiles)
    'radial_radius':        0.55,      # falloff starts at this fraction of igs canvas
    'radial_power':         1.5,       # controls coastline sharpness
    'erosion_passes':       40,        # number of erosion passes (deterministic)
    'erosion_strength':     0.40,      # max blend toward blurred (on flat tiles)
    'target_land_fraction': 0.45,      # fraction of tiles that become land
    'land_gamma':           0.60,      # gamma < 1 lifts midtones (fixes flatness)
    'noise_octaves':        3,
    'noise_scale':          0.08,      # base spatial scale of noise (fraction of gs)
    'noise_amplitude':      0.03,      # peak noise amplitude on land
}

SEA_LEVEL = 0.20  # fixed — matches WATER_LEVEL in render.js

# ── Result type ───────────────────────────────────────────────────────────────

class TerrainResult:
    """All terrain data produced by the pipeline."""
    __slots__ = (
        'elevations', 'biomes', 'flow_dir', 'drainage_area',
        'basin_id', 'volcanic_mask', 'peak_locations', 'sea_level',
    )

    def __init__(self, elevations, biomes, flow_dir, drainage_area,
                 basin_id, volcanic_mask, peak_locations, sea_level):
        self.elevations     = elevations      # (gs, gs) float32, 0-1
        self.biomes         = biomes          # (gs, gs) uint8, 0-4
        self.flow_dir       = flow_dir        # (gs, gs) uint8, D8 codes 0-8
        self.drainage_area  = drainage_area   # (gs, gs) float32, upstream cell count
        self.basin_id       = basin_id        # (gs, gs) int32
        self.volcanic_mask  = volcanic_mask   # (gs, gs) bool
        self.peak_locations = peak_locations  # list of (r, c) tuples
        self.sea_level      = sea_level       # float, always 0.20

# ── D8 direction tables ───────────────────────────────────────────────────────
# Codes match dir_map in sim-core.py _sync_flow_dirs:
#   (-1,-1):1  (-1,0):2  (-1,1):3  (0,1):4  (1,1):5  (1,0):6  (1,-1):7  (0,-1):8

_D8 = [
    (-1, -1, 1), (-1, 0, 2), (-1, 1, 3),
    ( 0,  1, 4), ( 1, 1, 5), ( 1, 0, 6),
    ( 1, -1, 7), ( 0, -1, 8),
]
_DIR_TO_DELTA = {
    1: (-1, -1), 2: (-1, 0), 3: (-1, 1),
    4: ( 0,  1), 5: ( 1, 1), 6: ( 1, 0),
    7: ( 1, -1), 8: ( 0, -1),
}

# ── Biome IDs (must match sim-core.py) ───────────────────────────────────────

BIOME_DEEP_WATER    = 0
BIOME_SHALLOW_MARSH = 1
BIOME_REED_BEDS     = 2
BIOME_TIDAL_FLATS   = 3
BIOME_ROCKY_SHORE   = 4

# ── Main entry point ──────────────────────────────────────────────────────────

def generate(seed, grid_size, params=None):
    """
    Run the 11-stage terrain pipeline. Pure function — no side effects.

    Args:
        seed:       int or str — used to seed all RNG
        grid_size:  int — output will be (grid_size × grid_size)
        params:     optional dict of parameter overrides

    Returns:
        TerrainResult
    """
    p = dict(TERRAIN_PARAMS)
    if params:
        p.update(params)

    # Deterministic RNG
    if isinstance(seed, str):
        seed_val = sum(ord(c) * (i + 1) for i, c in enumerate(seed))
    else:
        seed_val = int(seed)
    rng = np.random.RandomState(seed_val % (2 ** 31))

    gs  = grid_size
    igs = gs * 2   # internal oversized canvas

    # ── STAGE 1: TECTONIC SKELETON ────────────────────────────────────────────
    # Central eruption point, rift geometry, curved rift lines, vent catalog.
    # All positions in igs-space (0..igs).

    cx0 = rng.uniform(igs * 0.35, igs * 0.65)
    cy0 = rng.uniform(igs * 0.35, igs * 0.65)

    num_rifts  = int(rng.randint(int(p['num_rifts'][0]), int(p['num_rifts'][1]) + 1))
    base_angle = rng.uniform(0, 2 * math.pi)
    ideal_gap  = 2 * math.pi / num_rifts

    # Evenly-spaced angles with ±15° perturbation
    rift_angles = []
    for i in range(num_rifts):
        a = base_angle + i * ideal_gap + rng.uniform(-0.26, 0.26)
        rift_angles.append(a % (2 * math.pi))

    # Enforce ≥30° (0.52 rad) minimum separation
    for i in range(len(rift_angles)):
        for j in range(i + 1, len(rift_angles)):
            diff = abs(rift_angles[i] - rift_angles[j])
            diff = min(diff, 2 * math.pi - diff)
            if diff < 0.52:
                rift_angles[j] = (rift_angles[j] + 0.52) % (2 * math.pi)

    # Build curved rift lines as series of (r, c) points
    rift_length = igs * rng.uniform(0.35, 0.50)
    rift_points = []
    for ri, angle in enumerate(rift_angles):
        dx = math.cos(angle)
        dy = math.sin(angle)
        curve_amp   = rift_length * float(p['rift_curvature']) * rng.uniform(0.5, 1.5) * 0.1
        curve_freq  = rng.uniform(1.5, 3.0)
        curve_phase = rng.uniform(0, 2 * math.pi)
        pts = []
        for si in range(41):
            t    = si / 40.0
            dist = t * rift_length
            off  = math.sin(t * curve_freq * math.pi + curve_phase) * curve_amp * t
            pr   = cx0 + dist * dx + off * (-dy)
            pc   = cy0 + dist * dy + off * dx
            pts.append((pr, pc))
        rift_points.append(pts)

    # Vent catalog
    eruption_count = int(rng.randint(int(p['eruption_count'][0]), int(p['eruption_count'][1]) + 1))
    pow_lo, pow_hi = float(p['eruption_power'][0]), float(p['eruption_power'][1])
    rad_lo, rad_hi = float(p['eruption_radius'][0]), float(p['eruption_radius'][1])
    # radius params are in gs-space tiles; scale to igs-space
    rad_lo_igs = rad_lo * (igs / gs)
    rad_hi_igs = rad_hi * (igs / gs)

    vents = []

    # Central summit vent
    vents.append({
        'x': cx0, 'y': cy0,
        'power':  rng.uniform(pow_lo * 0.8, pow_hi * 0.8),
        'radius': rng.uniform(igs * 0.06, igs * 0.10),
        'age':    0,
    })

    # Distribute remaining vents evenly across rifts
    remaining        = eruption_count - 1
    vents_per_rift   = max(1, remaining // num_rifts)

    for ri, pts in enumerate(rift_points):
        # Last rift gets any leftover
        n_here = vents_per_rift if ri < num_rifts - 1 else max(1, remaining - vents_per_rift * (num_rifts - 1))
        for _ in range(n_here):
            t     = float(rng.random()) ** 1.3
            t     = max(0.05, min(0.95, t))
            idx_f = t * (len(pts) - 1)
            idx_i = int(idx_f)
            frac  = idx_f - idx_i
            if idx_i >= len(pts) - 1:
                pr, pc = pts[-1]
            else:
                pr = pts[idx_i][0] * (1 - frac) + pts[idx_i + 1][0] * frac
                pc = pts[idx_i][1] * (1 - frac) + pts[idx_i + 1][1] * frac

            angle  = rift_angles[ri]
            jitter = rng.uniform(-igs * 0.03, igs * 0.03)
            pr    += jitter * (-math.sin(angle))
            pc    += jitter * math.cos(angle)
            pr     = float(max(1, min(igs - 2, pr)))
            pc     = float(max(1, min(igs - 2, pc)))

            dist_factor = 1.0 - t * 0.6
            power  = rng.uniform(pow_lo, pow_hi) * dist_factor
            radius = rng.uniform(rad_lo_igs, rad_hi_igs) * dist_factor
            radius = max(2.0, radius)

            vents.append({
                'x': pr, 'y': pc,
                'power':  power,
                'radius': radius,
                'age':    int(rng.uniform(0, 100)),
            })

    # ── STAGE 2: VOLCANIC EDIFICE LAYER ──────────────────────────────────────
    # p*(1-d/R)^2 for each vent, summed additively. Primary height driver.

    edifice = np.zeros((igs, igs), dtype=np.float32)
    for vent in vents:
        cx, cy = vent['x'], vent['y']
        R, pv  = vent['radius'], vent['power']
        maxr   = int(R * 1.1) + 2
        r0, r1 = max(0, int(cx) - maxr), min(igs, int(cx) + maxr + 1)
        c0, c1 = max(0, int(cy) - maxr), min(igs, int(cy) + maxr + 1)
        lr = np.arange(r0, r1, dtype=np.float32)[:, None]
        lc = np.arange(c0, c1, dtype=np.float32)[None, :]
        dist   = np.sqrt((lr - cx) ** 2 + (lc - cy) ** 2)
        t_vent = np.clip(1.0 - dist / R, 0.0, 1.0)
        edifice[r0:r1, c0:c1] += (pv * t_vent * t_vent).astype(np.float32)

    # ── STAGE 3: RIDGE NETWORK LAYER ─────────────────────────────────────────
    # Gaussian cross-sections along rift lines. Independent of edifice.

    ridge_height = float(p['ridge_height'])
    # ridge_sigma is in gs-space tiles; scale to igs-space
    ridge_sigma  = float(p['ridge_sigma']) * (igs / gs)
    ridges       = np.zeros((igs, igs), dtype=np.float32)

    for ri, pts in enumerate(rift_points):
        rh    = ridge_height * rng.uniform(0.8, 1.2)
        sigma = ridge_sigma  * rng.uniform(0.8, 1.2)
        for si in range(0, len(pts), 3):
            pr, pc = pts[si]
            t      = si / max(1, len(pts) - 1)
            decay  = (1.0 - t) ** 2   # quadratic decay toward rift tip
            maxr   = int(sigma * 4) + 2
            r0, r1 = max(0, int(pr) - maxr), min(igs, int(pr) + maxr + 1)
            c0, c1 = max(0, int(pc) - maxr), min(igs, int(pc) + maxr + 1)
            lr = np.arange(r0, r1, dtype=np.float32)[:, None]
            lc = np.arange(c0, c1, dtype=np.float32)[None, :]
            dist   = np.sqrt((lr - pr) ** 2 + (lc - pc) ** 2)
            contrib = rh * decay * np.exp(-(dist * dist) / (2.0 * sigma * sigma))
            ridges[r0:r1, c0:c1] += contrib.astype(np.float32)

    # ── STAGE 4: OCEAN FLOOR LAYER ───────────────────────────────────────────
    # Flat baseline slightly below sea level, with gentle Perlin undulation.

    ocean_noise = rng.rand(igs, igs).astype(np.float32)
    ocean_noise = gaussian_filter(ocean_noise, sigma=igs * 0.08, mode='wrap')
    n_lo, n_hi  = float(ocean_noise.min()), float(ocean_noise.max())
    if n_hi > n_lo:
        ocean_noise = (ocean_noise - n_lo) / (n_hi - n_lo)
    ocean_floor = np.full((igs, igs), -0.04, dtype=np.float32)
    ocean_floor += (ocean_noise - 0.5) * 0.04  # ±0.02 undulation

    # ── STAGE 5: COMPOSITE + RADIAL BOUNDARY ─────────────────────────────────
    # Sum all three layers, then apply smoothstep radial falloff.

    composite = edifice + ridges + ocean_floor

    rows_i = np.arange(igs, dtype=np.float32)[:, None]
    cols_i = np.arange(igs, dtype=np.float32)[None, :]

    # Center of mass of the positive (land) region
    pos = composite > 0.0
    if np.any(pos):
        coords  = np.argwhere(pos)
        w       = composite[pos]
        wsum    = float(w.sum())
        cm_r    = float((coords[:, 0] * w).sum()) / wsum
        cm_c    = float((coords[:, 1] * w).sum()) / wsum
    else:
        cm_r, cm_c = float(igs // 2), float(igs // 2)

    dist_cm  = np.sqrt((rows_i - cm_r) ** 2 + (cols_i - cm_c) ** 2)
    max_dist = igs * float(p['radial_radius'])
    t_rad    = np.clip(dist_cm / max_dist, 0.0, 1.0).astype(np.float32)

    rp      = float(p['radial_power'])
    falloff = (1.0 - t_rad ** rp).astype(np.float32)
    np.clip(falloff, 0.0, 1.0, out=falloff)

    composite = composite * falloff + ocean_floor * (1.0 - falloff)

    # ── STAGE 6: GEOLOGICAL EROSION ──────────────────────────────────────────
    # Slope-weighted smoothing: flat tiles blur toward neighbors (erosion),
    # steep ridgelines blend minimally (preserved). Fixed passes, deterministic.

    grid = composite.copy()
    erosion_passes   = int(p['erosion_passes'])
    erosion_strength = float(p['erosion_strength'])

    for _ in range(erosion_passes):
        blurred = gaussian_filter(grid, sigma=0.8, mode='nearest')
        pad     = np.pad(grid, 1, mode='edge')
        sx      = pad[1:-1, 2:] - pad[1:-1, :-2]
        sy      = pad[2:, 1:-1] - pad[:-2, 1:-1]
        slope   = np.sqrt(sx * sx + sy * sy)
        # Flat → blend fully; steep → blend very little
        blend   = erosion_strength * (1.0 - np.clip(slope / 0.05, 0.0, 1.0) * 0.8)
        blend   = blend.astype(np.float32)
        grid    = grid * (1.0 - blend) + blurred * blend

    # ── CROP + RESAMPLE from igs to gs ────────────────────────────────────────
    # Center crop on the land mass, then bicubic resample to gs×gs.
    # Track crop window so vent positions can be remapped to gs space.

    g_min = float(grid.min())
    g_max = float(grid.max())
    land_thresh  = g_min + (g_max - g_min) * 0.05
    land_mask_igs = grid > land_thresh

    if np.any(land_mask_igs):
        lc = np.argwhere(land_mask_igs)
        lr_min, lc_min = int(lc[:, 0].min()), int(lc[:, 1].min())
        lr_max, lc_max = int(lc[:, 0].max()), int(lc[:, 1].max())
        land_ext  = max(lr_max - lr_min + 1, lc_max - lc_min + 1)
        crop_size = max(gs, int(land_ext / 0.65))
        r_ctr     = (lr_min + lr_max) // 2
        c_ctr     = (lc_min + lc_max) // 2
    else:
        crop_size = igs
        r_ctr     = igs // 2
        c_ctr     = igs // 2

    half = crop_size // 2
    cr0  = max(0, min(igs - crop_size, r_ctr - half))
    cc0  = max(0, min(igs - crop_size, c_ctr - half))
    cr1  = min(igs, cr0 + crop_size)
    cc1  = min(igs, cc0 + crop_size)

    cropped = grid[cr0:cr1, cc0:cc1]
    ah, aw  = cropped.shape

    if ah != gs or aw != gs:
        grid_gs = zoom(cropped, (gs / ah, gs / aw), order=1, mode='nearest').astype(np.float32)
        if grid_gs.shape != (gs, gs):
            final      = np.full((gs, gs), float(cropped.min()), dtype=np.float32)
            cr_s       = min(gs, grid_gs.shape[0])
            cc_s       = min(gs, grid_gs.shape[1])
            final[:cr_s, :cc_s] = grid_gs[:cr_s, :cc_s]
            grid_gs    = final
    else:
        grid_gs = cropped.astype(np.float32)

    # Scale factors: igs-crop coords → gs coords
    crop_h  = cr1 - cr0
    crop_w  = cc1 - cc0
    scale_r = gs / max(1, crop_h)
    scale_c = gs / max(1, crop_w)

    # ── STAGE 7: SEA LEVEL CALIBRATION ───────────────────────────────────────
    # Shift the elevation curve so exactly target_land_fraction of tiles land.
    # Maps: [min, T] → [0, SEA_LEVEL],  [T, max] → [SEA_LEVEL, 1.0]

    target_land = float(p['target_land_fraction'])
    T = float(np.percentile(grid_gs.ravel(), (1.0 - target_land) * 100.0))

    lo = float(grid_gs.min())
    hi = float(grid_gs.max())
    if hi <= lo:
        hi = lo + 1.0
    T = float(np.clip(T, lo + 1e-6, hi - 1e-6))

    under    = grid_gs <= T
    land_gs  = ~under

    elevs = np.empty((gs, gs), dtype=np.float32)
    elevs[under]   = ((grid_gs[under]   - lo) / max(1e-6, T - lo)) * SEA_LEVEL
    elevs[land_gs] = SEA_LEVEL + ((grid_gs[land_gs] - T) / max(1e-6, hi - T)) * (1.0 - SEA_LEVEL)
    np.clip(elevs, 0.0, 1.0, out=elevs)

    # ── STAGE 8: LAND ELEVATION CURVE ────────────────────────────────────────
    # Gamma < 1 expands midtones — tiles that would be flat lowland become
    # visible mid-elevation terrain. Key fix for "too flat" island interiors.

    gamma   = float(p['land_gamma'])
    land_t  = (elevs - SEA_LEVEL) / (1.0 - SEA_LEVEL)
    land_tc = np.power(np.clip(land_t, 0.0, 1.0).astype(np.float64), gamma).astype(np.float32)
    elevs   = np.where(land_gs, SEA_LEVEL + land_tc * (1.0 - SEA_LEVEL), elevs)
    np.clip(elevs, 0.0, 1.0, out=elevs)

    # ── STAGE 9: FINE DETAIL NOISE ───────────────────────────────────────────
    # 3-octave multi-scale noise, added only to land tiles.
    # Amplitude is suppressed on steep slopes to prevent serrating ridgelines.

    pad9   = np.pad(elevs, 1, mode='edge')
    sx9    = pad9[1:-1, 2:] - pad9[1:-1, :-2]
    sy9    = pad9[2:, 1:-1] - pad9[:-2, 1:-1]
    slope9 = np.sqrt(sx9 * sx9 + sy9 * sy9)
    slope_sup = np.clip(slope9 / 0.02, 0.0, 1.0).astype(np.float32)

    noise_amp   = float(p['noise_amplitude'])
    noise_scale = float(p['noise_scale'])
    n_octaves   = int(p['noise_octaves'])

    detail = np.zeros((gs, gs), dtype=np.float32)
    for octave in range(n_octaves):
        sf    = float(2 ** octave)
        sigma = max(0.5, gs * noise_scale / sf)
        n     = rng.rand(gs, gs).astype(np.float32)
        n     = gaussian_filter(n, sigma=sigma, mode='wrap')
        n_lo, n_hi = float(n.min()), float(n.max())
        if n_hi > n_lo:
            n = (n - n_lo) / (n_hi - n_lo)
        amp     = noise_amp / sf
        detail += (n - 0.5) * amp

    detail *= (1.0 - slope_sup * 0.8)
    elevs   = np.where(land_gs,
                       np.clip(elevs + detail, SEA_LEVEL, 1.0),
                       elevs)

    # ── STAGE 10: DRAINAGE BASIN ROUTING ─────────────────────────────────────
    # D8 flow direction: each tile routes to its steepest downhill neighbor.
    # Drainage area: count upstream tiles flowing through each tile.
    # Basin ID: which outlet each tile drains to.

    # D8 flow direction (vectorized)
    flow_dir = np.zeros((gs, gs), dtype=np.uint8)
    pad10    = np.pad(elevs, 1, mode='edge')
    best_s   = np.full((gs, gs), -1.0, dtype=np.float32)
    for dr, dc, code in _D8:
        dist_d  = math.sqrt(float(dr * dr + dc * dc))
        nb      = pad10[1 + dr:gs + 1 + dr, 1 + dc:gs + 1 + dc]
        slope_d = (elevs - nb) / dist_d
        better  = slope_d > best_s
        best_s  = np.where(better, slope_d, best_s).astype(np.float32)
        flow_dir = np.where(better, np.uint8(code), flow_dir).astype(np.uint8)

    # Drainage accumulation: process high-to-low, each cell passes its
    # accumulated count to its downhill D8 neighbor.
    drain     = np.ones(gs * gs, dtype=np.float32)
    ev_flat   = elevs.ravel()
    for idx in np.argsort(-ev_flat):  # high to low
        idx = int(idx)
        d   = int(flow_dir[idx // gs, idx % gs])
        if d == 0:
            continue
        dr2, dc2 = _DIR_TO_DELTA[d]
        nr, nc   = idx // gs + dr2, idx % gs + dc2
        if 0 <= nr < gs and 0 <= nc < gs:
            drain[nr * gs + nc] += drain[idx]

    drainage_area = drain.reshape(gs, gs)

    # Basin IDs: assign water → basin 0; land tiles follow flow to outlet.
    # Process low-to-high so each tile's downhill neighbor is already labeled.
    basin_flat  = np.full(gs * gs, -1, dtype=np.int32)
    basin_flat[ev_flat < SEA_LEVEL] = 0
    next_basin  = 1
    for idx in np.argsort(ev_flat):   # low to high
        idx = int(idx)
        if basin_flat[idx] != -1:
            continue
        d = int(flow_dir[idx // gs, idx % gs])
        if d == 0:
            basin_flat[idx] = next_basin
            next_basin += 1
        else:
            dr2, dc2 = _DIR_TO_DELTA[d]
            nr, nc   = idx // gs + dr2, idx % gs + dc2
            nidx     = nr * gs + nc
            if 0 <= nr < gs and 0 <= nc < gs and basin_flat[nidx] != -1:
                basin_flat[idx] = basin_flat[nidx]
            else:
                basin_flat[idx] = next_basin
                next_basin += 1

    basin_id = basin_flat.reshape(gs, gs)

    # ── REMAP VENTS TO GS SPACE ───────────────────────────────────────────────
    # Transform vent (x, y) from igs-canvas coords → gs-grid coords via
    # the crop window (cr0, cc0) and scale factors (scale_r, scale_c).

    rows_gs = np.arange(gs, dtype=np.float32)[:, None]
    cols_gs = np.arange(gs, dtype=np.float32)[None, :]

    volcanic_mask = np.zeros((gs, gs), dtype=bool)
    for vent in vents:
        vr_gs = (vent['x'] - cr0) * scale_r
        vc_gs = (vent['y'] - cc0) * scale_c
        # Scale vent radius to gs-space
        r_gs = max(1.5, vent['radius'] * min(scale_r, scale_c) * 0.6)
        dist2 = (rows_gs - vr_gs) ** 2 + (cols_gs - vc_gs) ** 2
        volcanic_mask |= (dist2 < r_gs * r_gs)

    # Clip to grid bounds (the broadcasted mask is already bounded)
    volcanic_mask = volcanic_mask & np.ones((gs, gs), dtype=bool)

    # Peak locations: local maxima on land, spaced ≥ gs/8 apart, sorted high→low
    is_land_mask = elevs >= SEA_LEVEL
    pad_pk       = np.pad(elevs, 1, mode='edge')
    is_local_max = is_land_mask.copy()
    for dpr in [-1, 0, 1]:
        for dpc in [-1, 0, 1]:
            if dpr == 0 and dpc == 0:
                continue
            nb_pk = pad_pk[1 + dpr:gs + 1 + dpr, 1 + dpc:gs + 1 + dpc]
            is_local_max &= (elevs >= nb_pk)

    peak_coords = np.argwhere(is_local_max)
    if len(peak_coords) > 0:
        peak_elevs  = elevs[peak_coords[:, 0], peak_coords[:, 1]]
        sorted_idx  = np.argsort(-peak_elevs)
        sorted_pks  = peak_coords[sorted_idx]
        min_sep     = max(3, gs // 8)
        peak_locations = []
        for pk in sorted_pks:
            pr, pc = int(pk[0]), int(pk[1])
            if any(abs(pr - er) + abs(pc - ec) < min_sep for er, ec in peak_locations):
                continue
            peak_locations.append((pr, pc))
            if len(peak_locations) >= max(3, gs // 8):
                break
    else:
        peak_locations = []

    # ── STAGE 11: BIOME SEEDING ───────────────────────────────────────────────
    # Same 5 biome IDs as the original sim, but assigned using slope (actual
    # steepness) and drainage_area (valley detection) from the D8 routing.

    biomes_out  = np.zeros((gs, gs), dtype=np.uint8)
    is_land_bio = elevs >= SEA_LEVEL

    # Water
    biomes_out[elevs < 0.08]                          = BIOME_DEEP_WATER
    biomes_out[(elevs >= 0.08) & (~is_land_bio)]      = BIOME_SHALLOW_MARSH

    # All land starts as reed beds (forest/vegetation default)
    biomes_out[is_land_bio] = BIOME_REED_BEDS

    # Max slope from 4 cardinal neighbors
    pad_b    = np.pad(elevs, 1, mode='edge')
    max_slope = np.zeros((gs, gs), dtype=np.float32)
    for dr, dc in [(-1, 0), (1, 0), (0, -1), (0, 1)]:
        nb_b = pad_b[1 + dr:gs + 1 + dr, 1 + dc:gs + 1 + dc]
        max_slope = np.maximum(max_slope, np.abs(elevs - nb_b))

    # Water adjacency (8-neighbor) for coastal detection
    water_f = (~is_land_bio).astype(np.float32)
    wpad    = np.pad(water_f, 1, mode='constant')
    wadj    = (wpad[:-2, 1:-1] + wpad[2:, 1:-1] + wpad[1:-1, :-2] + wpad[1:-1, 2:] +
               wpad[:-2, :-2] + wpad[:-2, 2:]   + wpad[2:, :-2]   + wpad[2:, 2:]) > 0
    near_w  = wadj

    # Two-tile water proximity (for second beach ring)
    nwf    = near_w.astype(np.float32)
    nwpad  = np.pad(nwf, 1, mode='constant')
    near_w2 = (nwpad[:-2, 1:-1] + nwpad[2:, 1:-1] + nwpad[1:-1, :-2] + nwpad[1:-1, 2:]) > 0

    # Volcanic adjacency (for rocky spread near summits)
    volf   = volcanic_mask.astype(np.float32)
    volpad = np.pad(volf, 1, mode='constant')
    near_vol = (volpad[:-2, 1:-1] + volpad[2:, 1:-1] + volpad[1:-1, :-2] + volpad[1:-1, 2:] +
                volpad[:-2, :-2] + volpad[:-2, 2:]   + volpad[2:, :-2]   + volpad[2:, 2:]) > 0

    inland = is_land_bio & (~near_w) & (~near_w2)

    # Rocky: volcanic summits (steep volcanic tiles only) + very steep inland.
    # volcanic_mask marks the whole edifice base — only its steep portions are rocky.
    # Coastal slope is just the land→water drop, not a real cliff, so exclude near_w.
    # Thresholds: 0.04 for steep-volcanic, 0.06 for generic inland cliff.
    rocky = is_land_bio & (
        (volcanic_mask & inland & (max_slope > 0.04)) |
        (near_vol & inland & (max_slope > 0.04)) |
        (inland & (max_slope > 0.06))
    )
    biomes_out[rocky] = BIOME_ROCKY_SHORE

    # Coastal tidal flats: land touching water, not rocky
    coastal = is_land_bio & near_w & (~rocky)
    biomes_out[coastal] = BIOME_TIDAL_FLATS

    # Second beach ring: low-elevation land near coastal tiles
    cf    = coastal.astype(np.float32)
    cpad  = np.pad(cf, 1, mode='constant')
    near_coast = (cpad[:-2, 1:-1] + cpad[2:, 1:-1] + cpad[1:-1, :-2] + cpad[1:-1, 2:] +
                  cpad[:-2, :-2] + cpad[:-2, 2:]   + cpad[2:, :-2]   + cpad[2:, 2:]) > 0
    buf_beach = is_land_bio & near_coast & (~rocky) & (~coastal) & (elevs < 0.28)
    biomes_out[buf_beach] = BIOME_TIDAL_FLATS

    # Valley forest: inland non-rocky tiles with significant drainage flow.
    # High drainage_area → upstream basin collects here → valley/riparian.
    valley_land   = is_land_bio & (~rocky) & (~coastal) & (~buf_beach)
    valley_forest = valley_land & (drainage_area > 3.0)
    biomes_out[valley_forest] = BIOME_REED_BEDS

    # Open flats: inland, low drainage, moderate elevation → tidal flats
    open_flats = valley_land & (~valley_forest) & (elevs < 0.35)
    biomes_out[open_flats] = BIOME_TIDAL_FLATS

    # Safety net: any remaining unassigned land → reed beds
    biomes_out[is_land_bio & (biomes_out == 0)] = BIOME_REED_BEDS

    return TerrainResult(
        elevations    = elevs,
        biomes        = biomes_out,
        flow_dir      = flow_dir,
        drainage_area = drainage_area,
        basin_id      = basin_id,
        volcanic_mask = volcanic_mask,
        peak_locations = peak_locations,
        sea_level     = SEA_LEVEL,
    )
