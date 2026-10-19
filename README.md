# Evolution Arena

A grid-world evolution sim where natural selection is an *emergent* property of a closed
energy economy, plus a dashboard that lets you watch it and interrogate it.

There is no fitness function anywhere in this code. Nothing scores an organism. An
organism either has enough energy left over to split, or it does not. Everything that
looks like "selection" is bookkeeping about who can pay their bills.

```
python -m evo.run --preset arms_race --live --out out/live
open out/live.html
```

That writes a self-contained HTML file. No server, no build step, no internet — the whole
simulator is inlined in the page and runs in your browser.

`--live` is the agar.io-style view: the world steps in real time, organisms are drawn every
frame, and the graphs below redraw about five times a second while you watch. It is a live
run, not a recording — the scrubber follows the frontier, and dragging it back pauses and
rewinds; press resume to rejoin. Speed is `--steps`: how many ticks one animation frame
computes. Raise it to run faster than real time, at the cost of a choppier world. The
lineage tree keeps growing as you watch, so it is rebuilt on that same five-times-a-second
beat rather than every frame.

Drop `--live` and the sim runs in Python instead, with a finished trace baked into the page.
Slower to produce, but it carries every tick, so the scrubber has full resolution:

---

## The model

One tick, in order:

```
food regrows  →  every organism senses, moves, attacks, eats, burns, ages  →  maybe splits
              →  anything at zero energy, or past its lifespan, dies
```

Seven traits, each in `[0, 1]`:

| trait | buys | costs |
|---|---|---|
| `speed` | more cells travelled per tick, and better at catching prey | `move_cost` per cell travelled |
| `sense` | a wider, smoother view of the food field | attention is expensive per tick |
| `size` | energy capacity, and the right to eat smaller organisms | **quadratic** upkeep, and digests plants *worse* |
| `metabolism` | assimilates prey better, digests food better | the most expensive trait in the world |
| `repro` | (nothing directly) | raises the energy threshold needed to split |
| `lifespan` | lives longer | upkeep for every tick lived |
| `hue` | nothing | nothing — a neutral marker so a lineage is visible as a colour |

Energy enters as `food_regrow` per cell per tick and never any other way. Carrying
capacity is therefore an *outcome* of the model, never a parameter.

---

## Three rules that decide whether this is interesting

Everything below was learned the hard way, by watching graphs go flat.

### 1. Every trait must cost energy

This is the whole model. A free trait evolves to its ceiling, every organism reaches that
ceiling, the population becomes one clone, and every graph is a straight line. The cost
table in `World.derive` is where natural selection actually lives — that one function is
the entire "environment" the organisms are adapting to.

### 2. Body size must buy very little

The first version let capacity scale with size. Size ratcheted to 1.0 and stopped. Worse,
once *everyone* is big, any small mutant gets eaten before it establishes, so the
population locks into one point of trait space forever — a permanent evolutionary trap,
and a permanently flat dashboard.

Now capacity is `38 + 14·size` (barely anything) and plant digestion is multiplied by
`1 − 0.6·size`. Being large is a *net loss* unless you can catch something. Size only
pays for itself through killing, which is what converts "bigger is better" into a
two-sided arms race.

### 3. Predators and prey must be able to find each other

Predation was dead code for two separate reasons, both invisible:

- the search used `maximum_filter`, which returns the *max* count in a 3×3 block, not the
  sum, so an attack still required two organisms in the same cell — roughly 1 in 3000;
- both sides sensed the same thing, so the size classes never intersected.

Now organisms pull toward the size class *below* them and push away from the class *above*
them. Kills went from essentially never, to several per tick sustained for thousands of ticks.

---

## What the current default actually does

`arms_race`, 4000 ticks, seed 1 (mean of the last 2400 ticks). Regenerate with
`python -m evo.run --preset arms_race --ticks 4000 --seed 1 --report --no-html`:

```
pop 660-761, no trend      diversity 1.81 (ceiling ln16 = 2.77)
predation 4.4 kills/tick sustained, peaks of 26
19,114 organisms born from 100 founders; deepest surviving lineage 42 generations
trait means:  speed 0.43  sense 0.23  size 0.51  metabolism 0.96  repro 0.09  lifespan 0.33
```

The means are the least interesting part. Histogrammed at the end of the run, the
population has broken into **discrete strategies**, not a smooth cloud:

