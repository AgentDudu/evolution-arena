"""CLI: run the arena, write a trace, emit a standalone dashboard.

  python -m evo.run --preset arms_race --ticks 5000 --out out/run
  python -m evo.run --preset famine --set food_regrow=0.03 --seed 7
  python -m evo.run --resume out/run.state.json --ticks 2000 --out out/run2
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from dataclasses import replace

import numpy as np

from . import trace
from .golden import rng_state
from .sim import PRESETS, TRAITS, Params, World, preset

TEMPLATE = os.path.join(os.path.dirname(__file__), "dashboard.html")
WEB = os.path.join(os.path.dirname(__file__), "web")


def _js_module(path):
    """Read a browser-inlined module: drop the ESM export line, refuse anything that could
     close the script tag early."""
    with open(path, encoding="utf-8") as f:
        src = f.read()
    src = re.sub(r"^export\s*\{[^}]*\};?[ \t]*$", "", src, flags=re.M)
    if "</script" in src.lower():
        raise SystemExit(f"{path} contains a script end tag and cannot be inlined")
    return src


# What the inlined model hands the page. Inlined inside an IIFE because sim.js and
# dashboard.html both declare names like NG and N at top level.
LIVE_GLOBALS = "World, preset, defaults, PRESETS, boxBlur, boxSum, NG, DEATH, TRAITS, RNG"


def emit_live(html_path, cfg):
    """One self-contained HTML that runs the model in the browser. Same double-click
     property as the baked dashboard, but the world is live instead of replayed."""
    with open(TEMPLATE, encoding="utf-8") as f:
        tpl = f.read()
    sim = ("(function(){\n"
           + _js_module(os.path.join(WEB, "prng.js")) + "\n"
           + _js_module(os.path.join(WEB, "sim.js")) + "\n"
           + f"Object.assign(globalThis, {{{LIVE_GLOBALS}}});\n}})();")
    stub = {"meta": {"params": {}, "traits": list(TRAITS), "w": 0, "h": 0, "ticks": 0},
            "stats": [], "snaps": [],
            "lineage": {"n": 0, "parent": [], "hue": [], "size": [], "born": [],
                        "died": [], "cause": []}}
    doc = (tpl.replace("__SIM__", sim)
              .replace("__LIVE__", json.dumps(cfg))
              .replace("__TRACE__", json.dumps(stub)))
    left = [ph for ph in ("__TRACE__", "__LIVE__", "__SIM__") if ph in doc]
    if left:
        raise SystemExit(f"unreplaced placeholder(s) {left} in {TEMPLATE}")
    with open(html_path, "w", encoding="utf-8") as f:
        f.write(doc)


def parse_overrides(pairs):
    """--set key=value with a best-effort literal parse (bools, numbers, strings)."""
    out = {}
    for pair in pairs or []:
        if "=" not in pair:
            raise SystemExit(f"--set wants key=value, got {pair!r}")
        k, v = pair.split("=", 1)
        k, v = k.strip(), v.strip()
        if v.lower() in ("true", "false"):
            out[k] = v.lower() == "true"
        else:
            try:
                out[k] = int(v) if v.lstrip("-").isdigit() else float(v)
            except ValueError:
                out[k] = v
    return out


def emit_html(html_path, doc):
    """Inline the trace so the dashboard opens with a double-click (no server, no fetch)."""
    with open(TEMPLATE, encoding="utf-8") as f:
        tpl = f.read()
    if "__TRACE__" not in tpl:
        raise SystemExit(f"{TEMPLATE} has no __TRACE__ placeholder")
    html = tpl.replace("__SIM__", "").replace("__LIVE__", "null")
    with open(html_path, "w", encoding="utf-8") as f:
        f.write(html.replace("__TRACE__", doc.replace("</", "<\\/")))


def report(w, stats, window: int):
    """The summary block the README quotes. Kept next to the runner so the numbers in the
    README have one command that regenerates them instead of being hand-copied."""
    tail = stats[-window:]
    pops = [s["pop"] for s in tail]
    kills = [s["d_eaten"] for s in tail]
    print(f"\nmean of last {len(tail)} ticks:")
    print(f"  pop {min(pops)}-{max(pops)}      "
          f"diversity {np.mean([s['div'] for s in tail]):.2f} (ceiling ln16 = 2.77)")
    print(f"  predation {np.mean(kills):.1f} kills/tick sustained, peaks of {max(kills)}")
    depth, parent = [0] * len(w.parent_of), w.parent_of
    for i in range(len(parent)):
        depth[i] = 0 if parent[i] < 0 else depth[parent[i]] + 1
    print(f"  {len(parent) - 100:,} organisms born from 100 founders; "
          f"deepest surviving lineage {max(depth)} generations")
    s = stats[-1]
    print("  trait means:  " + "  ".join(
        f"{name} {v:.2f}" for name, v in zip(TRAITS, s["mean"])))
    for name, key in (("speed", 0), ("size", 2)):
        v = np.array([o.g[key] for o in w.orgs]) if w.orgs else np.zeros(1)
        hist = np.histogram(v, bins=8, range=(0.0, 1.0))[0]
        print(f"  {name:5s} hist:  " + "  ".join(f"{int(c):5d}" for c in hist))
    food = w.food
    print(f"  food field: mean {food.mean():.2f} sd {food.std():.2f}")


def main(argv=None):
    a = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    a.add_argument("--preset", default="ancestral", choices=sorted(PRESETS))
    a.add_argument("--seed", type=int, default=1)
    a.add_argument("--ticks", type=int, default=5000)
    a.add_argument("--out", default="out/run", help="base path (no extension)")
    a.add_argument("--snap-every", type=int, default=50)
    a.add_argument("--snap-cap", type=int, default=1000)
    a.add_argument("--set", nargs="*", metavar="KEY=VALUE",
                   help="override any Params field")
    a.add_argument("--resume", metavar="STATE.json", help="continue a saved world")
    a.add_argument("--save-state", action="store_true",
                   help="also write <out>.state.json so the run can be resumed")
    a.add_argument("--no-html", action="store_true")
    a.add_argument("--live", action="store_true",
                   help="emit a self-contained page that runs the world in the browser "
                        "instead of replaying a baked trace (no sim run, no trace)")
    a.add_argument("--live-warmup", type=int, default=200,
                   help="ticks to simulate before the page first paints")
    a.add_argument("--steps", type=int, default=4,
                   help="live mode: ticks computed per animation frame, which is the speed "
                        "of the world (default 4); past ~12 it starts to strobe")
    a.add_argument("--quiet", action="store_true")
    a.add_argument("--report", action="store_true",
                   help="print the summary block the README quotes")
    a.add_argument("--report-window", type=int, default=2400)
    a.add_argument("--list-presets", action="store_true")
    args = a.parse_args(argv)

    if args.list_presets:
        for name, over in sorted(PRESETS.items()):
            print(f"{name:12s} {over}")
        return 0

    p = preset(args.preset, seed=args.seed, **parse_overrides(args.set))

    if args.live:
        cfg = {"preset": args.preset, "seed": p.seed, "warmup": args.live_warmup,
               "steps": args.steps,
               "snapEvery": max(1, args.snap_every), "snapCap": args.snap_cap,
               # JS does not reimplement CPython's seeding, so hand it the real state:
               # the live world is then the same world `--preset X --seed Y` would bake.
               "rng": rng_state(p.seed),
               "history": 2400, "frames": 160}
        os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
        emit_live(args.out + ".html", cfg)
        if not args.quiet:
            print(f"wrote {args.out}.html "
                  f"({os.path.getsize(args.out + '.html') / 1e3:.0f} KB)")
            print(f"open {args.out}.html")
        return 0

    world = None
    if args.resume:
        with open(args.resume, encoding="utf-8") as f:
            world = World.load(json.load(f))
        p = world.p
        if not args.quiet:
            print(f"resumed {args.resume} at tick {world.tick}")

    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    if not args.quiet:
        print(f"{args.preset} seed={p.seed} {p.w}x{p.h} ticks={args.ticks} "
              f"regrow={p.food_regrow} predation={p.predation}")
    w, stats, snaps = trace.run(p, args.ticks, args.snap_every, args.snap_cap,
                                world=world, progress=None if args.quiet else 500)
    doc = trace.to_json(p, stats, snaps, trace.lineage_blob(w),
                        extra={"preset": args.preset if not args.resume else "resumed"})
    base = args.out
    if base.endswith(".json"):
        base = base[:-5]
    trace.save(base + ".json", doc)
    size = os.path.getsize(base + ".json") / 1e6
    if args.save_state or args.resume:
        with open(base + ".state.json", "w", encoding="utf-8") as f:
            json.dump(w.state(), f)
    if not args.no_html:
        emit_html(base + ".html", doc)
    s = stats[-1]
    if not args.quiet:
        print(f"wrote {base}.json ({size:.1f} MB)"
              + ("" if args.no_html else f" and {base}.html"))
        print(f"final: pop {s['pop']}  food {s['food']:.0f}  div {s['div']:.2f}  "
              f"births {s['births']}  deaths {s['deaths']}")
        print(f"open {base}.html")
    if args.report:
        report(w, stats, min(args.report_window, len(stats)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
