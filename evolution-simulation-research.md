# Evolution Simulation — Mathematical Reference

A compiled reference of equations and models relevant to simulating evolutionary processes, including species-specific formulas drawn from real biological datasets.

---

## 1. Population Genetics Core

### Hardy-Weinberg Equilibrium
The null "no evolution" baseline. Useful for detecting when drift, selection, or mutation is active.

- Genotype frequencies: `p² (AA) + 2pq (Aa) + q² (aa) = 1`
- Allele frequencies: `p + q = 1`

**Application:** Initialize populations at HWE, then perturb with selection/drift and track deviation.

---

### Allele Frequency Change Under Selection
```
Δp = sp(1−p) / (1 + sp)
```
- `s` = selection coefficient
- `p` = frequency of favored allele

**Application:** Core per-generation update rule for any locus under directional selection.

---

### Allele Frequency Change with Dominance (General)
A more complete version handling dominance and heterozygote fitness:
```
Δp = pq[p(w₁₁ − w₁₂) + q(w₁₂ − w₂₂)] / w̄
```
- `w₁₁`, `w₁₂`, `w₂₂` = fitness values for AA, Aa, aa genotypes
- `w̄` = mean population fitness = `p²w₁₁ + 2pqw₁₂ + q²w₂₂`

---

### Genetic Drift Variance
```
σ² = p(1−p) / 2N
```
- `N` = effective population size

**Application:** Per-generation stochastic noise. Simulate by drawing new `p` from a binomial distribution with this variance.

---

## 2. Fitness & Selection

### Mean Population Fitness
```
w̄ = p²w₁₁ + 2pqw₁₂ + q²w₂₂
```

---

### Heterozygote Advantage — Balancing Selection Equilibrium
When heterozygotes are fittest, alleles reach a stable equilibrium rather than fixation:
```
p̂ = (w₁₂ − w₂₂) / (2w₁₂ − w₁₁ − w₂₂)
```
**Species relevance:** Mirrors stickleback *Eda* locus polymorphism and finch beak bimodality at El Garrapatero (G. fortis).

---

### Disruptive Selection
When intermediate phenotypes are *least* fit (bimodal selection), the variance in fitness across phenotypes drives the population toward two peaks. Model using a fitness function with two optima:
```
W(z) = 1 − s·exp(−(z − θ₁)² / 2σ²) − s·exp(−(z − θ₂)² / 2σ²)
```
- `z` = individual trait value
- `θ₁`, `θ₂` = two fitness optima
- `σ` = width of each selection valley

**Species relevance:** Documented in *G. fortis* beak size at El Garrapatero during drought. Strong disruptive selection maintained bimodality between small- and large-beaked morphs.

---

### Stabilizing Selection
When intermediate phenotypes are most fit (Gaussian fitness function):
```
W(z) = exp(−(z − θ)² / 2ω²)
```
- `θ` = optimal trait value
- `ω²` = strength of stabilizing selection (larger = weaker selection)

**Species relevance:** *D. melanogaster* bristle number is under stabilizing selection. *P. major* clutch size shows stabilizing selection mediated by incubation costs.

---

### Selection Differential
```
S = μ_selected − μ_population
```
The difference between the mean of individuals that reproduce vs. the whole population mean.

---

## 3. Quantitative Genetics

### Breeder's Equation
Predicts response to selection on a continuous trait:
```
R = h²S
```
- `R` = response to selection (change in mean per generation)
- `h²` = narrow-sense heritability
- `S` = selection differential

**Species relevance:**
- *G. fortis* beak depth: h² ≈ 0.70 — used by the Grants to accurately predict post-drought beak size evolution
- *D. melanogaster* bristle number: h² ≈ 0.50
- *P. major* clutch size: h² ≈ 0.40–0.50

---

### Heritability (narrow-sense)
```
h² = V_A / V_P
```
- `V_A` = additive genetic variance
- `V_P` = total phenotypic variance = `V_A + V_D + V_I + V_E`

---