```
bin        0.00-.125  .125-.25  .25-.375  .375-.5  .50-.625  .625-.75 .75-.875  .875-1.0
speed          340       57        22         9        11        13       32       239
size           133      133        65        84        18         9       43       238
```

Speed is **bimodal**: a large sit-and-wait population at ~0.05 and a fast one at ~0.9,
with almost nothing in between. Running is expensive, and the middle — fast enough to
cost a lot, not fast enough to reliably catch things — is the worst place to be. Size is
split the same way, which is the signature that predation is a real force rather than a
bonus: small-and-cheap and large-and-dangerous both persist, and the intermediate size is
the one that starves.

`metabolism` climbing to 0.96 while `repro` falls to 0.09 is the world paying for
digestion quality by giving up reproductive readiness.

Global population is **stable, not oscillating**. I went looking for boom-bust cycles with
the sweep and could not find them at this grid size — the food field regenerates faster
than the generation time, which damps the classic Lotka-Volterra swing. What does happen
is *spatial*: the food field has strong local structure (sd 0.25 on a mean of 0.46), so
grazing waves move across the map even while the global total sits still. Watch the food
background in the Replay tab for that.

---

## The graphs, and what each one is evidence for

The dashboard has four tabs.

**Replay** — the world, coloured by any trait, over the food field. Scrub or play. Colour
by `hue` and you see lineages as blobs of colour that split and vanish; colour by `size`
and you see the herbivore/predator split arrange itself spatially.

**Charts** — the diagnostic set:

| graph | what it proves |
|---|---|
| Trait means | selection's footprint. If any line sits at 1.0, that trait is free — a bug |
| Trait std | polymorphism. A collapse to 0 means one genotype swept the world |
| Size ridgeline | the population splitting into two feeding strategies, live |
| Speed ridgeline | whether running is under selection or just drifting |
| Speed × size scatter | the trade-off frontier. The empty middle is where selection punishes generalists |
| Sense × metabolism | the "cheap and blind vs far-seeing and hungry" split |
| Deaths by cause | *what the selective pressure actually is*, which is the point of the whole exercise |
| Energy partition | energy in bodies vs in the environment — the closed system, made visible |
| Flux | births vs deaths; their crossing precedes population turns |

**Lineage** — the tree of life. Every organism that ever lived, parent → offspring, height
= time, colour = the neutral hue marker. Faint branches are extinct. Sample size is a
slider because a full 18,000-node tree is a comb, not a tree. It reports the most recent
common ancestor of the survivors, which for these runs does *not* exist — multiple founder
lines are still segregating at tick 4000, which is what you'd expect from 100 founders on
a 64×64 torus with real spatial structure.

**Rules** — the model written out, with the live cost table and current trait means.

---

## Commands

```bash
python -m evo.run --list-presets
python -m evo.run --preset arms_race --live --out out/live        # watch it run in the browser
python -m evo.run --preset arms_race --live --steps 12 --out out/fast       # faster than real time
python -m evo.run --preset famine --set food_regrow=0.03 --seed 7 --out out/fam
python -m evo.run --preset arms_race --ticks 4000 --out out/arms --save-state
python -m evo.run --resume out/arms.state.json --ticks 2000 --out out/arms2

# find the interesting corners of parameter space instead of guessing
python -m evo.sweep --preset arms_race --ticks 1500 --jobs 4 \
    --sweep food_regrow=0.02,0.05,0.10 --sweep carnivory=0.2,0.6,0.9
python -m evo.sweep ... --top 3 --save        # dashboards for the best 3

python -m tests.test_sim                      # invariants
python -m evo.golden && node tests/test_parity.js   # sim.py <-> web/sim.js parity
python -m evo.controls                        # regenerate the controls table below

# the render goldens are blessed against exactly these two artifacts
python -m evo.run --preset arms_race --ticks 4000 --seed 1 --out out/arms
python -m evo.run --preset arms_race --seed 3 --live --out out/live
node tools/render_check.js out/arms.html      # dashboard draws the blessed tape
node tools/render_check.js out/live.html      # live page boots the Python world and advances
```

Presets: `ancestral` `eden` `famine` `arms_race` `mutagenic` `peaceful` `flat`.

### Controls

`peaceful` (no predation) and `flat` (no spatial patches) exist as *controls* — they are
what you run to check that the interesting behaviour has a cause. 2500 ticks, mean of the
last 1500:

