/**
 * UI controller — handles DOM interactions, orchestrates sim + renderer.
 * Entry point for the application.
 */

import * as sim from './sim.js';
import { GLOBAL, TRAIT } from './layout.js';
import { THEMES, setTheme, getBiomeColors, getMapBg, getWaterColor, loadSavedTheme } from './themes.js';
import { drawPortrait } from './creatures.js';
import { checkForEntries, getRecent } from './journal.js';
import { MapRenderer } from './render.js';
import * as analysis from './analysis.js';

// ── DOM refs ──
const $ = id => document.getElementById(id);
const loader = $('loader');
const loaderMsg = $('loader-msg');
const loaderFill = $('loader-fill');
const setup = $('setup');
const app = $('app');
const seedInput = $('seed-input');
const genNum = $('gen-num');
const seasonLabel = $('season-label');
const btnPlay = $('btn-play');
const mapCanvas = $('map-canvas');
const popChart = $('pop-chart');
const pentagonChart = $('pentagon-chart');

let gridSize = 128;
let playing = false;
let renderFrameId = null;
let lastRenderedGen = -1;
let mapRenderer = null; // WebGL renderer (null = use Canvas 2D fallback)
let debugMode = true;   // default on

// Camera state
let camTilt = 0.5;   // 0.2 (flat) to 0.8 (steep)
let camZoom = 1.0;
let camPanX = 0;
let camPanY = 0;
let camRotation = 0; // 0-3 = 0°, 90°, 180°, 270°
let isDragging = false;
let dragButton = -1;
let dragLastX = 0;
let dragLastY = 0;

// Population history for chart
const popHistory = [];
const MAX_HISTORY = 300;

// Trait history for selection tab — one entry per sampled generation
// Each entry: { gen, traits: Float32Array(5*5) } — [speciesIdx * 5 + traitIdx]
const traitHistory = [];
let activeTab = 'overview';
const UNIVERSAL_TRAIT_NAMES = ['Clutch Size', 'Longevity', 'Mutation Rate', 'Metabolism', 'Migration'];

// Ghost data: extinct species' last N data points, preserved after death
const ghostData = {}; // species index → [{gen, pop}]
let knownExtinctions = new Set();
const extinctionRecords = []; // {species, name, color, bornGen, diedGen, cause, peakPop}

// Timeline event markers — rendered on the population chart
// Each: { gen, type: 'extinction'|'speciation'|'environmental', label, color }
const timelineEvents = [];

// ── Challenges & Achievements ──
const CHALLENGES = [
  { id: 'conservationist', name: 'The Conservationist', check: (gen, pops, s) => gen >= 3000 && pops.every(p => p > 0) && !s.anyExtinctBefore3k },
  { id: 'diverger',        name: 'The Diverger',        check: (gen, pops, s) => s.speciationGen !== null && s.speciationGen <= 1000 },
  { id: 'perfect',         name: 'Perfect Ecosystem',   check: (gen, pops, s) => gen >= 5000 && pops.every(p => p > 0) && !s.anyExtinct },
  { id: 'resilience',      name: 'Resilience',          check: (gen, pops, s) => s.resilienceAchieved },
  { id: 'speed',           name: 'Speed Observer',      check: (gen, pops, s) => gen >= 10000 },
];

const ACHIEVEMENTS_DEF = [
  { id: 'first-run',        name: 'First Observation',  desc: 'Complete your first run' },
  { id: 'first-extinction', name: 'First Extinction',   desc: 'Witness a species go extinct' },
  { id: 'first-speciation', name: 'First Speciation',   desc: 'Witness a speciation event' },
  { id: 'millennium',       name: 'Millennium',         desc: 'Reach generation 1,000' },
  { id: 'deep-time',        name: 'Deep Time',          desc: 'Reach generation 5,000' },
  { id: 'geological-scale', name: 'Geological Scale',   desc: 'Reach generation 10,000' },
  { id: 'all-present-3k',   name: 'All Present',        desc: 'All 5 species alive at gen 3,000' },
  { id: 'total-wipeout',    name: 'Total Wipeout',      desc: 'Every species goes extinct' },
  { id: 'veteran',          name: 'Veteran Observer',   desc: 'Complete 5 or more observations' },
  { id: 'comeback',         name: 'Against the Odds',   desc: 'A species recovers from near-extinction' },
];

let activeChallenge = -1; // -1 = free, 0–4 = challenge index
let challengeState = resetChallengeState();
let achievementToastQueue = [];
let toastTimeout = null;
let currentGen = 0;

function resetChallengeState() {
  return {
    speciationGen: null,
    resilienceAchieved: false,
    resilienceLowPop: [false, false, false, false, false],
    anyExtinct: false,
    anyExtinctBefore3k: false,
    allAliveAt3k: false,
  };
}

// ── Seed utils ──
function generateSeed() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

window.randomSeed = () => { seedInput.value = generateSeed(); renderPreview(); };
let previewData = null; // cached {elevations, biomes, gridSize} from Python

// ── Setup screen ──
seedInput.value = generateSeed();

document.querySelectorAll('.size-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.size-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    gridSize = parseInt(btn.dataset.size);
  });
});

document.querySelectorAll('.challenge-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.challenge-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeChallenge = parseInt(btn.dataset.challenge);
  });
});

// ── Lab tab switching ──
document.querySelectorAll('.lab-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.lab-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.tab-content').forEach(tc => tc.classList.remove('active'));
    const tabId = 'tab-' + btn.dataset.tab;
    document.getElementById(tabId).classList.add('active');
    activeTab = btn.dataset.tab;
    // Force redraw on tab switch
    if (activeTab === 'selection') renderSelectionCharts();
    if (activeTab === 'life-history') renderLifeHistoryChart();
    if (activeTab === 'stats') renderStatsReadouts();
    if (activeTab === 'traits') renderTraitsTab();
    if (activeTab === 'correlations') renderCorrelationsTab();
    if (activeTab === 'regions') renderRegionsTab();
  });
});

// ── Setup preview ──
const previewCanvas = $('preview-canvas');

let previewPending = false;

async function renderPreview() {
  if (!sim.isPreloaded()) return; // can't render without Pyodide
  if (previewPending) return;     // debounce
  previewPending = true;

  const gs = gridSize;
  const seed = seedInput.value || 'ABC123';

  // Show loading state
  const dpr = window.devicePixelRatio || 1;
  const w = previewCanvas.width = previewCanvas.offsetWidth * dpr;
  const h = previewCanvas.height = previewCanvas.offsetHeight * dpr;
  const ctx = previewCanvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const cw = previewCanvas.offsetWidth;
  const ch = previewCanvas.offsetHeight;
  ctx.fillStyle = getMapBg();
  ctx.fillRect(0, 0, cw, ch);
  ctx.fillStyle = 'rgba(221,193,101,0.3)';
  ctx.font = '11px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('Generating terrain...', cw / 2, ch / 2);

  // Run actual Python terrain gen
  try {
    previewData = await sim.generatePreviewTerrain(gs, seed);
  } catch (e) {
    console.error('Preview terrain gen failed:', e);
    previewPending = false;
    return;
  }

  if (!previewData) { previewPending = false; return; }

  // Simple top-down 2D grid — each tile is a colored square
  ctx.fillStyle = getMapBg();
  ctx.fillRect(0, 0, cw, ch);

  const size = Math.min(cw, ch);
  const tileSize = size / gs;
  const ox = (cw - size) / 2;
  const oy = (ch - size) / 2;

  const WATER_LEVEL = 0.20;
  for (let r = 0; r < gs; r++) {
    for (let c = 0; c < gs; c++) {
      const idx = r * gs + c;
      const e = previewData.elevations[idx];
      const biome = previewData.biomes[idx];

      let cr, cg, cb;
      if (e < 0.08) {
        // Deep water
        cr = 15; cg = 40; cb = 80;
      } else if (e < WATER_LEVEL) {
        // Shallow water
        const t = (e - 0.08) / 0.12;
        cr = 15 + t * 30 | 0; cg = 40 + t * 40 | 0; cb = 80 + t * 40 | 0;
      } else if (biome === 3) {
        // Beach
        cr = 180; cg = 165; cb = 120;
      } else if (biome === 4) {
        // Rocky
        const t = (e - 0.55) / 0.45;
        cr = 70 + t * 20 | 0; cg = 68 + t * 18 | 0; cb = 65 + t * 15 | 0;
      } else {
        // Forest — darker green at higher elevation
        const t = Math.min(1, (e - WATER_LEVEL) / 0.5);
        cr = 30 + t * 20 | 0; cg = 70 + t * 30 | 0; cb = 25 + t * 10 | 0;
      }

      ctx.fillStyle = `rgb(${cr},${cg},${cb})`;
      ctx.fillRect(ox + c * tileSize, oy + r * tileSize, Math.ceil(tileSize), Math.ceil(tileSize));
    }
  }
  previewPending = false;
}

// Trigger preview on seed/size changes (debounced)
let previewTimer = null;
function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(renderPreview, 300);
}
seedInput.addEventListener('input', schedulePreview);
document.querySelectorAll('.size-btn').forEach(b => b.addEventListener('click', () => setTimeout(schedulePreview, 10)));

$('btn-begin').addEventListener('click', async () => {
  debugMode = $('debug-toggle')?.checked ?? true;
  setup.classList.add('hidden');
  loader.classList.remove('hidden');
  loaderFill.style.width = '0%';

  try {
    await sim.init(gridSize, seedInput.value, (phase, pct) => {
      loaderMsg.textContent = {
        pyodide: 'Downloading Python runtime...',
        numpy: 'Loading numpy...',
        buffer: 'Allocating shared memory...',
        sim: 'Initializing simulation...',
        init: 'Seeding populations...',
        ready: 'Ready.',
      }[phase] || phase;
      loaderFill.style.width = pct + '%';
    });

    loader.classList.add('hidden');
    app.classList.remove('hidden');

    // Initialize WebGL renderer
    mapRenderer = new MapRenderer(mapCanvas);
    if (mapRenderer.fallback) {
      console.warn('WebGL init failed, using Canvas 2D fallback');
      mapRenderer = null;
    } else {
      mapRenderer.setup(gridSize);
    }

    // Show active challenge in header
    const badge = $('challenge-badge');
    if (activeChallenge >= 0) {
      badge.textContent = CHALLENGES[activeChallenge].name;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }

    // Show/hide debug panel
    const debugPanel = $('debug-panel');
    if (debugMode && debugPanel) debugPanel.classList.remove('hidden');

    resizeCanvases();
    startRenderLoop();
  } catch (err) {
    loaderMsg.textContent = 'Error: ' + err.message;
    loaderFill.style.width = '100%';
    loaderFill.style.background = '#C0392B';
    console.error(err);
  }
});

// ── History button ──
const btnHistory = $('btn-history');
const hallOverlay = $('hall-overlay');
if (JSON.parse(localStorage.getItem('evosim-hall') || '[]').length) btnHistory.style.display = '';
btnHistory.addEventListener('click', () => { renderHall(); hallOverlay.classList.remove('hidden'); });
$('hall-close').addEventListener('click', () => hallOverlay.classList.add('hidden'));
hallOverlay.addEventListener('click', e => { if (e.target === hallOverlay) hallOverlay.classList.add('hidden'); });

// ── Play/pause controls ──
btnPlay.addEventListener('click', () => {
  playing = sim.togglePause();
  btnPlay.textContent = playing ? '⏸ Pause' : '▶ Play';
  btnPlay.classList.toggle('active', playing);
});

document.querySelectorAll('.speed-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.speed-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    sim.setSpeed(parseInt(btn.dataset.speed));
  });
});

// ── Canvas sizing ──
function resizeCanvases() {
  const dpr = window.devicePixelRatio || 1;

  // Map canvas
  const mapRect = mapCanvas.parentElement.getBoundingClientRect();
  mapCanvas.width = mapRect.width * dpr;
  mapCanvas.height = mapRect.height * dpr;
  mapCanvas.style.width = mapRect.width + 'px';
  mapCanvas.style.height = mapRect.height + 'px';

  // Pop chart
  const chartRect = popChart.parentElement.getBoundingClientRect();
  // Pentagon chart
  const pentRect = pentagonChart.parentElement.getBoundingClientRect();
  pentagonChart.width = pentRect.width * dpr;
  pentagonChart.height = 140 * dpr;

  popChart.width = chartRect.width * dpr;
  popChart.height = 160 * dpr;
}

