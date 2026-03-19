/**
 * SharedArrayBuffer layout definition.
 * THE source of truth for how Python and JS share simulation state.
 *
 * Both sides create typed array views at these exact byte offsets.
 * Changing this file requires updating sim-core.py to match.
 */

export const SPECIES_COUNT = 5;
export const TRAITS_PER_SPECIES = 6;
export const MAX_RIVERS = 20;
export const MAX_RIVER_POINTS = 512;

export const TRAIT = {
  CLUTCH_SIZE: 0,
  LONGEVITY: 1,
  MUTATION_RATE: 2,
  METABOLISM: 3,
  MIGRATION_TENDENCY: 4,
  SPECIES_SPECIFIC: 5,
};

export const GLOBAL = {
  GENERATION: 0,
  SEASON_FACTOR: 1,
  EPOCH_ID: 2,
  SIM_SPEED: 3,
  LOD_LEVEL: 4,
  SIM_STEP_MS: 5,
  TOTAL_POP_0: 6,
  TOTAL_POP_1: 7,
  TOTAL_POP_2: 8,
  TOTAL_POP_3: 9,
  TOTAL_POP_4: 10,
  PAUSED: 11,
  TOTAL_DEATHS: 12,
  VEGETATION_MEAN: 13,
};

export function createLayout(gridSize) {
  const G2 = gridSize * gridSize;
  const S = SPECIES_COUNT;
  const T = TRAITS_PER_SPECIES;
  let offset = 0;

  function section(name, TypedArray, count) {
    const byteSize = count * TypedArray.BYTES_PER_ELEMENT;
    const s = { name, offset, count, byteSize, TypedArray };
    offset += byteSize;
    offset = Math.ceil(offset / 8) * 8;
    return s;
  }

  const layout = {};
  layout.globals     = section('globals',     Float64Array, 16);
  layout.elevations  = section('elevations',  Float32Array, G2);
  layout.biomes      = section('biomes',      Uint8Array,   G2);
  layout.vegetation  = section('vegetation',  Float32Array, G2);
  layout.populations = section('populations', Uint16Array,  G2 * S);
  layout.traitMeans  = section('traitMeans',  Float32Array, G2 * S * T);
  layout.traitVar    = section('traitVar',    Float32Array, G2 * S * T);
  layout.tileFlags   = section('tileFlags',   Uint8Array,   G2);
  layout.riverPaths  = section('riverPaths',  Int16Array,   MAX_RIVER_POINTS * 2);
  layout.riverMeta   = section('riverMeta',   Float32Array, MAX_RIVERS * 4);

  layout.totalBytes = offset;
  layout.gridSize = gridSize;
  layout.speciesCount = S;
  layout.traitsPerSpecies = T;

  return layout;
}

export function createViews(buffer, layout) {
  const views = {};
  for (const [key, sec] of Object.entries(layout)) {
    if (sec && sec.TypedArray && sec.offset !== undefined) {
      views[key] = new sec.TypedArray(buffer, sec.offset, sec.count);
    }
  }
  return views;
}
