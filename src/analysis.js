/**
 * Analysis & observation tools — the core game experience.
 *
 * Phases:
 *   1. Trait Distribution Histograms
 *   2. Correlation Explorer (scatter plot)
 *   3. Region Comparison
 *   5. Enhanced Map Overlays
 *   6. Species Detail Modal
 *
 * All rendering is Canvas 2D. All data is read-only from SharedArrayBuffer views.
 */

import { TRAIT, SPECIES_COUNT, TRAITS_PER_SPECIES } from './layout.js';

// ── Constants ──
const SPECIES_COLORS = ['#DDC165', '#C0392B', '#2ECC71', '#E5591C', '#9B59B6'];
const SPECIES_NAMES = ['Velothrix', 'Leviathan', 'Crawler', 'Crab', 'Worm'];
const SPECIES_FULL = ['Velothrix aurantis', 'Kelp Leviathan', 'Reed Crawler', 'Tidal Crab', 'Bioluminescent Worm'];
const UNIVERSAL_TRAIT_NAMES = ['Clutch Size', 'Longevity', 'Mutation Rate', 'Metabolism', 'Migration'];
const SPECIES_TRAIT_NAMES = ['Crest Brightness', 'Hunting Range', 'Burrowing Depth', 'Shell Thickness', 'Glow Intensity'];
const ALL_TRAIT_NAMES = [...UNIVERSAL_TRAIT_NAMES, 'Species-Specific'];
const BIOME_NAMES = ['Deep Water', 'Shallow Marsh', 'Reed Beds', 'Tidal Flats', 'Rocky Shore'];
const NUM_BINS = 20;

// ── Helpers ──
function hexToRgb(hex) {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}
function hexToRgba(hex, a) {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}
function getStyle() {
  const s = getComputedStyle(document.documentElement);
  return {
    card: s.getPropertyValue('--card').trim() || '#2a1500',
    bg: s.getPropertyValue('--bg').trim() || '#1A0D00',
    bgDark: s.getPropertyValue('--bg-dark').trim() || '#120800',
    border: s.getPropertyValue('--border').trim() || '#3d2200',
    dim: s.getPropertyValue('--dim').trim() || '#7a5a2a',
    gold: s.getPropertyValue('--gold').trim() || '#DDC165',
    goldLight: s.getPropertyValue('--gold-light').trim() || '#FFE9A3',
    goldDim: s.getPropertyValue('--gold-dim').trim() || '#a08940',
    text: s.getPropertyValue('--text').trim() || '#DDC165',
    orange: s.getPropertyValue('--orange').trim() || '#E5591C',
    red: s.getPropertyValue('--red').trim() || '#C0392B',
    green: s.getPropertyValue('--green').trim() || '#6aaa64',
    blue: s.getPropertyValue('--blue').trim() || '#4a9eff',
  };
}
function setupCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  if (canvas.width !== rect.width * dpr || canvas.height !== rect.height * dpr) {
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w: rect.width, h: rect.height, dpr };
}

// ════════════════════════════════════════════════════════════════════
// PHASE 1: TRAIT DISTRIBUTION HISTOGRAMS
// ════════════════════════════════════════════════════════════════════

let selectedHistSpecies = 0; // which species is selected for histogram view

export function setHistSpecies(s) { selectedHistSpecies = s; }
export function getHistSpecies() { return selectedHistSpecies; }

/**
 * Compute histogram data for a given species and trait across all tiles.
 * Returns { bins: number[], binEdges: number[], mean, variance, skew, totalPop }
 */
function computeTraitHistogram(views, layout, species, traitIdx) {
  const gs = layout.gridSize;
  const G2 = gs * gs;
  const T = layout.traitsPerSpecies;
  const bins = new Float64Array(NUM_BINS);
  let sum = 0, sumSq = 0, sumCube = 0, totalPop = 0;

  for (let i = 0; i < G2; i++) {
    const pop = views.populations[i * SPECIES_COUNT + species];
    if (pop <= 0) continue;
    const val = views.traitMeans[(i * SPECIES_COUNT + species) * T + traitIdx];
    if (isNaN(val)) continue;
    const clamped = Math.max(0, Math.min(0.9999, val));
    const bin = Math.floor(clamped * NUM_BINS);
    bins[bin] += pop;
    sum += val * pop;
    sumSq += val * val * pop;
    sumCube += val * val * val * pop;
    totalPop += pop;
  }

  const mean = totalPop > 0 ? sum / totalPop : 0.5;
  const variance = totalPop > 0 ? (sumSq / totalPop) - mean * mean : 0;
  const stdDev = Math.sqrt(Math.max(0, variance));
  let skew = 0;
  if (totalPop > 0 && stdDev > 0.001) {
    skew = ((sumCube / totalPop) - 3 * mean * variance - mean * mean * mean) / (stdDev * stdDev * stdDev);
  }

  return { bins: Array.from(bins), mean, variance, skew, stdDev, totalPop };
}

/**
 * Render trait histograms for the selected species.
 * Canvas layout: 6 small histograms (3×2 grid) for the 6 traits.
 */
