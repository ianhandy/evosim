/**
 * Research Journal — field researcher voice.
 *
 * Generates narrative entries based on simulation events.
 * Entries are clickable notifications that link to relevant data.
 *
 * Voice: first-person field researcher observing the ecosystem.
 * "Day 847. The Leviathan population has declined sharply..."
 */

const ENTRIES = []; // { gen, text, type, data }
const MAX_ENTRIES = 200;

// Track state for detecting notable changes
let lastPops = [0, 0, 0, 0, 0];
let lastEpoch = -1;
let checkInterval = 50; // check every N generations
let lastCheckGen = 0;

const SPECIES_NAMES = ['Velothrix', 'Leviathan', 'Crawler', 'Crab', 'Worm'];
const SPECIES_FULL = ['Velothrix aurantis', 'Kelp Leviathan', 'Reed Crawler', 'Tidal Crab', 'Bioluminescent Worm'];

/**
 * Check current state and generate journal entries if warranted.
 * Called from the render loop when generation changes.
 */
export function checkForEntries(gen, pops, season) {
  if (gen - lastCheckGen < checkInterval) return;
  lastCheckGen = gen;

  // Population change detection
  for (let s = 0; s < 5; s++) {
    const curr = pops[s];
    const prev = lastPops[s];
    if (prev <= 0) continue;

    const delta = (curr - prev) / prev;

    // Boom (+50% in check interval)
    if (delta > 0.5 && curr > 100) {
      _add(gen, _boom(s, curr, prev, gen), 'boom', { species: s });
    }

    // Crash (-40% in check interval)
    if (delta < -0.4 && prev > 50) {
      _add(gen, _crash(s, curr, prev, gen), 'crash', { species: s });
    }

    // Near extinction (<20 total)
    if (curr > 0 && curr < 20 && prev >= 20) {
      _add(gen, _endangered(s, curr, gen), 'endangered', { species: s });
    }

    // Extinction
    if (curr === 0 && prev > 0) {
      _add(gen, _extinction(s, prev, gen), 'extinction', { species: s });
    }
  }

  // First population milestone
  for (let s = 0; s < 5; s++) {
    if (pops[s] > 1000 && lastPops[s] <= 1000) {
      _add(gen, _milestone(s, pops[s], gen), 'milestone', { species: s });
    }
  }

  // Dominance detection — one species > 60% of total
  const totalPop = pops.reduce((a, b) => a + b, 0);
  if (totalPop > 100) {
    for (let s = 0; s < 5; s++) {
      if (pops[s] / totalPop > 0.6 && (lastPops[s] / Math.max(1, lastPops.reduce((a,b)=>a+b,0))) <= 0.6) {
        _add(gen, _dominance(s, pops[s], totalPop, gen), 'dominance', { species: s });
      }
    }
  }

  // Season transitions
  if (season < 0.15 && gen > 50 && gen % SEASON_CHECK_MOD === 0) {
    _add(gen, _winter(gen), 'season', {});
  }
  if (season > 0.9 && gen > 50 && gen % SEASON_CHECK_MOD === 0) {
    _add(gen, _summer(gen), 'season', {});
  }

  // Ecosystem recovery — all 5 species alive and total pop > 1000 after a crash
  if (gen > 200 && pops.every(p => p > 0) && totalPop > 1000) {
    const prevTotal = lastPops.reduce((a,b) => a + b, 0);
    if (prevTotal < 500 && totalPop > 1000) {
      _add(gen, _recovery(gen, totalPop), 'recovery', {});
    }
  }

  lastPops = [...pops];
}

const SEASON_CHECK_MOD = 100; // only log season once per full cycle

/**
 * Get all journal entries.
 */
export function getEntries() {
  return ENTRIES;
}

/**
 * Get entries since a given generation.
 */
export function getEntriesSince(gen) {
  return ENTRIES.filter(e => e.gen >= gen);
}

/**
 * Get the most recent N entries.
 */
export function getRecent(n = 10) {
  return ENTRIES.slice(-n);
}

// ── Entry generators (field researcher voice) ──