### Multivariate Breeder's Equation (Lande Equation)
When multiple correlated traits are under selection simultaneously:
```
Δz̄ = G · β
```
- `Δz̄` = vector of changes in trait means
- `G` = additive genetic variance-covariance matrix
- `β` = vector of selection gradients (partial regression of fitness on each trait)

**Species relevance:** *G. fortis* beak length and depth co-evolve; *P. reticulata* color elements are correlated. This equation captures those trade-offs.

---

### Selection Gradient (β)
Partial regression of relative fitness (w/w̄) on a trait value:
```
β = Cov(w/w̄, z) / V_P
```

---

### Robertson-Price Identity
Fundamental theorem connecting covariance of fitness and trait to evolutionary change:
```
Δz̄ = Cov(w, z) / w̄
```
Partitions change into selection and drift components.

---

## 4. Mutation & Mutation-Selection Balance

### Mutation-Selection Balance (Recessive Deleterious Allele)
Equilibrium frequency of a deleterious recessive:
```
q̂ ≈ √(μ/s)
```

### Mutation-Selection Balance (Dominant Deleterious Allele)
```
q̂ ≈ μ/s
```
- `μ` = mutation rate
- `s` = selection coefficient against the allele

**Species relevance:** *D. melanogaster* has a per-character mutation rate of ~0.03 for bristle number — among the best empirically characterized. Mutations show diminishing epistasis at background-dependent rates.

---

### Mutational Variance (V_M)
The amount of new additive genetic variance introduced each generation by mutation:
```
V_M = 2N_e · μ · a²
```
- `a` = average mutational effect size
- Used to predict long-term selection response limits

---

## 5. Gene Flow & Migration

### Gene Flow (Island Model)
```
Δp = m(p_m − p)
```
- `m` = migration rate (proportion of migrants per generation)
- `p_m` = allele frequency in migrant source population

**Species relevance:** Lake Washington stickleback (*G. aculeatus*) models account for marine and stream migrant influx when estimating *Eda* selection coefficients. Migration substantially complicates inference of s.

---

### FST — Population Differentiation
```
F_ST = (H_T − H_S) / H_T
```
- `H_T` = expected heterozygosity in total population
- `H_S` = expected heterozygosity within subpopulations

Used to test whether differentiation between populations exceeds neutral expectations (PST/QST comparisons in sticklebacks).

---

## 6. Effective Population Size & Drift

### Effective Population Size
```
1/N_e = (1/t) × Σ(1/Nᵢ)
```
Harmonic mean across generations — bottlenecks dominate.

**Species relevance:** Guppy introduction experiments start with small founder populations (~few dozen). This formula quantifies how strongly bottleneck effects shape early evolution vs. selection.

---

### Probability of Fixation (Kimura)
For a new mutation with selection coefficient `s` in population of size `N`:
```
P_fix = (1 − e^(−2s)) / (1 − e^(−4Ns))
```
- Neutral allele: P_fix = 1/2N
- Advantageous allele: P_fix ≈ 2s (when Ns >> 1)

---

## 7. Life History Theory

### Lack Clutch Size Optimization
David Lack's classic prediction: optimal clutch size `C*` maximizes the number of surviving offspring. Modeled as:
```
W(C) = C · S(C) · p_survival(C)
```
- `C` = clutch size
- `S(C)` = per-offspring survival as function of clutch size (decreases with C)
- `p_survival` = parental survival (can also decrease with C)

**Species relevance:** *P. major* (great tit) is the canonical test system for Lack's hypothesis. Wytham Woods data (1947–present) show positive selection on brood size during nestling phase, but stabilizing selection when incubation costs and second-clutch effects are included. Overall fitness:
```
W_total = P_survival + R_clutch1/2 + R_clutch2/2
```
where R = recruits per clutch.

---

### Euler-Lotka Equation (Age-Structured Fitness)
For populations with overlapping generations:
```
Σ e^(−rx) · l(x) · m(x) = 1
```
- `r` = intrinsic rate of increase (fitness measure)
- `l(x)` = survivorship to age x
- `m(x)` = fecundity at age x

