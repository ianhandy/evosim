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
    `Gen ${gen}. A population explosion among the ${SPECIES_NAMES[s]}. ${curr} individuals counted, up from ${prev}. Resources will be tested.`,
    `Gen ${gen}. The ${SPECIES_NAMES[s]} are thriving. ${pct}% growth in recent generations. I wonder how long this can sustain before the system corrects.`,
    `Gen ${gen}. Something is favoring the ${SPECIES_NAMES[s]} — ${curr} individuals now. That's ${pct}% more than last count. Conditions must be near optimal.`,
    `Gen ${gen}. Boom. ${SPECIES_FULL[s]} at ${curr} and climbing. I've seen this pattern before. It doesn't always end well for the species that caused it.`,
  ];
  return texts[Math.floor(Math.random() * texts.length)];
}

function _crash(s, curr, prev, gen) {
  const pct = Math.round((prev - curr) / prev * 100);
  const texts = [
    `Gen ${gen}. ${SPECIES_FULL[s]} in sharp decline — down ${pct}% to ${curr}. Something has shifted in the balance.`,
    `Gen ${gen}. The ${SPECIES_NAMES[s]} are struggling. Population dropped from ${prev} to ${curr}. Predation? Habitat loss? Something to investigate.`,
    `Gen ${gen}. Alarming decline in ${SPECIES_NAMES[s]} numbers. ${pct}% loss this period. The ecosystem is adjusting, but at what cost.`,
    `Gen ${gen}. ${SPECIES_FULL[s]}: ${prev} to ${curr} in one interval. A ${pct}% drop. That's not noise — something's driving this.`,
    `Gen ${gen}. The ${SPECIES_NAMES[s]} are being pushed out. ${pct}% fewer individuals. Competition, starvation, or something I haven't measured yet.`,
  ];
  return texts[Math.floor(Math.random() * texts.length)];
}

function _endangered(s, curr, gen) {
  const texts = [
    `Gen ${gen}. Only ${curr} ${SPECIES_FULL[s]} remain. We may be witnessing the beginning of an extinction event.`,
    `Gen ${gen}. ${SPECIES_NAMES[s]} critically endangered — ${curr} individuals across the entire grid. Every generation could be their last.`,
    `Gen ${gen}. I count ${curr} ${SPECIES_NAMES[s]}. The population is functionally on the edge. Genetic drift alone could finish them now.`,
    `Gen ${gen}. ${curr} ${SPECIES_NAMES[s]} left. At this size, a single bad generation ends the lineage entirely. Watching closely.`,
    `Gen ${gen}. ${SPECIES_FULL[s]}: ${curr} individuals. The grid feels emptier already. Whether they pull through depends on factors I can't control.`,
  ];
  return texts[Math.floor(Math.random() * texts.length)];
}