function _add(gen, text, type, data) {
  ENTRIES.push({ gen, text, type, data, ts: Date.now() });
  if (ENTRIES.length > MAX_ENTRIES) ENTRIES.shift();
}

function _boom(s, curr, prev, gen) {
  const pct = Math.round((curr - prev) / prev * 100);
  const texts = [
    `Gen ${gen}. ${SPECIES_FULL[s]} numbers have surged — up ${pct}% to ${curr}. The marsh can barely contain them.`,
    `Gen ${gen}. A population explosion among the ${SPECIES_NAMES[s]}. ${curr} individuals now, up from ${prev}. Resources will be tested.`,
    `Gen ${gen}. The ${SPECIES_NAMES[s]} are thriving. ${pct}% growth in recent generations. I wonder how long this can sustain.`,
  ];
  return texts[Math.floor(Math.random() * texts.length)];
}

function _crash(s, curr, prev, gen) {
  const pct = Math.round((prev - curr) / prev * 100);
  const texts = [
    `Gen ${gen}. ${SPECIES_FULL[s]} in sharp decline — down ${pct}% to ${curr}. Something has shifted in the balance.`,
    `Gen ${gen}. The ${SPECIES_NAMES[s]} are struggling. Population dropped from ${prev} to ${curr}. Predation? Habitat loss? Need to investigate.`,
    `Gen ${gen}. Alarming decline in ${SPECIES_NAMES[s]} numbers. ${pct}% loss. The ecosystem is adjusting, but at what cost.`,
  ];
  return texts[Math.floor(Math.random() * texts.length)];
}

function _endangered(s, curr, gen) {
  const texts = [
    `Gen ${gen}. Only ${curr} ${SPECIES_FULL[s]} remain. We may be witnessing the beginning of an extinction event.`,
    `Gen ${gen}. ${SPECIES_NAMES[s]} critically endangered — ${curr} individuals across the entire grid. Every generation could be their last.`,
    `Gen ${gen}. I count ${curr} ${SPECIES_NAMES[s]}. The population is functionally on the edge. Genetic drift alone could finish them.`,
  ];
  return texts[Math.floor(Math.random() * texts.length)];
}

function _extinction(s, prev, gen) {
  const texts = [
    `Gen ${gen}. ${SPECIES_FULL[s]} — extinct. The last individuals are gone. ${prev} at my last count, now zero. The marsh feels different already.`,
    `Gen ${gen}. I've confirmed it. No ${SPECIES_NAMES[s]} remain anywhere on the grid. An entire lineage, ended. The ecosystem will never be quite the same.`,
    `Gen ${gen}. Extinction confirmed: ${SPECIES_FULL[s]}. I keep scanning the tiles but there's nothing. The silence is the data now.`,
  ];
  return texts[Math.floor(Math.random() * texts.length)];
}

function _milestone(s, pop, gen) {
  return `Gen ${gen}. ${SPECIES_FULL[s]} has crossed 1,000 individuals. A robust population — though permanence is never guaranteed in this system.`;
}

function _dominance(s, pop, total, gen) {
  const pct = Math.round(pop / total * 100);
  return `Gen ${gen}. ${SPECIES_FULL[s]} dominates — ${pct}% of the total population. The ecosystem balance is tilting.`;
}

function _winter(gen) {
  const texts = [
    `Gen ${gen}. Deep winter. Food regrowth has slowed to a crawl. The species with high metabolism will feel this first.`,
    `Gen ${gen}. The seasonal low point. Vegetation is sparse, competition fierce. Winter always reveals who's adapted and who's borrowed time.`,
  ];
  return texts[Math.floor(Math.random() * texts.length)];
}

function _summer(gen) {
  const texts = [
    `Gen ${gen}. Peak summer. Vegetation flourishes. Populations swell. But abundance breeds competition.`,
    `Gen ${gen}. The warm season. Food is plentiful, growth rates peak. The predators are well-fed. For now.`,
  ];
  return texts[Math.floor(Math.random() * texts.length)];
}

function _recovery(gen, pop) {
  return `Gen ${gen}. Recovery. After a period of decline, the ecosystem bounces back — ${pop} total individuals across all species. Life finds a way.`;
}
