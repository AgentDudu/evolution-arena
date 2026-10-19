# Roadmap

Ranked by impressiveness, defined as **how much a skeptical reader's estimate of this
project moves, per hour of work**. Not ranked by difficulty.

Every claim below was checked against the tree at `d2767bb`, with `file:line`.

## Summary

| # | gap | kind | cost | why it moves the needle |
|---|---|---|---|---|
| 1 | Every headline number is n=1 | both | ~1 day | decides whether the science is *true*; nothing above it survives without it |
| 2 | The patchiness claim is inverted by its own control | theoretical | ~2 days | a well-handled negative result beats a padded positive one |
| 3 | No neutral null | theoretical | ~1 day | the difference between "diversity 2.04" and "diversity 0.4 above drift" |
| 4 | Diversity is a histogram statistic, not an evolutionary one | theoretical | ~2 days | the lineage forest is already recorded and unused |
| 5 | No contingency experiment | theoretical | ~3 days | the most impressive single result available, and the machinery already exists |
| 6 | No CI, nothing pinned | technical | ~2 h | the goldens and parity contract can rot silently today |
| 7 | `scipy`/`numpy` undeclared, no `LICENSE` | technical | ~10 min | gates anyone reusing it |
| 8 | `state()` has no format version | technical | ~30 min | save/resume is a headline feature with no guard |
| 9 | Lineage view is not reproducible | technical | ~30 min | blocks sharing a screenshot of a result |
| 10 | 2.7 MB per 4000-tick artifact | technical | ~1 day | reach: lets people email longer runs |
| 11 | Canvas-only output | technical | ~1 day | reach: the artifact is the deliverable and is unreadable without sight |
| 12 | Playback repaints ~5 times a second, whatever you set | technical | **live done**; +1 day baked | the difference between *alive* and *a toy*; predation was invisible by construction |

---

## 1. Every headline number is n=1

**Evidence.** `evo/controls.py:26` is `def run(name, over, seed=1)` and `main()` calls it
once per row, returning `np.mean` over the tail window (`controls.py:38`). One seed, one
run, no spread. The README table (`README.md:200`) therefore has no error bars, and
`README.md:217` concludes "spatial patchiness costs *nothing at all* in diversity
(2.06 vs 2.04)" from two single draws.

`README.md:233` rests on "paired cell-by-cell predation wins 7 of 9". As a sign test that is
**one-sided p = 0.090, two-sided p = 0.180**. Eight of nine would have been p = 0.020. The
cells also come from one parameter grid, so they are not independent draws either.

**Do.** `evo/sweep.py` already accepts `--seeds N` (`sweep.py:106`) and builds
`args.seed + s` jobs (`sweep.py:117`) — but then sorts and prints every run as its own row
(`sweep.py:129`), so multiple seeds are never aggregated. Aggregate per cell: mean, sd, and
for paired comparisons the per-seed difference. Add `--seeds 5` to `controls.py` and put
`±` in the README table.

**Unlocks.** Nothing else on this list is worth believing until this exists. It is also the
cheapest way to look rigorous: a table with error bars reads as a different class of work.

## 2. The patchiness claim is inverted by its own control

**Evidence.** The model's stated mechanism is that spatial fertility patches maintain
diversity. `evo/sim.py:140` admits it in a comment: "patchiness removed, diversity only
falls 1.99 → 1.82". `flat` scores 2.06 against `arms_race` 2.04 (`README.md:200`). The
control built to prove the mechanism matters currently scores *higher* than the model.

**Do.** Three honest branches, in order of preference:
1. Find the regime where patchiness *does* matter and characterise it — patch size and
   dispersal distance are the obvious axes, and a phase diagram is a real result.
2. Show the mechanism is redundant rather than false: patches and predation as substitutes
   for the same coexistence mechanism. Then the negative control is the finding.
3. Say it does not work, and keep the model as a predation-only diversity driver.

**Unlocks.** Handling a failed prediction in public is the most impressive thing on this
list to a working researcher, and the least impressive thing to fake.

## 3. No neutral null

