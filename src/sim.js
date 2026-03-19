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

  // Set scalar globals accessible from Python
  pyodide.globals.set('_grid_size', gridSize);
  pyodide.globals.set('_seed', seed);
  pyodide.globals.set('_species_count', SPECIES_COUNT);
  pyodide.globals.set('_traits_per_species', TRAITS_PER_SPECIES);
  pyodide.globals.set('_max_rivers', MAX_RIVERS);
  pyodide.globals.set('_max_river_points', MAX_RIVER_POINTS);

  // Pass layout as JSON string
  const layoutInfo = {};
  for (const [key, sec] of Object.entries(layout)) {
    if (sec && sec.offset !== undefined) {
      layoutInfo[key] = { offset: sec.offset, count: sec.count, byteSize: sec.byteSize };
    }
  }
  pyodide.globals.set('_layout_json', JSON.stringify(layoutInfo));

  // Expose typed array views as JS globals that Python can write to via JsProxy.
  // Python does `from js import _js_globals` then `_js_globals[0] = value`
  // This writes directly into the SharedArrayBuffer — true zero-copy on write.
  pyodide.globals.set('_js_globals', views.globals);
  pyodide.globals.set('_js_elevations', views.elevations);
  pyodide.globals.set('_js_biomes', views.biomes);
  pyodide.globals.set('_js_vegetation', views.vegetation);
  pyodide.globals.set('_js_populations', views.populations);
  pyodide.globals.set('_js_trait_means', views.traitMeans);
  pyodide.globals.set('_js_trait_var', views.traitVar);
  pyodide.globals.set('_js_tile_flags', views.tileFlags);

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
