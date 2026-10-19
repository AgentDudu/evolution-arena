"""Invariant tests for the arena. Run: python -m tests.test_sim  (or pytest)

These check the things that silently ruin an evolution sim: energy appearing from
nowhere, runs not reproducing, save/resume drifting, and the model flatlining.
"""
from __future__ import annotations

import json

import numpy as np

from evo.sim import Params, World, preset


def sig(w: World):
    """Fingerprint of a world state, tight enough to catch a single diverged mutation."""
    s = w.stats()
    return (w.tick, len(w.orgs), round(float(w.food.sum()), 9),
            tuple(round(v, 9) for v in s["mean"]), tuple(round(v, 9) for v in s["std"]))


def steps(w: World, n: int):
    for _ in range(n):
        w.step()
    return w


def test_determinism():
    a, b = World(preset("arms_race")), World(preset("arms_race"))
    steps(a, 400), steps(b, 400)
    assert sig(a) == sig(b), "same seed must give the same world"


def test_seed_changes_outcome():
    a = sig(steps(World(preset("arms_race", seed=1)), 300))
    b = sig(steps(World(preset("arms_race", seed=2)), 300))
    assert a != b, "seed must matter"


def test_save_resume_is_exact():
    """A resumed run must be indistinguishable from one that never stopped."""
    w = World(preset("arms_race"))
    steps(w, 400)
    r = World.load(json.loads(json.dumps(w.state())))   # through JSON, like the CLI
    steps(r, 200)
    steps(w, 200)
    assert sig(w) == sig(r), "resume drifted from the uninterrupted run"


def test_snapshot_does_not_perturb_the_sim():
    """Playback frames are taken every N ticks; they must not touch the run."""
    a, b = World(preset("arms_race")), World(preset("arms_race"))
    for _ in range(300):
        a.step()
        b.step()
        b.snapshot(300)
    assert sig(a) == sig(b), "snapshotting changed the simulation"


def test_energy_is_never_created():
    """Closed system: the world can lose energy (clipping, waste heat) but not gain it.

    `injected` is the exact amount of sun energy that entered, after the food cap, so
    any gain above it would have to come from inside the system.
    """
    w = World(preset("arms_race"))
    p = w.p
    start = float(w.food.sum()) + sum(o.e for o in w.orgs)
    injected = 0.0
    for _ in range(300):
        pre = np.minimum(w.food + p.food_regrow * w.fertility, p.food_cap)
        injected += float(pre.sum() - w.food.sum())
        w.step()
    end = float(w.food.sum()) + sum(o.e for o in w.orgs)
    assert end - start <= injected + 1e-6, (
        f"created {end - start - injected:.3f} units of energy out of nothing")
    assert injected > 0


def test_food_never_goes_negative():
    w = World(preset("famine"))
    for _ in range(600):
        w.step()
        assert (w.food >= 0).all(), "food went negative: two grazers ate one item"


def test_traits_do_not_all_saturate():
    """The failure mode of this kind of model is every trait pinned at 1.0.

    If that happens the population is identical, predation stops making sense and
    every graph goes flat, which is exactly what this test is here to catch.
    """
    w = steps(World(preset("arms_race")), 1500)
    s = w.stats()
    assert max(s["mean"]) < 0.99, f"a trait ratcheted to its ceiling: {s['mean']}"
    assert min(s["mean"]) > 0.01, f"a trait went to zero: {s['mean']}"


def test_selection_is_happening():
    """Selection must actually move: at least one trait far from its random start."""
    w = steps(World(preset("arms_race")), 1500)
    moved = [abs(m - 0.5) for m in w.stats()["mean"]]
    assert max(moved) > 0.15, f"selection barely moved anything: {w.stats()['mean']}"


def test_polymorphism_survives():
    """Body size must stay split, otherwise the arms race has collapsed to one strategy."""
    w = steps(World(preset("arms_race")), 1500)
    s = w.stats()
    assert s["std"][2] > 0.05, f"size is monomorphic (std {s['std'][2]:.3f})"
    assert s["div"] > 0.5, f"one niche dominates (diversity {s['div']:.2f})"


def test_predation_is_not_dead_code():
    w = steps(World(preset("arms_race")), 1500)
    eaten = 0
    for _ in range(300):
        w.step()
        eaten += w.deaths_this["eaten"]
    assert eaten > 20, f"predation essentially never fired ({eaten} kills in 300 ticks)"


def test_extinction_is_survivable():
    """A world that empties must keep running, not divide by zero or crash."""
    w = World(preset("ancestral", food_regrow=0.0, n0=30))
    for _ in range(3000):
        w.step()
        w.stats()
        w.snapshot(100)
    assert len(w.orgs) == 0, f"{len(w.orgs)} organisms survived 3000 ticks of famine"


def test_presets_are_consistent():
    from evo.sim import PRESETS
    for name in PRESETS:
        p = preset(name)
        assert isinstance(p, Params)
        w = steps(World(p), 30)
        assert w.stats()["t"] == 30


def test_lineage_is_a_forest():
    """Every organism cites an older parent, so the tree cannot contain a cycle."""
    w = steps(World(preset("arms_race")), 600)
    for i, p in enumerate(w.parent_of):
        assert p == -1 or p < i, f"organism {i} has parent {p}"
    assert sum(1 for p in w.parent_of if p == -1) == w.p.n0


def main():
    fns = [(k, v) for k, v in sorted(globals().items())
           if k.startswith("test_") and callable(v)]
    failed = 0
    for name, fn in fns:
        try:
            fn()
            print(f"  PASS  {name}")
        except AssertionError as e:
            failed += 1
            print(f"  FAIL  {name}: {e}")
        except Exception as e:
            failed += 1
            print(f"  ERROR {name}: {type(e).__name__}: {e}")
    print(f"\n{len(fns) - failed}/{len(fns)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