// Species-specific extinction templates — indexed by species index (0-4)
const EXTINCTION_TEMPLATES = [
  // Velothrix aurantis (0)
  [
    (prev, gen) => `Gen ${gen}. Velothrix aurantis — extinct. I've been watching this species since the first generation. ${prev} individuals at my last count, now zero. The amber marshes will miss them.`,
    (prev, gen) => `Gen ${gen}. The last Velothrix is gone. ${prev} strong when I checked, now silence. They were the flagship of this ecosystem. Their loss changes everything downstream.`,
    (prev, gen) => `Gen ${gen}. I won't write "Velothrix aurantis — extinct" without pausing on it. ${prev} counted last interval. None now. The species that defined this sim is finished.`,
    (prev, gen) => `Gen ${gen}. Velothrix gone. They were here from the start — the original colonizer. ${prev} at last census. Whatever selective pressure ended them, it was decisive.`,
    (prev, gen) => `Gen ${gen}. Final Velothrix aurantis record: generation ${gen}, population zero. ${prev} at last count. Lineage closed. The niche they pioneered opens now to whoever is adaptive enough to claim it.`,
    (prev, gen) => `Gen ${gen}. The aurantis line ends here. ${prev} individuals — then none. There's something ironic about watching the namesake species go. The system doesn't care about names.`,
  ],
  // Kelp Leviathan (1)
  [
    (prev, gen) => `Gen ${gen}. The Kelp Leviathan is gone. Largest species in the system — ${prev} at my last count, now absent from every tile. The deep water zones will be emptier for it.`,
    (prev, gen) => `Gen ${gen}. Leviathan extinction confirmed. ${prev} counted last interval. I never expected something so large to disappear so fast. Size doesn't confer immunity in this system.`,
    (prev, gen) => `Gen ${gen}. The Kelp Leviathan is no more. ${prev} individuals — then zero. They once dominated the subtidal zones. Whatever ended them moved through the population faster than reproduction could compensate.`,
    (prev, gen) => `Gen ${gen}. No more Leviathans. ${prev} in the last census, none today. Generation ${gen}. The biomass they represented will redistribute slowly. Something will fill the gap, but not them.`,
    (prev, gen) => `Gen ${gen}. Kelp Leviathan — extinct at generation ${gen}. ${prev} individuals at last count. They were the heavyweights of this ecosystem. The food web just lost a major node.`,
    (prev, gen) => `Gen ${gen}. The Leviathan went quietly. ${prev} at census, zero now. For a species of their size, I expected a slower decline. The end came in a single interval. That's a collapse, not a fade.`,
  ],
  // Reed Crawler (2)
  [
    (prev, gen) => `Gen ${gen}. Reed Crawler — extinct. ${prev} at my last count, none surviving. They were rarely the dominant species, but they filled every marginal niche. The reed beds feel empty.`,
    (prev, gen) => `Gen ${gen}. The Crawlers are gone. ${prev} individuals last I checked, zero now. They were the quiet ones — always near the water's edge. I kept expecting them to bounce back. They didn't.`,
    (prev, gen) => `Gen ${gen}. Reed Crawler extinction confirmed at generation ${gen}. ${prev} counted last interval. They specialized too narrowly. When the reeds thinned, the Crawlers had nowhere left to go.`,
    (prev, gen) => `Gen ${gen}. No Crawlers remain. ${prev} at last census. They were adaptable in the middle generations but something broke their momentum. Zero left now. The reed margins are theirs no longer.`,
    (prev, gen) => `Gen ${gen}. Final Reed Crawler entry: generation ${gen}, population zero. ${prev} at last count. Modest species — never topped the charts — but their absence opens up the littoral zone in ways I didn't expect.`,
    (prev, gen) => `Gen ${gen}. The Crawlers slipped out quietly. ${prev} to zero in a single check interval. That's a rapid collapse for a species that seemed stable. Something changed fast, and they couldn't track it.`,
  ],
  // Tidal Crab (3)
  [
    (prev, gen) => `Gen ${gen}. Tidal Crab — extinct. ${prev} at last count, zero now. They were the scavengers, the recyclers. Without them the energy cycling in the tidal zones will shift. Generation ${gen} marks their end.`,
    (prev, gen) => `Gen ${gen}. The Crabs are gone. ${prev} individuals — then none. They clung to the tidal margins through every pressure event. Whatever ended them finally, it was enough. The intertidal is quieter now.`,
    (prev, gen) => `Gen ${gen}. Tidal Crab extinction at generation ${gen}. ${prev} counted last interval. They were tougher than they looked — survived three population bottlenecks before this one. This one didn't let go.`,
    (prev, gen) => `Gen ${gen}. No more Crabs. ${prev} in the last census. I've watched them scrape through near-extinction twice. The third time the margin closed. Zero remaining. The tide rolls in on an emptier shore.`,
    (prev, gen) => `Gen ${gen}. Final Tidal Crab record: gone at generation ${gen}. ${prev} at last count. They were specialists in survival. In the end, even that wasn't enough. The niche they held will be slow to fill.`,
    (prev, gen) => `Gen ${gen}. Tidal Crab, extinct. ${prev} to zero — a fast ending for a species I expected to outlast the others. Their disappearance removes the only detritivore from the system. Something will pay for that.`,
  ],
  // Bioluminescent Worm (4)
  [
    (prev, gen) => `Gen ${gen}. The Bioluminescent Worm is gone. ${prev} at my last count, none remaining anywhere on the grid. Their light is extinguished. Generation ${gen}. I didn't know I'd miss it.`,
    (prev, gen) => `Gen ${gen}. Worm extinction confirmed. ${prev} individuals — now zero. They were the most cryptic species in the system. Half the time I wasn't sure they were thriving or barely surviving. Now I know.`,
    (prev, gen) => `Gen ${gen}. The Worms are gone. ${prev} at last census. They lit up the deep sediment zones in ways that were almost beautiful, for a simulation. Whatever pressure ended them left no signal I could read. Just absence.`,
    (prev, gen) => `Gen ${gen}. Bioluminescent Worm — extinct at generation ${gen}. ${prev} last counted. Of all the species I've lost, this one leaves the strangest silence. The deep tiles have no glow now.`,
    (prev, gen) => `Gen ${gen}. Final Worm entry. ${prev} individuals, then zero. They were the deepest specialists — only found in the softest sediments. When that habitat narrowed, there was nowhere for them to retreat to.`,
    (prev, gen) => `Gen ${gen}. The last Worm is gone. ${prev} at last count. A species defined by inaccessibility — hard to find, hard to lose track of once you knew where to look. Now the data just shows zero.`,
  ],
];

function _extinction(s, prev, gen) {
  const speciesTemplates = EXTINCTION_TEMPLATES[s];
  const fn = speciesTemplates[Math.floor(Math.random() * speciesTemplates.length)];
  return fn(prev, gen);
}

