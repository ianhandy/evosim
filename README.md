# evosim

An evolution observation simulation. Watch 5 species evolve across procedurally generated terrain in real time. Every metric, equation, and event maps to real biology.

## What It Is

You're a field researcher observing an ecosystem. Five species compete, evolve, and adapt on a volcanic island shaped by tectonic forces. Population genetics equations run every generation — the same math biologists use to model real evolution.

**Species:**
- **Velothrix aurantis** — marsh stalker, sexual selection via crest brightness
- **Kelp Leviathan** — aquatic predator, hunting range trait
- **Reed Crawler** — burrowing herbivore, burrowing depth trait
- **Tidal Crab** — armored scavenger, shell thickness trait
- **Bioluminescent Worm** — detritivore, glow intensity trait

Each species has 6 evolvable traits (5 universal + 1 species-specific). Tradeoffs emerge from system interactions — nothing is hardcoded.

## Running

```bash
node serve.js
# Open http://localhost:3002
```

Requires: Node.js (for the dev server). Everything else loads in-browser (Pyodide, numpy, scipy).

## Architecture

- **Python (Pyodide)** — all simulation math: population genetics, ecology, terrain, rivers
- **JavaScript** — all rendering: Canvas 2D isometric map, charts, UI
- **SharedArrayBuffer / ArrayBuffer** — zero-copy data bridge between Python and JS
- **Decoupled sim/render** — simulation ticks independently of 60fps rendering

See `ARCHITECTURE.md` in the workspace mirror for full technical documentation.

## File Structure

```
src/
├── index.html      — entry point
├── style.css       — all styles, CSS custom properties for themes
├── sim.js          — Pyodide bridge, sim loop, save/load
├── sim-core.py     — Python simulation (population genetics, ecology, terrain)
├── render.js       — WebGL map renderer (currently disabled, Canvas 2D active)
├── ui.js           — DOM interactions, Canvas 2D map, charts, panels
├── layout.js       — SharedArrayBuffer layout contract
├── themes.js       — 5 color themes with biome palettes
├── creatures.js    — procedural creature portrait rendering
├── journal.js      — field researcher narrative journal
```

## Features

- 6-trait gene system with emergent tradeoffs
- Logistic growth, Lotka-Volterra predation (Holling Type II)
- Tectonic plate terrain generation
- River system with meandering, erosion, oxbow lakes
- Environmental events (drought, disease, algal bloom, tidal surge, reef, volcanic)
- Speciation detection, extinction tracking with cause analysis
- 5 visual themes
- Procedural creature portraits
- Field researcher journal
- Progressive disclosure tooltips with equation explanations
- Save/load to localStorage
- Pentagon ecosystem balance diagram
- Ghost data for extinct species on charts

## License

MIT
