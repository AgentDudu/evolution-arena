"""Run a simulation to a compact, self-contained trace file that the dashboard replays.

Trace format (one JSON document):
  meta     params, trait names, grid size
  stats    one record per tick: population, food, births, deaths by cause, trait mean/std,
           biomass, Shannon diversity
  snaps    one frame every `snap_every` ticks: per-organism cell/hue/size/speed/energy,
           packed as hex-encoded typed arrays so a 5k-tick run stays a few hundred KB
  lineage  parent id, hue, size, born, died, death cause for every organism that ever lived
"""
from __future__ import annotations

import json
import time

from .sim import PRESETS, TRAITS, Params, World, preset

CAUSE = {"": 0, "starved": 1, "age": 2, "eaten": 3}


def run(p: Params, ticks: int, snap_every: int = 50, snap_cap: int = 1000,
        world: World | None = None, progress=None):
    w = world or World(p)
    stats, snaps = [], []
    t0 = time.time()
    for i in range(ticks):
        w.step()
        stats.append(w.stats())
        if (i + 1) % snap_every == 0 or i == ticks - 1:
            snaps.append(w.snapshot(snap_cap))
        if progress and (i + 1) % progress == 0:
            s = stats[-1]
            print(f"  tick {i + 1:6d}/{ticks}  pop {s['pop']:5d}  "
                  f"food {s['food']:8.0f}  div {s['div']:.2f}  "
                  f"{time.time() - t0:6.1f}s", flush=True)
    return w, stats, snaps


def lineage_blob(w: World):
    return {"n": len(w.parent_of),
            "parent": w.parent_of,
            "hue": [int(v * 255) for v in w.hue_of],
            "size": [int(v * 255) for v in w.size_of],
            "born": w.born_of,
            "died": w.died_of,
            "cause": [CAUSE.get(c, 0) for c in w.deaths]}


def to_json(p: Params, stats, snaps, lineage, extra=None):
    doc = {"meta": {"params": p.to_json(), "traits": list(TRAITS),
                    "w": p.w, "h": p.h, "ticks": len(stats),
                    "cause": CAUSE, **(extra or {})},
           "stats": stats, "snaps": snaps, "lineage": lineage}
    return json.dumps(doc, separators=(",", ":"))


def save(path: str, doc: str):
    with open(path, "w", encoding="utf-8") as f:
        f.write(doc)


def load(path: str):
    with open(path, encoding="utf-8") as f:
        return json.load(f)
