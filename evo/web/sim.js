/* Live evolution arena - JavaScript port of evo/sim.py.

   Same model, same trade-off table, same numbers. The Python version stays the
   reference (it is shorter and does the sweeps); this one exists so the browser can
   run 60fps without a server. tests/test_parity.js runs both from one seed and fails
   if they drift, which is the only thing keeping two implementations honest.

   Layout is structure-of-arrays over a recycled slot pool. That is not a micro-
   optimisation: an array of 4000 objects is 4000 allocations the GC eventually stops
   the frame for, and a single pause is what makes a live sim feel bad.

   NOTE: a JS `seed` is not the same world as a Python seed with the same number -
   CPython 3.14's seeding is its own thing and is not reimplemented here. Seeds are
   reproducible within JS; cross-language runs are pinned by passing an MT state. */

const TRAITS = ['speed', 'sense', 'size', 'metabolism', 'repro', 'lifespan', 'hue'];
const NG = TRAITS.length;                      // same order as sim.py TRAITS
const SENSE_RADII = [1, 3, 5];
const MAX_STEPS = 3;
// (dx, dy), self first - same order as sim.py DIRS, so cand[] matches cell for cell.
const DIR_DX = [0, 1, -1, 0, 0, 1, 1, -1, -1];
const DIR_DY = [0, 0, 0, 1, -1, 1, -1, 1, -1];
const DEATH = ['', 'starved', 'age', 'eaten'];

function defaults() {
  return {
    w: 64, h: 64, n0: 100, seed: 1,
    food_regrow: 0.05, food_cap: 1.0, bite: 0.5, fertility_patchiness: 0.8,
    base_burn: 0.06,
    cost: [0.05, 0.045, 0.10, 0.05, 0.015, 0.01, 0.0],
    move_cost: 0.012,
    cap0: 38.0, cap1: 14.0, repro0: 22.0, repro1: 14.0, split: 0.45,
    age0: 250.0, age1: 1000.0,
    mut_rate: 0.15, mut_sigma: 0.08,
    predation: true, attack_gap: 0.08, attack_cost: 0.06, attack_yield: 0.6,
    carnivory: 0.6, hunt_weight: 1.5, flee_weight: 1.5,
    max_pop: 4000,
  };
}

const PRESETS = {
  ancestral: { food_regrow: 0.05, mut_sigma: 0.08, predation: true, fertility_patchiness: 0.8 },
  eden:      { food_regrow: 0.18, mut_sigma: 0.08, predation: true, fertility_patchiness: 0.4 },
  famine:    { food_regrow: 0.018, mut_sigma: 0.08, predation: true, fertility_patchiness: 1.0 },
  arms_race: { food_regrow: 0.07, mut_sigma: 0.10, predation: true, attack_gap: 0.04, fertility_patchiness: 0.6 },
  mutagenic: { food_regrow: 0.07, mut_sigma: 0.25, predation: true, fertility_patchiness: 0.8 },
  peaceful:  { food_regrow: 0.05, mut_sigma: 0.08, predation: false, fertility_patchiness: 0.8 },
  flat:      { food_regrow: 0.05, mut_sigma: 0.08, predation: true, fertility_patchiness: 0.0 },
};

function preset(name, over) {
  if (!(name in PRESETS)) throw new Error('unknown preset ' + name);
  return Object.assign(defaults(), PRESETS[name], over || {});
}

/* Separable box blur with wrap edges == scipy uniform_filter(size=2r+1, mode='wrap').
   Running sums, not a per-cell window sum: 4096 cells x 11 taps x 6 fields per tick is
   the difference between 0.1ms and 1ms. The add/remove cursors wrap without a modulo. */