**Species relevance:** *P. major* has age-specific breeding success; *P. reticulata* matures at different ages under different predation regimes. Both require age-structured fitness.

---

### Life History Trade-off: Reznick's Model (Guppies)
Under high predation, age at maturity decreases and offspring size increases. Modeled as:
```
r ≈ ln(R₀) / T
```
- `R₀` = net reproductive rate = `Σ l(x)m(x)`
- `T` = generation time = `Σ x·l(x)·m(x) / R₀`

High-predation guppies evolve higher r via earlier maturation; low-predation guppies shift toward K-selection (fewer, larger offspring). This is one of the best empirically validated life-history evolution systems.

---

## 8. Sexual Selection

### Zahavian Handicap / Signal Reliability
Honest signaling model — ornament expression is costly, so only high-quality males can afford to express it:
```
C(t, q) = t² / q
```
- `t` = trait intensity (e.g., color saturation)
- `q` = male quality
- Equilibrium ornament level maximizes `q − C(t, q)`

**Species relevance:** *P. reticulata* carotenoid coloration is condition-dependent and honest. Predation toggles the cost side of this equation (conspicuousness = predation risk).

---

### Frequency-Dependent Sexual Selection (Rare Male Advantage)
Fitness of a male color morph `i`:
```
W_i = w̄ + α(1/f_i − 1)
```
- `f_i` = frequency of morph i
- `α` = strength of rare-male advantage

**Species relevance:** *P. reticulata* females prefer rare male color patterns. This negative frequency-dependence maintains high polymorphism in male coloration across generations (documented over 10 generations in natural population pedigrees).

---

### Sexual Selection Index (Bateman Gradient)
Regression of reproductive success on number of mates:
```
β_ss = Cov(RS, mates) / Var(mates)
```
Steeper gradient = stronger sexual selection.

---

## 9. Population Dynamics (Ecological Context)

### Logistic Growth
```
dN/dt = rN(1 − N/K)
```
- `r` = intrinsic growth rate
- `K` = carrying capacity

Connects ecological density to evolutionary dynamics (density-dependent selection).

---

### Density-Dependent Selection on Life History
When population is near K, selection favors survival and competitive ability. At low N, selection favors early reproduction. This shifts the optimal life history across a gradient.

**Species relevance:** Guppy eco-evolutionary feedbacks: evolved guppy populations alter nutrient cycling and prey availability, feeding back to change the selective environment. Carrying capacity effectively shifts based on guppy phenotype.

---

## 10. Species-Specific Parameter Reference

| Species | Trait | h² | Key Formula |
|---|---|---|---|
| *G. fortis* (finch) | Beak depth | ~0.70 | Breeder's eq., disruptive selection |
| *G. aculeatus* (stickleback) | Plate number | ~major-effect QTL (Eda locus) | Allele freq. change + migration model |
| *D. melanogaster* (fruit fly) | Bristle number | ~0.50 | Stabilizing selection, mutation-selection balance |
| *P. reticulata* (guppy) | Color area | ~0.30–0.50 | Rare male advantage, life history r/K |
| *P. major* (great tit) | Clutch size | ~0.40–0.50 | Lack optimum, Euler-Lotka |

---

## 11. Simulation Update Order (Suggested Per-Generation Loop)

1. **Selection** — apply fitness function, compute `Δp` or `ΔR` via Breeder's Eq.
2. **Drift** — sample new allele frequency from binomial(N, p)
3. **Mutation** — add `V_M` or apply mutation rate per locus
4. **Migration** — update p using island model
5. **Reproduction** — compute next-generation N via logistic or Euler-Lotka
6. **Record** — track p, mean phenotype, V_A, V_P, w̄ per generation

---

## 12. River Geomorphology & Terrain Dynamics

### Hydrostatic Equilibrium (Standing Water Level Rule)
Connected bodies of standing water settle to the same elevation. In a grid simulation this is enforced as a constraint: after any elevation modification, flood-fill from the lowest connected water tile to normalise all reachable sub-water-table tiles to a single level.

