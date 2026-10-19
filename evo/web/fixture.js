/* A hand-built crowded world, used only by tests/test_parity.js.

   At natural density the 3x3 crowding gate and the prey-density fields are both zero
   for the first dozen ticks, so a trajectory comparison cannot see whether predation
   and hunt/flee steering are implemented correctly - dropping either passes. This
   fixture packs organisms into one 3x3 block so both paths definitely fire, and is
   mirrored by apply_dense() in evo/golden.py. Neither uses randomness, so the MT state
   from construction still pins the run. */
function applyDense(w) {
  const n = Math.min(40, w.n);
  for (let i = 0; i < n; i++) {
    const s = w.list[i];
    w.cell[s] = (i % 3) + ((i / 3) | 0) % 3 * w.w;   // all inside one 3x3 block
    w.g[0][s] = 0.0;                                  // speed 0: no random steps
    w.g[2][s] = i / 40;                               // a spread of size classes
    w.g[4][s] = 0.5;
    w.e[s] = 30.0;                                    // above repro threshold
    w.age[s] = 0;
    w._derive(s);
  }
  return n;
}

if (typeof module !== 'undefined') module.exports = { applyDense };