/* Separable wrap-around box filter. Returns the SUM over the window; boxBlur is the mean.
   Keeping the sum available is not an optimisation: scipy's uniform_filter keeps the input
   dtype, so for an integer input it truncates an exact integer running sum. Reproducing
   that with `Math.floor(blurMean)` is wrong twice over - the mean is `sum * (1/area)`,
   which is inexact, so an exact integer quotient can floor one too low, and round-off can
   leave a value like -1e-16 that floors to -1 (which is how "no prey here" became
   "prey = -1" and inverted hunt/flee steering into repulsion). `Math.floor(sum / area)`
   is exact: IEEE division is correctly rounded, and a non-multiple of area is at least
   1/area away from the next integer, far more than one ulp.
   Safe to alias src === dst. Do NOT alias tmp === src (the row pass would eat the input). */
function boxSum(src, dst, tmp, w, h, r) {
  const win = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0, add = (r + 1) % w, rem = (w - r) % w;
    for (let k = 0; k < win; k++) sum += src[row + ((k - r + w) % w)];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = sum;
      sum += src[row + add] - src[row + rem];
      if (++add === w) add = 0;
      if (++rem === w) rem = 0;
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0, add = (r + 1) % h, rem = (h - r) % h;
    for (let k = 0; k < win; k++) sum += tmp[((k - r + h) % h) * w + x];
    for (let y = 0; y < h; y++) {
      dst[y * w + x] = sum;
      sum += tmp[add * w + x] - tmp[rem * w + x];
      if (++add === h) add = 0;
      if (++rem === h) rem = 0;
    }
  }
  return win * win;   // the 2-D window area; boxSum leaves area-sums in dst
}

function boxBlur(src, dst, tmp, w, h, r) {
  const area = boxSum(src, dst, tmp, w, h, r), inv = 1.0 / area;
  const n = w * h;
  for (let i = 0; i < n; i++) dst[i] *= inv;
}

/* uniform_filter over an integer array, i.e. trunc(mean) - what sim.py actually sees. */
function boxTruncMean(src, dst, tmp, w, h, r) {
  const area = boxSum(src, dst, tmp, w, h, r);
  const n = w * h;
  for (let i = 0; i < n; i++) dst[i] = Math.floor(dst[i] / area);
}

class World {
  constructor(p, rng) {
    p = p || defaults();
    this.p = p;
    this.rng = rng;
    const w = p.w, h = p.h, n = w * h;
    this.w = w; this.h = h; this.nCells = n;

    // Persistent fertility patches, smoothed once at birth.
    const raw = new Float64Array(n);
    for (let i = 0; i < n; i++) raw[i] = rng.random();
    const fert = new Float64Array(n), tmp = new Float64Array(n);
    boxBlur(raw, fert, tmp, w, h, 2);
    let mean = 0;
    for (let i = 0; i < n; i++) mean += fert[i];
    mean /= n;
    this.fertility = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      this.fertility[i] = 1.0 + p.fertility_patchiness * (fert[i] / mean - 1.0);
    }

    this.food = new Float64Array(n);
    for (let i = 0; i < n; i++) this.food[i] = Math.min(rng.random(), p.food_cap);

