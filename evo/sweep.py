"""Parameter sweep: find the regimes where the graphs actually move.

Most of the parameter space of an evolution sim is boring: the population crashes to
zero, or one clone takes over and every line goes flat. This runs a grid of short runs
and scores each one on how much *selection* it shows, so the interesting corners can be
found instead of guessed at.

  python -m evo.sweep --preset arms_race --ticks 1200 \
      --sweep food_regrow=0.02,0.04,0.07,0.12 --sweep mut_sigma=0.05,0.12,0.22
  python -m evo.sweep ... --top 3 --save     # write dashboards for the best runs
"""
from __future__ import annotations

import argparse
import itertools
import json
import sys
import time
from concurrent.futures import ProcessPoolExecutor
from dataclasses import replace

from . import trace
from .sim import PRESETS, World, preset


def score(stats, warmup: float = 0.4, max_pop: int = 4000):
    """Score a run on evidence of ongoing selection. Returns (score, parts).

    Everything is measured after `warmup` of the run, because the first few hundred
    ticks are just the random founding population settling down.
    """
    n = len(stats)
    tail = stats[int(n * warmup):] or stats
    live = [s for s in tail if s["pop"] > 0]
    parts = {"alive": 0.0, "poly": 0.0, "div": 0.0, "hunt": 0.0, "swing": 0.0,
             "turnover": 0.0}
    if not live:
        return 0.0, parts
    pops = [s["pop"] for s in live]
    mean_pop = sum(pops) / len(pops)
    if mean_pop < 10:
        return 0.0, parts
    # A run that hits the population guard is not interesting, it is an artefact.
    parts["alive"] = min(1.0, mean_pop / 60.0) * (0.3 if mean_pop > max_pop * 0.9 else 1.0)

    def mean(key, idx=None):
        return sum((s[key][idx] if idx is not None else s[key]) for s in live) / len(live)

    # ln(16) = 2.77 is the ceiling for the niche grid; 2.4 means "close to fully spread".
    parts["poly"] = min(1.0, (mean("std", 2) + mean("std", 0) + mean("std", 1)) / 1.0)
    parts["div"] = min(1.0, mean("div") / 2.4)
    parts["hunt"] = min(1.0, mean("d_eaten") / 4.0)
    parts["turnover"] = min(1.0, mean("deaths") / 6.0)
    # Detrend first: a population still climbing out of its founding transient has a
    # large raw cv, and scoring that as "oscillation" ranks half-finished runs highly.
    n2 = len(pops)
    if n2 > 8:
        mx = (n2 - 1) / 2.0
        slope = (sum((i - mx) * (p - mean_pop) for i, p in enumerate(pops))
                 / sum((i - mx) ** 2 for i in range(n2)))
        resid = [p - (mean_pop + slope * (i - mx)) for i, p in enumerate(pops)]
    else:
        resid = [p - mean_pop for p in pops]
    sd = (sum(r * r for r in resid) / n2) ** 0.5
    parts["swing"] = min(1.0, (sd / mean_pop) / 0.35)   # boom-bust cycles
    total = (1.6 * parts["poly"] + 1.3 * parts["div"] + 1.1 * parts["hunt"]
             + 1.0 * parts["swing"] + 0.6 * parts["turnover"]) / 5.6
    return round(total * parts["alive"], 4), parts


def one(args):
    name, over, ticks, seed, want_stats = args
    p = replace(preset(name, seed=seed), **over)
    w, stats, _ = trace.run(p, ticks)
    sc, parts = score(stats, max_pop=p.max_pop)
    s = stats[-1]
    out = {"params": over, "score": sc, "parts": parts, "seed": seed,
           "pop": s["pop"], "div": s["div"], "eaten": s["d_eaten"],
           "std_size": s["std"][2], "mean": [round(v, 3) for v in s["mean"]]}
    if want_stats:
        out["stats"] = stats
    return out


def grid(specs):
    """specs = [("food_regrow", [0.02, 0.04]), ...] -> list of dicts."""
    keys = [k for k, _ in specs]
    return [dict(zip(keys, combo)) for combo in itertools.product(*(v for _, v in specs))]


def parse_spec(text):
    k, _, vals = text.partition("=")
    out = []
    for v in vals.split(","):
        out.append(float(v) if v.replace(".", "").replace("-", "").isdigit() else
                   (True if v == "true" else False if v == "false" else v))
    return k.strip(), out


def main(argv=None):
    a = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    a.add_argument("--preset", default="arms_race", choices=sorted(PRESETS))
    a.add_argument("--ticks", type=int, default=1200)
    a.add_argument("--seed", type=int, default=1)
    a.add_argument("--seeds", type=int, default=1, help="average this many seeds per cell")
    a.add_argument("--sweep", action="append", default=[], metavar="K=v1,v2",
                   help="parameter grid; repeatable")
    a.add_argument("--jobs", type=int, default=1)
    a.add_argument("--top", type=int, default=0, help="write dashboards for the best N")
    a.add_argument("--out", default="out/sweep")
    a.add_argument("--json", action="store_true", help="dump full results as json")
    args = a.parse_args(argv)

    specs = [parse_spec(s) for s in args.sweep]
    cells = grid(specs) if specs else [{}]
    jobs = [(args.preset, c, args.ticks, args.seed + s, bool(args.top))
            for c in cells for s in range(args.seeds)]
    print(f"{len(jobs)} runs x {args.ticks} ticks "
          f"({', '.join(f'{k}={len(v)}' for k, v in specs) or 'no grid'})")

    t0 = time.time()
    if args.jobs > 1:
        with ProcessPoolExecutor(max_workers=args.jobs) as ex:
            res = list(ex.map(one, jobs))
    else:
        res = [one(j) for j in jobs]
    res.sort(key=lambda r: -r["score"])
    print(f"\n{'score':>6} {'pop':>5} {'div':>5} {'eaten':>5} {'sd(size)':>8}  "
          f"{'alive poly div hunt swing turn':>32}  params")
    for r in res[:25]:
        p = r["parts"]
        bar = " ".join(f"{p[k]:.2f}" for k in
                       ("alive", "poly", "div", "hunt", "swing", "turnover"))
        print(f"{r['score']:6.3f} {r['pop']:5d} {r['div']:5.2f} {r['eaten']:5d} "
              f"{r['std_size']:8.3f}  {bar}  {r['params']}")
    print(f"\n{len(res)} runs in {time.time() - t0:.0f}s. "
          f"best={res[0]['score']:.3f} worst={res[-1]['score']:.3f}")

    if args.top:
        import os
        os.makedirs(args.out, exist_ok=True)
        for i, r in enumerate(res[:args.top]):
            if "stats" not in r:
                continue
            p = replace(preset(args.preset, seed=r["seed"]), **r["params"])
            w, stats, snaps = trace.run(p, args.ticks)
            doc = trace.to_json(p, stats, snaps, trace.lineage_blob(w),
                                extra={"preset": args.preset, "score": r["score"]})
            path = f"{args.out}/top{i + 1}.json"
            trace.save(path, doc)
            from .run import emit_html
            emit_html(f"{args.out}/top{i + 1}.html", doc)
            print(f"wrote {path}")
    if args.json:
        with open(args.out + ".json", "w", encoding="utf-8") as f:
            json.dump(res, f, indent=1)
        print(f"wrote {args.out}.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