```
For all tiles T in connected water body W:
  elevation(T) = min(elevation(T) for T in W)
```

Rivers are exempt — they are flowing water with a directional gradient, not standing bodies.

---

### River as Directed-Path Overlay
In grid-based terrain, rivers cannot be modeled as water tiles without violating the standing water constraint (a river descends; standing water is level). The solution is to treat rivers as a **graph overlay** — an ordered sequence of tile coordinates from source to mouth, stored separately from the elevation grid.

Each tile along the path receives a `has_river` flag. The tile's terrain elevation is unchanged by the river's presence. The river follows the existing elevation gradient.

**Data structure:**
```
river = {
    path: [(r₀, c₀), (r₁, c₁), ...],  # source → mouth
    age: int,                             # generations since spawn
    width: int                            # tiles at widest meander
}
```

---

### Stream Power Law (Erosion Rate)
The rate at which a river erodes its channel is proportional to upstream drainage area and local slope:

```
E = K · A^m · S^n
```
- `E` = erosion rate (elevation change per unit time)
- `A` = upstream drainage area (proxy: number of tiles upstream in the path)
- `S` = local slope (elevation difference between adjacent path tiles)
- `K` = erodibility constant (material-dependent)
- `m ≈ 0.5`, `n ≈ 1.0` (empirical exponents, Whipple & Tucker 1999)

**Simulation note:** On a coarse grid, E is used to set the river advance rate (tiles per geological tick), not per-tick elevation change. The river overlay does not modify elevation; the stream power law governs how quickly the path extends toward the coast.

---

### Meander Migration — Lateral Channel Shift
River meanders form because flow velocity is asymmetric at bends:
- **Outside of bend**: faster flow → more erosion → bank retreats
- **Inside of bend**: slower flow → deposition → point bar forms

The lateral migration rate of a meander bend:

```
dξ/dt = E₀ · (R_c / w)^(-α)
```
- `ξ` = lateral position of the channel centerline
- `E₀` = baseline erosion rate
- `R_c` = radius of curvature of the bend
- `w` = channel width
- `α ≈ 1` (tighter bends migrate faster, up to a cutoff)

**Grid simplification:** At each geological tick, for each bend point in the path (where direction changes), compute the "outside" tile perpendicular to the bend direction. With probability `p_meander` (tunable), shift the bend outward by adding the outside tile to the path and removing the corresponding inside tile. The inside tile reverts to dry land.

**Constraint:** The path must remain contiguous and maintain an overall downhill gradient. The path cannot cross itself — when it nearly does, an oxbow cutoff is triggered.

*Reference: Howard & Knutson (1984), "Sufficient conditions for river meandering." Ikeda, Parker & Sawai (1981), "Bend theory of river meanders."*

---

### Oxbow Lake Formation (Meander Cutoff)
When a meander loop curves far enough that two non-adjacent segments of the river path occupy adjacent tiles, the river **cuts through the neck** — the shorter, straighter path is energetically favoured.

The severed loop becomes an isolated body of standing water — an **oxbow lake**. It obeys the standing water level rule (all tiles in the oxbow share one elevation, disconnected from the river).

**Detection algorithm (grid):**
1. For each tile in the river path, check whether any *non-adjacent-in-path* river tile is a grid neighbour.
2. If found, the path between the two tiles (the longer arc) is severed.
3. Severed tiles: `has_river = False`, reclassified as standing water at local ground elevation.
4. The main river path is updated to the shorter arc.

**Biological significance:** Oxbow lakes create isolated microhabitats. Populations within the former loop may experience temporary genetic isolation, analogous to a small-scale founder event. Over geological time, oxbow lakes can infill via sedimentation (elevation slowly rises until they become dry land again).

*Reference: Gagliano & Howard (1984), "Meander cutoff mechanics." Constantine & Dunne (2008), "Meander cutoff and the controls on the production of oxbow lakes."*

---

### Sinuosity Ratio
A measure of how meandered a river is:

