/**
 * UI controller — handles DOM interactions, orchestrates sim + renderer.
 * Entry point for the application.
 */

import * as sim from './sim.js';
import { GLOBAL } from './layout.js';
import { THEMES, setTheme, getBiomeColors, getMapBg, getWaterColor, loadSavedTheme } from './themes.js';
import { drawPortrait } from './creatures.js';
import { checkForEntries, getRecent } from './journal.js';
import { MapRenderer } from './render.js';

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

let gridSize = 32;
let playing = false;
let renderFrameId = null;
let lastRenderedGen = -1;
let mapRenderer = null; // WebGL renderer (null = use Canvas 2D fallback)

// Camera state
let camTilt = 0.5;   // 0.2 (flat) to 0.8 (steep)
let camZoom = 1.0;
let camPanX = 0;
let camPanY = 0;
let isDragging = false;
let dragButton = -1;
let dragLastX = 0;
let dragLastY = 0;

// Population history for chart
const popHistory = [];
const MAX_HISTORY = 300;

// Ghost data: extinct species' last N data points, preserved after death
const ghostData = {}; // species index → [{gen, pop}]
let knownExtinctions = new Set();

// ── Seed utils ──
function generateSeed() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

window.randomSeed = () => { seedInput.value = generateSeed(); };

// ── Setup screen ──
seedInput.value = generateSeed();

document.querySelectorAll('.size-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.size-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    gridSize = parseInt(btn.dataset.size);
  });
});

// ── Setup preview ──
const previewCanvas = $('preview-canvas');

function renderPreview() {
  // Generate a simple noise preview without Pyodide (JS-only approximation)
  const dpr = window.devicePixelRatio || 1;
  const w = previewCanvas.width = previewCanvas.offsetWidth * dpr;
  const h = previewCanvas.height = previewCanvas.offsetHeight * dpr;
  const ctx = previewCanvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const cw = previewCanvas.offsetWidth;
  const ch = previewCanvas.offsetHeight;

  ctx.fillStyle = getMapBg();
  ctx.fillRect(0, 0, cw, ch);

  const gs = gridSize;
  const seed = seedInput.value || 'ABC123';
  const seedVal = seed.split('').reduce((a, c, i) => a + c.charCodeAt(0) * (i + 1), 0);

  // Seeded hash for deterministic pseudo-random
  function hash(x, y, s) {
    let n = Math.sin(x * 127.1 + y * 311.7 + s) * 43758.5453;
    return n - Math.floor(n);
  }

  // Smooth noise via interpolated hash grid (preview-quality)
  function smoothNoise(x, y, s) {
    const ix = Math.floor(x), iy = Math.floor(y);
    const fx = x - ix, fy = y - iy;
    // Smoothstep
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const a = hash(ix, iy, s), b = hash(ix+1, iy, s);
    const c = hash(ix, iy+1, s), d = hash(ix+1, iy+1, s);
    return a + sx * (b - a) + sy * (c - a) + sx * sy * (a - b - c + d);
  }

  function fbm(x, y, s, oct = 6) {
    let v = 0, amp = 1, tot = 0, freq = 1;
    for (let o = 0; o < oct; o++) {
      v += smoothNoise(x * freq, y * freq, s + o * 1337) * amp;
      tot += amp;
      freq *= 2;
      amp *= 0.5;
    }
    return v / tot;
  }

  // Generate blob landmass (matches Python algorithm)
  const cx2 = gs * (0.4 + hash(0, 0, seedVal + 1) * 0.2);
  const cy2 = gs * (0.4 + hash(0, 1, seedVal + 2) * 0.2);
  const aspect = 0.6 + hash(0, 2, seedVal + 3) * 1.0;
  const mainR = gs * (0.32 + hash(0, 3, seedVal + 4) * 0.1);
  const numBlobs = 5 + Math.floor(hash(0, 4, seedVal + 5) * 8);

  const blobs = [[cx2, cy2, mainR, mainR * aspect, hash(0, 5, seedVal + 6) * Math.PI]];
  for (let i = 0; i < numBlobs; i++) {
    const parent = blobs[Math.floor(hash(i, 10, seedVal + 20) * blobs.length)];
    const angle = hash(i, 11, seedVal + 21) * Math.PI * 2;
    const dist = parent[2] * (0.3 + hash(i, 12, seedVal + 22) * 0.5);
    const bx = parent[0] + Math.cos(angle) * dist;
    const by = parent[1] + Math.sin(angle) * dist;
    const br = gs * (0.08 + hash(i, 13, seedVal + 23) * 0.17);
    const ba = br * (0.5 + hash(i, 14, seedVal + 24) * 1.0);
    const brot = hash(i, 15, seedVal + 25) * Math.PI;
    blobs.push([bx, by, br, ba, brot]);
  }

  const tileW = (cw / gs) * 0.85;
  const tileH = tileW * 0.5;
  const heightScale = 40;
  const offsetX = cw / 2;
  const offsetY = (ch - gs * tileH * 0.5) / 2 + 20;
  const biomeColors = getBiomeColors();

  for (let r = 0; r < gs; r++) {
    for (let c = 0; c < gs; c++) {
      // Blob mask
      let mask = 0;
      for (const [bx, by, brx, bry, brot] of blobs) {
        const dx = r - bx, dy = c - by;
        const rx = dx * Math.cos(brot) + dy * Math.sin(brot);
        const ry = -dx * Math.sin(brot) + dy * Math.cos(brot);
        const d = (rx / Math.max(1, brx)) ** 2 + (ry / Math.max(1, bry)) ** 2;
        if (d < 1) {
          const t = Math.sqrt(d);
          mask = Math.max(mask, (1 - t * t) ** 2);
        }
      }

      // Edge falloff
      const border = gs * 0.08;
      const edgeDist = Math.min(r, c, gs - 1 - r, gs - 1 - c);
      if (edgeDist < border) mask *= (edgeDist / border) ** 1.5;

      // Combine mask with noise
      const n = fbm(r / gs * 4, c / gs * 4, seedVal);
      let e = mask * 0.4 + mask * n * 0.6;
      e = Math.max(0, Math.min(1, e));

      let biome;
      if (e < 0.15) biome = 0;
      else if (e < 0.3) biome = 1;
      else if (e < 0.5) biome = 2;
      else if (e < 0.7) biome = 3;
      else biome = 4;

      const bc = biomeColors[biome];
      const tr = bc[0] + e * 25;
      const tg = bc[1] + e * 18;
      const tb = bc[2] + e * 12;
      const shade = 0.6 + e * 0.3;

      const ix = (c - r) * tileW * 0.5;
      const iy = (c + r) * tileH * 0.5;
      const iz = e * heightScale;
      const sx = offsetX + ix;
      const sy = offsetY + iy - iz;

      ctx.fillStyle = `rgb(${tr * shade | 0},${tg * shade | 0},${tb * shade | 0})`;
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

// Render preview when seed or size changes
seedInput.addEventListener('input', renderPreview);
document.querySelectorAll('.size-btn').forEach(b => b.addEventListener('click', () => setTimeout(renderPreview, 10)));
setTimeout(renderPreview, 50);

$('btn-begin').addEventListener('click', async () => {
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

    // Canvas 2D renderer (WebGL upgrade deferred until shader geometry is correct)
    mapRenderer = null;

    resizeCanvases();
    startRenderLoop();
  } catch (err) {
    loaderMsg.textContent = 'Error: ' + err.message;
    loaderFill.style.width = '100%';
    loaderFill.style.background = '#C0392B';
    console.error(err);
  }
});

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
    camTilt = Math.max(0.2, Math.min(0.8, camTilt + dy * 0.004));
  } else {
    // Left-click: pan
    camPanX += dx;
    camPanY += dy;
  }
});
window.addEventListener('mouseup', () => { isDragging = false; dragButton = -1; });
mapCanvas.addEventListener('contextmenu', e => e.preventDefault());

