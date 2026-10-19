"""Emit the reference trace the JavaScript live sim is checked against.

    python -m evo.golden            # writes evo/web/golden.json
    node tests/test_parity.js       # checks the port against it

The world is built from an RNG whose state is dumped *before* construction, so JS can
start from the identical Mersenne Twister state. CPython 3.14's integer seeding is not
reimplemented in JS, so pinning the state is what pins the run - and it tests the
generator itself, not merely its seeding.

Agreement is exact for the first ~20 ticks and statistical afterwards: JS `Math.log`
is not correctly rounded, so `gauss` differs from CPython by ~1 ulp, and a chaotic sim
amplifies that. See tests/test_parity.js for the thresholds and why they are loose.
"""
from __future__ import annotations

import argparse
import json
import random

from .sim import World, preset

# Presets chosen to cover the interesting regimes, not just the pretty ones: predation
# on/off, famine, and a high-fertility world that amplifies float noise fastest.
CASES = [("arms_race", 3, 600), ("famine", 3, 600), ("eden", 3, 600),
         ("peaceful", 3, 600), ("mutagenic", 5, 300)]


def rng_state(seed: int):
    body = list(random.Random(seed).getstate()[1])
    # CPython appends the index as a 625th word rather than using the tuple's third slot.
    return {"mt": body[:624], "pos": body[624] if len(body) > 624 else 624}


def apply_dense(w: World, n: int = 40) -> int:
    """Mirror of applyDense() in web/fixture.js - see the comment there for why.

    Packs organisms into a single 3x3 block so the crowding gate and the prey-density
    fields are non-zero, which is the only way to exercise predation and hunt/flee
    steering inside the short window where the two implementations agree exactly.
    """
    n = min(n, len(w.orgs))
    for i, o in enumerate(w.orgs[:n]):
        o.cell = (i % 3) + (i // 3) % 3 * w.p.w
        o.g[0] = 0.0
        o.g[2] = i / 40
        o.g[4] = 0.5
        o.e = 30.0
        o.age = 0
        w._init_derived(o)
    return n


def run(name: str, ticks: int, seed: int, dense: bool = False):
    w = World(preset(name, seed=seed), rng=random.Random(seed))
    if dense:
        apply_dense(w)
    rows = []
    for _ in range(ticks):
        w.step()
        s = w.stats()
        rows.append([s["pop"], s["food"], s["births"], s["deaths"], s["d_eaten"],
                     s["mean"], s["std"], s["div"], s["hue_div"]])
    return {"params": w.p.to_json(), "rng": rng_state(seed), "rows": rows,
            # how many organisms ever lived: the JS lineage arrays are capacity-allocated,
            # so nothing else would catch a port that reports capacity instead of count.
            "lived": len(w.parent_of),
            "preset": name, "seed": seed}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="evo/web/golden.json")
    ap.add_argument("--ticks", type=int, default=0, help="override every case's length")
    args = ap.parse_args()
    cases = [run(n, args.ticks or t, s) for n, s, t in CASES]
    # The dense fixture: short, but it is the only case where predation definitely fires.
    cases.append(run("arms_race", 12, 11, dense=True))
    cases[-1]["preset"] = "arms_race_dense"
    blob = {"cases": cases}
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(blob, fh)
    for c in blob["cases"]:
        print(f"  {c['preset']:<10} seed={c['seed']} {len(c['rows'])} ticks, "
              f"pop {c['rows'][0][0]} -> {c['rows'][-1][0]}")
    print(f"{args.out}")


if __name__ == "__main__":
    main()