function _milestone(s, pop, gen) {
  const texts = [
    `Gen ${gen}. ${SPECIES_FULL[s]} has crossed 1,000 individuals. A robust population — though permanence is never guaranteed in this system.`,
    `Gen ${gen}. ${SPECIES_NAMES[s]} at 1,000+. A threshold that matters. Extinction events become statistically unlikely at this scale. For now.`,
    `Gen ${gen}. Over a thousand ${SPECIES_NAMES[s]} on the grid. The species has momentum. Whether that momentum outlasts its food base is the open question.`,
  ];
  return texts[Math.floor(Math.random() * texts.length)];
}

function _dominance(s, pop, total, gen) {
  const pct = Math.round(pop / total * 100);
  const texts = [
    `Gen ${gen}. ${SPECIES_FULL[s]} dominates — ${pct}% of the total population. The ecosystem balance is tilting.`,
    `Gen ${gen}. ${pct}% of all individuals are ${SPECIES_NAMES[s]}. That kind of dominance reshapes the system around itself. Other species adapt or decline.`,
    `Gen ${gen}. The grid belongs to the ${SPECIES_NAMES[s]} right now. ${pct}% share. I've seen dominant species collapse faster than they rose. The resource base won't hold forever.`,
  ];
  return texts[Math.floor(Math.random() * texts.length)];
}

function _winter(gen) {
  const texts = [
    `Gen ${gen}. Deep winter. Food regrowth has slowed to a crawl. The species with high metabolism will feel this first.`,
    `Gen ${gen}. The seasonal low point. Vegetation is sparse, competition fierce. Winter always reveals who's adapted and who's borrowed time.`,
    `Gen ${gen}. Cold season. Movement slows. Populations that overextended during summer are paying for it now. The grid looks thin.`,
    `Gen ${gen}. Winter conditions. The marsh is quieter. I count fewer individuals moving than last cycle. Something is tightening.`,
  ];
  return texts[Math.floor(Math.random() * texts.length)];
}

function _summer(gen) {
  const texts = [
    `Gen ${gen}. Peak summer. Vegetation flourishes. Populations swell. But abundance breeds competition.`,
    `Gen ${gen}. The warm season. Food is plentiful, growth rates peak. The predators are well-fed. For now.`,
    `Gen ${gen}. High summer. The marsh is dense with life. It won't last — it never does — but for now, every biome is productive.`,
    `Gen ${gen}. Summer peak. I've been tracking this system long enough to know what comes after. Enjoy the abundance, ${SPECIES_NAMES[Math.floor(Math.random() * 5)]}.`,
  ];
  return texts[Math.floor(Math.random() * texts.length)];
}

function _volcanic(gen) {
  const texts = [
    `Gen ${gen}. Eruption. The ground splits open, ash billows skyward. Everything within range is transformed — or destroyed.`,
    `Gen ${gen}. Volcanic event. New rock rises from the earth. The ecosystem around the eruption site will never be the same.`,
    `Gen ${gen}. Lava breach. The landscape is being rewritten. Anything that can't move is lost. The survivors inherit whatever remains.`,
  ];
  return texts[Math.floor(Math.random() * texts.length)];
}

function _recovery(gen, pop) {
  const texts = [
    `Gen ${gen}. Recovery. After a period of decline, the ecosystem bounces back — ${pop} total individuals across all species. Life finds a way.`,
    `Gen ${gen}. The system stabilized. All five species present, ${pop} individuals total. A collapse that didn't fully collapse. Worth noting.`,
    `Gen ${gen}. Unexpected resilience. The population bottleneck cleared. ${pop} individuals across all species. The diversity held.`,
  ];
  return texts[Math.floor(Math.random() * texts.length)];
}

/**
 * Speciation event journal entry — exported so ui.js can call it directly.
 */
export function addSpeciationEntry(gen, speciesIdx) {
  const name = SPECIES_NAMES[speciesIdx];
  const full = SPECIES_FULL[speciesIdx];
  const texts = [
    `Gen ${gen}. Speciation detected in ${full}. Northern and southern populations have diverged past the genetic threshold — their traits no longer overlap. A lineage splits. This is how new species are born.`,
    `Gen ${gen}. The ${name} population has forked. Two genetically distinct groups, separated by distance and selection pressure. FST exceeds 0.25. I'm watching evolution in real time.`,
    `Gen ${gen}. ${full} — speciation event confirmed. Allopatric isolation did its work. The traits that defined the common ancestor are now distributed differently across the map. They may never reconverge.`,
    `Gen ${gen}. The ${name} have split. High genetic divergence between the northern and southern subpopulations — sustained for over 100 generations. A branching point. The phylogeny deepens.`,
    `Gen ${gen}. Speciation in ${full}. I've been tracking the divergence for generations. The FST crossed the threshold and held. Two populations that can no longer be called the same species by any meaningful measure.`,
    `Gen ${gen}. ${full} has speciated. What started as geographic isolation became genetic isolation. The variation I was watching between regions has crossed the line from polymorphism into species-level divergence.`,
  ];
  _add(gen, texts[Math.floor(Math.random() * texts.length)], 'speciation', { species: speciesIdx });
}