| world | diversity | sd(size) | kills/tick | pop |
|---|---|---|---|---|
| `arms_race` (everything on) | **2.04** | **0.213** | 3.72 | 706 |
| `peaceful` — no predation | 1.17 | 0.078 | 0 | 907 |
| `flat` — no fertility patches | 2.06 | 0.150 | 1.37 | 570 |
| `carnivory=0` — size costs nothing to digest | 1.18 | **0.016** | 0.15 | 851 |

Regenerate with `python -m evo.controls`.

Read the last row first, because it is the surprising one. Turning off *only* the rule that
large bodies digest plants badly doesn't weaken predation, it **switches predation off**
(3.7 &rarr; 0.15 kills/tick) and collapses size polymorphism 13-fold. Being big has to be
a *net loss* for being big to ever be contested. The arms race is created by the cost of
size, not by the existence of teeth.

Removing predation halves diversity (2.04 &rarr; 1.17) and removes two thirds of the size
variation, so predation is maintaining roughly a third of the world's niches. Removing
spatial patchiness costs *nothing at all* in diversity (2.06 vs 2.04) and only a third of
the size variation — the size trade-off, not the landscape, is doing all of the work. That
revised an earlier design assumption of mine:
I had treated patchy fertility as one of the three load-bearing rules, and the control says
it is a supporting actor.

The sweep agrees, but less cleanly than I first wrote. 3x3x2 grid, 18 cells (`food_regrow` x
`carnivory` x `predation`), 1500 ticks:

```bash
python -m evo.sweep --preset arms_race --ticks 1500 --jobs 4 \
    --sweep food_regrow=0.02,0.05,0.10 --sweep carnivory=0.2,0.6,0.9 --sweep predation=true,false
```

The top **six of six** cells are `predation=true`, and the single best (0.74) beats the best
predation-off cell (0.47) by a wide margin. But the ranges overlap: predation-on spans
0.33-0.74 and predation-off 0.34-0.47, and paired cell-by-cell predation wins 7 of 9. The
two it loses are both at `food_regrow=0.02` - when there is no primary-production surplus,
a predator lineage has nothing to convert. Predation predicts an interesting world *given
resources*, not universally. That is a better result than the clean split I claimed
earlier, and it only appeared once the grid included the famine end.

One caveat worth keeping: this is a single seed per cell. The predation-vs-famine
interaction is exactly the kind of result that wants three seeds before anyone should trust
the direction of those two losses.

---

## Invariants

`tests/test_sim.py` guards the ways this kind of model fails silently:

- **energy is never created** — the world can lose energy to clipping and waste heat, but
  `Δ(food + bodies) ≤ energy injected`. This caught a real bug: two organisms in one cell
  each ate the whole meal because the code read a stale copy of the food list, and food
  went negative.
- **determinism** — same seed, same world.
- **save/resume is exact** — a resumed run is byte-identical to one that never stopped.
- **snapshots don't perturb the sim** — playback frames are taken every 50 ticks, so a
  shared RNG here would silently change the science.
- **traits don't all saturate**, **selection actually moves something**, **size stays
  polymorphic**, **predation is not dead code**, **extinction doesn't crash**, **the
  lineage graph is a forest** (every parent is older than its child).

### The parity contract

`evo/web/sim.js` is a second implementation of the same model, so the browser can run the
world live instead of replaying a baked trace. Two implementations can disagree silently,
so `tests/test_parity.js` runs both from the *same* Mersenne Twister state and asserts:

1. **exact** agreement for the first 15 ticks — population identical to the organism, every
   trait mean within 1e-9. This is the sharp instrument: a missing cost term or a wrong
   filter radius shows up immediately, not as slow drift.
2. **bounded** statistical agreement afterwards. JS `Math.log` is not correctly rounded, so
   `gauss` differs from CPython by ~1 ulp and a chaotic sim amplifies that. Measured drift
   over 600 ticks across 6 runs: population within 9%, trait means within 0.12.

Regenerate the reference with `python -m evo.golden`. The `arms_race_dense` case exists
because at natural density the crowding gate and the prey fields are both zero for the
first dozen ticks, so predation and hunt/flee steering can be deleted outright and the
trajectory comparison still passes — the dense fixture forces both paths to fire inside the
exact window. Deleting one cost term at a time, the test catches 10 of 10 injected bugs.

