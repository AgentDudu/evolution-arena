/* CPython `random.Random` (Mersenne Twister MT19937) in JavaScript.

   The live browser sim and the Python sim must produce the *same* organisms from
   the same seed, or the cross-check test is worthless. That means matching not just
   the generator but the exact methods Python's sim calls: random(), randrange(n)
   (which is _randbelow_with_getrandbits) and gauss() (Box-Muller with a cached
   second value). Verified against CPython output in tests/test_parity.js. */
const N = 624, M = 397, MATRIX_A = 0x9908b0df, UPPER = 0x80000000, LOWER = 0x7fffffff;
const TWOPI = 6.283185307179586;

class RNG {
  /* state: the 624 words from CPython's getstate() (its 625th entry is the index).
     Seeding is deliberately NOT reimplemented - the golden test hands over Python's
     own state, which pins the generator itself rather than only its seeding. */
  constructor(state, idx = N) {
    this.mt = state instanceof Uint32Array ? state.slice() : Uint32Array.from(state);
    this.idx = idx;
    this.gaussNext = 0.0;
  }

  /* In-place twist. The three loops exist because mt[i+M] must not have been
     overwritten yet - a single loop with %N reads values it already clobbered. */
  word() {
    if (this.idx >= N) {
      const mt = this.mt;
      let i, y, n;
      for (i = 0; i < N - M; i++) {
        y = ((mt[i] & UPPER) | (mt[i + 1] & LOWER)) >>> 0;
        n = (mt[i + M] ^ (y >>> 1)) >>> 0;
        mt[i] = (y & 1) ? (n ^ MATRIX_A) >>> 0 : n;
      }
      for (; i < N - 1; i++) {
        y = ((mt[i] & UPPER) | (mt[i + 1] & LOWER)) >>> 0;
        n = (mt[i + (M - N)] ^ (y >>> 1)) >>> 0;
        mt[i] = (y & 1) ? (n ^ MATRIX_A) >>> 0 : n;
      }
      y = ((mt[N - 1] & UPPER) | (mt[0] & LOWER)) >>> 0;
      n = (mt[M - 1] ^ (y >>> 1)) >>> 0;
      mt[N - 1] = (y & 1) ? (n ^ MATRIX_A) >>> 0 : n;
      this.idx = 0;
    }
    /* Tempering is part of genrand_uint32, not a separate step - every Python
       method above is built on the tempered word. */
    let y = this.mt[this.idx++];
    y ^= y >>> 11;
    y = (y ^ ((y << 7) & 0x9d2c5680)) >>> 0;
    y = (y ^ ((y << 15) & 0xefc60000)) >>> 0;
    return (y ^ (y >>> 18)) >>> 0;
  }

  /* Python: ((a>>5)*67108864.0 + (b>>6)) / 9007199254740992.0 */
  random() {
    const a = this.word() >>> 5, b = this.word() >>> 6;
    return (a * 67108864.0 + b) / 9007199254740992.0;
  }

  /* Python: getrandbits(k) for k <= 32 is genrand_uint32() >> (32 - k) */
  bits(k) {
    return this.word() >>> (32 - k);
  }

  /* Python: _randbelow_with_getrandbits(n) - rejection sampling on bit_length(n). */
  randrange(n) {
    let k = 0, t = n;
    while (t > 0) { k++; t >>>= 1; }
    let r = this.bits(k);
    while (r >= n) r = this.bits(k);
    return r;
  }

  /* Python's random_gauss: Box-Muller, second value cached in gauss_next. */
  gauss(mu, sigma) {
    let z = this.gaussNext;
    if (z !== 0.0) {
      this.gaussNext = 0.0;
    } else {
      const u1 = this.random(), u2 = this.random();
      const r = Math.sqrt(-2.0 * Math.log(1.0 - u2));
      const theta = TWOPI * u1;
      this.gaussNext = r * Math.sin(theta);
      z = r * Math.cos(theta);
    }
    return mu + sigma * z;
  }
}

if (typeof module !== 'undefined') module.exports = { RNG };