mapCanvas.addEventListener('wheel', e => {
  e.preventDefault();
  const delta = e.deltaY > 0 ? -0.1 : 0.1;
  camZoom = Math.max(0.4, Math.min(3.0, camZoom + delta));
}, { passive: false });

// Touch controls
let touchStartDist = 0;
let touchStartZoom = 1;
mapCanvas.addEventListener('touchstart', e => {
  if (e.touches.length === 1) {
    isDragging = true;
    dragLastX = e.touches[0].clientX;
    dragLastY = e.touches[0].clientY;
  } else if (e.touches.length === 2) {
    isDragging = false;
    const dx = e.touches[1].clientX - e.touches[0].clientX;
    const dy = e.touches[1].clientY - e.touches[0].clientY;
    touchStartDist = Math.sqrt(dx * dx + dy * dy);
    touchStartZoom = camZoom;
  }
}, { passive: true });
mapCanvas.addEventListener('touchmove', e => {
  if (e.touches.length === 1 && isDragging) {
    const dx = e.touches[0].clientX - dragLastX;
    const dy = e.touches[0].clientY - dragLastY;
    dragLastX = e.touches[0].clientX;
    dragLastY = e.touches[0].clientY;
    camPanX += dx;
    camPanY += dy;
  } else if (e.touches.length === 2) {
    const dx = e.touches[1].clientX - e.touches[0].clientX;
    const dy = e.touches[1].clientY - e.touches[0].clientY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    camZoom = Math.max(0.4, Math.min(3.0, touchStartZoom * (dist / touchStartDist)));
  }
}, { passive: true });
mapCanvas.addEventListener('touchend', () => { isDragging = false; });

// Double-click to reset camera
mapCanvas.addEventListener('dblclick', () => {
  camTilt = 0.5; camZoom = 1.0; camPanX = 0; camPanY = 0;
});