export function renderTraitHistograms(canvas, views, layout) {
  if (!canvas || !views) return;
  const { ctx, w, h } = setupCanvas(canvas);
  const st = getStyle();

  ctx.fillStyle = st.card;
  ctx.fillRect(0, 0, w, h);

  const s = selectedHistSpecies;
  const color = SPECIES_COLORS[s];
  const [cr, cg, cb] = hexToRgb(color);

  // Grid: 3 columns, 2 rows
  const cols = 3, rows = 2;
  const gap = 6;
  const cellW = (w - gap * (cols + 1)) / cols;
  const cellH = (h - gap * (rows + 1)) / rows;
  const pad = { l: 4, r: 2, t: 14, b: 10 };

  for (let t = 0; t < 6; t++) {
    const col = t % cols;
    const row = Math.floor(t / cols);
    const cx = gap + col * (cellW + gap);
    const cy = gap + row * (cellH + gap);
    const cw = cellW - pad.l - pad.r;
    const ch = cellH - pad.t - pad.b;

    // Cell background
    ctx.fillStyle = st.bgDark;
    ctx.fillRect(cx, cy, cellW, cellH);
    ctx.strokeStyle = st.border;
    ctx.lineWidth = 0.5;
    ctx.strokeRect(cx, cy, cellW, cellH);

    // Title
    const traitName = t < 5 ? UNIVERSAL_TRAIT_NAMES[t] : SPECIES_TRAIT_NAMES[s];
    ctx.font = '8px monospace';
    ctx.fillStyle = st.dim;
    ctx.textAlign = 'left';
    ctx.fillText(traitName, cx + pad.l, cy + 10);

    const hist = computeTraitHistogram(views, layout, s, t);
    if (hist.totalPop === 0) {
      ctx.fillStyle = st.dim;
      ctx.textAlign = 'center';
      ctx.fillText('No data', cx + cellW / 2, cy + cellH / 2);
      continue;
    }

    // Find max bin for scaling
    let maxBin = 1;
    for (const b of hist.bins) if (b > maxBin) maxBin = b;

    const barW = cw / NUM_BINS;
    const ox = cx + pad.l;
    const oy = cy + pad.t;

    // Draw bars
    for (let b = 0; b < NUM_BINS; b++) {
      const barH = (hist.bins[b] / maxBin) * ch;
      if (barH < 0.5) continue;
      const bx = ox + b * barW;
      const by = oy + ch - barH;

      // Glow
      ctx.fillStyle = `rgba(${cr},${cg},${cb},0.12)`;
      ctx.fillRect(bx - 1, by - 2, barW + 2, barH + 2);

      // Bar
      ctx.fillStyle = `rgba(${cr},${cg},${cb},0.7)`;
      ctx.fillRect(bx + 0.5, by, Math.max(1, barW - 1), barH);
    }

    // Mean indicator (vertical line)
    const meanX = ox + hist.mean * cw;
    ctx.strokeStyle = st.goldLight;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 2]);
    ctx.beginPath();
    ctx.moveTo(meanX, oy);
    ctx.lineTo(meanX, oy + ch);
    ctx.stroke();
    ctx.setLineDash([]);

    // Variance band (±1 stddev)
    if (hist.stdDev > 0.005) {
      const lo = ox + Math.max(0, hist.mean - hist.stdDev) * cw;
      const hi = ox + Math.min(1, hist.mean + hist.stdDev) * cw;
      ctx.fillStyle = `rgba(${cr},${cg},${cb},0.08)`;
      ctx.fillRect(lo, oy, hi - lo, ch);
    }

    // Stats text
    ctx.font = '7px monospace';
    ctx.fillStyle = st.goldDim;
    ctx.textAlign = 'right';
    ctx.fillText(`μ=${hist.mean.toFixed(2)} σ=${hist.stdDev.toFixed(2)}`, cx + cellW - pad.r, cy + cellH - 2);

    // Skew indicator (small arrow)
    if (Math.abs(hist.skew) > 0.3) {
      ctx.fillStyle = st.goldDim;
      ctx.textAlign = 'left';
      const skLabel = hist.skew > 0 ? 'skew→' : '←skew';
      ctx.fillText(skLabel, cx + pad.l, cy + cellH - 2);
    }

    // Baseline
    ctx.strokeStyle = st.border;
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(ox, oy + ch);
    ctx.lineTo(ox + cw, oy + ch);
    ctx.stroke();

    // Axis labels (0, 0.5, 1.0)
    ctx.font = '6px monospace';
    ctx.fillStyle = st.dim;
    ctx.textAlign = 'center';
    ctx.fillText('0', ox, oy + ch + 8);
    ctx.fillText('.5', ox + cw * 0.5, oy + ch + 8);
    ctx.fillText('1', ox + cw, oy + ch + 8);
  }
}

/**
 * Render species selector buttons for the traits tab.
 */
