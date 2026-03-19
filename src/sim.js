/**
 * Simulation bridge — loads Pyodide, creates SharedArrayBuffer,
 * initializes the Python sim, and manages the sim loop.
 *
 * The sim loop is decoupled from rendering:
 * - sim.step() advances the simulation N generations
 * - The renderer reads from the shared buffer independently at 60fps
 */

import { createLayout, createViews, GLOBAL, SPECIES_COUNT, TRAITS_PER_SPECIES, MAX_RIVERS, MAX_RIVER_POINTS } from './layout.js';

let pyodide = null;
let sharedBuffer = null;
let layout = null;
let views = null;
let simReady = false;
let simRunning = false;
let stepsPerTick = 1;
let tickInterval = null;

// Event queue for cold data (extinctions, speciation, epoch changes)
let eventQueue = [];

export function getLayout() { return layout; }
export function getBuffer() { return sharedBuffer; }
export function getViews() { return views; }
export function isReady() { return simReady; }
export function getEventQueue() { const q = eventQueue; eventQueue = []; return q; }

/**
 * Initialize Pyodide, create shared buffer, load sim code.
 */
export async function init(gridSize, seed, onProgress) {
  onProgress?.('pyodide', 10);
  pyodide = await loadPyodide();

  onProgress?.('numpy', 40);
  await pyodide.loadPackage('numpy');

  onProgress?.('buffer', 60);

  // Create layout and buffer
  // Try SharedArrayBuffer first (needs COOP/COEP + secure context).
  // Fall back to ArrayBuffer — works identically since sim and renderer
  // are in the same thread. SAB only matters if we move sim to a Worker.
  layout = createLayout(gridSize);
  try {
    sharedBuffer = new SharedArrayBuffer(layout.totalBytes);
    console.log('Using SharedArrayBuffer');
  } catch {
    sharedBuffer = new ArrayBuffer(layout.totalBytes);
    console.log('SharedArrayBuffer unavailable, using ArrayBuffer');
  }
  views = createViews(sharedBuffer, layout);
  new Uint8Array(sharedBuffer).fill(0);

  onProgress?.('sim', 70);

  // Set values on globalThis so Python can access them via `from js import`
  globalThis._grid_size = gridSize;
  globalThis._seed = seed;
  globalThis._species_count = SPECIES_COUNT;
  globalThis._traits_per_species = TRAITS_PER_SPECIES;
  globalThis._max_rivers = MAX_RIVERS;
  globalThis._max_river_points = MAX_RIVER_POINTS;

  // Layout as JSON string
  const layoutInfo = {};
  for (const [key, sec] of Object.entries(layout)) {
    if (sec && sec.offset !== undefined) {
      layoutInfo[key] = { offset: sec.offset, count: sec.count, byteSize: sec.byteSize };
    }
  }
  globalThis._layout_json = JSON.stringify(layoutInfo);

  // Expose typed array views — Python writes to these via JsProxy,
  // writes go directly into the ArrayBuffer that JS reads for rendering.
  globalThis._js_globals = views.globals;
  globalThis._js_elevations = views.elevations;
  globalThis._js_biomes = views.biomes;
  globalThis._js_vegetation = views.vegetation;
  globalThis._js_populations = views.populations;
  globalThis._js_trait_means = views.traitMeans;
  globalThis._js_trait_var = views.traitVar;
  globalThis._js_tile_flags = views.tileFlags;
  globalThis._js_river_paths = views.riverPaths;
  globalThis._js_river_meta = views.riverMeta;

  // Load and execute sim-core.py
  const simCode = await fetch('/sim-core.py').then(r => r.text());
  await pyodide.runPythonAsync(simCode);

  onProgress?.('init', 90);
  pyodide.runPython('init_simulation()');

  onProgress?.('ready', 100);
  simReady = true;
}

/**
 * Run one simulation step. Called by the tick loop.
 */
function step() {
  if (!simReady || views.globals[GLOBAL.PAUSED] === 1.0) return;

  const t0 = performance.now();
  pyodide.runPython(`step_simulation(${stepsPerTick})`);
  const elapsed = performance.now() - t0;

  views.globals[GLOBAL.SIM_STEP_MS] = elapsed;

  // Check for events (cold data)
  const eventsJson = pyodide.runPython('flush_events()');
  if (eventsJson && eventsJson !== '[]') {
    try {
      eventQueue.push(...JSON.parse(eventsJson));
    } catch {}
  }

  // Auto-LOD
  if (elapsed > 50 && views.globals[GLOBAL.LOD_LEVEL] === 0) {
    views.globals[GLOBAL.LOD_LEVEL] = 1;
    pyodide.runPython('set_lod(1)');
  } else if (elapsed < 20 && views.globals[GLOBAL.LOD_LEVEL] === 1) {
    views.globals[GLOBAL.LOD_LEVEL] = 0;
    pyodide.runPython('set_lod(0)');
  }
}

export function start(speed = 1) {
  if (!simReady) return;
  stepsPerTick = speed;
  simRunning = true;
  views.globals[GLOBAL.PAUSED] = 0;
  if (tickInterval) clearInterval(tickInterval);
  tickInterval = setInterval(step, 50);
}

export function pause() {
  simRunning = false;
  views.globals[GLOBAL.PAUSED] = 1.0;
  if (tickInterval) { clearInterval(tickInterval); tickInterval = null; }
}

export function togglePause() {
  if (simRunning) pause(); else start(stepsPerTick);
  return simRunning;
}

export function setSpeed(speed) {
  stepsPerTick = speed;
  views.globals[GLOBAL.SIM_SPEED] = speed;
  if (simRunning) {
    clearInterval(tickInterval);
    tickInterval = setInterval(step, 50);
  }
}

export function getGeneration() {
  return views ? views.globals[GLOBAL.GENERATION] : 0;
}