This test found a bug in the *reference* model, not just the port: `scipy.ndimage.uniform_filter`
dispatches on dtype, and its integer path applies `mode="wrap"` incorrectly, disagreeing with
its own float path at the border. Both density fields fed it int64, so the predation gate was
partly driven by that quirk. `evo/sim.py` now uses an exact integer box sum instead —
dtype-independent, and the one formulation JS can match bit for bit.

### The render contract

`tools/render_check.js` runs the dashboard's own JS against a fake DOM and records the
**draw tape**: every canvas call, with its arguments and the style in force when the mark
went down. `tests/golden/render/<artifact>.json` holds a digest of that tape per canvas,
plus op counts, extent, and the first 40 ops. A chart can now fail a test for being wrong,
not just for being blank.

This is a tape diff rather than a screenshot diff on purpose: no browser download, and no
flakiness from font rasterisation or GPU paths, because nothing is rasterised. It costs
~1s per artifact.

Injected bugs it catches, each localised to the exact op:

| mutation | caught |
|---|---|
| one series colour changed by one hex digit | yes |
| a line path shifted 3px | yes, `differs at op 15` |
| `lineWidth` 1 → 2 | yes |
| legend label gains a trailing space | yes |
| a CSS `--dim` colour changed by one hex digit | yes — the harness reads the real `:root` palette |
| a chart draws nothing | yes |

What a tape cannot see is *legibility*: two series in near-identical colours, or text sitting
on top of a line. `--sheet` replays the tape as `out/sheet.svg` for that — a contact sheet of
all 15 canvases at their authored sizes. `--bless` rewrites a golden after an intended
change; `--dump` writes full tapes to `out/tape/` when a digest mismatches and the first 40
ops do not explain why.

Two honest limits. `canvas{width:100%}` means the laid-out width is unknowable headlessly, so
charts are given their `width` attribute or 400px — horizontal layout is an assumption, not a
measurement. And `layoutTree` draws a random subsample of tips, so the harness seeds
`Math.random`; that makes the *test* reproducible, it does not make the browser view
reproducible.

The first thing the overflow check found was a real bug: `ridgeline()` spaced rows by
`(h-pad)/(rows-1)` but drew each ridge `2.6` row-heights tall, so the topmost ridge — the
newest one — peaked up to 91px above the canvas and was clipped away. Any run under ~2150
ticks (43 snapshots) hit it; the default 4000 happened to fit. The spacing now counts the
overlap, which puts the tallest possible ridge exactly at the top padding.

---

## Layout

```
evo/sim.py           the model. Params, World, the tick loop, the trade-off table
evo/trace.py         run a sim to a compact trace (stats + playback frames + lineage)
evo/run.py           CLI: run, save trace, emit standalone dashboard
evo/web/             JS port of the model (prng.js, sim.js) used by --live
evo/sweep.py         parameter grid, scored by how much selection it shows
evo/controls.py      regenerate the controls table in this README
evo/golden.py        emit the reference trace the JS port is checked against
evo/dashboard.html   the whole front end; __TRACE__ is replaced with the run's JSON
evo/web/prng.js      MT19937 + gauss, bit-exact with CPython's random
evo/web/sim.js       the model, ported to typed-array SoA for the live browser world
evo/web/fixture.js   dense test world that forces predation to fire
tests/test_sim.py    invariants
tests/test_parity.js sim.py <-> web/sim.js agreement
tools/render_check.js  headless check that the dashboard's JS runs and paints
```

## Known limits

- **`metabolism` is not a real trade-off yet.** It runs to 0.95 because its benefit is
  multiplicative on everything the organism eats while its cost is a flat 0.05/tick, so it
  is always worth buying at this food level. A convex cost (or a cost that scales with
  intake) would make it a genuine fork. Every other trait is properly constrained.
- `hue` is genuinely neutral, so it drifts; it is a lineage marker, not an adaptation.
- The 3×3 attack range and 9-cell sense neighbourhood are Chebyshev, so "distance" is
  square-ish. Fine here, wrong if you ever care about geometry.
- `max_pop` is a runtime guard, not ecology: a run that hits it is an artefact, and the
  sweep score penalises it rather than pretending it is a bloom.
- No dispersal kernel, no age structure, no sex. Each of those is a real model change, not
  a parameter.