**Evidence.** Presets are `ancestral eden famine arms_race mutagenic peaceful flat`.
`peaceful` removes predation and `flat` removes patches, but both still run full selection
and inheritance. There is no world where traits stop mattering, so there is no baseline for
"diversity 2.04" other than other evolved worlds.

**Do.** A zero-sum neutral world: offspring replace a random resident, offspring inherit
traits with `mutation=0` and no trait-dependent survival. Then report observed diversity
minus neutral diversity at matched population size. This is the standard move in diversity
ecology and it is one preset plus one column.

**Unlocks.** Turns every diversity number from a magnitude into an effect size. Cheap, and
it is the single change that makes the project legible to an ecologist.

## 4. Diversity is a histogram statistic, not an evolutionary one

**Evidence.** `evo/sim.py:406` — Shannon diversity over a 4×4 bin grid on (size, speed),
ceiling `ln 16 = 2.77` (`README.md:99`). So the headline metric is bin evenness in a coarse
histogram: it depends on arbitrary bin edges, saturates, and cannot distinguish one
genotype sweeping with noise from two genuinely coexisting morphs.

Meanwhile the full lineage forest is recorded and only ever drawn, never measured —
`LIN.parent` is walked in `evo/dashboard.html:445` purely to lay out the tree.

**Do.** Compute from data that already exists:
- lineage coexistence — how many distinct root-to-tip lineages survive to the end;
- trait-space mode separation — a bimodality index over (size, speed), which is what the UI
  already asserts visually at `dashboard.html:120` ("splitting bands are a population
  dividing into herbivores and predators") without ever testing;
- report the Shannon index at several bin counts so the binning is visibly not load-bearing.

**Unlocks.** Lets the dashboard claim lineages split and persist, which is an evolutionary
statement, instead of implying it from a histogram shape.

## 5. No contingency experiment

**Evidence.** The sim is deterministic per seed (`tests/test_sim.py` asserts it), save/resume
is exact, and `--resume` exists (`run.py:174` of the README usage). Nothing uses those
properties scientifically.

**Do.** The tape-of-life replay: take the ancestor at tick T from one saved state, resume N
independent seeds from it, and measure how far apart the endpoints land — diversity, size
polymorphism, lineage depth, and how many of the founding lineages survive. Report both the
spread and how it compares to seeds started from scratch.

**Unlocks.** A direct answer to "is this evolution repeatable or historical", which is the
question laypeople and biologists both recognise, and it is answerable here because the
state is exactly reproducible. Most impressive single result available; only ranked fifth
because it is meaningless before #1 exists.

## 6. No CI, nothing pinned

**Evidence.** No `.github/`. No `pyproject.toml`, `requirements.txt`, or `environment.yml`.
The four gates (`README.md:181-186`) run only when remembered.

This is not cosmetic here: the parity contract depends on float behaviour, and the README
records that `scipy.ndimage.uniform_filter`'s integer path once disagreed with its own float
path (`README.md:278-283`). A numpy or scipy bump can move goldens and parity with no code
change and no failing test.

**Do.** One Actions workflow on `push`/`pull_request`: install pinned deps, run the four
gates against freshly emitted artifacts. Pin `numpy`/`scipy` to what is known good. Record
the versions in the artifact `#meta` line so a bad HTML file is diagnosable.

## 7. Undeclared dependencies and no licence

**Evidence.** `scipy` is imported in the core model (`evo/sim.py:25`); `numpy` in
`evo/controls.py`. Neither is declared anywhere. Public repo, no `LICENSE` → all rights
reserved by default.

**Do.** `pyproject.toml` with `numpy`/`scipy`, plus a permissive licence. Ten minutes, and
until it exists the README's opening command is a broken promise.

## 8. `state()` has no format version

**Evidence.** `evo/run.py:196` writes `json.dump(w.state(), f)` with no schema or version
key, and `--resume` reads it back. The invariants assert save/resume is exact *today*; a
field rename later produces a silently wrong resumed world, or a crash three thousand ticks
in.

**Do.** A `"format": 1` key, refuse to resume across versions, and one test that a v1 state
still loads.

## 9. The lineage view is not reproducible

**Evidence.** `evo/dashboard.html:454` — `layoutTree` shuffles tips with `Math.random()` to
pick which subset to draw. So the same artifact shows a different tree on every re-layout,
and on the live page it reshuffles whenever the sliding window trims. The render harness
seeds `Math.random` to make its own tape stable; that is a workaround, not a fix.

**Do.** Seed the subsample deterministically from the data (or take a fixed stride), so a
given artifact always shows the same tree. Then a screenshot is evidence.

## 10. Artifact size

**Evidence.** 4000 ticks emits 2.71 MB of HTML (`out/arms.html`), roughly linear in ticks,
because frames are hex-encoded trait arrays.

**Do.** Quantise traits to one byte per channel and delta-encode frames. The design goal is
a single emailable file, so this is a feature, not optimisation.

## 11. Canvas-only output

**Evidence.** Every result is a `<canvas>`; the text surfaces are `#readout` and `#lstats`.
No CSV export, no text alternative, no keyboard path to the scrubber.

**Do.** A "download frames as CSV" button off data already in `TRACE`, and an `aria-label`
summary per canvas. Both are small and both widen who can use the thing.

## 12. Playback repaints about five times a second — whatever you set

**Status: Phase 1 shipped (live mode). Phase 2 (baked replay) open, gated on #10.**

**Cost: ~1 day live mode, +1 day for the baked replay.**

### Diagnosis: the fps control cannot fix this

The world canvas does not draw the world. It draws a **snapshot**, and snapshots are taken
every 50 ticks (`--snap-every 50`, `run.py:127`). Live mode steps the real world `tpf`
times per animation frame but pushes a snapshot only every 50 ticks (`dashboard.html:626`),
then paints `frame(cur)` (`:637`) — the photograph, not the world.

Picture updates per second = `60 × ticks_per_frame ÷ 50`:

| `--steps` | ticks/s | **picture updates/s** |
|---|---|---|
| 1 | 60 | 1.2 |
| 4 (default) | 240 | **4.8** |
| 12 | 720 | 14.4 |
| 30 | 1800 | 36 |

Raising the rate does not smooth it — it makes each 50-tick jump land sooner. The instinct
that this is "not the fps config thing" is correct.

Two things compound it:

- **Positions are cell indices.** `Org.cell` is one integer (`sim.py:125`) and circles are
  drawn at cell centres, `x=(cell%W)*sz+sz/2` (`dashboard.html:310`). With `sz = 512/64`
  = 8px and `MAX_STEPS = 3`, a fast organism teleports up to 24px per tick. There is no
  sub-cell position to interpolate because the model has none.
- **Every organism in a cell is drawn at the identical point.** Predator and prey in one
  cell are two concentric circles. Predation is not just fast — it is *invisible by
  construction*.

And `--snap-cap 1000` samples at most 1000 organisms per frame, so above that density the
replay silently drops organisms, including the ones being eaten.

### Phase 1 — live mode (cheap, and most of the feel)

The live page owns a real `World`, so it can paint the truth every frame instead of a
50-tick-old photograph.

1. **Paint from the world, not from `SN`.** Build the frame from `w.orgs` when live; keep
   `frame(cur)` for scrubbing and for the baked page. Charts stay on the 50-tick cadence —
   they do not need 60 Hz and already throttle to 5 Hz.
2. **Deterministic sub-cell offsets.** Hash the organism id into an offset inside its cell,
   stable per organism so it does not shimmer. Co-located organisms separate, and a
   predator sitting on prey becomes visibly *on* it.
3. **Interpolate.** Keep each organism's previous cell and lerp cell→cell at display rate,
   so a 3-cell move is a glide. Splitting the tick clock from the paint clock *is* the
   agar.io trick — smoothness and slowness then become the same knob.
4. **Slow it down.** Default ~1 tick per 2–3 painted frames (~20–30 ticks/s) instead of
   240 ticks/s.
5. **Make predation an event.** The sim knows who ate whom; the renderer never sees it.
   Record `(cell, tick)` per kill — a handful per tick — and draw a fading ring, or a brief
   line eater→eaten. Without this, slowing down shows smooth circles overlapping rather
   than smooth circles *eating*.

Science impact: **none.** Model untouched; goldens, parity and the 13 invariants stay green.

**Shipped, and the decisions that shaped it.** Live page only, render-only, kill rings —
chosen deliberately over a model change and over fixing the baked file.

- `evo/web/sim.js` — `_kill` records the cell of anything eaten into `world.kills`, which the
  renderer drains. Draw-only: it never reaches `state()` or the trace, so parity is untouched.
- `evo/dashboard.html` — `liveFrame(w)` builds a frame carrying organism **ids** plus each
  one's previous cell. `drawWorld` interpolates prev→current by `U` and adds a stable
  per-id sub-cell offset. The live loop now runs two clocks: ticks at `ticks/s` (15 default,
  was 240), paint every animation frame, drawn one tick behind. `--steps` is still offered in
  the select, converted to ticks/s, but no longer sets the opening rate.
- Gated, not eyeballed: `tools/render_check.js` now asserts the live loop paints *between*
  ticks, that the live frame carries ids and previous cells, that kill rings actually reach
  the renderer, and that the ticks/s control opens at 15 while keeping `--steps` reachable.
  The pump is 400 frames because predation starts at tick 285 in `arms_race` seed 1 — a
  shorter pump passes for the wrong reason.
- Proof the baked artifact did not move: `tests/golden/render/arms.json` is unchanged and
  `out/arms.html` still draws the blessed tape, including the `world` canvas. The live tape
  was re-blessed and reproduces across runs.

### Phase 2 — the baked replay (gated on #10)

A smooth standalone file needs ~1-tick frames, and 50× the frames at today's hex encoding
is not survivable: 4000 ticks × ~34KB ≈ 135MB against the current 2.71MB. Byte-quantised
positions plus delta-encoding against the previous frame (only moved organisms differ) is
the route — which is exactly #10, so #10 stops being housekeeping and becomes the thing
standing between you and a smooth shareable file.

Interim, and arguably the better answer: **the smooth experience is the live page; the baked
file stays a chart-and-snapshot artifact.** After Phase 1, `python -m evo.run --live` has
everything it needs.

### The decision that was made, and the one still open

Sub-cell offsets and lerp are a *render* lie: the model really is a cellular automaton, and
interpolating implies a path between cells that was never simulated. Accepted knowingly — it
buys the feel and costs nothing scientific.

Still open: if you want predation to be a spatial *event* — a radius check, a chase, an
escape — that belongs in the model, with organisms carrying `(x, y)` floats instead of a cell
index. That is not a renderer change: the density fields, the box filter, the toroidal
candidate neighbourhood (`sim.py:168`) and all of `tests/test_sim.py` assume cells. It would
be a better simulation and a different paper, and it invalidates the goldens and the parity
harness. Worth choosing deliberately, not falling into as an animation fix.

---

## If doing only three

1. **#1 variance** — nothing else is believable without it.
2. **#3 neutral null** — one preset, converts magnitudes into effect sizes.
3. **#6 CI + pins** — two hours, and it is what stops the existing gates from quietly
   decaying.

#2 and #5 are the impressive ones but each needs a real thinking session; #1, #3, #6 are
afternoon work that changes what the README is allowed to say.

**#12 is the exception to the list above.** It buys no scientific credibility at all, but it
is the one that decides whether a first-time viewer believes the thing is alive — and Phase
1 cannot break a result, because it touches no model code.

## Deliberately not planned

- **A browser-based e2e render test.** The tape gate plus the SVG contact sheet already cover
  geometry, colour, and (by eye, confirmed against `out/arms.html`) fidelity. Playwright is a
  ~100 MB dependency for a marginal gain over what exists.
- **Rewriting the sim in one vectorised step or on GPU.** Nothing measured says the model is
  too slow; the artifact size (#10) is the actual bottleneck.
- **More charts.** The dashboard has 15 canvases and the metrics underneath are the weak
  part (#4).
