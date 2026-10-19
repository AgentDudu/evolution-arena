"""Regenerate the controls table in README.md.

    python -m evo.controls

Each row is one rule switched off. The point of the table is that the interesting
behaviour has a *cause*: if `arms_race` looks interesting but the same numbers show up
with the rule removed, the rule was never doing anything.
"""
from __future__ import annotations

import numpy as np

from .sim import World, preset

TICKS, WINDOW = 2500, 1500

# (label, preset, param overrides)
ROWS = [
    ("`arms_race` (everything on)", "arms_race", {}),
    ("`peaceful` — no predation", "peaceful", {}),
    ("`flat` — no fertility patches", "flat", {}),
    ("`carnivory=0` — size costs nothing to digest", "arms_race", {"carnivory": 0.0}),
]


def run(name, over, seed=1):
    w = World(preset(name, **over))
    pop, div, sz, eaten = [], [], [], []
    for _ in range(TICKS):
        w.step()
        if len(w.orgs):
            pop.append(len(w.orgs))
            s = w.stats()
            div.append(s["div"])
            sz.append(np.std([o.g[2] for o in w.orgs]))
            eaten.append(w.deaths_this.get("eaten", 0))
    tail = slice(-WINDOW, None)
    return np.mean(div[tail]), np.mean(sz[tail]), np.mean(eaten[tail]), np.mean(pop[tail])


def main():
    print("| world | diversity | sd(size) | kills/tick | pop |")
    print("|---|---|---|---|---|")
    for label, name, over in ROWS:
        d, s, k, p = run(name, over)
        print(f"| {label} | {d:.2f} | {s:.3f} | {k:.2f} | {p:.0f} |")


if __name__ == "__main__":
    main()
