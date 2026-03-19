/**
 * Simulation bridge — loads Pyodide, creates SharedArrayBuffer,
 * initializes the Python sim, and manages the sim loop.
 *
 * The sim loop is decoupled from rendering:
 * - sim.step() advances the simulation N generations
 * - The renderer reads from the shared buffer independently at 60fps
 */

import { createLayout, createViews, GLOBAL } from './layout.js';

let pyodide = null;
let sharedBuffer = null;
let layout = null;
let views = null;
let simReady = false;
let simRunning = false;
let stepsPerTick = 1;
let tickInterval = null;

// Event queue for cold data (extinctions, speciation, epoch changes)
// Python appends JSON strings here; JS reads and clears
let eventQueue = [];

export function getLayout() { return layout; }
export function getBuffer() { return sharedBuffer; }
export function getViews() { return views; }
export function isReady() { return simReady; }
export function getEventQueue() { const q = eventQueue; eventQueue = []; return q; }

/**
 * Initialize Pyodide, create shared buffer, load sim code.
 * @param {number} gridSize - Grid dimension (e.g., 12 for 12×12)
 * @param {string} seed - RNG seed string
 * @param {function} onProgress - Progress callback(phase, percent)
 */
export async function init(gridSize, seed, onProgress) {
  onProgress?.('pyodide', 10);

  // Load Pyodide
  pyodide = await loadPyodide();
  onProgress?.('numpy', 40);

  // Load numpy
  await pyodide.loadPackage('numpy');
  onProgress?.('buffer', 60);

  // Create layout and shared buffer
  layout = createLayout(gridSize);
  sharedBuffer = new SharedArrayBuffer(layout.totalBytes);
  views = createViews(sharedBuffer, layout);

  // Zero the buffer
  new Uint8Array(sharedBuffer).fill(0);

  onProgress?.('sim', 70);

  // Make buffer accessible to Python
  pyodide.globals.set('_shared_buffer', sharedBuffer);
  pyodide.globals.set('_grid_size', gridSize);
  pyodide.globals.set('_seed', seed);

  // Pass layout offsets to Python as a dict
  const layoutDict = {};
  for (const [key, sec] of Object.entries(layout)) {
    if (sec && sec.offset !== undefined) {
      layoutDict[key] = {
        offset: sec.offset,
        count: sec.count,
        byteSize: sec.byteSize,
        dtype: sec.TypedArray === Float64Array ? 'float64'
             : sec.TypedArray === Float32Array ? 'float32'
             : sec.TypedArray === Uint16Array  ? 'uint16'
             : sec.TypedArray === Int16Array   ? 'int16'
             : 'uint8',
      };
    }
  }
  pyodide.globals.set('_layout', pyodide.toPy(layoutDict));

  // Load and execute sim-core.py
  const simCode = await fetch('/sim-core.py').then(r => r.text());
  await pyodide.runPythonAsync(simCode);
  onProgress?.('init', 90);

  // Initialize the simulation
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

  // Write step timing for auto-LOD
  views.globals[GLOBAL.SIM_STEP_MS] = elapsed;

  // Check for events (cold data — JSON, infrequent)
  const eventsJson = pyodide.runPython('flush_events()');
  if (eventsJson && eventsJson !== '[]') {
    try {
      const events = JSON.parse(eventsJson);
      eventQueue.push(...events);
    } catch {}
  }

  // Auto-LOD: if step took > 50ms, switch to simplified
  if (elapsed > 50 && views.globals[GLOBAL.LOD_LEVEL] === 0) {
    views.globals[GLOBAL.LOD_LEVEL] = 1;
    pyodide.runPython('set_lod(1)');
  } else if (elapsed < 20 && views.globals[GLOBAL.LOD_LEVEL] === 1) {
    // Re-upgrade if headroom exists
    views.globals[GLOBAL.LOD_LEVEL] = 0;
    pyodide.runPython('set_lod(0)');
  }
}

/**
 * Start the simulation loop.
 * @param {number} speed - Generations per tick (1, 5, 20, 100)
 */
export function start(speed = 1) {
  if (!simReady) return;
  stepsPerTick = speed;
  simRunning = true;
  views.globals[GLOBAL.PAUSED] = 0;

  // Run sim at ~20 ticks/sec (decoupled from 60fps render)
  if (tickInterval) clearInterval(tickInterval);
  tickInterval = setInterval(step, 50);
}

/**
 * Pause the simulation.
 */
export function pause() {
  simRunning = false;
  views.globals[GLOBAL.PAUSED] = 1.0;
  if (tickInterval) {
    clearInterval(tickInterval);
    tickInterval = null;
  }
}

/**
 * Toggle play/pause.
 */
export function togglePause() {
  if (simRunning) pause();
  else start(stepsPerTick);
  return simRunning;
}

/**
 * Set simulation speed.
 * @param {number} speed - Generations per tick
 */
export function setSpeed(speed) {
  stepsPerTick = speed;
  views.globals[GLOBAL.SIM_SPEED] = speed;
  if (simRunning) {
    // Restart interval with same timing
    clearInterval(tickInterval);
    tickInterval = setInterval(step, 50);
  }
}

/**
 * Get current generation from shared buffer.
 */
export function getGeneration() {
  return views ? views.globals[GLOBAL.GENERATION] : 0;
}