    // cand[cell*9 + k] = the 9 cells within Chebyshev distance 1, self first.
    const cand = new Int32Array(n * 9);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const base = (y * w + x) * 9;
        for (let k = 0; k < 9; k++) {
          cand[base + k] = (((y + DIR_DY[k]) % h) + h) % h * w + ((((x + DIR_DX[k]) % w) + w) % w);
        }
      }
    }
    this.cand = cand;

    // scratch buffers, allocated once
    this.fields = SENSE_RADII.map(() => new Float64Array(n));
    this.prey = SENSE_RADII.map(() => new Float64Array(n));
    this._blurTmp = new Float64Array(n);
    this._clsCount = new Int32Array(n);
    this._counts = new Int32Array(n);
    this._offsets = new Int32Array(n + 1);
    this._near = new Float64Array(n);
    this._nearInt = new Float64Array(n);
    this._taken = new Float64Array(n);
    this._order = new Int32Array(p.max_pop);
    this._fieldTmp = new Float64Array(n);
    this._cursor = new Int32Array(n);
    this._perClass = [new Int32Array(p.max_pop), new Int32Array(p.max_pop), new Int32Array(p.max_pop)];

    // ---- organism pool (structure of arrays over recycled slots) ----
    const cap = p.max_pop + 64;
    this.cap = cap;
    const F = () => new Float64Array(cap), I = () => new Int32Array(cap);
    this.oid = I(); this.cell = I(); this.e = F(); this.age = F(); this.parent = I();
    this.g = []; for (let i = 0; i < NG; i++) this.g.push(F());
    this.bcost = F(); this.capy = F(); this.rthresh = F(); this.mage = F();
    this.gi = I(); this.cls = I();
    this.wf = F(); this.hunt = F(); this.flee = F(); this.peff = F();
    this.free = I(); this.nFree = 0;
    for (let i = cap - 1; i >= 0; i--) this.free[this.nFree++] = i;
    this.list = I();          // live slots, in the order sim.py keeps self.orgs
    this.n = 0;

    // ---- lineage, append-only, indexed by organism id ----
    this.ln = 0; this.lCap = 0;
    this._growLineage(4096);

    this.tick = 0; this.nextId = 0;
    this.births = 0; this.deathsAlive = 0;
    this.dStarved = 0; this.dAge = 0; this.eaten = 0;
    this.newborn = new Int32Array(cap); this.newbornParent = new Int32Array(cap);
    this.nNew = 0;
    this._seen = [0, 0, 0];

    for (let i = 0; i < p.n0; i++) {
      const g = [];
      for (let k = 0; k < NG; k++) g.push(rng.random());
      this._spawn(g, -1, rng.randrange(n));
    }
  }

  _growLineage(min) {
    const cap = Math.max(min, this.lCap * 2 || 0);
    const copy = (old, arr) => arr.set(old.subarray(0, this.ln));
    const parent = new Int32Array(cap), born = new Int32Array(cap),
          died = new Int32Array(cap), hue = new Float64Array(cap),
          size = new Float64Array(cap), deaths = new Uint8Array(cap);
    if (this.parent_of) {
      copy(this.parent_of, parent); copy(this.born_of, born); copy(this.died_of, died);
      copy(this.hue_of, hue); copy(this.size_of, size); copy(this.deaths_of, deaths);
    } else {
      died.fill(-1);
    }
    this.parent_of = parent; this.born_of = born; this.died_of = died;
    this.hue_of = hue; this.size_of = size; this.deaths_of = deaths;
    this.lCap = cap;
  }

  /* Genome -> the ten numbers the tick loop reads. This is the trade-off table;
     every line is a rule of the world. Mirrors World.derive in sim.py line for line. */
  _derive(slot) {
    const p = this.p, g0 = this.g[0][slot], g1 = this.g[1][slot], g2 = this.g[2][slot],
          g3 = this.g[3][slot], g4 = this.g[4][slot], g5 = this.g[5][slot],
          g6 = this.g[6][slot], c = p.cost;
    this.bcost[slot] = p.base_burn + c[0] * g0 + c[1] * g1 + c[2] * g2 * g2
      + c[3] * g3 + c[4] * g4 + c[5] * g5 + c[6] * g6;
    this.capy[slot] = p.cap0 + p.cap1 * g2;
    this.rthresh[slot] = p.repro0 + p.repro1 * g4;
    this.mage[slot] = p.age0 + p.age1 * g5;
    this.gi[slot] = Math.min(SENSE_RADII.length - 1, (g1 * SENSE_RADII.length) | 0);
    this.wf[slot] = 0.3 + 2.0 * g1;
    this.cls[slot] = Math.min(2, (g2 * 3) | 0);
    this.hunt[slot] = p.hunt_weight * g2;
    this.flee[slot] = p.flee_weight * (1.0 - g2);
    this.peff[slot] = (0.35 + 0.65 * g3) * (1.0 - p.carnivory * g2);
  }

  _spawn(g, parent, cell) {
    const s = this.free[--this.nFree];
    const id = this.nextId++;
    this.oid[s] = id; this.cell[s] = cell;
    this.e[s] = 0.5 * (this.p.cap0 + this.p.cap1 * g[2]);
    this.age[s] = 0; this.parent[s] = parent;
    for (let k = 0; k < NG; k++) this.g[k][s] = g[k];
    this._derive(s);
    this.list[this.n++] = s;
    if (this.ln >= this.lCap) this._growLineage(this.lCap + 4096);
    const i = this.ln++;
    this.parent_of[i] = parent; this.hue_of[i] = g[6]; this.size_of[i] = g[2];
    this.born_of[i] = this.tick; this.died_of[i] = -1; this.deaths_of[i] = 0;
    return s;
  }

  _kill(s, code) {
    this.e[s] = -1.0;
    const i = this.oid[s];
    if (this.died_of[i] < 0) this.died_of[i] = this.tick;
    this.deaths_of[i] = code;
    if (code === 1) this.dStarved++; else if (code === 2) this.dAge++; else this.eaten++;
  }

  /* Group live slots by cell: members of c are _order[_offsets[c] .. +_counts[c]). */
  _index() {
    const n = this.n, nCells = this.nCells;
    if (!n) return false;
    const counts = this._counts;
    counts.fill(0);
    for (let i = 0; i < n; i++) counts[this.cell[this.list[i]]]++;
    const offs = this._offsets;
    let acc = 0;
    for (let c = 0; c < nCells; c++) { offs[c] = acc; acc += counts[c]; }
    offs[nCells] = acc;
    const cursor = this._cursor;   // write head per cell
    cursor.set(offs.subarray(0, nCells));
    // stable: iterate list order so ties keep their order, like np.argsort(kind=stable)
    for (let i = 0; i < n; i++) {
      const s = this.list[i];
      this._order[cursor[this.cell[s]]++] = s;
    }
    return true;
  }

  _senseFields() {
    const { w, h, nCells } = this;
    for (let k = 0; k < SENSE_RADII.length; k++) {
      boxBlur(this.food, this.fields[k], this._blurTmp, w, h, SENSE_RADII[k]);
    }
    const n = this.n;
    if (!n) {
      for (let c = 0; c < 3; c++) this.prey[c].fill(0);
      return;
    }
    const perClass = this._perClass, seen = this._seen;
    seen[0] = seen[1] = seen[2] = 0;
    for (let c = 0; c < 3; c++) this.prey[c].fill(0);
    for (let i = 0; i < n; i++) {
      const s = this.list[i], c = this.cls[s];
      this.prey[c][this.cell[s]] += 1.0;
    }
    // Truncation is not a simplification: the input is an integer bincount, so sim.py
    // sees trunc(mean_5x5) and steering is dead below 25 organisms in a 5x5 block.
    for (let c = 0; c < 3; c++) boxTruncMean(this.prey[c], this.prey[c], this._fieldTmp, w, h, 2);
  }

  step() {
    const p = this.p, r = this.rng, w = this.w, h = this.h, nCells = this.nCells;
    this.tick++;
    this.dStarved = 0; this.dAge = 0; this.eaten = 0;

    const food = this.food, regrow = p.food_regrow, cap = p.food_cap, fert = this.fertility;
    for (let i = 0; i < nCells; i++) {
      const v = food[i] + regrow * fert[i];
      food[i] = v > cap ? cap : v;
    }

    this._senseFields();
    const avail = food;                 // read-only during the tick; `taken` does the subtract
    const taken = this._taken;
    taken.fill(0);
    const cand = this.cand;
    const moveCost = p.move_cost;
    const list = this.list, n = this.n;

    // ---------- move ----------
    for (let i = 0; i < n; i++) {
      const s = list[i];
      const f = this.fields[this.gi[s]];
      const cls = this.cls[s];
      const hunt = this.hunt[s], flee = this.flee[s], wf = this.wf[s];
      const below = (hunt && cls) ? this.prey[cls - 1] : null;
      const above = (flee && cls < 2) ? this.prey[cls + 1] : null;
      let cell = this.cell[s], moved = 0;
      const speed = this.g[0][s];
      const steps = 1 + (r.random() < speed ? 1 : 0) + (r.random() < speed ? 1 : 0);
      for (let st = 0; st < steps; st++) {
        if (r.random() < 0.15) {
          cell = cand[cell * 9 + 1 + ((r.random() * 8) | 0)];
          moved++;
          continue;
        }
        let best = -1e18, bc = cell, base = cell * 9;
        for (let k = 0; k < 9; k++) {
          const c = cand[base + k];
          let sc = avail[c] + wf * f[c];
          if (below !== null) sc += hunt * below[c];
          if (above !== null) sc -= flee * above[c];
          if (sc > best) { best = sc; bc = c; }
        }
        if (bc !== cell) { cell = bc; moved++; }
      }
      if (moved) { this.cell[s] = cell; this.e[s] -= moveCost * moved; }
    }

    // ---------- eat, fight, age, reproduce ----------
    const indexed = this._index();
    // Must be the *sum* over the 3x3 block (mean x 9): gating on the max only fires
    // when two organisms already share a cell, which never happens at this density.
    let near = null;
    if (indexed) {
      const countsF = this._nearInt;
      for (let c = 0; c < nCells; c++) countsF[c] = this._counts[c];
      // trunc(mean_3x3) * 9, matching uniform_filter over an integer array. The gate
      // `near > 1` therefore really means "9 or more organisms in the 3x3", not "> 1".
      near = this._near;
      boxTruncMean(countsF, near, this._blurTmp, w, h, 1);
      for (let c = 0; c < nCells; c++) near[c] *= 9;
    }
    const newborn = this.newborn;
    let nNew = 0;
    const gap = p.attack_gap, bite = p.bite, acost = p.attack_cost, ayield = p.attack_yield;
    const predation = p.predation, offs = this._offsets, counts = this._counts,
          order = this._order;
    const pop = n;
    const mutRate = p.mut_rate, mutSigma = p.mut_sigma;
    const g0a = this.g[0], g2a = this.g[2], g3a = this.g[3];

    for (let i = 0; i < n; i++) {
      const s = list[i];
      if (this.e[s] <= 0) continue;              // already eaten this tick
      const sz = g2a[s];
      if (predation && indexed && near[this.cell[s]] > 1) {
        let qBest = -1, qE = 0.0, base = this.cell[s] * 9;
        for (let k = 0; k < 9; k++) {
          const c = cand[base + k];
          const end = offs[c] + counts[c];
          for (let j = offs[c]; j < end; j++) {
            const q = order[j];
            if (q !== s && this.e[q] > qE && this.e[q] > 0 && sz - g2a[q] > gap) {
              qBest = q; qE = this.e[q];
            }
          }
        }
        if (qBest >= 0) {
          this.e[s] -= acost;                    // a failed chase still costs
          if (r.random() < 0.5 + 0.5 * (g0a[s] - g0a[qBest])) {
            this.e[s] += ayield * this.e[qBest] * (0.5 + 0.5 * g3a[s]);
            this._kill(qBest, 3);
          }
        }
      }
      const cell = this.cell[s];
      const left = avail[cell] - taken[cell];
      if (left > 0) {
        const take = left < bite ? left : bite;
        taken[cell] += take;
        this.e[s] += take * this.peff[s];
      }
      this.e[s] -= this.bcost[s];
      this.age[s] += 1;
      if (this.e[s] < 0) {
        this._kill(s, 1);
      } else if (this.age[s] > this.mage[s]) {
        this._kill(s, 2);
      } else {
        if (this.e[s] > this.capy[s]) this.e[s] = this.capy[s];
        if (this.e[s] >= this.rthresh[s] && pop + nNew < p.max_pop) {
          const g2 = new Array(NG);
          for (let k = 0; k < NG; k++) {
            let v = this.g[k][s];
            if (r.random() < mutRate) {
              v = v + r.gauss(0.0, mutSigma);
              v = v > 1.0 ? 1.0 : (v < 0.0 ? 0.0 : v);
            }
            g2[k] = v;
          }
          const share = this.e[s] * p.split;
          this.e[s] = Math.min(this.e[s] - share, this.capy[s]);
          const nc = cand[cell * 9 + ((r.random() * 9) | 0)];
          newborn[nNew] = this._reserveSlot(g2, nc, share);
          this.newbornParent[nNew] = this.oid[s];
          nNew++;
        }
      }
    }

    for (let i = 0; i < nCells; i++) {
      const v = food[i] - taken[i];
      food[i] = v > 0 ? v : 0;
    }

    // Newborns were pushed into the pool already (they need slots to hold their
    // genome), but their lineage rows must be stamped after the parents'.
    for (let i = 0; i < nNew; i++) this._commitNewborn(newborn[i], this.newbornParent[i]);
    this.births = nNew;

    // ---------- die ----------
    // Must run over this.n (parents *plus* this tick's newborns), not the count captured
    // before the eat loop, or the newborns appended above are silently discarded.
    const total = this.n;
    let keep = 0;
    for (let i = 0; i < total; i++) {
      const s = list[i];
      if (this.e[s] > 0) {
        list[keep++] = s;
      } else {
        if (this.died_of[this.oid[s]] < 0) this._kill(s, 1);
        this.free[this.nFree++] = s;
      }
    }
    this.n = keep;
    this.deathsAlive = total - keep;
  }

  /* A newborn needs a slot immediately (its genome has to live somewhere) but must not
     join the live list or the lineage until every parent has been processed, or a child
     born this tick could be eaten by one. */
  _reserveSlot(g, cell, energy) {
    const s = this.free[--this.nFree];
    this.cell[s] = cell; this.e[s] = energy; this.age[s] = 0;
    for (let k = 0; k < NG; k++) this.g[k][s] = g[k];
    return s;
  }

  _commitNewborn(s, parentId) {
    const id = this.nextId++;
    this.oid[s] = id; this.parent[s] = parentId;
    this._derive(s);
    this.list[this.n++] = s;
    if (this.ln >= this.lCap) this._growLineage(this.lCap + 4096);
    const i = this.ln++;
    this.parent_of[i] = parentId; this.hue_of[i] = this.g[6][s];
    this.size_of[i] = this.g[2][s]; this.born_of[i] = this.tick;
    this.died_of[i] = -1; this.deaths_of[i] = 0;
  }

  stats() {
    const n = this.n;
    const s = {
      t: this.tick, pop: n, births: this.births, deaths: this.deathsAlive,
      d_starved: this.dStarved, d_age: this.dAge, d_eaten: this.eaten,
    };
    let foodSum = 0;
    for (let i = 0; i < this.nCells; i++) foodSum += this.food[i];
    s.food = Math.round(foodSum * 10) / 10;
    if (!n) {
      s.mean = [0, 0, 0, 0, 0, 0, 0]; s.std = [0, 0, 0, 0, 0, 0, 0];
      s.biomass = 0; s.energy = 0; s.div = 0; s.hue_div = 0;
      return s;
    }
    const mean = new Array(NG).fill(0);
    for (let k = 0; k < NG; k++) {
      const a = this.g[k];
      for (let i = 0; i < n; i++) mean[k] += a[this.list[i]];
      mean[k] /= n;
    }
    const std = mean.map(() => 0);
    for (let k = 0; k < NG; k++) {
      const a = this.g[k];
      let v = 0;
      for (let i = 0; i < n; i++) { const d = a[this.list[i]] - mean[k]; v += d * d; }
      std[k] = Math.sqrt(v / n);
    }
    let bio = 0;
    const bins = new Float64Array(16), hueBins = new Float64Array(8);
    for (let i = 0; i < n; i++) {
      const s2 = this.list[i];
      bio += this.e[s2];
      const sz = Math.min(0.999, Math.max(0, this.g[2][s2]));
      const sp = Math.min(0.999, Math.max(0, this.g[0][s2]));
      bins[((sz * 4) | 0) * 4 + ((sp * 4) | 0)]++;
      hueBins[((Math.min(0.999, Math.max(0, this.g[6][s2])) * 8) | 0)]++;
    }
    let div = 0;
    for (let b = 0; b < 16; b++) {
      if (bins[b] > 0) { const c = bins[b] / n; div -= c * Math.log(c); }
    }
    let hdiv = 0;
    for (let b = 0; b < 8; b++) {
      if (hueBins[b] > 0) { const c = hueBins[b] / n; hdiv -= c * Math.log(c); }
    }
    const r4 = (v) => Math.round(v * 10000) / 10000;
    s.mean = mean.map(r4); s.std = std.map(r4);
    s.biomass = Math.round(bio * 10) / 10;
    s.energy = Math.round((bio / n) * 100) / 100;
    s.div = r4(div); s.hue_div = r4(hdiv);
    return s;
  }

  /* Mirrors trace.lineage_blob so the dashboard's tree can read a running world.
     Refills the object it is handed, so the caller can keep one reference. JS already
     keeps the death cause as a numeric code, unlike sim.py's strings. */
  lineageBlob(o) {
    o = o || {n: 0, parent: [], hue: [], size: [], born: [], died: [], cause: []};
    const n = this.ln;          // capacity is over-allocated in blocks; ln is the real count
    const hue = new Uint8Array(n), size = new Uint8Array(n), cause = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      hue[i] = this.hue_of[i] * 255 | 0;
      size[i] = this.size_of[i] * 255 | 0;
      cause[i] = this.deaths_of[i];
    }
    o.n = n; o.parent = this.parent_of; o.born = this.born_of; o.died = this.died_of;
    o.hue = hue; o.size = size; o.cause = cause;
    return o;
  }

  /* Playback frame in the same packed shape as World.snapshot(), so the existing
     dashboard chart code can read a live world or a baked trace unchanged. */
  snapshot(capN, grid) {
    capN = capN || 1000; grid = grid || 16;
    const { w, h, n } = this;
    const fg = new Uint8Array(grid * grid);
    const bh = (h / grid) | 0, bw = (w / grid) | 0;
    for (let gy = 0; gy < grid; gy++) {
      for (let gx = 0; gx < grid; gx++) {
        let acc = 0;
        for (let y = 0; y < bh; y++) {
          for (let x = 0; x < bw; x++) acc += this.food[(gy * bh + y) * w + gx * bw + x];
        }
        fg[gy * grid + gx] = Math.min(255, (acc / (bh * bw)) * 255) | 0;
      }
    }
    const m = Math.min(n, capN);
    const cell = new Uint16Array(m), g = new Uint8Array(m * NG), e = new Uint8Array(m);
    for (let i = 0; i < m; i++) {
      const s = this.list[i];
      cell[i] = this.cell[s];
      for (let k = 0; k < NG; k++) g[i * NG + k] = Math.min(255, this.g[k][s] * 255) | 0;
      e[i] = Math.min(255, (this.e[s] / 55 * 255)) | 0;
    }
    return { t: this.tick, n: m, sampled: n > capN, fg, cell, g, e };
  }
}

if (typeof module !== 'undefined') {
  module.exports = { World, preset, defaults, PRESETS, boxBlur, boxSum, NG, DEATH, TRAITS };
}