```
σ = L_channel / L_valley
```
- `L_channel` = actual path length (number of tiles in the river path)
- `L_valley` = straight-line distance from source to mouth

A straight channel has σ = 1. Rivers with σ > 1.5 are considered meandering. σ > 2.5 is highly sinuous (common in low-gradient floodplains). Oxbow cutoffs reduce σ abruptly.

**Simulation use:** Track sinuosity as a diagnostic. When σ exceeds a threshold, oxbow formation probability increases. Can be exposed in Lab mode charts as a terrain metric.

---

### River as Biogeographic Barrier
Rivers are among the most important drivers of allopatric speciation in terrestrial and semi-aquatic organisms.

**Riverine barrier hypothesis** (Wallace 1852): large rivers reduce gene flow between populations on opposite banks, leading to genetic divergence and eventually speciation.

Empirical support:
- Amazon tributaries serve as species boundaries for primates, birds, and butterflies (Ayres & Clutton-Brock 1992; Hayes & Sewlal 2004)
- Width of the river correlates with degree of genetic differentiation: wider channels → higher FST (Gascon et al. 2000)
- The barrier effect is **asymmetric** — strong for poor dispersers, weak for volant species

**Simulation model:**
```
m_effective = m_baseline × barrier_factor(river)
barrier_factor = 1 / (1 + k · width · age)
```
- `m_baseline` = gene flow rate without the river
- `width` = number of tiles spanned by the river at the crossing point
- `age` = generations since the river reached this point (older rivers are more established barriers)
- `k` = scaling constant (tuning required)

As `barrier_factor` approaches 0, gene flow between opposite banks approaches 0 — full isolation. FST then rises under drift and differential selection on each side, feeding into the existing speciation mechanic.

*Reference: Wallace (1852), "On the monkeys of the Amazon." Gascon et al. (2000), "Riverine barriers and the geographic distribution of Amazonian species." Burney & Brumfield (2009), "Ecology predicts levels of genetic differentiation across Amazonian rivers."*

---

### Terrain Erosion — Background Process
Erosion in the absence of rivers is modeled as a slow, continuous reduction in elevation for high-elevation tiles:

```
Δelev(r,c) = -ε · max(0, elev(r,c) - elev_mean)
```
- `ε` = erosion rate constant (very small; tune so a full biome transition takes hundreds of generations)
- `elev_mean` = mean elevation of the grid (or a fixed reference)

This creates a long-term trend toward flatter terrain and expanding shallow-marsh habitat. It is a background process with no event card — the player observes it through slowly changing biome proportions in Lab mode charts.

After each erosion step, the standing water level rule is re-enforced: if any tile has eroded below `water_table`, it joins the nearest standing water body and all connected tiles normalise to the same level.

---

### Volcanic Terrain Events — Instantaneous Transform
Volcanic events are modeled as single-generation terrain mutations:

```
For selected tile (r, c) and radius R:
  elev(r, c) += Δ_volcano          # new high-elevation substrate
  For all tiles within R of (r, c):
    temp(r', c') *= temp_spike      # multiplicative temperature shock
    food(r', c') *= food_crash      # multiplicative food reduction
```

The entire event resolves in 1 generation — faster than one Velothrix breeding cycle. There is no cooling phase. The new high-elevation substrate is immediately available for colonisation (governed by DISP allele frequency at time of eruption). Erosion (§ above) applies to the new substrate from the next tick onward, slowly wearing it down over hundreds of generations.

After the volcanic elevation change, the standing water level rule is re-enforced in case the eruption displaced a coastal tile above or below `water_table`.

---

*Last updated: March 2026. Sources: Grant & Grant (finches), Kitano et al. (stickleback), Mackay (Drosophila bristles), Reznick et al. (guppies), Tinbergen & Sanz (great tit), Endler (sexual selection models), Howard & Knutson (meandering), Ikeda et al. (bend theory), Constantine & Dunne (oxbow lakes), Whipple & Tucker (stream power), Wallace / Gascon et al. / Burney & Brumfield (riverine barriers).*