window.addEventListener('resize', resizeCanvases);

// ── Map camera controls ──
mapCanvas.addEventListener('mousedown', e => {
  isDragging = true;
  dragButton = e.button;
  dragLastX = e.clientX;
  dragLastY = e.clientY;
  e.preventDefault();
});
window.addEventListener('mousemove', e => {
  if (!isDragging) return;
  const dx = e.clientX - dragLastX;
  const dy = e.clientY - dragLastY;
  dragLastX = e.clientX;
  dragLastY = e.clientY;

  if (dragButton === 2 || e.shiftKey) {
    // Right-click or shift: tilt
    camTilt = Math.max(0.05, Math.min(0.8, camTilt + dy * 0.004));
  } else {
    // Left-click: pan (clamped so center stays on map)
    camPanX += dx;
    camPanY += dy;
    clampPan();
  }
});
function clampPan() {
  // Map half-extent in screen pixels (approximate)
  const rect = mapCanvas.getBoundingClientRect();
  const tileW = (rect.width / gridSize) * 0.85 * camZoom;
  const halfMapW = gridSize * tileW * 0.5;
  const halfMapH = gridSize * tileW * camTilt * 0.5;
  const maxPanX = Math.max(0, halfMapW - rect.width * 0.1);
  const maxPanY = Math.max(0, halfMapH - rect.height * 0.1);
  camPanX = Math.max(-maxPanX, Math.min(maxPanX, camPanX));
  camPanY = Math.max(-maxPanY, Math.min(maxPanY, camPanY));
}
window.addEventListener('mouseup', () => { isDragging = false; dragButton = -1; });
mapCanvas.addEventListener('contextmenu', e => e.preventDefault());

mapCanvas.addEventListener('wheel', e => {
  e.preventDefault();
  const delta = e.deltaY > 0 ? -0.1 : 0.1;
  // Min zoom: map fills ~66% of screen width
  const minZoom = 0.78;
  camZoom = Math.max(minZoom, Math.min(8.0, camZoom + delta));
}, { passive: false });

// ── Touch controls ──
// Supports: single-finger pan, two-finger pinch-to-zoom with simultaneous pan,
// double-tap to reset camera, velocity-based flick panning.

let touchStartDist = 0;
let touchStartZoom = 1;
let touchPrevCenterX = 0;
let touchPrevCenterY = 0;

// Flick velocity tracking — rolling window of last few move deltas
let flickVX = 0;
let flickVY = 0;
let flickRafId = null;

function stopFlick() {
  if (flickRafId) { cancelAnimationFrame(flickRafId); flickRafId = null; }
  flickVX = 0;
  flickVY = 0;
}

function startFlick(vx, vy) {
  stopFlick();
  if (Math.abs(vx) < 0.5 && Math.abs(vy) < 0.5) return;
  flickVX = vx;
  flickVY = vy;
  function tick() {
    flickVX *= 0.92;
    flickVY *= 0.92;
    if (Math.abs(flickVX) < 0.3 && Math.abs(flickVY) < 0.3) { flickRafId = null; return; }
    camPanX += flickVX;
    camPanY += flickVY;
    clampPan();
    flickRafId = requestAnimationFrame(tick);
  }
  flickRafId = requestAnimationFrame(tick);
}

// Double-tap detection (touch equivalent of dblclick)
let lastTapTime = 0;

mapCanvas.addEventListener('touchstart', e => {
  stopFlick();

  if (e.touches.length === 1) {
    isDragging = true;
    dragLastX = e.touches[0].clientX;
    dragLastY = e.touches[0].clientY;

    // Double-tap: two taps within 300ms → reset camera
    const now = Date.now();
    if (now - lastTapTime < 300) {
      camTilt = 0.5; camZoom = 1.0; camPanX = 0; camPanY = 0; camRotation = 0;
    }
    lastTapTime = now;

  } else if (e.touches.length === 2) {
    isDragging = false;
    const dx = e.touches[1].clientX - e.touches[0].clientX;
    const dy = e.touches[1].clientY - e.touches[0].clientY;
    touchStartDist = Math.sqrt(dx * dx + dy * dy);
    touchStartZoom = camZoom;
    // Track two-finger centroid for simultaneous pan
    touchPrevCenterX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
    touchPrevCenterY = (e.touches[0].clientY + e.touches[1].clientY) / 2;

  } else if (e.touches.length === 3) {
    // Three-finger tap: rotate 90° right
    camRotation = (camRotation + 1) % 4;
  }
}, { passive: true });

mapCanvas.addEventListener('touchmove', e => {
  e.preventDefault(); // prevent scroll/zoom conflicts while interacting with map

  if (e.touches.length === 1 && isDragging) {
    const dx = e.touches[0].clientX - dragLastX;
    const dy = e.touches[0].clientY - dragLastY;
    // Rolling velocity (weighted toward most recent)
    flickVX = flickVX * 0.4 + dx * 0.6;
    flickVY = flickVY * 0.4 + dy * 0.6;
    dragLastX = e.touches[0].clientX;
    dragLastY = e.touches[0].clientY;
    camPanX += dx;
    camPanY += dy;
    clampPan();

  } else if (e.touches.length === 2) {
    const dx = e.touches[1].clientX - e.touches[0].clientX;
    const dy = e.touches[1].clientY - e.touches[0].clientY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    camZoom = Math.max(0.78, Math.min(8.0, touchStartZoom * (dist / touchStartDist)));

    // Two-finger pan: track centroid movement
    const centerX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
    const centerY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
    camPanX += centerX - touchPrevCenterX;
    camPanY += centerY - touchPrevCenterY;
    clampPan();
    touchPrevCenterX = centerX;
    touchPrevCenterY = centerY;
  }
}, { passive: false });

mapCanvas.addEventListener('touchend', () => {
  isDragging = false;
  // Launch flick if significant velocity — ignores tiny taps
  if (Math.abs(flickVX) > 1.5 || Math.abs(flickVY) > 1.5) {
    startFlick(flickVX, flickVY);
  } else {
    flickVX = 0;
    flickVY = 0;
  }
});

// Double-click to reset camera (desktop)
mapCanvas.addEventListener('dblclick', () => {
  camTilt = 0.5; camZoom = 1.0; camPanX = 0; camPanY = 0; camRotation = 0;
});

// Map click for region selection (only when in region select mode)
mapCanvas.addEventListener('click', e => {
  if (!analysis.getRegionSelectMode()) return;
  const views = sim.getViews();
  const layout = sim.getLayout();
  if (!views || !layout) return;

  const gs = layout.gridSize;
  const dpr = window.devicePixelRatio || 1;
  const rect = mapCanvas.getBoundingClientRect();
  const w = rect.width;
  const h = rect.height;
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;

  const tileW = (w / gs) * 0.85 * camZoom;
  const tileH = tileW * camTilt;
  const heightScale = 80 * camZoom;
  const offsetX = w / 2 + camPanX;
  const offsetY = (h - gs * tileH * 0.5 + heightScale) / 2 + camPanY;

  // Reverse isometric: find closest tile to click position
  // Approximate by ignoring elevation (flat grid)
  let bestDist = Infinity, bestR = -1, bestC = -1;
  for (let r = 0; r < gs; r++) {
    for (let c = 0; c < gs; c++) {
      const idx = r * gs + c;
      const elev = views.elevations[idx];
      const ix = (c - r) * tileW * 0.5;
      const iy = (c + r) * tileH * 0.5;
      const iz = elev * heightScale;
      const sx = offsetX + ix;
      const sy = offsetY + iy - iz;
      const dist = (sx - mx) ** 2 + (sy - my) ** 2;
      if (dist < bestDist) { bestDist = dist; bestR = r; bestC = c; }
    }
  }
  if (bestR >= 0) {
    analysis.setRegionTile(bestR, bestC);
    if (activeTab === 'regions') renderRegionsTab();
  }
});

// Q/E to rotate 90°, P to toggle population overlay
document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (e.key === 'Escape') {
    // Dismiss modals and overlays
    if (!speciesDetailOverlay.classList.contains('hidden')) {
      speciesDetailOverlay.classList.add('hidden');
    } else if (!tooltipOverlay.classList.contains('hidden')) {
      tooltipOverlay.classList.add('hidden');
    } else if (analysis.getRegionSelectMode()) {
      analysis.clearRegions();
      if (activeTab === 'regions') renderRegionsTab();
    }
    return;
  }
  if (e.key === 'q' || e.key === 'Q') {
    camRotation = (camRotation + 3) % 4; // rotate left 90°
  } else if (e.key === 'e' || e.key === 'E') {
    camRotation = (camRotation + 1) % 4; // rotate right 90°
  } else if (e.key === 'p' || e.key === 'P') {
    if (mapRenderer) {
      mapRenderer.popMode = !mapRenderer.popMode;
    }
  }
});

// ── Render loop (decoupled from sim) ──
const SPECIES_COLORS = ['#DDC165', '#C0392B', '#2ECC71', '#E5591C', '#9B59B6'];

const SEASON_NAMES = ['Winter', 'Spring', 'Summer', 'Autumn'];
function getSeasonName(val) {
  return SEASON_NAMES[Math.floor(((val + 0.25) % 1) * 4) % 4];
}

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}
const SPECIES_NAMES = ['Velothrix', 'Leviathan', 'Crawler', 'Crab', 'Worm'];

function startRenderLoop() {
  function frame() {
    const views = sim.getViews();
    if (!views) { renderFrameId = requestAnimationFrame(frame); return; }

    const gen = views.globals[GLOBAL.GENERATION];

    if (gen !== lastRenderedGen) {
      lastRenderedGen = gen;

      // Update generation counter
      genNum.textContent = Math.floor(gen).toLocaleString();

      // Season
      const seasonVal = views.globals[GLOBAL.SEASON_FACTOR];
      seasonLabel.textContent = getSeasonName(seasonVal);

      // Collect population totals for chart
      const pops = [];
      for (let s = 0; s < 5; s++) {
        pops.push(views.globals[GLOBAL.TOTAL_POP_0 + s]);
      }
      popHistory.push({ gen, pops: [...pops] });
      if (popHistory.length > MAX_HISTORY) popHistory.shift();

      // Track trait history (population-weighted mean per species per universal trait)
      {
        const gs = sim.getLayout().gridSize;
        const G2 = gs * gs;
        const T = sim.getLayout().traitsPerSpecies;
        const traits = new Float32Array(25); // 5 species × 5 universal traits
        for (let s = 0; s < 5; s++) {
          let totalPop = 0;
          for (let i = 0; i < G2; i++) {
            const p = views.populations[i * 5 + s];
            if (p > 0) {
              totalPop += p;
              for (let t = 0; t < 5; t++) {
                traits[s * 5 + t] += views.traitMeans[(i * 5 + s) * T + t] * p;
              }
            }
          }
          if (totalPop > 0) {
            for (let t = 0; t < 5; t++) traits[s * 5 + t] /= totalPop;
          } else {
            for (let t = 0; t < 5; t++) traits[s * 5 + t] = NaN;
          }
        }
        traitHistory.push({ gen, traits });
        if (traitHistory.length > MAX_HISTORY) traitHistory.shift();
      }

      // Detect new extinctions → freeze ghost data
      for (let s = 0; s < 5; s++) {
        if (pops[s] === 0 && !knownExtinctions.has(s)) {
          // Species just went extinct — capture its historical data
          knownExtinctions.add(s);
          ghostData[s] = popHistory.filter(h => h.pops[s] > 0).map(h => ({ gen: h.gen, pop: h.pops[s] }));
        }
      }

      // ── Challenge state tracking ──
      currentGen = Math.floor(gen);
      if (knownExtinctions.size > 0) challengeState.anyExtinct = true;
      if (currentGen < 3000 && knownExtinctions.size > 0) challengeState.anyExtinctBefore3k = true;
      if (currentGen >= 3000 && !challengeState.allAliveAt3k && pops.every(p => p > 0)) challengeState.allAliveAt3k = true;
      for (let s = 0; s < 5; s++) {
        if (pops[s] > 0 && pops[s] < 50) challengeState.resilienceLowPop[s] = true;
        if (challengeState.resilienceLowPop[s] && pops[s] > 500) challengeState.resilienceAchieved = true;
      }

      // Epoch display
      updateEpoch(views.globals[GLOBAL.EPOCH_ID]);

      // Journal + progressive disclosure + extinction checks
      checkForEntries(gen, pops, seasonVal);
      checkDisclosures(gen, pops);
      checkAllExtinct(pops);

      // Sim events (extinctions, speciation)
      checkSimEvents();

      // Render all panels
      renderPentagon(pops);
      renderPopChart();
      renderSpeciesCards(pops);
      renderJournal();

      // Lab mode tabs
      if (activeTab === 'selection') renderSelectionCharts();
      if (activeTab === 'life-history') renderLifeHistoryChart();
      if (activeTab === 'stats') renderStatsReadouts();
      if (activeTab === 'traits') renderTraitsTab();
      if (activeTab === 'correlations') renderCorrelationsTab();
      if (activeTab === 'regions') renderRegionsTab();

      // Overlay data snapshot (for migration tracking)
      analysis.snapshotPopulations(views, sim.getLayout());
    }

    // Render map (every frame — camera might move)
    if (mapRenderer) {
      // Species colors as RGB arrays for population overlay
      const specRGB = SPECIES_COLORS.map(hex => [
        parseInt(hex.slice(1,3), 16),
        parseInt(hex.slice(3,5), 16),
        parseInt(hex.slice(5,7), 16)
      ]);
      mapRenderer.updateData(views.elevations, views.biomes, views.vegetation, views.flowDirs, views.populations, specRGB);
      mapRenderer.render(
        { tilt: camTilt, zoom: camZoom, panX: camPanX, panY: camPanY, rotSteps: camRotation },
        getBiomeColors()
      );
      // WebGL overlay rendering on separate canvas
      renderWebGLOverlay(views);
    } else {
      // Canvas 2D fallback
      renderMap(views);
    }

    renderFrameId = requestAnimationFrame(frame);
  }

  renderFrameId = requestAnimationFrame(frame);
}