// ── Render loop (decoupled from sim) ──
const SPECIES_COLORS = ['#DDC165', '#C0392B', '#2ECC71', '#E5591C', '#9B59B6'];

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
      const seasonNames = ['Winter', 'Spring', 'Summer', 'Autumn'];
      const seasonIdx = Math.floor(((seasonVal + 0.25) % 1) * 4) % 4;
      seasonLabel.textContent = seasonNames[seasonIdx];

      // Collect population totals for chart
      const pops = [];
      for (let s = 0; s < 5; s++) {
        pops.push(views.globals[GLOBAL.TOTAL_POP_0 + s]);
      }
      popHistory.push({ gen, pops: [...pops] });
      if (popHistory.length > MAX_HISTORY) popHistory.shift();

      // Detect new extinctions → freeze ghost data
      for (let s = 0; s < 5; s++) {
        if (pops[s] === 0 && !knownExtinctions.has(s)) {
          // Species just went extinct — capture its historical data
          knownExtinctions.add(s);
          ghostData[s] = popHistory.filter(h => h.pops[s] > 0).map(h => ({ gen: h.gen, pop: h.pops[s] }));
        }
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
    }

    // Render map (every frame — camera might move)
    if (mapRenderer) {
      // WebGL path
      if (gen !== lastRenderedGen || true) { // always update for camera movement
        mapRenderer.updateData(views.elevations, views.biomes);
      }
      mapRenderer.render(
        { tilt: camTilt, zoom: camZoom, panX: camPanX, panY: camPanY },
        getBiomeColors()
      );
    } else {
      // Canvas 2D fallback
      renderMap(views);
    }

    renderFrameId = requestAnimationFrame(frame);
  }

  renderFrameId = requestAnimationFrame(frame);
}

// ── Map renderer (Canvas 2D) ──
function renderMap(views) {
  const dpr = window.devicePixelRatio || 1;
  const ctx = mapCanvas.getContext('2d');
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

  // Water level plane
  const WATER_LEVEL = 0.18;

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

  // Per-tile color noise (seeded, stable across frames)
  // Adds visual variety within biomes — grass isn't uniform green
  function tileNoise(r, c) {
    const n = Math.sin(r * 127.1 + c * 311.7 + 43758.5453) * 43758.5453;
    return (n - Math.floor(n)) * 2 - 1; // -1 to 1
  }

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
      const nz = tileNoise(r, c), nz2 = tileNoise(r + 100, c + 200);
      let tr = Math.max(0, Math.min(255, bc[0] + elev * 25 + nz * 12));
      let tg = Math.max(0, Math.min(255, bc[1] + elev * 18 + nz2 * 10));
      let tb = Math.max(0, Math.min(255, bc[2] + elev * 12 + nz * 6));

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
  // Draw river paths that follow the tile grid, rendered as thick lines
  // connecting tile centers at their isometric positions
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
}

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
      const ctx = canvas.getContext('2d');
      const dpr = window.devicePixelRatio || 1;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawPortrait(ctx, s, meanTraits[s], 40, SPECIES_COLORS[s]);
    }
  }
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
}

// ── Journal feed ──
const journalFeed = $('journal-feed');
let lastJournalCount = 0;

function renderJournal() {
  const entries = getRecent(15);
  if (entries.length === lastJournalCount) return;
  lastJournalCount = entries.length;

  journalFeed.innerHTML = entries.map(e =>
    `<div class="journal-entry type-${e.type}">${e.text}</div>`
  ).join('');

  journalFeed.scrollTop = journalFeed.scrollHeight;
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
<p>Drag to pan the map. Scroll to zoom. Right-drag to tilt.</p>
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

// Check for speciation/extinction events from the queue
let shownEulogies = new Set();
function checkSimEvents() {
  const events = sim.getEventQueue();
  for (const evt of events) {
    // Extinction eulogy
    if (evt.type === 'extinction' && evt.data && !shownEulogies.has(evt.data.species)) {
      shownEulogies.add(evt.data.species);
      showEulogy(evt.data);
    }

    if (evt.type === 'speciation' && !DISCLOSED.has('first-speciation')) {
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
  // Reset state
  popHistory.length = 0;
  Object.keys(ghostData).forEach(k => delete ghostData[k]);
  knownExtinctions.clear();
  shownEulogies.clear();
  lastRenderedGen = -1;
  portraitCanvases = [];
  lastTraitValues = [-1, -1, -1, -1, -1];
  lastJournalCount = 0;
  lastEpochId = -1;
  mapRenderer = null;
  seedInput.value = generateSeed();
  renderPreview();
});

// Auto-trigger end screen when all species extinct
function checkAllExtinct(pops) {
  if (pops.every(p => p === 0) && !observationEnded && sim.getGeneration() > 10) {
    showEndScreen();
  }
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

    mapRenderer = null;

    resizeCanvases();
    startRenderLoop();
  } catch (err) {
    loaderMsg.textContent = 'Error: ' + err.message;
    console.error(err);
  }
});

// ── Init ──
const savedTheme = loadSavedTheme();
themeSelect.value = savedTheme;
loader.classList.add('hidden');
setup.classList.remove('hidden');
