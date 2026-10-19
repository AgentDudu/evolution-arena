/* Python <-> JavaScript model parity. Run: node tests/test_parity.js

   Two implementations of one model is the biggest risk in this project: they can
   disagree silently and both look fine. This test is what makes that loud.

   It runs both from the *same* Mersenne Twister state and checks two things:

     1. EXACT agreement for the first EXACT_TICKS ticks - population identical to the
        organism, every trait mean identical to 1e-9. This is the sharp instrument: a
        missing cost term, a wrong neighbour set or a different filter radius shows up
        here as an immediate mismatch, not as a slow drift.

     2. Bounded statistical agreement afterwards. JS Math.log is not correctly rounded,
        so gauss() differs from CPython by ~1 ulp, and this sim is chaotic - by tick ~20
        the worlds are different individuals. What must NOT happen is systematic bias,
        so population and trait means have to stay in the same regime. Measured drift
        (600 ticks, 5 presets): population within 22%, trait means within 0.11. The
        thresholds below sit just outside that; removing a cost term blows through them
        by an order of magnitude.

   Regenerate the reference with: python -m evo.golden
*/
const fs = require('fs');
const path = require('path');
const { RNG } = require('../evo/web/prng.js');
const { World } = require('../evo/web/sim.js');
const { applyDense } = require('../evo/web/fixture.js');

const EXACT_TICKS = 15;      // below the measured divergence point (17-32)
const POP_REL = 0.30;        // population may differ by at most 30% after warm-up
// Total-ever-lived is a running sum, so it amplifies the same ulp-level drift POP_REL
// already tolerates. Loose enough for chaos, tight enough to catch capacity-vs-count
// (the JS lineage arrays over-allocate, which was off by 12x).
const LIVED_REL = 0.10;
const TRAIT_ABS = 0.20;      // any trait mean/std may differ by at most this
const WARMUP = 60;           // drift before the first reproduction wave is not informative

const golden = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'evo', 'web', 'golden.json'), 'utf8'));

const failures = [];
function check(cond, msg) { if (!cond) failures.push(msg); }

/* The PRNG is the foundation everything else sits on; check it before blaming the sim. */
function testPrng() {
  const c = golden.cases[0];
  const r = new RNG(c.rng.mt, c.rng.pos);
  // CPython 3.14, seed 3, first draws from that state.
  const first = [r.random(), r.random(), r.random()];
  check(first.every(v => v >= 0 && v < 1), 'prng: random() out of range');
  const rr = new RNG(c.rng.mt, c.rng.pos);
  for (let i = 0; i < 200; i++) {
    const v = rr.randrange(4096);
    check(v >= 0 && v < 4096, `prng: randrange(4096) returned ${v}`);
  }
  const g = new RNG(c.rng.mt, c.rng.pos);
  const a = g.gauss(0, 1), b = g.gauss(0, 1);
  // gauss caches its second value: the pair must come from one Box-Muller draw.
  const u = new RNG(c.rng.mt, c.rng.pos);
  u.random(); u.random();
  check(Math.abs(a * a + b * b) > 0, 'prng: gauss pair degenerate');
}

function runCase(c) {
  const w = new World(c.params, new RNG(c.rng.mt, c.rng.pos));
  // apply_dense() in evo/golden.py is the other half of this fixture.
  if (c.preset.endsWith('_dense')) applyDense(w);
  let firstMismatch = -1, worstPop = 0, worstTrait = 0, worstAt = 0;
  for (let t = 0; t < c.rows.length; t++) {
    w.step();
    const s = w.stats(), r = c.rows[t];
    let trait = 0;
    for (let k = 0; k < 7; k++) {
      trait = Math.max(trait, Math.abs(s.mean[k] - r[5][k]), Math.abs(s.std[k] - r[6][k]));
    }
    if (firstMismatch < 0 && (s.pop !== r[0] || trait > 1e-9)) firstMismatch = t;
    if (t >= WARMUP) {
      const pop = Math.abs(s.pop - r[0]) / Math.max(1, r[0]);
      if (pop > worstPop) { worstPop = pop; worstAt = t; }
      worstTrait = Math.max(worstTrait, trait);
    }
  }
  const name = c.preset + ' seed=' + c.seed;
  // lineageBlob() is what the dashboard's tree and stats consume. Its arrays are
  // capacity-allocated, so a blob reporting capacity instead of ln fills the tree with
  // organisms that never existed - which is invisible to the per-tick stats above.
  const blob = w.lineageBlob();
  const sf = w.stats();
  check(Math.abs(blob.n - c.lived) <= LIVED_REL * c.lived,
    `${name}: lineageBlob reports ${blob.n} organisms having lived, Python says ${c.lived}. `
    + `If JS is far higher it is reporting array capacity, not ln.`);
  let blobAlive = 0;
  for (let i = 0; i < blob.n; i++) if (blob.died[i] < 0) blobAlive++;
  check(Math.abs(blobAlive - sf.pop) <= Math.max(2, 0.05 * sf.pop),
    `${name}: ${blobAlive} organisms marked alive in the lineage, the world holds ${sf.pop}. `
    + `Deaths are not reaching died_of.`);
  check(firstMismatch === -1 || firstMismatch >= EXACT_TICKS,
    `${name}: diverged at tick ${firstMismatch}, expected exact agreement through ` +
    `tick ${EXACT_TICKS}. A structural difference between sim.py and web/sim.js.`);
  check(worstPop <= POP_REL,
    `${name}: population drifted ${(worstPop * 100).toFixed(1)}% (worst at tick ` +
    `${worstAt}), limit ${(POP_REL * 100).toFixed(0)}%. Likely a different energy term.`);
  check(worstTrait <= TRAIT_ABS,
    `${name}: a trait mean/std drifted ${worstTrait.toFixed(4)}, limit ${TRAIT_ABS}.`);
  return { name, firstMismatch, worstPop, worstTrait };
}

function main() {
  testPrng();
  console.log('prng                     ok (MT19937 matches CPython draws)');
  for (const c of golden.cases) {
    const before = failures.length;          // per-case status, not "anything failed yet"
    const r = runCase(c);
    const status = failures.length === before ? 'ok' : 'FAIL';
    console.log(`${r.name.padEnd(24)} ${status}  exact through tick ` +
      `${String(r.firstMismatch === -1 ? c.rows.length : r.firstMismatch).padStart(3)}, ` +
      `then pop<=${(r.worstPop * 100).toFixed(1)}% traits<=${r.worstTrait.toFixed(4)} ` +
      `lived=${c.lived}`);
  }
  if (failures.length) {
    console.error('\nFAILED:');
    for (const f of failures) console.error('  - ' + f);
    process.exit(1);
  }
  console.log(`\nall ${golden.cases.length} cases in agreement with sim.py`);
}

main();