// ── Map renderer (Canvas 2D fallback — only used when WebGL is unavailable) ──
function renderMap(views) {
  const dpr = window.devicePixelRatio || 1;
  const ctx = mapCanvas.getContext('2d');
  if (!ctx) return; // canvas already has WebGL context
  const w = mapCanvas.width / dpr;
  const h = mapCanvas.height / dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  ctx.fillStyle = getMapBg();
  ctx.fillRect(0, 0, w, h);

  const gs = sim.getLayout().gridSize;
  const tileW = (w / gs) * 0.85 * camZoom;
  const tileH = tileW * camTilt;
  const heightScale = 80 * camZoom;

  const offsetX = w / 2 + camPanX;
  const offsetY = (h - gs * tileH * 0.5 + heightScale) / 2 + camPanY;

  // Compute overlay data for analysis overlays
  const overlayData = analysis.computeOverlayData(views, sim.getLayout());

  // Water level plane
  const WATER_LEVEL = 0.20;  // sea level in normalized elevation

  // No artificial floor — pillars extend to each tile's actual elevation.
  // The diorama shows the full terrain depth.

  const BIOME_COLORS = getBiomeColors();

  // Helper: isometric screen position for grid coordinates at a given elevation
  function isoXY(r, c, elev) {
    const ix = (c - r) * (tileW * 0.5);
    const iy = (c + r) * (tileH * 0.5);
    const iz = elev * heightScale;
    return { x: offsetX + ix, y: offsetY + iy - iz };
  }

  // (per-tile noise removed — clean biome colors)

  // Find global min elevation for the floor
  let minElev = 1;
  for (let i = 0; i < gs * gs; i++) {
    if (views.elevations[i] < minElev) minElev = views.elevations[i];
  }
  const FLOOR_ELEV = minElev - 0.02; // just below the deepest tile

  // Helper: draw a filled quad
  function quad(ax,ay, bx,by, cx,cy, dx,dy) {
    ctx.beginPath();
    ctx.moveTo(ax,ay); ctx.lineTo(bx,by); ctx.lineTo(cx,cy); ctx.lineTo(dx,dy);
    ctx.closePath(); ctx.fill();
  }

  // Single pass: back-to-front
  for (let r = 0; r < gs; r++) {
    for (let c = 0; c < gs; c++) {
      const idx = r * gs + c;
      const elev = views.elevations[idx];
      const biome = views.biomes[idx];
      const underwater = elev < WATER_LEVEL;
      const depth = underwater ? WATER_LEVEL - elev : 0;

      // ── Terrain color ──
      const bc = BIOME_COLORS[biome] || [30, 20, 10];
      let tr = Math.max(0, Math.min(255, bc[0] + elev * 25));
      let tg = Math.max(0, Math.min(255, bc[1] + elev * 18));
      let tb = Math.max(0, Math.min(255, bc[2] + elev * 12));

      // Shade
      let shade = 0.65;
      if (r > 0 && c > 0) {
        const hL = views.elevations[r * gs + (c - 1)];
        const hU = views.elevations[(r - 1) * gs + c];
        shade = 0.5 + 0.5 * Math.max(0, Math.min(1, 0.5 + (elev - hL) * 2.5 + (elev - hU) * 2));
      }

      // Surface diamond (actual terrain elevation)
      const s = isoXY(r, c, elev);
      const sT = { x: s.x, y: s.y - tileH * 0.5 };
      const sR = { x: s.x + tileW * 0.5, y: s.y };
      const sB = { x: s.x, y: s.y + tileH * 0.5 };
      const sL = { x: s.x - tileW * 0.5, y: s.y };

      // Floor diamond (deepest point in the map)
      const f = isoXY(r, c, FLOOR_ELEV);
      const fT = { x: f.x, y: f.y - tileH * 0.5 };
      const fR = { x: f.x + tileW * 0.5, y: f.y };
      const fB = { x: f.x, y: f.y + tileH * 0.5 };
      const fL = { x: f.x - tileW * 0.5, y: f.y };

      // ── SIDE FACES ──
      ctx.fillStyle = `rgb(${tr*shade*0.45|0},${tg*shade*0.45|0},${tb*shade*0.45|0})`;
      quad(sR.x,sR.y, sB.x,sB.y, fB.x,fB.y, fR.x,fR.y);

      ctx.fillStyle = `rgb(${tr*shade*0.35|0},${tg*shade*0.35|0},${tb*shade*0.35|0})`;
      quad(sL.x,sL.y, sB.x,sB.y, fB.x,fB.y, fL.x,fL.y);

      if (r === 0) {
        ctx.fillStyle = `rgb(${tr*shade*0.3|0},${tg*shade*0.3|0},${tb*shade*0.3|0})`;
        quad(sT.x,sT.y, sR.x,sR.y, fR.x,fR.y, fT.x,fT.y);
      }
      if (c === 0) {
        ctx.fillStyle = `rgb(${tr*shade*0.25|0},${tg*shade*0.25|0},${tb*shade*0.25|0})`;
        quad(sT.x,sT.y, sL.x,sL.y, fL.x,fL.y, fT.x,fT.y);
      }

      // ── TOP FACE (terrain) ──
      ctx.fillStyle = `rgb(${tr*shade|0},${tg*shade|0},${tb*shade|0})`;
      quad(sT.x,sT.y, sR.x,sR.y, sB.x,sB.y, sL.x,sL.y);

      // ── WATER TILE — flat diamond at water level ON TOP of terrain ──
      if (underwater) {
        const w = isoXY(r, c, WATER_LEVEL);
        const wT = { x: w.x, y: w.y - tileH * 0.5 };
        const wR = { x: w.x + tileW * 0.5, y: w.y };
        const wB = { x: w.x, y: w.y + tileH * 0.5 };
        const wL = { x: w.x - tileW * 0.5, y: w.y };

        // Depth gradient: shallow=bright blue (0.3α), deep=blue-black (0.9α)
        const dn = Math.min(1, depth / 0.18);  // normalized depth
        const alpha = 0.3 + dn * 0.6;
        const wr = Math.round(20 + (1 - dn) * 60);   // 80 shallow → 20 deep
        const wg = Math.round(80 + (1 - dn) * 80);    // 160 shallow → 80 deep
        const wb = Math.round(140 + (1 - dn) * 60);   // 200 shallow → 140 deep

        ctx.fillStyle = `rgba(${wr},${wg},${wb},${alpha.toFixed(2)})`;
        quad(wT.x,wT.y, wR.x,wR.y, wB.x,wB.y, wL.x,wL.y);
      }

      // ── OVERLAYS ──
      if (!underwater) {
        if (views.tileFlags[idx] & 1) {
          ctx.fillStyle = 'rgba(25,75,135,0.4)';
          quad(sT.x,sT.y, sR.x,sR.y, sB.x,sB.y, sL.x,sL.y);
        }
        if (views.tileFlags[idx] & 2) {
          ctx.fillStyle = 'rgba(229,89,28,0.3)';
          quad(sT.x,sT.y, sR.x,sR.y, sB.x,sB.y, sL.x,sL.y);
        }
      }

      // Analysis overlay
      if (overlayData) {
        const overlayColor = analysis.getOverlayColor(overlayData[idx]);
        if (overlayColor) {
          const oBase = underwater ? isoXY(r, c, WATER_LEVEL) : s;
          const oT = { x: oBase.x, y: oBase.y - tileH * 0.5 };
          const oR = { x: oBase.x + tileW * 0.5, y: oBase.y };
          const oB = { x: oBase.x, y: oBase.y + tileH * 0.5 };
          const oL = { x: oBase.x - tileW * 0.5, y: oBase.y };
          ctx.fillStyle = overlayColor;
          quad(oT.x,oT.y, oR.x,oR.y, oB.x,oB.y, oL.x,oL.y);
        }
      }

      // Species overlay (on water level for underwater, terrain for land)
      const pBase = underwater ? isoXY(r, c, WATER_LEVEL) : s;
      let maxPop = 0, maxS = -1;
      for (let sp = 0; sp < 5; sp++) {
        const p = views.populations[idx * 5 + sp];
        if (p > maxPop) { maxPop = p; maxS = sp; }
      }
      if (maxPop > 5 && maxS >= 0) {
        const intensity = Math.min(0.4, maxPop / 250);
        ctx.fillStyle = hexToRgba(SPECIES_COLORS[maxS], intensity);
        quad(pBase.x, pBase.y - tileH*0.5, pBase.x + tileW*0.5, pBase.y,
             pBase.x, pBase.y + tileH*0.5, pBase.x - tileW*0.5, pBase.y);
      }

      // Grid line
      ctx.strokeStyle = 'rgba(221,193,101,0.03)';
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(sT.x,sT.y); ctx.lineTo(sR.x,sR.y);
      ctx.lineTo(sB.x,sB.y); ctx.lineTo(sL.x,sL.y);
      ctx.closePath(); ctx.stroke();
    }
  }

  // ── Rivers (2D paths on tile surfaces) ──
  function tilePos(r, c) {
    const idx = r * gs + c;
    const elev = views.elevations[idx] || 0.2;
    return isoXY(r, c, elev);
  }
  const rp = views.riverPaths;
  const rm = views.riverMeta;
  const maxRivers = rm.length / 4;
  let rpIdx = 0;

  for (let ri = 0; ri < maxRivers; ri++) {
    const riverId = rm[ri * 4];
    if (riverId < 0) break;
    const width = Math.max(1, rm[ri * 4 + 2]);
    const active = rm[ri * 4 + 3] > 0;

    // Collect path points
    const points = [];
    while (rpIdx < rp.length / 2) {
      const pr = rp[rpIdx * 2];
      const pc = rp[rpIdx * 2 + 1];
      rpIdx++;
      if (pr < 0) break;
      points.push(tilePos(pr, pc));
    }

    if (points.length < 2) continue;

    // Draw river as smooth curve on tile surface
    ctx.strokeStyle = active ? 'rgba(20, 70, 140, 0.7)' : 'rgba(20, 50, 100, 0.3)';
    ctx.lineWidth = Math.max(1.5, width * 1.2 * camZoom);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
      // Smooth curve through midpoints for organic river feel
      if (i < points.length - 1) {
        const mx = (points[i].x + points[i + 1].x) / 2;
        const my = (points[i].y + points[i + 1].y) / 2;
        ctx.quadraticCurveTo(points[i].x, points[i].y, mx, my);
      } else {
        ctx.lineTo(points[i].x, points[i].y);
      }
    }
    ctx.stroke();

    // River glow
    ctx.strokeStyle = active ? 'rgba(40, 100, 180, 0.15)' : 'rgba(30, 60, 100, 0.08)';
    ctx.lineWidth = Math.max(3, width * 2.5 * camZoom);
    ctx.stroke();
  }

  // Vignette
  const grad = ctx.createRadialGradient(w/2, h/2, Math.min(w,h)*0.35, w/2, h/2, Math.min(w,h)*0.7);
  grad.addColorStop(0, 'rgba(0,0,0,0)');
  grad.addColorStop(1, 'rgba(0,0,0,0.5)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
}