export function renderTraitSpeciesSelector(container, onSelect) {
  container.innerHTML = '';
  for (let s = 0; s < SPECIES_COUNT; s++) {
    const btn = document.createElement('button');
    btn.className = 'trait-sp-btn' + (s === selectedHistSpecies ? ' active' : '');
    btn.style.borderColor = SPECIES_COLORS[s];
    btn.textContent = SPECIES_NAMES[s];
    btn.dataset.species = s;
    btn.addEventListener('click', () => {
      selectedHistSpecies = s;
      container.querySelectorAll('.trait-sp-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      if (onSelect) onSelect(s);
    });
    container.appendChild(btn);
  }
}


// ════════════════════════════════════════════════════════════════════
// PHASE 2: CORRELATION EXPLORER
// ════════════════════════════════════════════════════════════════════

const METRIC_DEFS = [
  // Traits (per tile per species)
  { id: 'clutch',    label: 'Clutch Size',     get: (v, l, i, s) => v.traitMeans[(i * SPECIES_COUNT + s) * l.traitsPerSpecies + TRAIT.CLUTCH_SIZE] },
  { id: 'longevity', label: 'Longevity',       get: (v, l, i, s) => v.traitMeans[(i * SPECIES_COUNT + s) * l.traitsPerSpecies + TRAIT.LONGEVITY] },
  { id: 'mutation',  label: 'Mutation Rate',   get: (v, l, i, s) => v.traitMeans[(i * SPECIES_COUNT + s) * l.traitsPerSpecies + TRAIT.MUTATION_RATE] },
  { id: 'metabolism',label: 'Metabolism',       get: (v, l, i, s) => v.traitMeans[(i * SPECIES_COUNT + s) * l.traitsPerSpecies + TRAIT.METABOLISM] },
  { id: 'migration', label: 'Migration',       get: (v, l, i, s) => v.traitMeans[(i * SPECIES_COUNT + s) * l.traitsPerSpecies + TRAIT.MIGRATION_TENDENCY] },
  { id: 'specific',  label: 'Species Trait',   get: (v, l, i, s) => v.traitMeans[(i * SPECIES_COUNT + s) * l.traitsPerSpecies + TRAIT.SPECIES_SPECIFIC] },
  // Environmental (per tile)
  { id: 'elevation', label: 'Elevation',       get: (v, l, i) => v.elevations[i] },
  { id: 'vegetation',label: 'Vegetation',      get: (v, l, i) => v.vegetation[i] },
  { id: 'population',label: 'Population',      get: (v, l, i, s) => v.populations[i * SPECIES_COUNT + s] },
];

let corrMetricX = 'elevation';
let corrMetricY = 'specific';

export function setCorrMetrics(x, y) { corrMetricX = x; corrMetricY = y; }

const PRESETS = [
  { label: 'Crest Brightness vs Predation', x: 'specific', y: 'population', note: 'Velothrix vs Leviathan density' },
  { label: 'Burrowing Depth vs Elevation', x: 'specific', y: 'elevation', note: 'Reed Crawler adaptation to terrain' },
  { label: 'Shell Thickness vs Tidal Zone', x: 'specific', y: 'elevation', note: 'Tidal Crab coastal adaptation' },
  { label: 'Glow Intensity vs Predator Density', x: 'specific', y: 'population', note: 'Bioluminescent Worm defense' },
  { label: 'Metabolism vs Vegetation', x: 'metabolism', y: 'vegetation' },
  { label: 'Migration vs Elevation', x: 'migration', y: 'elevation' },
  { label: 'Clutch Size vs Population', x: 'clutch', y: 'population' },
];

export function getPresets() { return PRESETS; }

/**
 * Render correlation scatter plot.
 */
export function renderCorrelationPlot(canvas, views, layout) {
  if (!canvas || !views) return;
  const { ctx, w, h } = setupCanvas(canvas);
  const st = getStyle();

  ctx.fillStyle = st.card;
  ctx.fillRect(0, 0, w, h);

  const gs = layout.gridSize;
  const G2 = gs * gs;
  const mxDef = METRIC_DEFS.find(m => m.id === corrMetricX);
  const myDef = METRIC_DEFS.find(m => m.id === corrMetricY);
  if (!mxDef || !myDef) return;

  const pad = { l: 36, r: 12, t: 12, b: 28 };
  const cw = w - pad.l - pad.r;
  const ch = h - pad.t - pad.b;

  // Collect data points: one per (tile, species) with pop > 0
  const points = [];
  let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;

  for (let i = 0; i < G2; i++) {
    for (let s = 0; s < SPECIES_COUNT; s++) {
      const pop = views.populations[i * SPECIES_COUNT + s];
      if (pop <= 0) continue;
      const xVal = mxDef.get(views, layout, i, s);
      const yVal = myDef.get(views, layout, i, s);
      if (isNaN(xVal) || isNaN(yVal)) continue;
      points.push({ x: xVal, y: yVal, pop, species: s, tile: i });
      if (xVal < xMin) xMin = xVal;
      if (xVal > xMax) xMax = xVal;
      if (yVal < yMin) yMin = yVal;
      if (yVal > yMax) yMax = yVal;
    }
  }

  if (points.length === 0) {
    ctx.fillStyle = st.dim;
    ctx.font = '10px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('No data', w / 2, h / 2);
    return;
  }

  // Add padding to ranges
  const xRange = (xMax - xMin) || 1;
  const yRange = (yMax - yMin) || 1;
  xMin -= xRange * 0.05;
  xMax += xRange * 0.05;
  yMin -= yRange * 0.05;
  yMax += yRange * 0.05;

  // Grid lines
  ctx.strokeStyle = st.border;
  ctx.lineWidth = 0.5;
  ctx.font = '7px monospace';
  ctx.fillStyle = st.dim;

  for (let i = 0; i <= 4; i++) {
    const frac = i / 4;
    // Vertical
    const gx = pad.l + frac * cw;
    ctx.beginPath(); ctx.moveTo(gx, pad.t); ctx.lineTo(gx, pad.t + ch); ctx.stroke();
    ctx.textAlign = 'center';
    ctx.fillText((xMin + frac * (xMax - xMin)).toFixed(2), gx, pad.t + ch + 10);
    // Horizontal
    const gy = pad.t + (1 - frac) * ch;
    ctx.beginPath(); ctx.moveTo(pad.l, gy); ctx.lineTo(pad.l + cw, gy); ctx.stroke();
    ctx.textAlign = 'right';
    ctx.fillText((yMin + frac * (yMax - yMin)).toFixed(2), pad.l - 3, gy + 3);
  }

  // Axis labels
  ctx.font = '8px monospace';
  ctx.fillStyle = st.dim;
  ctx.textAlign = 'center';
  ctx.fillText(mxDef.label, pad.l + cw / 2, h - 3);
  ctx.save();
  ctx.translate(8, pad.t + ch / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText(myDef.label, 0, 0);
  ctx.restore();

  // Compute regression
  let sx = 0, sy = 0, sxx = 0, sxy = 0, n = points.length;
  for (const p of points) { sx += p.x; sy += p.y; sxx += p.x * p.x; sxy += p.x * p.y; }
  const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx || 1);
  const intercept = (sy - slope * sx) / n;
  // R²
  const yMean = sy / n;
  let ssTot = 0, ssRes = 0;
  for (const p of points) {
    ssTot += (p.y - yMean) ** 2;
    ssRes += (p.y - (slope * p.x + intercept)) ** 2;
  }
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;

  // Regression line
  const rx1 = xMin, ry1 = slope * rx1 + intercept;
  const rx2 = xMax, ry2 = slope * rx2 + intercept;
  const toScreenX = x => pad.l + ((x - xMin) / (xMax - xMin)) * cw;
  const toScreenY = y => pad.t + ch - ((y - yMin) / (yMax - yMin)) * ch;

  ctx.strokeStyle = hexToRgba(st.gold, 0.4);
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.moveTo(toScreenX(rx1), toScreenY(ry1));
  ctx.lineTo(toScreenX(rx2), toScreenY(ry2));
  ctx.stroke();
  ctx.setLineDash([]);

  // R² label
  ctx.font = '8px monospace';
  ctx.fillStyle = st.goldDim;
  ctx.textAlign = 'right';
  ctx.fillText(`R² = ${r2.toFixed(3)}  n=${n}`, pad.l + cw, pad.t - 2);

  // Plot dots (subsample if too many)
  const maxDots = 800;
  const stride = points.length > maxDots ? Math.ceil(points.length / maxDots) : 1;
  let maxPop = 1;
  for (const p of points) if (p.pop > maxPop) maxPop = p.pop;

  for (let i = 0; i < points.length; i += stride) {
    const p = points[i];
    const px = toScreenX(p.x);
    const py = toScreenY(p.y);
    const radius = 1.5 + (p.pop / maxPop) * 3;
    const color = SPECIES_COLORS[p.species];

    // Glow
    ctx.beginPath();
    ctx.arc(px, py, radius + 2, 0, Math.PI * 2);
    ctx.fillStyle = hexToRgba(color, 0.08);
    ctx.fill();

    // Dot
    ctx.beginPath();
    ctx.arc(px, py, radius, 0, Math.PI * 2);
    ctx.fillStyle = hexToRgba(color, 0.55);
    ctx.fill();
  }
}

/**
 * Populate metric selector dropdowns.
 */
export function populateMetricSelectors(selectX, selectY, onChange) {
  for (const sel of [selectX, selectY]) {
    sel.innerHTML = '';
    for (const m of METRIC_DEFS) {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.label;
      sel.appendChild(opt);
    }
  }
  selectX.value = corrMetricX;
  selectY.value = corrMetricY;

  selectX.addEventListener('change', () => { corrMetricX = selectX.value; onChange?.(); });
  selectY.addEventListener('change', () => { corrMetricY = selectY.value; onChange?.(); });
}

export function applyPreset(preset, selectX, selectY, onChange) {
  corrMetricX = preset.x;
  corrMetricY = preset.y;
  selectX.value = preset.x;
  selectY.value = preset.y;
  onChange?.();
}


// ════════════════════════════════════════════════════════════════════
// PHASE 3: REGION COMPARISON
// ════════════════════════════════════════════════════════════════════

let regionA = null; // { r, c } tile coordinates
let regionB = null;
let regionSelectMode = false; // 'a' | 'b' | false

export function startRegionSelect(which) { regionSelectMode = which; }
export function getRegionSelectMode() { return regionSelectMode; }
export function getRegions() { return { a: regionA, b: regionB }; }

export function setRegionTile(r, c) {
  if (regionSelectMode === 'a') { regionA = { r, c }; regionSelectMode = 'b'; }
  else if (regionSelectMode === 'b') { regionB = { r, c }; regionSelectMode = false; }
}
export function clearRegions() { regionA = null; regionB = null; regionSelectMode = false; }

/**
 * Render region comparison panel.
 */
export function renderRegionComparison(canvas, views, layout) {
  if (!canvas || !views) return;
  const { ctx, w, h } = setupCanvas(canvas);
  const st = getStyle();

  ctx.fillStyle = st.card;
  ctx.fillRect(0, 0, w, h);

  if (!regionA && !regionB) {
    ctx.fillStyle = st.dim;
    ctx.font = '10px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('Click "Select Region A" then click a tile on the map.', w / 2, h / 2 - 10);
    ctx.fillText('Then select Region B to compare.', w / 2, h / 2 + 8);
    return;
  }

  const gs = layout.gridSize;
  const T = layout.traitsPerSpecies;
  const regions = [];
  if (regionA) regions.push({ label: 'Region A', ...regionA });
  if (regionB) regions.push({ label: 'Region B', ...regionB });

  const colW = regions.length === 2 ? w / 2 - 4 : w - 8;
  const pad = { l: 4, t: 8, r: 4 };

  for (let ri = 0; ri < regions.length; ri++) {
    const reg = regions[ri];
    const ox = ri * (colW + 8) + pad.l;
    const idx = reg.r * gs + reg.c;

    // Header
    ctx.fillStyle = st.goldLight;
    ctx.font = '9px monospace';
    ctx.textAlign = 'left';
    ctx.fillText(`${reg.label} — Tile (${reg.r}, ${reg.c})`, ox, pad.t + 8);

    // Environment
    const elev = views.elevations[idx];
    const biome = views.biomes[idx];
    const veg = views.vegetation[idx];
    let yOff = pad.t + 22;

    ctx.fillStyle = st.dim;
    ctx.font = '8px monospace';
    ctx.fillText(`Elev: ${elev.toFixed(2)}  Biome: ${BIOME_NAMES[biome] || '?'}  Veg: ${veg.toFixed(2)}`, ox, yOff);
    yOff += 14;

    // Species data
    for (let s = 0; s < SPECIES_COUNT; s++) {
      const pop = views.populations[idx * SPECIES_COUNT + s];
      ctx.fillStyle = pop > 0 ? SPECIES_COLORS[s] : st.dim;
      ctx.font = '8px monospace';
      ctx.fillText(`${SPECIES_NAMES[s]}: ${pop}`, ox, yOff);
      yOff += 11;

      if (pop > 0) {
        // Mini trait bar
        for (let t = 0; t < 6; t++) {
          const val = views.traitMeans[(idx * SPECIES_COUNT + s) * T + t];
          const barX = ox + 60 + t * 22;
          const barW = 18;
          const barH = 4;
          ctx.fillStyle = st.border;
          ctx.fillRect(barX, yOff - 8, barW, barH);
          ctx.fillStyle = hexToRgba(SPECIES_COLORS[s], 0.6);
          ctx.fillRect(barX, yOff - 8, barW * val, barH);
        }
      }
    }

    // Divider
    if (ri === 0 && regions.length === 2) {
      ctx.strokeStyle = st.border;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(colW + 4, pad.t);
      ctx.lineTo(colW + 4, h - 4);
      ctx.stroke();
    }
  }

  // Genetic distance (Fst proxy) if both regions selected
  if (regionA && regionB) {
    const idxA = regionA.r * gs + regionA.c;
    const idxB = regionB.r * gs + regionB.c;
    let yOff = h - 80;

    ctx.fillStyle = st.goldDim;
    ctx.font = '8px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('── Genetic Distance (Fst proxy) ──', w / 2, yOff);
    yOff += 12;

    const SPECIATION_THRESHOLD = 0.25; // Fst > 0.25 = very high divergence

    for (let s = 0; s < SPECIES_COUNT; s++) {
      const popA = views.populations[idxA * SPECIES_COUNT + s];
      const popB = views.populations[idxB * SPECIES_COUNT + s];
      if (popA <= 0 || popB <= 0) continue;

      // Fst proxy: mean |trait_diff| / pooled_stddev per trait, then average
      let fstSum = 0;
      let fstCount = 0;
      for (let t = 0; t < 6; t++) {
        const meanA = views.traitMeans[(idxA * SPECIES_COUNT + s) * T + t];
        const meanB = views.traitMeans[(idxB * SPECIES_COUNT + s) * T + t];
        const varA = views.traitVar[(idxA * SPECIES_COUNT + s) * T + t];
        const varB = views.traitVar[(idxB * SPECIES_COUNT + s) * T + t];
        // Pooled variance
        const pooledVar = (varA * popA + varB * popB) / (popA + popB);
        const pooledStd = Math.sqrt(Math.max(0.0001, pooledVar));
        const diff = Math.abs(meanA - meanB);
        fstSum += diff / pooledStd;
        fstCount++;
      }
      const fst = fstCount > 0 ? fstSum / fstCount : 0;
      const exceeds = fst > SPECIATION_THRESHOLD;

      // Draw Fst value with speciation highlight
      if (exceeds) {
        // Glow background for speciation alert
        ctx.fillStyle = hexToRgba(st.gold, 0.12);
        ctx.fillRect(w / 2 - 100, yOff - 9, 200, 13);
        ctx.strokeStyle = st.gold;
        ctx.lineWidth = 0.5;
        ctx.strokeRect(w / 2 - 100, yOff - 9, 200, 13);
      }

      ctx.fillStyle = exceeds ? st.goldLight : SPECIES_COLORS[s];
      ctx.font = exceeds ? 'bold 8px monospace' : '8px monospace';
      ctx.fillText(
        `${SPECIES_NAMES[s]}: Fst=${fst.toFixed(3)}${exceeds ? ' ★ DIVERGING' : ''}`,
        w / 2, yOff
      );
      yOff += 13;
    }

    // Legend
    ctx.font = '7px monospace';
    ctx.fillStyle = st.dim;
    ctx.fillText(`Fst > ${SPECIATION_THRESHOLD} suggests speciation potential`, w / 2, yOff + 4);
  }
}


// ════════════════════════════════════════════════════════════════════
// PHASE 5: ENHANCED MAP OVERLAYS
// ════════════════════════════════════════════════════════════════════

let activeOverlay = 'none'; // 'none' | 'diversity' | 'predation' | 'vegetation-stress'
let prevPopulations = null; // snapshot of previous generation for migration diff

export function setOverlay(id) { activeOverlay = id; }
export function getOverlay() { return activeOverlay; }

/**
 * Snapshot current populations for migration diff tracking.
 * Call once per generation from the render loop.
 */
export function snapshotPopulations(views, layout) {
  const G2 = layout.gridSize * layout.gridSize;
  if (!prevPopulations || prevPopulations.length !== G2 * SPECIES_COUNT) {
    prevPopulations = new Uint16Array(G2 * SPECIES_COUNT);
  }
  prevPopulations.set(views.populations.subarray(0, G2 * SPECIES_COUNT));
}

/**
 * Compute overlay data for the active overlay type.
 * Returns Float32Array(G2) with values 0-1 for intensity per tile, or null if overlay is 'none'.
 */
export function computeOverlayData(views, layout) {
  if (activeOverlay === 'none') return null;
  const gs = layout.gridSize;
  const G2 = gs * gs;
  const T = layout.traitsPerSpecies;
  const data = new Float32Array(G2);

  if (activeOverlay === 'diversity') {
    // Genetic diversity: sum of trait variance across all species & traits per tile
    let maxVal = 0;
    for (let i = 0; i < G2; i++) {
      let sumVar = 0;
      for (let s = 0; s < SPECIES_COUNT; s++) {
        const pop = views.populations[i * SPECIES_COUNT + s];
        if (pop <= 0) continue;
        for (let t = 0; t < T; t++) {
          sumVar += views.traitVar[(i * SPECIES_COUNT + s) * T + t];
        }
      }
      data[i] = sumVar;
      if (sumVar > maxVal) maxVal = sumVar;
    }
    if (maxVal > 0) for (let i = 0; i < G2; i++) data[i] /= maxVal;

  } else if (activeOverlay === 'predation') {
    // Predation pressure proxy: Leviathan (species 1, predator) population density
    let maxVal = 0;
    for (let i = 0; i < G2; i++) {
      const pred = views.populations[i * SPECIES_COUNT + 1]; // Leviathan = predator
      data[i] = pred;
      if (pred > maxVal) maxVal = pred;
    }
    if (maxVal > 0) for (let i = 0; i < G2; i++) data[i] /= maxVal;

  } else if (activeOverlay === 'vegetation-stress') {
    // Resource stress: inverse vegetation level (low veg = high stress)
    for (let i = 0; i < G2; i++) {
      data[i] = 1 - Math.min(1, views.vegetation[i]);
    }

  } else if (activeOverlay === 'migration') {
    // Migration: population change magnitude since last snapshot
    if (!prevPopulations) return null;
    let maxVal = 0;
    for (let i = 0; i < G2; i++) {
      let delta = 0;
      for (let s = 0; s < SPECIES_COUNT; s++) {
        const cur = views.populations[i * SPECIES_COUNT + s];
        const prev = prevPopulations[i * SPECIES_COUNT + s];
        delta += Math.abs(cur - prev);
      }
      data[i] = delta;
      if (delta > maxVal) maxVal = delta;
    }
    if (maxVal > 0) for (let i = 0; i < G2; i++) data[i] /= maxVal;
  }

  return data;
}

/**
 * Get overlay color for a tile given its intensity (0-1).
 */
export function getOverlayColor(intensity) {
  if (intensity <= 0) return null;
  if (activeOverlay === 'diversity') {
    return `rgba(100,220,255,${intensity * 0.5})`;
  } else if (activeOverlay === 'predation') {
    return `rgba(220,50,40,${intensity * 0.5})`;
  } else if (activeOverlay === 'vegetation-stress') {
    return `rgba(229,89,28,${intensity * 0.4})`;
  } else if (activeOverlay === 'migration') {
    return `rgba(255,255,100,${intensity * 0.45})`;
  }
  return null;
}


// ════════════════════════════════════════════════════════════════════
// PHASE 6: SPECIES DETAIL MODAL
// ════════════════════════════════════════════════════════════════════

/**
 * Compute detailed data for a species to populate the detail modal.
 */
export function computeSpeciesDetail(views, layout, speciesIdx, popHistory, traitHistory) {
  const gs = layout.gridSize;
  const G2 = gs * gs;
  const T = layout.traitsPerSpecies;
  const s = speciesIdx;

  // Total population
  let totalPop = 0;
  let tileCount = 0;
  const spatialGrid = new Float32Array(G2); // normalized pop per tile

  let maxTilePop = 0;
  for (let i = 0; i < G2; i++) {
    const pop = views.populations[i * SPECIES_COUNT + s];
    spatialGrid[i] = pop;
    totalPop += pop;
    if (pop > 0) tileCount++;
    if (pop > maxTilePop) maxTilePop = pop;
  }
  // Normalize
  if (maxTilePop > 0) for (let i = 0; i < G2; i++) spatialGrid[i] /= maxTilePop;

  // Mean traits (population-weighted)
  const meanTraits = new Float64Array(6);
  for (let t = 0; t < 6; t++) {
    let sumT = 0, sumP = 0;
    for (let i = 0; i < G2; i++) {
      const pop = views.populations[i * SPECIES_COUNT + s];
      if (pop <= 0) continue;
      sumT += views.traitMeans[(i * SPECIES_COUNT + s) * T + t] * pop;
      sumP += pop;
    }
    meanTraits[t] = sumP > 0 ? sumT / sumP : 0.5;
  }

  // Genetic diversity (mean trait variance)
  let meanVar = 0, varCount = 0;
  for (let i = 0; i < G2; i++) {
    const pop = views.populations[i * SPECIES_COUNT + s];
    if (pop <= 0) continue;
    for (let t = 0; t < 6; t++) {
      meanVar += views.traitVar[(i * SPECIES_COUNT + s) * T + t];
      varCount++;
    }
  }
  const geneticDiversity = varCount > 0 ? meanVar / varCount : 0;

  // Extinction risk based on population trend + diversity + habitat
  let risk = 0;
  if (totalPop === 0) { risk = 1; }
  else {
    // Low population
    if (totalPop < 100) risk += 0.4;
    else if (totalPop < 500) risk += 0.15;
    // Low diversity
    if (geneticDiversity < 0.01) risk += 0.25;
    // Shrinking habitat
    if (tileCount <= 2) risk += 0.2;
    // Declining trend (from pop history)
    if (popHistory && popHistory.length >= 10) {
      const recent = popHistory.slice(-10);
      const first = recent[0].pops[s];
      const last = recent[recent.length - 1].pops[s];
      if (first > 0 && last < first * 0.5) risk += 0.2;
    }
    risk = Math.min(1, risk);
  }

  // Trait sparklines from history
  const sparklines = [];
  if (traitHistory && traitHistory.length > 1) {
    for (let t = 0; t < 5; t++) {
      const vals = traitHistory.map(h => h.traits[s * 5 + t]).filter(v => !isNaN(v));
      sparklines.push(vals);
    }
  }

  // Pop sparkline from history
  const popSparkline = popHistory ? popHistory.map(h => h.pops[s]) : [];

  return {
    speciesIdx: s,
    name: SPECIES_FULL[s],
    shortName: SPECIES_NAMES[s],
    color: SPECIES_COLORS[s],
    totalPop,
    tileCount,
    meanTraits,
    geneticDiversity,
    extinctionRisk: risk,
    spatialGrid,
    gridSize: gs,
    sparklines,
    popSparkline,
    speciesTraitName: SPECIES_TRAIT_NAMES[s],
  };
}

/**
 * Render species detail modal content onto the provided canvas.
 */
export function renderSpeciesDetail(canvas, detail, drawPortraitFn) {
  if (!canvas || !detail) return;
  const { ctx, w, h } = setupCanvas(canvas);
  const st = getStyle();
  const [cr, cg, cb] = hexToRgb(detail.color);

  // Background
  ctx.fillStyle = st.bgDark;
  ctx.fillRect(0, 0, w, h);

  // Subtle border glow
  ctx.strokeStyle = hexToRgba(detail.color, 0.3);
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, w - 2, h - 2);

  const extinct = detail.totalPop === 0;

  // ── Left column: portrait + name ──
  const portraitSize = 80;
  const px = 20, py = 20;

  // Portrait background
  ctx.fillStyle = st.card;
  ctx.fillRect(px - 2, py - 2, portraitSize + 4, portraitSize + 4);
  ctx.strokeStyle = detail.color;
  ctx.lineWidth = 1;
  ctx.strokeRect(px - 2, py - 2, portraitSize + 4, portraitSize + 4);

  // Draw portrait
  if (drawPortraitFn) {
    ctx.save();
    ctx.translate(px, py);
    drawPortraitFn(ctx, detail.speciesIdx, detail.meanTraits[5], portraitSize, detail.color);
    ctx.restore();
  }

  // Species name
  ctx.font = '14px monospace';
  ctx.fillStyle = extinct ? st.dim : detail.color;
  ctx.textAlign = 'left';
  ctx.fillText(detail.name, px + portraitSize + 16, py + 18);
  if (extinct) {
    ctx.fillStyle = st.red;
    ctx.font = '10px monospace';
    ctx.fillText('EXTINCT', px + portraitSize + 16, py + 34);
  }

  // Population
  ctx.font = '11px monospace';
  ctx.fillStyle = st.goldLight;
  ctx.fillText(`Population: ${detail.totalPop.toLocaleString()}`, px + portraitSize + 16, py + extinct ? 50 : 38);
  ctx.fillStyle = st.dim;
  ctx.font = '9px monospace';
  ctx.fillText(`Tiles occupied: ${detail.tileCount}  |  Genetic diversity: ${detail.geneticDiversity.toFixed(4)}`, px + portraitSize + 16, py + (extinct ? 64 : 52));

  // ── Extinction risk bar ──
  const riskX = px + portraitSize + 16;
  const riskY = py + (extinct ? 74 : 64);
  const riskW = 120;
  ctx.fillStyle = st.dim;
  ctx.font = '8px monospace';
  ctx.fillText('Extinction Risk', riskX, riskY);
  ctx.fillStyle = st.border;
  ctx.fillRect(riskX, riskY + 3, riskW, 5);
  const riskColor = detail.extinctionRisk > 0.6 ? st.red : detail.extinctionRisk > 0.3 ? st.orange : st.green;
  ctx.fillStyle = riskColor;
  ctx.fillRect(riskX, riskY + 3, riskW * detail.extinctionRisk, 5);

  // ── Trait values with sparklines ──
  const traitStartY = py + portraitSize + 20;
  const traitNames = [...UNIVERSAL_TRAIT_NAMES, detail.speciesTraitName];

  for (let t = 0; t < 6; t++) {
    const ty = traitStartY + t * 28;
    const val = detail.meanTraits[t];

    // Label
    ctx.font = '8px monospace';
    ctx.fillStyle = st.dim;
    ctx.textAlign = 'left';
    ctx.fillText(traitNames[t], px, ty);

    // Value
    ctx.fillStyle = st.goldLight;
    ctx.textAlign = 'right';
    ctx.fillText(val.toFixed(3), px + 130, ty);

    // Trait bar
    const barX = px + 140;
    const barW = 100;
    ctx.fillStyle = st.border;
    ctx.fillRect(barX, ty - 5, barW, 6);
    ctx.fillStyle = `rgba(${cr},${cg},${cb},0.7)`;
    ctx.fillRect(barX, ty - 5, barW * val, 6);

    // Sparkline (if available, universal traits only t < 5)
    if (t < 5 && detail.sparklines[t] && detail.sparklines[t].length > 2) {
      const spk = detail.sparklines[t];
      const spkX = barX + barW + 10;
      const spkW = w - spkX - 20;
      const spkH = 16;
      const spkY = ty - 10;

      // Background
      ctx.fillStyle = st.card;
      ctx.fillRect(spkX, spkY, spkW, spkH);

      let spkMin = Infinity, spkMax = -Infinity;
      for (const v of spk) { if (v < spkMin) spkMin = v; if (v > spkMax) spkMax = v; }
      const spkRange = spkMax - spkMin || 0.01;

      ctx.strokeStyle = `rgba(${cr},${cg},${cb},0.6)`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i < spk.length; i++) {
        const sx = spkX + (i / (spk.length - 1)) * spkW;
        const sy = spkY + spkH - ((spk[i] - spkMin) / spkRange) * spkH;
        if (i === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
      }
      ctx.stroke();
    }
  }

  // ── Spatial distribution mini-map ──
  const mapSize = Math.min(120, w * 0.25);
  const mapX = w - mapSize - 20;
  const mapY = traitStartY;
  const dgs = detail.gridSize;
  const cellSize = mapSize / dgs;

  ctx.fillStyle = st.card;
  ctx.fillRect(mapX - 2, mapY - 14, mapSize + 4, mapSize + 18);
  ctx.strokeStyle = st.border;
  ctx.strokeRect(mapX - 2, mapY - 14, mapSize + 4, mapSize + 18);
  ctx.fillStyle = st.dim;
  ctx.font = '7px monospace';
  ctx.textAlign = 'left';
  ctx.fillText('Distribution', mapX, mapY - 5);

  for (let r = 0; r < dgs; r++) {
    for (let c = 0; c < dgs; c++) {
      const val = detail.spatialGrid[r * dgs + c];
      if (val <= 0) continue;
      ctx.fillStyle = `rgba(${cr},${cg},${cb},${0.1 + val * 0.8})`;
      ctx.fillRect(mapX + c * cellSize, mapY + r * cellSize, Math.max(1, cellSize), Math.max(1, cellSize));
    }
  }

  // ── Population sparkline ──
  if (detail.popSparkline.length > 2) {
    const popY = mapY + mapSize + 16;
    const popW = mapSize;
    const popH = 30;

    ctx.fillStyle = st.card;
    ctx.fillRect(mapX - 2, popY - 2, popW + 4, popH + 4);
    ctx.strokeStyle = st.border;
    ctx.strokeRect(mapX - 2, popY - 2, popW + 4, popH + 4);

    let pMax = 1;
    for (const v of detail.popSparkline) if (v > pMax) pMax = v;

    ctx.strokeStyle = detail.color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < detail.popSparkline.length; i++) {
      const sx = mapX + (i / (detail.popSparkline.length - 1)) * popW;
      const sy = popY + popH - (detail.popSparkline[i] / pMax) * popH;
      if (i === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
    }
    ctx.stroke();

    ctx.fillStyle = st.dim;
    ctx.font = '7px monospace';
    ctx.textAlign = 'left';
    ctx.fillText('Population history', mapX, popY + popH + 10);
  }
}

// ── Export constants for use by ui.js ──
export { SPECIES_COLORS as ANALYSIS_SPECIES_COLORS, SPECIES_NAMES as ANALYSIS_SPECIES_NAMES };
