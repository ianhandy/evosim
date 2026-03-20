/**
 * Simulation bridge — loads Pyodide, creates SharedArrayBuffer,
 * initializes the Python sim, and manages the sim loop.
 *
 * The sim loop is decoupled from rendering:
 * - sim.step() advances the simulation N generations
 * - The renderer reads from the shared buffer independently at 60fps
 */

import { createLayout, createViews, GLOBAL, SPECIES_COUNT, TRAITS_PER_SPECIES, MAX_RIVERS, MAX_RIVER_POINTS, MAX_LAVA_FLOWS, MAX_LAVA_POINTS } from './layout.js';

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
 * Preload Pyodide + packages. Call early so preview and init are fast.
 */
let preloaded = false;

export async function preload(onProgress) {
  if (preloaded) return;
  onProgress?.('pyodide', 20);
  pyodide = await loadPyodide();
  onProgress?.('numpy', 50);
  await pyodide.loadPackage('numpy');
  onProgress?.('scipy', 80);
  await pyodide.loadPackage('scipy');
  preloaded = true;
  onProgress?.('ready', 100);
}

export function isPreloaded() { return preloaded; }

/**
 * Generate preview terrain using the actual Python sim code.
 * Returns {elevations: Float32Array, biomes: Uint8Array} for the given seed/size.
 */
export async function generatePreviewTerrain(gridSize, seed) {
  if (!preloaded) return null;

  // Set up minimal globals for terrain gen
  globalThis._grid_size = gridSize;
  globalThis._seed = seed;
  globalThis._species_count = SPECIES_COUNT;
  globalThis._traits_per_species = TRAITS_PER_SPECIES;

  // Create a temporary layout + buffer for the preview
  const prevLayout = createLayout(gridSize);
  const prevBuffer = new ArrayBuffer(prevLayout.totalBytes);
  const prevViews = createViews(prevBuffer, prevLayout);
  new Uint8Array(prevBuffer).fill(0);

  // Expose views to Python
  globalThis._js_globals = prevViews.globals;
  globalThis._js_elevations = prevViews.elevations;
  globalThis._js_biomes = prevViews.biomes;
  globalThis._js_vegetation = prevViews.vegetation;
  globalThis._js_populations = prevViews.populations;
  globalThis._js_trait_means = prevViews.traitMeans;
  globalThis._js_trait_var = prevViews.traitVar;
  globalThis._js_tile_flags = prevViews.tileFlags;
  globalThis._js_river_paths = prevViews.riverPaths;
  globalThis._js_river_meta = prevViews.riverMeta;
  globalThis._js_lava_paths = prevViews.lavaPaths;
  globalThis._js_lava_meta = prevViews.lavaMeta;
  globalThis._js_flow_dirs = prevViews.flowDirs;
  globalThis._layout_json = JSON.stringify(
    Object.fromEntries(
      Object.entries(prevLayout)
        .filter(([k, v]) => v && v.offset !== undefined)
        .map(([k, v]) => [k, { offset: v.offset, count: v.count, byteSize: v.byteSize }])
    )
  );

  // Load and run sim code (generates terrain + assigns biomes)
  const simCodeText = await fetch('/sim-core.py').then(r => r.text());
  await pyodide.runPythonAsync(simCodeText);
  pyodide.runPython(`_generate_terrain("${seed}")`);
  pyodide.runPython('_sync_to_buffer()');

  return {
    elevations: new Float32Array(prevViews.elevations),
    biomes: new Uint8Array(prevViews.biomes),
    gridSize,
  };
}

/**
 * Initialize the full simulation (after preload).
 */
export async function init(gridSize, seed, onProgress) {
  if (!preloaded) {
    await preload(onProgress);
  }

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
  globalThis._max_lava_flows = MAX_LAVA_FLOWS;
  globalThis._max_lava_points = MAX_LAVA_POINTS;

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
  globalThis._js_lava_paths = views.lavaPaths;
  globalThis._js_lava_meta = views.lavaMeta;
  globalThis._js_flow_dirs = views.flowDirs;

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
  tickInterval = setInterval(step, 500);
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
    tickInterval = setInterval(step, 500);
  }
}

export function getGeneration() {
  return views ? views.globals[GLOBAL.GENERATION] : 0;
}

/**
 * Save simulation state to localStorage.
 */
export function saveGame() {
  if (!simReady) return false;
  try {
    const stateJson = pyodide.runPython('get_save_state()');
    localStorage.setItem('evosim-save', stateJson);
    return true;
  } catch (e) {
    console.error('Save failed:', e);
    return false;
  }
}

/**
 * Load simulation state from localStorage.
 */
export function loadGame() {
  if (!simReady) return false;
  try {
    const stateJson = localStorage.getItem('evosim-save');
    if (!stateJson) return false;
    // Pass JSON via globalThis to avoid string escaping issues
    globalThis._loadStateJson = stateJson;
    pyodide.runPython(`
from js import _loadStateJson
load_save_state(str(_loadStateJson))
`);
    delete globalThis._loadStateJson;
    return true;
  } catch (e) {
    console.error('Load failed:', e);
    return false;
  }
}

/**
 * Check if a save exists.
 */
export function hasSave() {
  return !!localStorage.getItem('evosim-save');
}

/**
 * Delete save.
 */
export function deleteSave() {
  localStorage.removeItem('evosim-save');
}

// ── Debug API ──

export function debugSpawnRiver() {
  if (!simReady) return;
  return pyodide.runPython('debug_spawn_river()');
}

export function debugTriggerEvent(eventType) {
  if (!simReady) return;
  return pyodide.runPython(`debug_trigger_event('${eventType}')`);
}

export function debugGetTileInfo(r, c) {
  if (!simReady) return '{}';
  return pyodide.runPython(`debug_get_tile_info(${r}, ${c})`);
}