// ── WebGL overlay (drawn on separate canvas for analysis overlays) ──
function renderWebGLOverlay(views) {
  const overlayCanvas = document.getElementById('overlay-canvas');
  if (!overlayCanvas) return;
  const overlayData = analysis.computeOverlayData(views, sim.getLayout());
  const dpr = window.devicePixelRatio || 1;
  const mapRect = mapCanvas.parentElement.getBoundingClientRect();

  if (overlayCanvas.width !== mapRect.width * dpr || overlayCanvas.height !== mapRect.height * dpr) {
    overlayCanvas.width = mapRect.width * dpr;
    overlayCanvas.height = mapRect.height * dpr;
    overlayCanvas.style.width = mapRect.width + 'px';
    overlayCanvas.style.height = mapRect.height + 'px';
  }

  const ctx = overlayCanvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const w = mapRect.width;
  const h = mapRect.height;
  ctx.clearRect(0, 0, w, h);

  if (!overlayData) return;

  const gs = sim.getLayout().gridSize;
  const tileW = (w / gs) * 0.85 * camZoom;
  const tileH = tileW * camTilt;
  const heightScale = 80 * camZoom;
  const WATER_LEVEL = 0.20;
  const offsetX = w / 2 + camPanX;
  const offsetY = (h - gs * tileH * 0.5 + heightScale) / 2 + camPanY;

  for (let r = 0; r < gs; r++) {
    for (let c = 0; c < gs; c++) {
      const idx = r * gs + c;
      const color = analysis.getOverlayColor(overlayData[idx]);
      if (!color) continue;
      const elev = Math.max(views.elevations[idx], WATER_LEVEL);
      const ix = (c - r) * tileW * 0.5;
      const iy = (c + r) * tileH * 0.5;
      const iz = elev * heightScale;
      const sx = offsetX + ix;
      const sy = offsetY + iy - iz;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(sx, sy - tileH * 0.5);
      ctx.lineTo(sx + tileW * 0.5, sy);
      ctx.lineTo(sx, sy + tileH * 0.5);
      ctx.lineTo(sx - tileW * 0.5, sy);
      ctx.closePath();
      ctx.fill();
    }
  }
}

