/**
 * UI controller — handles DOM interactions, orchestrates sim + renderer.
 * Entry point for the application.
 */

import * as sim from './sim.js';
import { GLOBAL } from './layout.js';
import { THEMES, setTheme, getBiomeColors, getMapBg, getWaterColor, loadSavedTheme } from './themes.js';
import { drawPortrait } from './creatures.js';

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

let gridSize = 12;
let playing = false;
let renderFrameId = null;
let lastRenderedGen = -1;

// Population history for chart
const popHistory = [];
const MAX_HISTORY = 300;

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
  popChart.width = chartRect.width * dpr;
  popChart.height = 160 * dpr;
}

window.addEventListener('resize', resizeCanvases);

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

      // Render population chart + species cards
      renderPopChart();
      renderSpeciesCards(pops);
    }

    // Render map (every frame — camera might move)
    renderMap(views);

    renderFrameId = requestAnimationFrame(frame);
  }

  renderFrameId = requestAnimationFrame(frame);
}

// ── Map renderer (Canvas 2D for now — WebGL upgrade later) ──
function renderMap(views) {
  const dpr = window.devicePixelRatio || 1;
  const ctx = mapCanvas.getContext('2d');
  const w = mapCanvas.width / dpr;
  const h = mapCanvas.height / dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  ctx.fillStyle = getMapBg();
  ctx.fillRect(0, 0, w, h);

  const gs = sim.getLayout().gridSize;
  const tileW = (w / gs) * 0.85;
  const tileH = tileW * 0.5;
  const heightScale = 60;

  const offsetX = w / 2;
  const offsetY = (h - gs * tileH * 0.5) / 2 + heightScale * 0.3;

  const BIOME_COLORS = getBiomeColors();

  for (let r = 0; r < gs; r++) {
    for (let c = 0; c < gs; c++) {
      const idx = r * gs + c;
      const elev = views.elevations[idx];
      const biome = views.biomes[idx];

      const bc = BIOME_COLORS[biome] || [30, 20, 10];
      let tr = bc[0] + elev * 30;
      let tg = bc[1] + elev * 20;
      let tb = bc[2] + elev * 15;

      // Directional shade
      let shade = 0.65;
      if (r > 0 && c > 0) {
        const hL = views.elevations[r * gs + (c - 1)];
        const hU = views.elevations[(r - 1) * gs + c];
        shade = 0.5 + 0.5 * Math.max(0, Math.min(1, 0.5 + (elev - hL) * 2 + (elev - hU) * 1.5));
      }

      const ix = (c - r) * (tileW * 0.5);
      const iy = (c + r) * (tileH * 0.5);
      const iz = elev * heightScale;
      const sx = offsetX + ix;
      const sy = offsetY + iy - iz;

      const deepBase = offsetY + gs * tileH * 0.5 + heightScale * 0.5;
      const pillarH = deepBase - (sy + tileH * 0.5);

      if (pillarH > 0) {
        // Right face
        ctx.fillStyle = `rgb(${tr * shade * 0.45 | 0},${tg * shade * 0.45 | 0},${tb * shade * 0.45 | 0})`;
        ctx.beginPath();
        ctx.moveTo(sx + tileW * 0.5, sy);
        ctx.lineTo(sx, sy + tileH * 0.5);
        ctx.lineTo(sx, sy + tileH * 0.5 + pillarH);
        ctx.lineTo(sx + tileW * 0.5, sy + pillarH);
        ctx.fill();

        // Front face
        ctx.fillStyle = `rgb(${tr * shade * 0.3 | 0},${tg * shade * 0.3 | 0},${tb * shade * 0.3 | 0})`;
        ctx.beginPath();
        ctx.moveTo(sx - tileW * 0.5, sy);
        ctx.lineTo(sx, sy + tileH * 0.5);
        ctx.lineTo(sx, sy + tileH * 0.5 + pillarH);
        ctx.lineTo(sx - tileW * 0.5, sy + pillarH);
        ctx.fill();
      }

      // Top face
      ctx.fillStyle = `rgb(${tr * shade | 0},${tg * shade | 0},${tb * shade | 0})`;
      ctx.beginPath();
      ctx.moveTo(sx, sy - tileH * 0.5);
      ctx.lineTo(sx + tileW * 0.5, sy);
      ctx.lineTo(sx, sy + tileH * 0.5);
      ctx.lineTo(sx - tileW * 0.5, sy);
      ctx.closePath();
      ctx.fill();

      // Water shimmer for aquatic biomes
      if (biome <= 1) {
        ctx.fillStyle = getWaterColor();
        ctx.beginPath();
        ctx.moveTo(sx, sy - tileH * 0.5);
        ctx.lineTo(sx + tileW * 0.5, sy);
        ctx.lineTo(sx, sy + tileH * 0.5);
        ctx.lineTo(sx - tileW * 0.5, sy);
        ctx.closePath();
        ctx.fill();
      }

      // Species population overlay — show dominant species color
      let maxPop = 0, maxS = -1;
      for (let s = 0; s < 5; s++) {
        const p = views.populations[idx * 5 + s];
        if (p > maxPop) { maxPop = p; maxS = s; }
      }
      if (maxPop > 5 && maxS >= 0) {
        const intensity = Math.min(0.5, maxPop / 200);
        ctx.fillStyle = hexToRgba(SPECIES_COLORS[maxS], intensity);
        ctx.beginPath();
        ctx.moveTo(sx, sy - tileH * 0.5);
        ctx.lineTo(sx + tileW * 0.5, sy);
        ctx.lineTo(sx, sy + tileH * 0.5);
        ctx.lineTo(sx - tileW * 0.5, sy);
        ctx.closePath();
        ctx.fill();
      }

      // Grid line
      ctx.strokeStyle = 'rgba(221,193,101,0.06)';
      ctx.lineWidth = 0.5;
      ctx.stroke();
    }
  }

  // Vignette
  const grad = ctx.createRadialGradient(w/2, h/2, Math.min(w,h)*0.35, w/2, h/2, Math.min(w,h)*0.7);
  grad.addColorStop(0, 'rgba(0,0,0,0)');
  grad.addColorStop(1, 'rgba(0,0,0,0.5)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
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

  // Species lines
  for (let s = 0; s < 5; s++) {
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

    // Glow effect for line visibility
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

// ── Init ──
const savedTheme = loadSavedTheme();
themeSelect.value = savedTheme;
loader.classList.add('hidden');
setup.classList.remove('hidden');
