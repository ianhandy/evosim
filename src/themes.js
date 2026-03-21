/**
 * Theme system — CSS custom property sets for visual theming.
 * Themes affect UI chrome AND map biome rendering colors.
 *
 * Usage: setTheme('deep-ocean') applies all CSS vars and updates biome palette.
 */

export const THEMES = {
  'funforrest': {
    label: 'FunForrest',
    vars: {
      '--bg':         '#1A0D00',
      '--bg-dark':    '#120800',
      '--card':       '#2a1500',
      '--card-hover': '#3a2000',
      '--border':     '#3d2200',
      '--gold':       '#DDC165',
      '--gold-light': '#FFE9A3',
      '--gold-dim':   '#a08940',
      '--orange':     '#E5591C',
      '--red':        '#C0392B',
      '--green':      '#6aaa64',
      '--blue':       '#4a9eff',
      '--purple':     '#9b59b6',
      '--text':       '#DDC165',
      '--dim':        '#7a5a2a',
    },
    biomes: [
      [30, 50, 75],    // deep_water — blue ocean floor
      [40, 90, 80],    // shallow_marsh — teal/turquoise shallows
      [50, 120, 45],   // reed_beds — vivid tropical green
      [200, 185, 140], // tidal_flats — warm sandy beach
      [85, 65, 50],    // rocky_shore — rich volcanic rock
    ],
    water: 'rgba(20, 80, 140, 0.3)',
    mapBg: '#0a0800',
  },

  'deep-ocean': {
    label: 'Deep Ocean',
    vars: {
      '--bg':         '#0a1520',
      '--bg-dark':    '#060e18',
      '--card':       '#0f1f30',
      '--card-hover': '#152840',
      '--border':     '#1a3050',
      '--gold':       '#6ec8e4',
      '--gold-light': '#a0e8ff',
      '--gold-dim':   '#3a8aa0',
      '--orange':     '#2ecc71',
      '--red':        '#e74c3c',
      '--green':      '#2ecc71',
      '--blue':       '#3498db',
      '--purple':     '#8e44ad',
      '--text':       '#6ec8e4',
      '--dim':        '#2a5a6a',
    },
    biomes: [
      [8, 20, 50],    // deep_water — dark abyss
      [15, 40, 60],   // shallow — twilight zone
      [20, 55, 55],   // reed — kelp forest
      [30, 50, 45],   // tidal — sandy shelf
      [45, 45, 50],   // rocky — reef wall
    ],
    water: 'rgba(10, 40, 80, 0.3)',
    mapBg: '#060e18',
  },

  'savanna': {
    label: 'Savanna',
    vars: {
      '--bg':         '#1a1508',
      '--bg-dark':    '#12100a',
      '--card':       '#2a2210',
      '--card-hover': '#3a3018',
      '--border':     '#4a3820',
      '--gold':       '#d4a843',
      '--gold-light': '#f0cc66',
      '--gold-dim':   '#8a7030',
      '--orange':     '#cc5500',
      '--red':        '#b03020',
      '--green':      '#7aaa44',
      '--blue':       '#5a90c0',
      '--purple':     '#886688',
      '--text':       '#d4a843',
      '--dim':        '#6a5830',
    },
    biomes: [
      [20, 35, 55],   // deep_water — mudhole / watering hole (blue)
      [35, 58, 38],   // shallow — murky green shallows (distinct from water)
      [75, 90, 35],   // reed — bright savanna grass (clearly green)
      [170, 145, 90], // tidal — pale dry earth / cracked mud (tan)
      [110, 80, 55],  // rocky — warm sandstone/laterite (orange-brown)
    ],
    water: 'rgba(30, 50, 70, 0.2)',
    mapBg: '#12100a',
  },

  'arctic': {
    label: 'Arctic',
    vars: {
      '--bg':         '#101820',
      '--bg-dark':    '#0a1018',
      '--card':       '#182430',
      '--card-hover': '#203040',
      '--border':     '#2a3a4a',
      '--gold':       '#b0c8d8',
      '--gold-light': '#d0e8f8',
      '--gold-dim':   '#607888',
      '--orange':     '#4a90c0',
      '--red':        '#c05050',
      '--green':      '#5aaa8a',
      '--blue':       '#70b0e0',
      '--purple':     '#8070a0',
      '--text':       '#b0c8d8',
      '--dim':        '#506070',
    },
    biomes: [
      [10, 20, 50],   // deep_water — deep navy arctic ocean
      [30, 55, 75],   // shallow — bright ice-edge blue (clearly different from deep)
      [55, 80, 65],   // reed — tundra moss (greenish teal, distinct)
      [140, 155, 160],// tidal — pale grey permafrost flats
      [210, 220, 230],// rocky — bright snow/ice cap (near-white)
    ],
    water: 'rgba(15, 35, 65, 0.25)',
    mapBg: '#0a1018',
  },

  'paper': {
    label: 'Paper',
    vars: {
      '--bg':         '#f0e8d8',
      '--bg-dark':    '#e8dcc8',
      '--card':       '#faf4ea',
      '--card-hover': '#f5efe0',
      '--border':     '#c8b898',
      '--gold':       '#4a3a20',
      '--gold-light': '#2a1a00',
      '--gold-dim':   '#8a7a5a',
      '--orange':     '#b05030',
      '--red':        '#a03020',
      '--green':      '#3a7a3a',
      '--blue':       '#2a5a8a',
      '--purple':     '#5a3a6a',
      '--text':       '#4a3a20',
      '--dim':        '#8a7a5a',
    },
    biomes: [
      [75, 100, 145],   // deep_water — strong ink blue (legible on paper bg)
      [100, 140, 120],  // shallow — watercolour green-blue
      [120, 145, 90],   // reed — olive-green (clearly distinct from shallow)
      [180, 160, 120],  // tidal — warm parchment tan
      [135, 125, 115],  // rocky — slate warm gray
    ],
    water: 'rgba(65, 90, 140, 0.18)',
    mapBg: '#e8dcc8',
  },
};

let currentTheme = 'funforrest';

/**
 * Apply a theme. Updates CSS custom properties and returns biome colors for the renderer.
 */
export function setTheme(themeId) {
  const theme = THEMES[themeId];
  if (!theme) return;

  currentTheme = themeId;
  const root = document.documentElement;
  for (const [prop, val] of Object.entries(theme.vars)) {
    root.style.setProperty(prop, val);
  }

  // Store theme preference
  try { localStorage.setItem('evosim-theme', themeId); } catch {}
}

/**
 * Get the current theme's biome color palette for the map renderer.
 */
export function getBiomeColors() {
  return THEMES[currentTheme].biomes;
}

/**
 * Get the current theme's water overlay color.
 */
export function getWaterColor() {
  return THEMES[currentTheme].water;
}

/**
 * Get the current theme's map background color.
 */
export function getMapBg() {
  return THEMES[currentTheme].mapBg;
}

/**
 * Get current theme ID.
 */
export function getCurrentTheme() {
  return currentTheme;
}

/**
 * Load saved theme preference.
 */
export function loadSavedTheme() {
  try {
    const saved = localStorage.getItem('evosim-theme');
    if (saved && THEMES[saved]) {
      setTheme(saved);
      return saved;
    }
  } catch {}
  setTheme('funforrest');
  return 'funforrest';
}