// ── Pentagon / Radar diagram ──
function renderPentagon(pops) {
  const dpr = window.devicePixelRatio || 1;
  const ctx = pentagonChart.getContext('2d');
  const w = pentagonChart.width / dpr;
  const h = pentagonChart.height / dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const style = getComputedStyle(document.documentElement);
  ctx.fillStyle = style.getPropertyValue('--card').trim() || '#2a1500';
  ctx.fillRect(0, 0, w, h);

  const cx = w / 2;
  const cy = h / 2;
  const maxR = Math.min(cx, cy) - 20;

  // Find max for normalization
  let maxPop = 1;
  for (let s = 0; s < 5; s++) if (pops[s] > maxPop) maxPop = pops[s];

  const gridColor = style.getPropertyValue('--border').trim() || '#3d2200';
  const dimColor = style.getPropertyValue('--dim').trim() || '#7a5a2a';

  // Draw grid rings (25%, 50%, 75%, 100%)
  ctx.strokeStyle = gridColor;
  ctx.lineWidth = 0.5;
  for (let ring = 0.25; ring <= 1.0; ring += 0.25) {
    ctx.beginPath();
    for (let s = 0; s <= 5; s++) {
      const angle = (s % 5) * (Math.PI * 2 / 5) - Math.PI / 2;
      const x = cx + Math.cos(angle) * maxR * ring;
      const y = cy + Math.sin(angle) * maxR * ring;
      if (s === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.stroke();
  }

  // Draw axis lines
  for (let s = 0; s < 5; s++) {
    const angle = s * (Math.PI * 2 / 5) - Math.PI / 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(angle) * maxR, cy + Math.sin(angle) * maxR);
    ctx.stroke();
  }

  // Draw data polygon (filled)
  ctx.beginPath();
  for (let s = 0; s < 5; s++) {
    const angle = s * (Math.PI * 2 / 5) - Math.PI / 2;
    const val = maxPop > 0 ? pops[s] / maxPop : 0;
    const r = val * maxR;
    const x = cx + Math.cos(angle) * r;
    const y = cy + Math.sin(angle) * r;
    if (s === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = 'rgba(221, 193, 101, 0.08)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(221, 193, 101, 0.3)';
  ctx.lineWidth = 1;
  ctx.stroke();

  // Draw species vertices
  for (let s = 0; s < 5; s++) {
    const angle = s * (Math.PI * 2 / 5) - Math.PI / 2;
    const val = maxPop > 0 ? pops[s] / maxPop : 0;
    const r = val * maxR;
    const x = cx + Math.cos(angle) * r;
    const y = cy + Math.sin(angle) * r;

    // Dot at vertex
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fillStyle = pops[s] === 0 ? dimColor : SPECIES_COLORS[s];
    ctx.fill();

    // Species label at edge
    const lx = cx + Math.cos(angle) * (maxR + 12);
    const ly = cy + Math.sin(angle) * (maxR + 12);
    ctx.fillStyle = pops[s] === 0 ? dimColor : SPECIES_COLORS[s];
    ctx.font = '8px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(SPECIES_NAMES[s], lx, ly);
  }
}

// ── Population chart ──
function renderPopChart() {
  if (!popHistory.length) return;
  const dpr = window.devicePixelRatio || 1;
  const ctx = popChart.getContext('2d');
  const w = popChart.width / dpr;
  const h = popChart.height / dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const style = getComputedStyle(document.documentElement);
  ctx.fillStyle = style.getPropertyValue('--card').trim() || '#2a1500';
  ctx.fillRect(0, 0, w, h);

  // Find max pop for scaling (with 10% headroom)
  let maxPop = 100;
  for (const entry of popHistory) {
    for (const p of entry.pops) {
      if (p > maxPop) maxPop = p;
    }
  }
  maxPop *= 1.1;

  const pad = { l: 30, r: 6, t: 8, b: 16 };
  const cw = w - pad.l - pad.r;
  const ch = h - pad.t - pad.b;

  // Y-axis gridlines
  const gridColor = style.getPropertyValue('--border').trim() || '#3d2200';
  const dimColor = style.getPropertyValue('--dim').trim() || '#7a5a2a';
  ctx.strokeStyle = gridColor;
  ctx.lineWidth = 0.5;
  ctx.font = '8px monospace';
  ctx.fillStyle = dimColor;
  ctx.textAlign = 'right';
  const ySteps = 4;
  for (let i = 0; i <= ySteps; i++) {
    const y = pad.t + (i / ySteps) * ch;
    const val = Math.round(maxPop * (1 - i / ySteps));
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(pad.l + cw, y);
    ctx.stroke();
    ctx.fillText(val >= 1000 ? (val / 1000).toFixed(1) + 'k' : String(val), pad.l - 3, y + 3);
  }

  // Generation range label
  if (popHistory.length > 1) {
    ctx.textAlign = 'center';
    ctx.fillStyle = dimColor;
    const firstGen = Math.floor(popHistory[0].gen);
    const lastGen = Math.floor(popHistory[popHistory.length - 1].gen);
    ctx.fillText(`Gen ${firstGen}`, pad.l + 15, h - 3);
    ctx.fillText(`${lastGen}`, pad.l + cw - 10, h - 3);
  }

  // Ghost data (extinct species — faded dashed lines)
  for (const [sStr, gdata] of Object.entries(ghostData)) {
    const s = parseInt(sStr);
    if (gdata.length < 2) continue;
    ctx.strokeStyle = hexToRgba(SPECIES_COLORS[s], 0.2);
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    for (let i = 0; i < gdata.length; i++) {
      // Map ghost gen to chart x position
      const firstGen = popHistory.length > 0 ? popHistory[0].gen : 0;
      const lastGen = popHistory.length > 0 ? popHistory[popHistory.length - 1].gen : 1;
      const genRange = lastGen - firstGen || 1;
      const x = pad.l + ((gdata[i].gen - firstGen) / genRange) * cw;
      const y = pad.t + ch - (gdata[i].pop / maxPop) * ch;
      if (x < pad.l || x > pad.l + cw) continue;
      if (i === 0 || gdata[i-1].gen < firstGen) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // Death marker (×) at last data point
    const last = gdata[gdata.length - 1];
    const firstGen2 = popHistory.length > 0 ? popHistory[0].gen : 0;
    const lastGen2 = popHistory.length > 0 ? popHistory[popHistory.length - 1].gen : 1;
    const dx = pad.l + ((last.gen - firstGen2) / (lastGen2 - firstGen2 || 1)) * cw;
    const dy = pad.t + ch - (last.pop / maxPop) * ch;
    if (dx >= pad.l && dx <= pad.l + cw) {
      ctx.strokeStyle = hexToRgba(SPECIES_COLORS[s], 0.5);
      ctx.lineWidth = 1.5;
      const m = 3;
      ctx.beginPath(); ctx.moveTo(dx - m, dy - m); ctx.lineTo(dx + m, dy + m); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(dx - m, dy + m); ctx.lineTo(dx + m, dy - m); ctx.stroke();
    }
  }

  // Living species lines
  for (let s = 0; s < 5; s++) {
    if (knownExtinctions.has(s)) continue; // skip extinct — drawn as ghost above
    ctx.strokeStyle = SPECIES_COLORS[s];
    ctx.lineWidth = 1.5;
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    for (let i = 0; i < popHistory.length; i++) {
      const x = pad.l + (i / Math.max(1, popHistory.length - 1)) * cw;
      const y = pad.t + ch - (popHistory[i].pops[s] / maxPop) * ch;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Glow
    ctx.strokeStyle = hexToRgba(SPECIES_COLORS[s], 0.15);
    ctx.lineWidth = 4;
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // ── Timeline event markers ──
  if (timelineEvents.length > 0 && popHistory.length > 1) {
    const firstGen = popHistory[0].gen;
    const lastGen = popHistory[popHistory.length - 1].gen;
    const genRange = lastGen - firstGen || 1;

    // Store marker positions for hover detection
    popChartMarkers.length = 0;

    for (const evt of timelineEvents) {
      const x = pad.l + ((evt.gen - firstGen) / genRange) * cw;
      if (x < pad.l || x > pad.l + cw) continue;

      const markerY = pad.t + ch + 6; // just below the chart area
      const radius = 3;

      // Glow
      ctx.beginPath();
      ctx.arc(x, markerY, radius + 2, 0, Math.PI * 2);
      ctx.fillStyle = hexToRgba(evt.color, 0.2);
      ctx.fill();

      // Dot
      ctx.beginPath();
      ctx.arc(x, markerY, radius, 0, Math.PI * 2);
      ctx.fillStyle = evt.color;
      ctx.fill();

      // Vertical line to chart
      ctx.strokeStyle = hexToRgba(evt.color, 0.15);
      ctx.lineWidth = 0.5;
      ctx.setLineDash([2, 2]);
      ctx.beginPath();
      ctx.moveTo(x, pad.t);
      ctx.lineTo(x, pad.t + ch);
      ctx.stroke();
      ctx.setLineDash([]);

      // Store for hover
      popChartMarkers.push({ x, y: markerY, radius: radius + 3, label: evt.label, gen: evt.gen, type: evt.type });
    }
  }
}

// Pop chart marker hover state
const popChartMarkers = []; // { x, y, radius, label, gen, type }
let popChartTooltip = null; // { x, y, label }

popChart.addEventListener('mousemove', e => {
  if (!popChartMarkers.length) return;
  const dpr = window.devicePixelRatio || 1;
  const rect = popChart.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;

  let found = null;
  for (const m of popChartMarkers) {
    const dist = Math.sqrt((mx - m.x) ** 2 + (my - m.y) ** 2);
    if (dist < m.radius + 4) { found = m; break; }
  }

  if (found) {
    popChartTooltip = found;
    popChart.style.cursor = 'pointer';
    // Draw tooltip overlay
    const ctx = popChart.getContext('2d');
    const w = popChart.width / dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const text = `Gen ${Math.floor(found.gen)}: ${found.label}`;
    ctx.font = '8px monospace';
    const tw = ctx.measureText(text).width + 8;
    const tx = Math.min(found.x - tw / 2, w - tw - 4);
    const ty = found.y - 16;
    ctx.fillStyle = 'rgba(0,0,0,0.85)';
    ctx.fillRect(Math.max(2, tx), ty, tw, 12);
    ctx.fillStyle = '#FFE9A3';
    ctx.textAlign = 'left';
    ctx.fillText(text, Math.max(2, tx) + 4, ty + 9);
  } else {
    popChartTooltip = null;
    popChart.style.cursor = '';
  }
});

popChart.addEventListener('mouseleave', () => {
  popChartTooltip = null;
  popChart.style.cursor = '';
});

// ── Species cards ──
const speciesCards = $('species-cards');
const SPECIES_TRAITS = ['Crest Brightness', 'Hunting Range', 'Burrowing Depth', 'Shell Thickness', 'Glow Intensity'];
const SPECIES_FULL = ['Velothrix aurantis', 'Kelp Leviathan', 'Reed Crawler', 'Tidal Crab', 'Bioluminescent Worm'];
let portraitCanvases = []; // cached canvas elements
let lastTraitValues = [-1, -1, -1, -1, -1]; // redraw portraits only when trait changes

function renderSpeciesCards(totalPops) {
  const views = sim.getViews();
  if (!views) return;
  const gs = sim.getLayout().gridSize;
  const G2 = gs * gs;
  const T = sim.getLayout().traitsPerSpecies;

  // Compute mean species-specific trait across all tiles (weighted by pop)
  const meanTraits = [];
  for (let s = 0; s < 5; s++) {
    let sumTrait = 0, sumPop = 0;
    for (let i = 0; i < G2; i++) {
      const p = views.populations[i * 5 + s];
      if (p > 0) {
        sumTrait += views.traitMeans[(i * 5 + s) * T + 5] * p; // T_SPECIFIC = index 5
        sumPop += p;
      }
    }
    meanTraits.push(sumPop > 0 ? sumTrait / sumPop : 0.5);
  }

  // Only rebuild DOM if cards don't exist yet
  if (portraitCanvases.length === 0) {
    let html = '';
    for (let s = 0; s < 5; s++) {
      html += `<div class="species-card" id="sp-card-${s}" style="border-left-color:${SPECIES_COLORS[s]}">
        <div class="sp-row">
          <canvas class="sp-portrait" id="sp-portrait-${s}" width="80" height="80"></canvas>
          <div class="sp-info">
            <div class="sp-name">${SPECIES_FULL[s]}</div>
            <div class="sp-pop" id="sp-pop-${s}">0</div>
            <div class="sp-trait-row">
              <span class="sp-trait-label">${SPECIES_TRAITS[s]}</span>
              <div class="sp-trait-bar"><div class="sp-trait-fill" id="sp-trait-${s}" style="width:50%;background:${SPECIES_COLORS[s]}"></div></div>
            </div>
          </div>
        </div>
      </div>`;
    }
    speciesCards.innerHTML = html;
    portraitCanvases = [];
    for (let s = 0; s < 5; s++) {
      const canvas = $(`sp-portrait-${s}`);
      const dpr = window.devicePixelRatio || 1;
      canvas.width = 80 * dpr;
      canvas.height = 80 * dpr;
      canvas.style.width = '40px';
      canvas.style.height = '40px';
      portraitCanvases.push(canvas);
      // Click species card to open detail
      const card = $(`sp-card-${s}`);
      card.style.cursor = 'pointer';
      card.addEventListener('click', () => showSpeciesDetail(s));
    }
  }

  // Update values (fast — no DOM rebuild)
  for (let s = 0; s < 5; s++) {
    const pop = Math.floor(totalPops[s]);
    const extinct = pop === 0;
    const card = $(`sp-card-${s}`);
    const popEl = $(`sp-pop-${s}`);
    const traitEl = $(`sp-trait-${s}`);

    card.classList.toggle('extinct', extinct);
    popEl.textContent = extinct ? 'EXTINCT' : pop.toLocaleString();
    traitEl.style.width = (meanTraits[s] * 100) + '%';

    // Redraw portrait only if trait changed significantly
    const traitDelta = Math.abs(meanTraits[s] - lastTraitValues[s]);
    if (traitDelta > 0.01 || lastTraitValues[s] < 0) {
      lastTraitValues[s] = meanTraits[s];
      const canvas = portraitCanvases[s];
      if (!canvas) continue;
      const ctx = canvas.getContext('2d');
      if (!ctx) continue;
      const dpr = window.devicePixelRatio || 1;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawPortrait(ctx, s, meanTraits[s], 40, SPECIES_COLORS[s]);
    }
  }
}

// ── Selection tab — trait line charts ──
function renderSelectionCharts() {
  if (!traitHistory.length) return;
  const style = getComputedStyle(document.documentElement);
  const cardBg = style.getPropertyValue('--card').trim() || '#2a1500';
  const dimColor = style.getPropertyValue('--dim').trim() || '#7a5a2a';
  const gridColor = style.getPropertyValue('--border').trim() || '#3d2200';
  const dpr = window.devicePixelRatio || 1;

  for (let t = 0; t < 5; t++) {
    const canvas = document.getElementById(`selection-chart-${t}`);
    if (!canvas) continue;
    if (canvas.width !== canvas.offsetWidth * dpr || canvas.height !== canvas.offsetHeight * dpr) {
      canvas.width = canvas.offsetWidth * dpr;
      canvas.height = canvas.offsetHeight * dpr;
    }
    const ctx = canvas.getContext('2d');
    const w = canvas.width / dpr;
    const h = canvas.height / dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.fillStyle = cardBg;
    ctx.fillRect(0, 0, w, h);

    const pad = { l: 30, r: 6, t: 14, b: 14 };
    const cw = w - pad.l - pad.r;
    const ch = h - pad.t - pad.b;

    // Title
    ctx.font = '8px monospace';
    ctx.fillStyle = dimColor;
    ctx.textAlign = 'left';
    ctx.fillText(UNIVERSAL_TRAIT_NAMES[t], pad.l, 10);

    // Y gridlines (0, 0.5, 1.0)
    ctx.strokeStyle = gridColor;
    ctx.lineWidth = 0.5;
    ctx.textAlign = 'right';
    for (let i = 0; i <= 2; i++) {
      const yVal = i * 0.5;
      const y = pad.t + ch - (yVal * ch);
      ctx.beginPath();
      ctx.moveTo(pad.l, y);
      ctx.lineTo(pad.l + cw, y);
      ctx.stroke();
      ctx.fillStyle = dimColor;
      ctx.fillText(yVal.toFixed(1), pad.l - 3, y + 3);
    }

    // Gen range
    if (traitHistory.length > 1) {
      ctx.textAlign = 'center';
      ctx.fillStyle = dimColor;
      ctx.fillText(`Gen ${Math.floor(traitHistory[0].gen)}`, pad.l + 15, h - 2);
      ctx.fillText(`${Math.floor(traitHistory[traitHistory.length - 1].gen)}`, pad.l + cw - 10, h - 2);
    }

    // Species lines
    for (let s = 0; s < 5; s++) {
      ctx.strokeStyle = SPECIES_COLORS[s];
      ctx.lineWidth = 1.5;
      ctx.globalAlpha = knownExtinctions.has(s) ? 0.25 : 0.85;
      if (knownExtinctions.has(s)) ctx.setLineDash([3, 3]);
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < traitHistory.length; i++) {
        const val = traitHistory[i].traits[s * 5 + t];
        if (isNaN(val)) { started = false; continue; }
        const x = pad.l + (i / Math.max(1, traitHistory.length - 1)) * cw;
        const y = pad.t + ch - (val * ch);
        if (!started) { ctx.moveTo(x, y); started = true; }
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.globalAlpha = 1;
  }
}

// ── Life History tab — r/K scatter plot ──
function renderLifeHistoryChart() {
  if (!traitHistory.length) return;
  const canvas = document.getElementById('life-history-chart');
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== canvas.offsetWidth * dpr || canvas.height !== canvas.offsetHeight * dpr) {
    canvas.width = canvas.offsetWidth * dpr;
    canvas.height = canvas.offsetHeight * dpr;
  }
  const ctx = canvas.getContext('2d');
  const w = canvas.width / dpr;
  const h = canvas.height / dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const style = getComputedStyle(document.documentElement);
  const cardBg = style.getPropertyValue('--card').trim() || '#2a1500';
  const dimColor = style.getPropertyValue('--dim').trim() || '#7a5a2a';
  const gridColor = style.getPropertyValue('--border').trim() || '#3d2200';
  const goldDim = style.getPropertyValue('--gold-dim').trim() || '#a08940';

  ctx.fillStyle = cardBg;
  ctx.fillRect(0, 0, w, h);

  const pad = { l: 36, r: 12, t: 16, b: 24 };
  const cw = w - pad.l - pad.r;
  const ch = h - pad.t - pad.b;

  // Axes
  ctx.strokeStyle = gridColor;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(pad.l, pad.t);
  ctx.lineTo(pad.l, pad.t + ch);
  ctx.lineTo(pad.l + cw, pad.t + ch);
  ctx.stroke();

  // Midlines
  ctx.strokeStyle = gridColor;
  ctx.lineWidth = 0.5;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(pad.l + cw / 2, pad.t);
  ctx.lineTo(pad.l + cw / 2, pad.t + ch);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(pad.l, pad.t + ch / 2);
  ctx.lineTo(pad.l + cw, pad.t + ch / 2);
  ctx.stroke();
  ctx.setLineDash([]);

  // Axis labels
  ctx.font = '8px monospace';
  ctx.fillStyle = dimColor;
  ctx.textAlign = 'center';
  ctx.fillText('Clutch Size →', pad.l + cw / 2, h - 4);
  ctx.save();
  ctx.translate(8, pad.t + ch / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText('Longevity →', 0, 0);
  ctx.restore();

  // Quadrant labels
  ctx.font = '7px monospace';
  ctx.fillStyle = goldDim;
  ctx.globalAlpha = 0.65;
  ctx.textAlign = 'center';
  ctx.fillText('K-selected', pad.l + cw * 0.25, pad.t + 10);
  ctx.fillText('r-selected', pad.l + cw * 0.75, pad.t + ch - 4);
  ctx.fillText('Opportunist', pad.l + cw * 0.75, pad.t + 10);
  ctx.fillText('Enduring', pad.l + cw * 0.25, pad.t + ch - 4);
  ctx.globalAlpha = 1;

  // Plot species dots from latest trait history
  const latest = traitHistory[traitHistory.length - 1];
  for (let s = 0; s < 5; s++) {
    const clutch = latest.traits[s * 5 + TRAIT.CLUTCH_SIZE];
    const longevity = latest.traits[s * 5 + TRAIT.LONGEVITY];
    if (isNaN(clutch) || isNaN(longevity)) continue;

    const x = pad.l + clutch * cw;
    const y = pad.t + ch - longevity * ch;

    // Glow
    ctx.beginPath();
    ctx.arc(x, y, 8, 0, Math.PI * 2);
    ctx.fillStyle = hexToRgba(SPECIES_COLORS[s], 0.15);
    ctx.fill();

    // Dot
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fillStyle = SPECIES_COLORS[s];
    ctx.globalAlpha = knownExtinctions.has(s) ? 0.3 : 1;
    ctx.fill();
    ctx.globalAlpha = 1;

    // Label
    ctx.font = '8px monospace';
    ctx.fillStyle = SPECIES_COLORS[s];
    ctx.textAlign = 'left';
    ctx.fillText(SPECIES_NAMES[s], x + 7, y + 3);
  }
}

// ── Stats tab — numeric readouts ──
function renderStatsReadouts() {
  const views = sim.getViews();
  if (!views) return;
  const el = document.getElementById('stats-readouts');
  if (!el) return;

  const gen = views.globals[GLOBAL.GENERATION];
  const season = views.globals[GLOBAL.SEASON_FACTOR];
  const vegMean = views.globals[GLOBAL.VEGETATION_MEAN];

  // Total population
  let totalPop = 0;
  for (let s = 0; s < 5; s++) totalPop += views.globals[GLOBAL.TOTAL_POP_0 + s];

  // Carrying capacity proxy: sum tile-level K (approximate from biome/vegetation)
  // Use pop/K as fitness proxy where K ≈ scaled total capacity
  const gs = sim.getLayout().gridSize;
  const G2 = gs * gs;
  const estimatedK = G2 * 50; // rough per-tile K average
  const fitProxy = estimatedK > 0 ? (totalPop / estimatedK).toFixed(3) : '—';

  // Alive count
  let aliveCount = 0;
  for (let s = 0; s < 5; s++) if (views.globals[GLOBAL.TOTAL_POP_0 + s] > 0) aliveCount++;

  el.innerHTML = `
    <div class="stat-row">
      <div><div class="stat-label">Total Population</div></div>
      <div class="stat-value">${Math.floor(totalPop).toLocaleString()}</div>
    </div>
    <div class="stat-row">
      <div><div class="stat-label">Species Alive</div></div>
      <div class="stat-value">${aliveCount} / 5</div>
    </div>
    <div class="stat-row">
      <div><div class="stat-label">Fitness Proxy</div><div class="stat-sub">pop / est. carrying capacity</div></div>
      <div class="stat-value">${fitProxy}</div>
    </div>
    <div class="stat-row">
      <div><div class="stat-label">Vegetation Level</div></div>
      <div class="stat-value">${vegMean !== undefined ? vegMean.toFixed(2) : '—'}</div>
    </div>
    <div class="stat-row">
      <div><div class="stat-label">Season Factor</div><div class="stat-sub">${getSeasonName(season)}</div></div>
      <div class="stat-value">${season.toFixed(3)}</div>
    </div>
    <div class="stat-row">
      <div><div class="stat-label">Generation</div></div>
      <div class="stat-value">${Math.floor(gen).toLocaleString()}</div>
    </div>
  `;
}

// ── Epoch display ──
const epochBanner = $('epoch-banner');
const epochNameEl = $('epoch-name');
const EPOCH_LIST = ['The Quiet', 'Age of Expansion', 'The Great Drought', "Predator's Reign",
                    'The Divergence', 'Twilight', 'Last Stand', 'The Long Equilibrium'];
let lastEpochId = -1;

function updateEpoch(epochId) {
  const id = Math.floor(epochId);
  if (id === lastEpochId) return;
  lastEpochId = id;
  const name = EPOCH_LIST[id] || 'Unknown';
  epochNameEl.textContent = name;
  epochBanner.classList.remove('hidden');
  epochBanner.classList.add('transitioning');
  setTimeout(() => epochBanner.classList.remove('transitioning'), 1500);
  // Terrain/biome/flow data may change on epoch transition — mark dirty
  if (mapRenderer) mapRenderer.markTerrainDirty();
  // Record epoch change as environmental timeline event
  if (id > 0) {
    timelineEvents.push({ gen: Math.floor(sim.getGeneration()), type: 'environmental', label: name, color: '#4a9eff' });
  }
}

// ── Journal feed ──
const journalFeed = $('journal-feed');
let lastJournalCount = 0;

function renderJournal() {
  const entries = getRecent(15);
  if (entries.length === lastJournalCount) return;
  lastJournalCount = entries.length;

  // Only auto-scroll if user is already at the bottom
  const atBottom = journalFeed.scrollTop + journalFeed.clientHeight >= journalFeed.scrollHeight - 20;

  journalFeed.innerHTML = entries.map(e =>
    `<div class="journal-entry type-${e.type}">${e.text}</div>`
  ).join('');

  if (atBottom) journalFeed.scrollTop = journalFeed.scrollHeight;
}

// ── Tooltip / Help system ──
const tooltipOverlay = $('tooltip-overlay');
const tooltipTitle = $('tooltip-title');
const tooltipBody = $('tooltip-body');

const HELP_CONTENT = {
  species: {
    title: 'Species & Traits',
    body: `<p>Each species has <strong>6 evolvable traits</strong> — 5 universal (clutch size, longevity, mutation rate, metabolism, migration tendency) plus 1 species-specific adaptation.</p>
<p>Traits are floats from 0 to 1, tracked as population-weighted means per tile. They evolve through <strong>natural selection</strong> (survivors pass traits to offspring), <strong>genetic drift</strong> (random changes in small populations), and <strong>mutation</strong>.</p>
<p>The trait bar shows the species-specific trait. No trait is "better" — every value creates tradeoffs through interacting systems.</p>
<p><strong>Equation:</strong> Drift variance: <code>σ² = p(1−p) / 2N</code> (Wright's equation). Smaller populations drift faster.</p>`,
  },
  population: {
    title: 'Population Dynamics',
    body: `<p>Population growth follows the <strong>logistic equation</strong>:</p>
<p><code>dN/dt = rN(1 − N/K)</code></p>
<p>Where <strong>r</strong> is the growth rate (modified by clutch size trait) and <strong>K</strong> is carrying capacity (modified by habitat, food, season, metabolism).</p>
<p>Predation uses the <strong>Holling Type II functional response</strong>:</p>
<p><code>kills = a·P·N / (1 + a·h·N)</code></p>
<p>This means predation <strong>saturates</strong> at high prey density — predators can't eat infinitely fast. <code>a</code> = attack rate, <code>h</code> = handling time, <code>P</code> = predators, <code>N</code> = prey.</p>
<p>Scientists use these exact equations to model real ecosystems. The Lotka-Volterra predator-prey cycle you see in the chart is an emergent property — not coded directly.</p>`,
  },
  pentagon: {
    title: 'Ecosystem Balance',
    body: `<p>The pentagon diagram shows all 5 species' <strong>relative population strength</strong> simultaneously. Each vertex represents one species.</p>
<p>A balanced ecosystem produces a roughly even pentagon. When one species dominates, its vertex stretches outward while others contract.</p>
<p>Ecologists call this a <strong>community composition</strong> diagram. It reveals at a glance whether the ecosystem is in equilibrium or if one trophic level is collapsing.</p>
<p>When a species goes extinct, its vertex collapses to the center — the pentagon becomes a quadrilateral, then a triangle.</p>`,
  },
  journal: {
    title: 'Field Journal',
    body: `<p>The journal records significant ecological events as they happen — population booms, crashes, extinctions, seasonal stress.</p>
<p>Entries are written from the perspective of a field researcher observing the ecosystem. Each entry corresponds to a real change in the simulation data.</p>
<p>In a real field study, researchers track <strong>census data</strong> over time and look for the same patterns: sudden declines, range contractions, founder effects after population bottlenecks.</p>
<p>Click any entry to jump to the relevant point in the population chart (coming soon).</p>`,
  },
};

document.querySelectorAll('.help-btn').forEach(btn => {
  btn.addEventListener('click', e => {
    e.stopPropagation();
    const key = btn.dataset.help;
    const content = HELP_CONTENT[key];
    if (!content) return;
    tooltipTitle.textContent = content.title;
    tooltipBody.innerHTML = content.body;
    tooltipOverlay.classList.remove('hidden');
  });
});

$('tooltip-close').addEventListener('click', () => tooltipOverlay.classList.add('hidden'));
tooltipOverlay.addEventListener('click', e => {
  if (e.target === tooltipOverlay) tooltipOverlay.classList.add('hidden');
});

// ── Progressive disclosure ──
// Shows one-time hints as users encounter features for the first time.
// Tracks which hints have been seen in localStorage.
const DISCLOSED = new Set(JSON.parse(localStorage.getItem('evosim-disclosed') || '[]'));

function disclose(key, title, body) {
  if (DISCLOSED.has(key)) return;
  DISCLOSED.add(key);
  try { localStorage.setItem('evosim-disclosed', JSON.stringify([...DISCLOSED])); } catch {}
  tooltipTitle.textContent = title;
  tooltipBody.innerHTML = body;
  tooltipOverlay.classList.remove('hidden');
}

// Trigger disclosures at key moments
let disclosedFirstPlay = false;
let disclosedFirstExtinction = false;
let disclosedFirstJournal = false;

let disclosedGenMilestones = new Set();

function checkDisclosures(gen, pops) {
  // Gen 100 milestone
  if (gen >= 100 && !disclosedGenMilestones.has(100)) {
    disclosedGenMilestones.add(100);
    disclose('gen-100',
      '100 Generations',
      `<p>100 generations have passed. In real biology, a "generation" varies wildly — fruit flies: 2 weeks, humans: 25 years, bristlecone pines: centuries.</p>
<p>In this simulation, each generation runs the full ecological cycle: growth, predation, competition, migration, trait evolution. By now, genetic drift has started to differentiate populations across tiles.</p>
<p>Watch the trait bars on the species cards — they'll start shifting as natural selection and drift take effect.</p>`
    );
  }

  // Gen 500 — explain carrying capacity
  if (gen >= 500 && !disclosedGenMilestones.has(500)) {
    disclosedGenMilestones.add(500);
    disclose('gen-500',
      'Carrying Capacity',
      `<p>By now you may have noticed populations stabilize around certain levels. This is <strong>carrying capacity (K)</strong> — the maximum population a habitat can sustain.</p>
<p><code>dN/dt = rN(1 − N/K)</code></p>
<p>When N approaches K, growth slows to zero. When N exceeds K, the population declines. This is the logistic equation — the foundation of population ecology.</p>
<p>K isn't fixed — it depends on food, season, biome, and species traits. A drought lowers K. A high-metabolism species has higher K when food is abundant but crashes harder when it's scarce.</p>`
    );
  }

  // First time pressing play
  if (!disclosedFirstPlay && gen > 5) {
    disclosedFirstPlay = true;
    disclose('first-play',
      'Your Observation Begins',
      `<p>You're watching 5 species evolve in real time. The simulation runs <strong>population genetics equations</strong> every generation — the same math biologists use to model real evolution.</p>
<p>The <strong>map</strong> shows terrain and species density. The <strong>chart</strong> tracks population over time. The <strong>journal</strong> records significant events.</p>
<p>Drag to pan. Scroll to zoom. Right-drag to tilt. Q/E rotate. P population overlay.</p>
<p>Click the <strong>?</strong> buttons anytime for detailed explanations of the science behind each panel.</p>`
    );
  }

  // First extinction
  if (!disclosedFirstExtinction) {
    for (let s = 0; s < 5; s++) {
      if (pops[s] === 0) {
        disclosedFirstExtinction = true;
        disclose('first-extinction',
          'Extinction Event',
          `<p>A species has gone extinct. In this simulation, extinction happens when population reaches zero across all tiles.</p>
<p>Real extinctions follow the same pattern: populations decline through habitat loss, predation pressure, competition, disease, or genetic drift (random changes in small populations).</p>
<p><strong>Genetic drift equation:</strong> <code>σ² = p(1−p) / 2N</code></p>
<p>When N (population size) is small, random variance σ² is large — traits fluctuate wildly, and the population can drift to unsustainable values. This is why small populations are especially vulnerable.</p>`
        );
        break;
      }
    }
  }
}

// ── Eulogy overlay ──
const eulogyOverlay = $('eulogy-overlay');
const CAUSE_NARRATIVES = {
  predation: (name) => `Hunted to extinction. The predator populations were too much — ${name} couldn't sustain the losses.`,
  disease: (name) => `A blight swept through the ${name} population. Too few remained to recover.`,
  habitat_loss: (name) => `Their habitat eroded beneath them. As the terrain shifted, nowhere suitable remained for ${name}.`,
  competition: (name) => `Outcompeted. Other species claimed the resources that ${name} depended on.`,
  genetic_drift: (name) => `Too few, for too long. Genetic diversity collapsed. The end was quiet for ${name}.`,
  unknown: (name) => `${name} faded. The exact cause remains unclear — perhaps a combination of pressures the ecosystem couldn't buffer.`,
};

function showEulogy(extData) {
  const s = extData.species;
  const name = SPECIES_FULL[s];
  const cause = extData.cause || 'unknown';

  $('eulogy-icon').textContent = '†';
  $('eulogy-icon').style.color = SPECIES_COLORS[s];
  $('eulogy-species').textContent = name;
  $('eulogy-species').style.color = SPECIES_COLORS[s];
  $('eulogy-dates').textContent = `Gen ${extData.gens_survived || '?'} generations survived · Peak: ${extData.peak_pop || '?'}`;
  $('eulogy-cause').textContent = (CAUSE_NARRATIVES[cause] || CAUSE_NARRATIVES.unknown)(SPECIES_NAMES[s]);
  $('eulogy-stats').textContent = `Last seen: tile (${(extData.last_tile || [0,0]).join(',')})`;

  // Sparkline — population decline
  const sparkCanvas = $('eulogy-sparkline');
  const ctx = sparkCanvas.getContext('2d');
  const sw = sparkCanvas.width;
  const sh = sparkCanvas.height;
  ctx.clearRect(0, 0, sw, sh);

  const ghost = ghostData[s];
  if (ghost && ghost.length > 1) {
    let maxP = 1;
    for (const g of ghost) if (g.pop > maxP) maxP = g.pop;

    ctx.strokeStyle = hexToRgba(SPECIES_COLORS[s], 0.6);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < ghost.length; i++) {
      const x = (i / (ghost.length - 1)) * sw;
      const y = sh - (ghost[i].pop / maxP) * (sh - 4) - 2;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  // Pause sim and show overlay
  const wasPlaying = playing;
  if (playing) { sim.pause(); playing = false; btnPlay.textContent = '▶ Play'; btnPlay.classList.remove('active'); }
  eulogyOverlay.classList.remove('hidden');

  $('eulogy-dismiss').onclick = () => {
    eulogyOverlay.classList.add('hidden');
    if (wasPlaying) { playing = sim.togglePause(); btnPlay.textContent = '⏸ Pause'; btnPlay.classList.add('active'); }
  };
}

// ── Graveyard panel ──
function renderGraveyard() {
  const container = $('graveyard');
  const entries = $('graveyard-entries');
  if (extinctionRecords.length === 0) {
    container.classList.add('hidden');
    return;
  }
  container.classList.remove('hidden');
  entries.innerHTML = extinctionRecords.map(r => {
    const causeLabel = r.cause.replace(/_/g, ' ');
    return `<div class="graveyard-entry" style="border-left-color:${hexToRgba(r.color, 0.3)}">
      <div class="graveyard-name"><span class="graveyard-dot" style="background:${r.color}"></span>${r.name}</div>
      <div class="graveyard-detail">Gen 0–${r.diedGen} · ${causeLabel} · Peak: ${r.peakPop}</div>
    </div>`;
  }).join('');
}

// Check for speciation/extinction events from the queue
let shownEulogies = new Set();
function checkSimEvents() {
  const events = sim.getEventQueue();
  for (const evt of events) {
    // Extinction eulogy
    if (evt.type === 'extinction' && evt.data && !shownEulogies.has(evt.data.species)) {
      shownEulogies.add(evt.data.species);
      const d = evt.data;
      const evtGen = d.gen || Math.floor(sim.getGeneration());
      extinctionRecords.push({
        species: d.species,
        name: SPECIES_FULL[d.species],
        color: SPECIES_COLORS[d.species],
        bornGen: 0,
        diedGen: evtGen,
        cause: d.cause || 'unknown',
        peakPop: d.peak_pop || 0,
      });
      timelineEvents.push({ gen: evtGen, type: 'extinction', label: `${SPECIES_NAMES[d.species]} extinct`, color: '#C0392B' });
      renderGraveyard();
      showEulogy(evt.data);
    }

    if (evt.type === 'speciation') {
      if (challengeState.speciationGen === null) challengeState.speciationGen = currentGen;
      const specGen = evt.data?.gen || Math.floor(sim.getGeneration());
      const specName = evt.data?.species !== undefined ? SPECIES_NAMES[evt.data.species] : 'Species';
      timelineEvents.push({ gen: specGen, type: 'speciation', label: `${specName} speciation`, color: '#DDC165' });
      if (!DISCLOSED.has('first-speciation')) {
        disclose('first-speciation',
          'Speciation Detected',
          `<p>A species has <strong>speciated</strong> — split into two genetically distinct populations. This is evolution's most dramatic outcome.</p>
<p>Scientists measure this using <strong>FST (fixation index)</strong>, which quantifies genetic divergence between populations:</p>
<p><code>FST = (Ht − Hs) / Ht</code></p>
<p>Where Ht is total genetic variance and Hs is within-subpopulation variance. FST > 0.25 is considered very high divergence in real biology.</p>
<p>In this simulation, speciation is detected when the species-specific trait diverges by more than 0.3 between northern and southern populations for 100+ consecutive generations.</p>`
        );
      }
    }

    // Environmental events (drought, flood, volcanic, etc.)
    if (evt.type === 'environmental' || evt.type === 'epoch') {
      const envGen = evt.data?.gen || Math.floor(sim.getGeneration());
      const envLabel = evt.data?.name || evt.type;
      timelineEvents.push({ gen: envGen, type: 'environmental', label: envLabel, color: '#4a9eff' });
    }
  }
}

// ── LOD toggle ──
const btnLod = $('btn-lod');
let lodManual = false;

btnLod.addEventListener('click', () => {
  const views = sim.getViews();
  if (!views) return;
  const current = views.globals[GLOBAL.LOD_LEVEL];
  const next = current === 0 ? 1 : 0;
  views.globals[GLOBAL.LOD_LEVEL] = next;
  lodManual = true;
  btnLod.textContent = next === 0 ? 'Full' : 'Fast';
  btnLod.classList.toggle('active', next === 1);
  // Tell Python
  // (auto-LOD in sim.js will respect this until it overrides)
});

// ── Map hint auto-fade ──
const mapHint = $('map-hint');
if (mapHint) {
  setTimeout(() => mapHint.classList.add('fade'), 5000);
}

// ── Theme selector ──
const themeSelect = $('theme-select');
function populateThemes() {
  for (const [id, theme] of Object.entries(THEMES)) {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = theme.label;
    themeSelect.appendChild(opt);
  }
}
populateThemes();
themeSelect.addEventListener('change', (e) => setTheme(e.target.value));

// ── End Observation ──
const endOverlay = $('end-overlay');
let observationEnded = false;

function showEndScreen() {
  if (observationEnded) return;
  observationEnded = true;

  // Pause
  if (playing) { sim.pause(); playing = false; btnPlay.textContent = '▶ Play'; btnPlay.classList.remove('active'); }

  const views = sim.getViews();
  const gen = Math.floor(views.globals[GLOBAL.GENERATION]);
  const pops = [];
  for (let s = 0; s < 5; s++) pops.push(views.globals[GLOBAL.TOTAL_POP_0 + s]);
  const alive = pops.filter(p => p > 0).length;
  const total = pops.reduce((a, b) => a + b, 0);

  $('end-seed').textContent = `Seed: ${seedInput.value} · Grid: ${gridSize}×${gridSize}`;
  $('end-stats').innerHTML = `
    <div class="end-stat"><div class="end-stat-val">${gen.toLocaleString()}</div><div class="end-stat-label">Generations</div></div>
    <div class="end-stat"><div class="end-stat-val">${alive}</div><div class="end-stat-label">Species Alive</div></div>
    <div class="end-stat"><div class="end-stat-val">${Math.floor(total).toLocaleString()}</div><div class="end-stat-label">Total Pop</div></div>
    <div class="end-stat"><div class="end-stat-val">${knownExtinctions.size}</div><div class="end-stat-label">Extinctions</div></div>
  `;

  let spHtml = '';
  for (let s = 0; s < 5; s++) {
    const alive = pops[s] > 0;
    spHtml += `<div class="end-sp">
      <div class="end-sp-dot" style="background:${SPECIES_COLORS[s]}${alive ? '' : ';opacity:0.3'}"></div>
      <div class="end-sp-name"${alive ? '' : ' style="text-decoration:line-through;opacity:0.5"'}>${SPECIES_FULL[s]}</div>
      <div class="end-sp-status ${alive ? 'alive' : 'dead'}">${alive ? Math.floor(pops[s]).toLocaleString() : 'EXTINCT'}</div>
    </div>`;
  }
  $('end-species-list').innerHTML = spHtml;

  // Save run, check challenge, check achievements
  saveRunToHall(gen, [...pops], seedInput.value);
  btnHistory.style.display = '';

  const resultEl = $('end-challenge-result');
  if (activeChallenge >= 0) {
    const passed = CHALLENGES[activeChallenge].check(gen, pops, challengeState);
    resultEl.textContent = passed ? '★ CHALLENGE COMPLETE' : '✗ CHALLENGE FAILED';
    resultEl.className = passed ? 'challenge-success' : 'challenge-fail';
    resultEl.classList.remove('hidden');
  } else {
    resultEl.classList.add('hidden');
  }

  const newAchievements = checkAchievements(gen, [...pops]);
  for (const ach of newAchievements) showAchievementToast(`Achievement: ${ach.name}`);

  endOverlay.classList.remove('hidden');
}

$('btn-end').addEventListener('click', showEndScreen);
$('end-close').addEventListener('click', () => {
  endOverlay.classList.add('hidden');
  observationEnded = false;
});
$('end-new').addEventListener('click', () => {
  endOverlay.classList.add('hidden');
  app.classList.add('hidden');
  setup.classList.remove('hidden');
  observationEnded = false;
  activeChallenge = -1;
  // Reset state
  popHistory.length = 0;
  traitHistory.length = 0;
  Object.keys(ghostData).forEach(k => delete ghostData[k]);
  knownExtinctions.clear();
  extinctionRecords.length = 0;
  renderGraveyard();
  shownEulogies.clear();
  timelineEvents.length = 0;
  popChartMarkers.length = 0;
  lastRenderedGen = -1;
  portraitCanvases = [];
  lastTraitValues = [-1, -1, -1, -1, -1];
  lastJournalCount = 0;
  lastEpochId = -1;
  // Re-init WebGL renderer for new grid size
  mapRenderer = new MapRenderer(mapCanvas);
  if (mapRenderer.fallback) { mapRenderer = null; }
  else { mapRenderer.setup(gridSize); }
  challengeState = resetChallengeState();
  currentGen = 0;
  $('challenge-badge').classList.add('hidden');
  analysis.clearRegions();
  analysis.setOverlay('none');
  traitsTabInitialized = false;
  corrTabInitialized = false;
  document.querySelectorAll('.overlay-btn').forEach(b => b.classList.toggle('active', b.dataset.overlay === 'none'));
  seedInput.value = generateSeed();
  renderPreview();
});

// Auto-trigger end screen when all species extinct
function checkAllExtinct(pops) {
  if (pops.every(p => p === 0) && !observationEnded && sim.getGeneration() > 10) {
    showEndScreen();
  }
}

// ── Achievement & Hall helpers ──
function checkAchievements(gen, pops) {
  const hall = JSON.parse(localStorage.getItem('evosim-hall') || '[]');
  const earned = new Set(JSON.parse(localStorage.getItem('evosim-achievements') || '[]'));
  const newOnes = [];
  function earn(id) {
    if (!earned.has(id)) {
      earned.add(id);
      const def = ACHIEVEMENTS_DEF.find(a => a.id === id);
      if (def) newOnes.push(def);
    }
  }
  earn('first-run');
  if (knownExtinctions.size > 0) earn('first-extinction');
  if (challengeState.speciationGen !== null) earn('first-speciation');
  if (gen >= 1000) earn('millennium');
  if (gen >= 5000) earn('deep-time');
  if (gen >= 10000) earn('geological-scale');
  if (challengeState.allAliveAt3k) earn('all-present-3k');
  if (pops.every(p => p === 0)) earn('total-wipeout');
  if (hall.length >= 4) earn('veteran'); // 4 past runs + this one = 5
  if (challengeState.resilienceAchieved) earn('comeback');
  try { localStorage.setItem('evosim-achievements', JSON.stringify([...earned])); } catch {}
  return newOnes;
}

function saveRunToHall(gen, pops, seed) {
  const hall = JSON.parse(localStorage.getItem('evosim-hall') || '[]');
  hall.unshift({
    seed,
    gen: Math.floor(gen),
    alive: pops.filter(p => p > 0).length,
    extinctions: knownExtinctions.size,
    date: new Date().toLocaleDateString(),
    challenge: activeChallenge >= 0 ? CHALLENGES[activeChallenge].id : null,
  });
  if (hall.length > 50) hall.pop();
  try { localStorage.setItem('evosim-hall', JSON.stringify(hall)); } catch {}
}

function renderHall() {
  const hall = JSON.parse(localStorage.getItem('evosim-hall') || '[]');
  const list = $('hall-list');
  if (!hall.length) {
    list.innerHTML = '<div class="hall-empty">No observations recorded yet.</div>';
    return;
  }
  list.innerHTML = hall.map((run, i) => {
    const chName = run.challenge ? ` · ${CHALLENGES.find(c => c.id === run.challenge)?.name || run.challenge}` : '';
    return `<div class="hall-entry">
      <div class="hall-rank">#${i + 1}</div>
      <div class="hall-info">
        <div class="hall-seed">${run.seed}${chName}</div>
        <div class="hall-meta">${run.date} · Gen ${run.gen.toLocaleString()} · ${run.alive}/5 alive · ${run.extinctions} extinctions</div>
      </div>
    </div>`;
  }).join('');
}

function showAchievementToast(text) {
  achievementToastQueue.push(text);
  if (!toastTimeout) processToastQueue();
}

function processToastQueue() {
  if (!achievementToastQueue.length) { toastTimeout = null; return; }
  const text = achievementToastQueue.shift();
  const toast = $('achievement-toast');
  $('achievement-toast-text').textContent = text;
  toast.classList.remove('hidden');
  toast.classList.add('show');
  toastTimeout = setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => {
      toast.classList.add('hidden');
      toastTimeout = null;
      processToastQueue();
    }, 400);
  }, 2500);
}

// ── Save/Load ──
const btnSave = $('btn-save');
const btnLoadSave = $('btn-load-save');

btnSave.addEventListener('click', () => {
  if (sim.saveGame()) {
    btnSave.textContent = 'Saved ✓';
    setTimeout(() => { btnSave.textContent = 'Save'; }, 1500);
  }
});

// Show "Resume" button on setup screen if save exists
if (sim.hasSave()) {
  btnLoadSave.style.display = '';
}

btnLoadSave.addEventListener('click', async () => {
  setup.classList.add('hidden');
  loader.classList.remove('hidden');
  loaderFill.style.width = '0%';

  // Need to parse the save to get grid size
  const saveData = JSON.parse(localStorage.getItem('evosim-save') || '{}');
  const savedGridSize = saveData.grid_size || 12;

  try {
    await sim.init(savedGridSize, saveData.seed || 'LOAD', (phase, pct) => {
      loaderMsg.textContent = {
        pyodide: 'Downloading Python runtime...',
        numpy: 'Loading numpy...',
        buffer: 'Allocating shared memory...',
        sim: 'Initializing simulation...',
        init: 'Restoring saved state...',
        ready: 'Ready.',
      }[phase] || phase;
      loaderFill.style.width = pct + '%';
    });

    sim.loadGame();
    loader.classList.add('hidden');
    app.classList.remove('hidden');

    mapRenderer = new MapRenderer(mapCanvas);
    if (mapRenderer.fallback) { mapRenderer = null; }
    else { mapRenderer.setup(gridSize); }

    resizeCanvases();
    startRenderLoop();
  } catch (err) {
    loaderMsg.textContent = 'Error: ' + err.message;
    console.error(err);
  }
});

// ── Analysis tools wiring ──

// Traits tab
let traitsTabInitialized = false;
function renderTraitsTab() {
  const views = sim.getViews();
  const layout = sim.getLayout();
  if (!views || !layout) return;
  const canvas = document.getElementById('trait-hist-canvas');
  if (!traitsTabInitialized) {
    traitsTabInitialized = true;
    const container = document.getElementById('trait-species-selector');
    analysis.renderTraitSpeciesSelector(container, () => renderTraitsTab());
  }
  analysis.renderTraitHistograms(canvas, views, layout);
}

// Correlations tab
let corrTabInitialized = false;
function renderCorrelationsTab() {
  const views = sim.getViews();
  const layout = sim.getLayout();
  if (!views || !layout) return;
  const canvas = document.getElementById('corr-canvas');
  if (!corrTabInitialized) {
    corrTabInitialized = true;
    const sx = document.getElementById('corr-x');
    const sy = document.getElementById('corr-y');
    analysis.populateMetricSelectors(sx, sy, () => renderCorrelationsTab());
    // Preset buttons
    const presetsEl = document.getElementById('corr-presets');
    for (const preset of analysis.getPresets()) {
      const btn = document.createElement('button');
      btn.className = 'corr-preset-btn';
      btn.textContent = preset.label;
      btn.addEventListener('click', () => {
        analysis.applyPreset(preset, sx, sy, () => renderCorrelationsTab());
      });
      presetsEl.appendChild(btn);
    }
  }
  analysis.renderCorrelationPlot(canvas, views, layout);
}

// Regions tab
function renderRegionsTab() {
  const views = sim.getViews();
  const layout = sim.getLayout();
  if (!views || !layout) return;
  const canvas = document.getElementById('region-canvas');
  analysis.renderRegionComparison(canvas, views, layout);
  // Update button states
  const mode = analysis.getRegionSelectMode();
  const btnA = document.getElementById('btn-region-a');
  const btnB = document.getElementById('btn-region-b');
  btnA.classList.toggle('selecting', mode === 'a');
  btnB.classList.toggle('selecting', mode === 'b');
}

document.getElementById('btn-region-a')?.addEventListener('click', () => {
  analysis.startRegionSelect('a');
  renderRegionsTab();
});
document.getElementById('btn-region-b')?.addEventListener('click', () => {
  analysis.startRegionSelect('b');
  renderRegionsTab();
});
document.getElementById('btn-region-clear')?.addEventListener('click', () => {
  analysis.clearRegions();
  renderRegionsTab();
});

// Map overlay controls
document.querySelectorAll('.overlay-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.overlay-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    analysis.setOverlay(btn.dataset.overlay);
  });
});

// Species detail modal
const speciesDetailOverlay = $('species-detail-overlay');
const speciesDetailCanvas = $('species-detail-canvas');

function showSpeciesDetail(speciesIdx) {
  const views = sim.getViews();
  const layout = sim.getLayout();
  if (!views || !layout) return;
  const detail = analysis.computeSpeciesDetail(views, layout, speciesIdx, popHistory, traitHistory);
  // Size canvas for HiDPI
  const dpr = window.devicePixelRatio || 1;
  const rect = speciesDetailCanvas.getBoundingClientRect();
  speciesDetailCanvas.width = rect.width * dpr;
  speciesDetailCanvas.height = rect.height * dpr;
  analysis.renderSpeciesDetail(speciesDetailCanvas, detail, drawPortrait);
  speciesDetailOverlay.classList.remove('hidden');
}

$('species-detail-close').addEventListener('click', () => speciesDetailOverlay.classList.add('hidden'));
speciesDetailOverlay.addEventListener('click', e => {
  if (e.target === speciesDetailOverlay) speciesDetailOverlay.classList.add('hidden');
});

// Help content for new tabs
HELP_CONTENT.traits = {
  title: 'Trait Distributions',
  body: `<p>Each histogram shows how a trait is distributed across the population of the selected species.</p>
<p>A tall, narrow distribution means the species is genetically uniform for that trait — strong selection has pushed everyone toward a similar value.</p>
<p>A wide or <strong>bimodal</strong> (two-peaked) distribution means the population is diverging — a precursor to <strong>speciation</strong>.</p>
<p>The dashed line shows the <strong>mean (μ)</strong>. The shaded band shows <strong>±1 standard deviation (σ)</strong>. Skew indicates asymmetry in the distribution.</p>`,
};
HELP_CONTENT.correlations = {
  title: 'Correlation Explorer',
  body: `<p>The scatter plot shows the relationship between any two metrics across all tiles.</p>
<p>Each dot is one tile with a non-zero species population. Color = species, size = population.</p>
<p>The dashed line is a <strong>linear regression</strong>. <strong>R²</strong> measures how much of the variation in Y is explained by X (0 = no correlation, 1 = perfect).</p>
<p>Try the presets to discover emergent tradeoffs — does shell thickness really correlate with tidal zones? Does metabolism track vegetation?</p>`,
};
HELP_CONTENT.regions = {
  title: 'Region Comparison',
  body: `<p>Compare two tiles side-by-side to detect local adaptation, population divergence, and early speciation.</p>
<p>Select two tiles by clicking the buttons, then clicking tiles on the map. The panel shows population counts, trait values, and <strong>genetic distance</strong> between subpopulations.</p>
<p>High genetic distance between isolated regions suggests speciation may be underway.</p>`,
};

// ── Init ──
const savedTheme = loadSavedTheme();
themeSelect.value = savedTheme;

// Preload Pyodide in background while showing setup screen
const loaderHint = $('loader-hint');
const loaderReload = $('loader-reload');
loaderMsg.textContent = 'Loading simulation engine...';
sim.preload((phase, pct) => {
  loaderFill.style.width = pct + '%';
  loaderMsg.textContent = {
    pyodide: 'Downloading Python runtime...',
    numpy: 'Loading scientific computing library...',
    scipy: 'Loading scipy...',
    code: 'Loading simulation code...',
    ready: 'Ready.',
  }[phase] || phase;
  // Show a patience hint during the slow Pyodide download phase
  if (loaderHint) {
    loaderHint.textContent = phase === 'pyodide'
      ? 'First load takes ~15 seconds — packages are cached after that.'
      : '';
  }
}).then(() => {
  if (loaderHint) loaderHint.textContent = '';
  loader.classList.add('hidden');
  setup.classList.remove('hidden');
  renderPreview(); // first preview with actual Python terrain gen
}).catch(err => {
  loaderMsg.textContent = 'Failed to load: ' + err.message;
  loaderFill.style.width = '100%';
  loaderFill.style.background = '#C0392B';
  if (loaderHint) loaderHint.textContent = 'Check your internet connection and try reloading.';
  if (loaderReload) loaderReload.classList.remove('hidden');
  console.error(err);
});

// ── Debug controls ──
$('debug-spawn-river')?.addEventListener('click', () => {
  const result = sim.debugSpawnRiver();
  console.log('Debug:', result);
});
$('debug-drought')?.addEventListener('click', () => sim.debugTriggerEvent('drought'));
$('debug-disease')?.addEventListener('click', () => sim.debugTriggerEvent('disease'));
$('debug-bloom')?.addEventListener('click', () => sim.debugTriggerEvent('algal_bloom'));
$('debug-surge')?.addEventListener('click', () => sim.debugTriggerEvent('tidal_surge'));
$('debug-eruption')?.addEventListener('click', () => sim.debugTriggerEvent('eruption'));

// Tile click for debug info (always works, shows in debug panel)
mapCanvas.addEventListener('click', e => {
  if (!debugMode) return;
  const views = sim.getViews();
  if (!views) return;
  const gs = sim.getLayout().gridSize;
  const dpr = window.devicePixelRatio || 1;
  const rect = mapCanvas.getBoundingClientRect();
  const mx = (e.clientX - rect.left) * dpr;
  const my = (e.clientY - rect.top) * dpr;

  // Reverse isometric: find closest tile to click position
  const tileW = (rect.width / gs) * 0.85 * camZoom * dpr;
  const tileH = tileW * camTilt;
  const hScale = 160 * camZoom / rect.height * 2.0;
  const cx = rect.width * dpr / 2 + camPanX * dpr;
  const cy = rect.height * dpr / 2 + camPanY * dpr;

  let bestR = 0, bestC = 0, bestDist = Infinity;
  for (let r = 0; r < gs; r++) {
    for (let c = 0; c < gs; c++) {
      const elev = views.elevations[r * gs + c];
      const ix = (c - r) * tileW * 0.5;
      const iy = (c + r) * tileH * 0.5;
      const iz = elev * hScale;
      const sx = cx + ix;
      const sy = cy + iy - iz;
      const dx = mx - sx, dy = my - sy;
      const d = dx * dx + dy * dy;
      if (d < bestDist) { bestDist = d; bestR = r; bestC = c; }
    }
  }

  const infoJson = sim.debugGetTileInfo(bestR, bestC);
  const info = JSON.parse(infoJson);
  const tileInfoEl = $('debug-tile-info');
  if (tileInfoEl && info.r !== undefined) {
    const pops = Object.entries(info.populations || {}).map(([k,v]) => `${k}:${v}`).join(' ');
    tileInfoEl.innerHTML = `<b>(${info.r},${info.c})</b> ${info.biome} · E:${info.elevation} V:${info.vegetation}` +
      (info.has_river ? ' · <span style="color:#4a9eff">River</span>' : '') +
      (info.volcanic ? ' · <span style="color:#E5591C">Volcanic</span>' : '') +
      (pops ? `<br>${pops}` : '');
  }
});
