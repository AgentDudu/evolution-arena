"""Evolution arena: toroidal grid world, closed energy economy, emergent natural selection.

Per tick: food regrows -> organisms sense and move -> eat -> attack -> burn -> age ->
reproduce -> die.

Three design decisions carry almost all of the interesting behaviour:

1. ENERGY IS CONSERVED. sun -> food -> organism -> metabolic heat, and nothing else
   enters or leaves. Carrying capacity is therefore an outcome, not a parameter.
2. EVERY TRAIT COSTS ENERGY. A free trait is a trait that drifts to its ceiling. The
   cost table in `World.derive` is where natural selection actually lives.
3. BODY SIZE BUYS LITTLE AND COSTS MUCH. Capacity is nearly flat in size and plant
   digestion gets *worse* with size, so being large only pays if you can catch
   something. That coupling is what turns "bigger is better" into an arms race.

Without (2) the sim flatlines. Without (3) size ratchets to the ceiling, every
organism becomes identical, predation switches itself off and the graphs go flat.
"""
from __future__ import annotations

import random
from dataclasses import asdict, dataclass, replace

import numpy as np
from scipy.ndimage import convolve1d, uniform_filter

def _box_sum_int(a, size):
    """Exact integer sum over a wrap-around (size x size) window.

    Deliberately not uniform_filter. scipy dispatches on dtype, and its *integer* path
    applies mode="wrap" incorrectly - it disagrees with its own float path at the border
    (a 3x3 sum of 37 came out as 3 where trunc(37/9) is 4) - while floor() of its float
    path is off by one wherever the true mean is an exact integer, because the mean is
    computed as sum * (1/area) and that product is inexact. Both density fields below are
    truncated, so only the exact integer sum is a safe basis for them. It is also the one
    formulation the JavaScript port can match bit for bit.
    """
    k = np.ones(size, np.int64)
    return convolve1d(convolve1d(a, k, axis=0, mode="wrap"), k, axis=1, mode="wrap")


TRAITS = ("speed", "sense", "size", "metabolism", "repro", "lifespan", "hue")
NG = len(TRAITS)
# 9 movement/sense targets: stay put plus the 8 neighbours.
DIRS = ((0, 0), (1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1))
SENSE_RADII = (1, 3, 5)   # box-filter half-widths, indexed by the sense trait
MAX_STEPS = 3             # a fast organism crosses 3 cells per tick


@dataclass(frozen=True)
class Params:
    w: int = 64
    h: int = 64
    n0: int = 100
    seed: int = 1

    # --- food economy. food_regrow is the master knob: it sets carrying capacity. ---
    food_regrow: float = 0.05     # energy per cell per tick, scaled by local fertility
    food_cap: float = 1.0
    bite: float = 0.5             # max food items eaten per tick
    fertility_patchiness: float = 0.8   # 0 = flat world, 1 = strong persistent patches

    # --- energy budget (see World.derive). cost[2] (size) is applied quadratically. ---
    base_burn: float = 0.06
    cost: tuple = (0.05, 0.045, 0.10, 0.05, 0.015, 0.01, 0.0)
    move_cost: float = 0.012      # per cell travelled

    # --- organism scaling. cap1 is small on purpose: see module docstring. ---
    cap0: float = 38.0
    cap1: float = 14.0
    repro0: float = 22.0          # energy needed to split = repro0 + repro1 * trait
    repro1: float = 14.0          # absolute, not a fraction of capacity
    split: float = 0.45           # share the offspring gets; the rest is reproductive cost
    age0: float = 250.0           # lifespan = age0 + age1 * lifespan
    age1: float = 1000.0

    # --- inheritance ---
    mut_rate: float = 0.15        # per-gene chance of mutating
    mut_sigma: float = 0.08

    # --- predation ---
    predation: bool = True
    attack_gap: float = 0.08      # required size advantage to bite
    attack_cost: float = 0.06     # paid even when the chase fails
    attack_yield: float = 0.6     # fraction of prey energy assimilated
    carnivory: float = 0.6        # how much body size costs plant digestion
    hunt_weight: float = 1.5      # pull toward the size class below
    flee_weight: float = 1.5      # push away from the size class above

    max_pop: int = 4000           # runtime guard: keeps a runaway run from eating RAM

    def to_json(self):
        d = asdict(self)
        d["cost"] = list(self.cost)
        return d


PRESETS = {
    "ancestral": dict(food_regrow=0.05, mut_sigma=0.08, predation=True,
                      fertility_patchiness=0.8),
    "eden": dict(food_regrow=0.18, mut_sigma=0.08, predation=True,
                 fertility_patchiness=0.4),
    "famine": dict(food_regrow=0.018, mut_sigma=0.08, predation=True,
                   fertility_patchiness=1.0),
    "arms_race": dict(food_regrow=0.07, mut_sigma=0.10, predation=True,
                      attack_gap=0.04, fertility_patchiness=0.6),
    "mutagenic": dict(food_regrow=0.07, mut_sigma=0.25, predation=True,
                      fertility_patchiness=0.8),
    "peaceful": dict(food_regrow=0.05, mut_sigma=0.08, predation=False,
                     fertility_patchiness=0.8),
    "flat": dict(food_regrow=0.05, mut_sigma=0.08, predation=True,
                 fertility_patchiness=0.0),
}


def preset(name: str, **over) -> Params:
    if name not in PRESETS:
        raise KeyError(f"unknown preset {name!r}; have {sorted(PRESETS)}")
    return replace(Params(), **{**PRESETS[name], **over})


class Org:
    # The tick loop reads ~10 genome-derived numbers per organism. Traits only change
    # at birth, so they are cached here; recomputing them every tick was ~25% of runtime.
    __slots__ = ("id", "cell", "e", "age", "g", "parent", "bcost", "cap", "rthresh",
                 "mage", "gi", "wf", "cls", "hunt", "flee", "peff")

    def __init__(self, oid, cell, e, g, parent):
        self.id, self.cell, self.e, self.age, self.g, self.parent = oid, cell, e, 0, g, parent


class World:
    def __init__(self, p: Params | None = None, rng: random.Random | None = None):
        self.p = p or Params()
        p = self.p
        self.rng = rng or random.Random(p.seed)
        r = self.rng
        n = p.w * p.h
        # Persistent fertility patches. Helps, but less than the size trade-off: with
        # patchiness removed, diversity only falls 1.99 -> 1.82 (see README controls).
        fert = uniform_filter(np.fromiter((r.random() for _ in range(n)), np.float64, n)
                              .reshape(p.h, p.w), size=5, mode="wrap")
        self.fertility = (1.0 + p.fertility_patchiness
                          * (fert / fert.mean() - 1.0)).ravel()
        self.food = np.clip(np.fromiter((r.random() for _ in range(n)), np.float64, n),
                            0, p.food_cap)
        self.cand = self._build_cand(p)
        self.snap_rng = random.Random(p.seed + 9871)   # playback must not perturb the sim
        self.orgs: list[Org] = []
        self.next_id = 0
        self.tick = 0
        self.births = 0
        self.deaths_alive = 0
        self.deaths_this = {"starved": 0, "age": 0, "eaten": 0}
        # lineage bookkeeping, indexed by organism id
        self.parent_of: list[int] = []
        self.hue_of: list[float] = []
        self.size_of: list[float] = []
        self.born_of: list[int] = []
        self.died_of: list[int] = []
        self.deaths: list[str] = []
        for _ in range(p.n0):
            self._spawn([r.random() for _ in range(NG)], None, r.randrange(n))

    # ---------- construction helpers ----------
    @staticmethod
    def _build_cand(p):
        """cand[cell] = the 9 cells within Chebyshev distance 1, self first (toroidal).

        Precomputed so the inner loops never do a modulo. Also used for the 3x3 prey
        search and for placing offspring.
        """
        per = []
        for y in range(p.h):
            for x in range(p.w):
                per.append(tuple(((y + dy) % p.h) * p.w + (x + dx) % p.w
                                 for dx, dy in DIRS))
        return per

    def derive(self, g):
        """Genome -> every number the tick loop needs. This is the trade-off table.

        Each line is a rule of the world: what a trait costs, what it buys.
        """
        p = self.p
        return (
            # cost of living. size is quadratic; everything else linear.
            p.base_burn + p.cost[0] * g[0] + p.cost[1] * g[1] + p.cost[2] * g[2] * g[2]
            + p.cost[3] * g[3] + p.cost[4] * g[4] + p.cost[5] * g[5] + p.cost[6] * g[6],
            p.cap0 + p.cap1 * g[2],                             # energy capacity
            p.repro0 + p.repro1 * g[4],                         # energy needed to split
            p.age0 + p.age1 * g[5],                             # lifespan
            min(len(SENSE_RADII) - 1, int(g[1] * len(SENSE_RADII))),  # field resolution
            0.3 + 2.0 * g[1],                                   # trust in smoothed field
            min(2, int(g[2] * 3)),                              # size class
            p.hunt_weight * g[2],                               # seek class below
            p.flee_weight * (1.0 - g[2]),                       # avoid class above
            (0.35 + 0.65 * g[3]) * (1.0 - p.carnivory * g[2]),  # plant digestion
        )

    def _init_derived(self, o):
        (o.bcost, o.cap, o.rthresh, o.mage, o.gi, o.wf, o.cls, o.hunt, o.flee,
         o.peff) = self.derive(o.g)
        return o

    def _spawn(self, g, parent, cell):
        p = self.p
        o = self._init_derived(
            Org(self.next_id, cell, 0.5 * (p.cap0 + p.cap1 * g[2]), g,
                -1 if parent is None else parent.id))
        self.next_id += 1
        self.orgs.append(o)
        self.parent_of.append(o.parent)
        self.hue_of.append(g[6])
        self.size_of.append(g[2])
        self.born_of.append(self.tick)
        self.died_of.append(-1)
        self.deaths.append("")
        return o

    def _kill(self, o, cause):
        o.e = -1.0
        self.died_of[o.id] = self.tick
        self.deaths[o.id] = cause
        self.deaths_this[cause] += 1

    # ---------- per-tick machinery ----------
    def _index(self):
        """Group organisms by cell: members of c are order[offs[c]:offs[c]+counts[c]]."""
        p, n = self.p, len(self.orgs)
        if not n:
            self.order = self.offsets = self.counts = None
            return False
        cid = np.fromiter((o.cell for o in self.orgs), dtype=np.int64, count=n)
        self.order = np.argsort(cid, kind="stable")
        self.counts = np.bincount(cid, minlength=p.w * p.h)
        offs = np.zeros(self.counts.size + 1, dtype=np.int64)
        np.cumsum(self.counts, out=offs[1:])
        self.offsets = offs
        return True

    def _sense_fields(self):
        """Food at three resolutions, plus density per size class.

        Predators sense the size class below them and small ones sense the class above.
        Without that separation the two never meet and predation is dead code.
        """
        p = self.p
        food2 = self.food.reshape(p.h, p.w)
        fields = [uniform_filter(food2, size=2 * k + 1, mode="wrap").ravel()
                  for k in SENSE_RADII]
        n = len(self.orgs)
        if not n:
            z = np.zeros(p.w * p.h)
            return fields, [z, z, z]
        cid = np.fromiter((o.cell for o in self.orgs), dtype=np.int64, count=n)
        size = np.fromiter((o.g[2] for o in self.orgs), dtype=np.float64, count=n)
        cls = np.minimum(2, (size * 3).astype(np.int64))
        prey = [(_box_sum_int(np.bincount(cid[cls == c], minlength=p.w * p.h)
                              .reshape(p.h, p.w), 5) // 25).ravel()
                for c in range(3)]
        return fields, prey

    def step(self):
        p, r, w, h = self.p, self.rng, self.p.w, self.p.h
        n_cells = w * h
        self.tick += 1
        self.deaths_this = {"starved": 0, "age": 0, "eaten": 0}
        self.food += p.food_regrow * self.fertility
        np.minimum(self.food, p.food_cap, out=self.food)

        fields, prey = self._sense_fields()
        fl = [f.tolist() for f in fields]
        pl = [f.tolist() for f in prey]
        avail = self.food.tolist()    # food in each cell before this tick's grazing
        taken = [0.0] * n_cells       # tracked apart so two grazers cannot eat one item
        cand = self.cand
        move_cost = p.move_cost
        rand = r.random

        # ---------- move ----------
        # Destination score = food actually there (so a grazed-out cell is abandoned)
        # + a smoothed field (so a rich patch is worth walking to) +/- the density of
        # the relevant neighbouring size class: hunt the class below, flee the class above.
        for o in self.orgs:
            f = fl[o.gi]
            cls = o.cls
            below = pl[cls - 1] if (o.hunt and cls) else None
            above = pl[cls + 1] if (o.flee and cls < 2) else None
            hunt, flee, wf = o.hunt, o.flee, o.wf
            cell = o.cell
            moved = 0
            for _ in range(1 + (rand() < o.g[0]) + (rand() < o.g[0])):
                if rand() < 0.15:                       # occasional random step
                    cell = cand[cell][1 + int(rand() * 8)]
                    moved += 1
                    continue
                best, bc = -1e18, cell
                for c in cand[cell]:
                    s = avail[c] + wf * f[c]
                    if below is not None:
                        s += hunt * below[c]
                    if above is not None:
                        s -= flee * above[c]
                    if s > best:
                        best, bc = s, c
                if bc != cell:
                    cell = bc
                    moved += 1
            if moved:
                o.cell = cell
                o.e -= move_cost * moved

        # ---------- eat, fight, age, reproduce ----------
        indexed = self._index()
        # Gate the 3x3 prey scan on "is anything within reach". Must be the *sum* over
        # the block: the max only fires when two organisms share one cell.
        near = (_box_sum_int(self.counts.reshape(h, w), 3) // 9).ravel() * 9 \
            if indexed else None
        newborn = []
        gap = p.attack_gap
        bite, acost, ayield = p.bite, p.attack_cost, p.attack_yield
        predation, offsets, counts, order = p.predation, self.offsets, self.counts, self.order
        pop = len(self.orgs)
        for o in self.orgs:
            if o.e <= 0:
                continue                                # already eaten this tick
            g = o.g
            if predation and indexed and near[o.cell] > 1:
                q_best, q_e = None, 0.0
                for c in cand[o.cell]:
                    for j in order[offsets[c]:offsets[c] + counts[c]]:
                        q = self.orgs[j]
                        if q is not o and q.e > q_e and q.e > 0 and g[2] - q.g[2] > gap:
                            q_best, q_e = q, q.e
                if q_best is not None:
                    o.e -= acost                        # a failed chase still costs
                    # faster prey escapes more often: keeps speed under selection
                    if rand() < 0.5 + 0.5 * (g[0] - q_best.g[0]):
                        o.e += ayield * q_best.e * (0.5 + 0.5 * g[3])
                        self._kill(q_best, "eaten")
            left = avail[o.cell] - taken[o.cell]
            if left > 0:
                take = left if left < bite else bite
                taken[o.cell] += take
                o.e += take * o.peff
            o.e -= o.bcost
            o.age += 1
            if o.e < 0:
                self._kill(o, "starved")
            elif o.age > o.mage:
                self._kill(o, "age")
            else:
                if o.e > o.cap:
                    o.e = o.cap
                if o.e >= o.rthresh and pop + len(newborn) < p.max_pop:
                    g2 = list(g)
                    for i in range(NG):
                        if rand() < p.mut_rate:
                            g2[i] = min(1.0, max(0.0, g2[i] + r.gauss(0.0, p.mut_sigma)))
                    share = o.e * p.split
                    o.e = min(o.e - share, o.cap)
                    newborn.append(Org(0, cand[o.cell][int(rand() * 9)], share, g2, o.id))

        self.food -= np.fromiter(taken, dtype=np.float64, count=n_cells)
        np.maximum(self.food, 0.0, out=self.food)
        for c in newborn:
            c.id = self.next_id
            self.next_id += 1
            self._init_derived(c)
            self.orgs.append(c)
            self.parent_of.append(c.parent)
            self.hue_of.append(c.g[6])
            self.size_of.append(c.g[2])
            self.born_of.append(self.tick)
            self.died_of.append(-1)
            self.deaths.append("")
        self.births = len(newborn)

        # ---------- die ----------
        alive = []
        for o in self.orgs:
            if o.e > 0:
                alive.append(o)
            elif self.died_of[o.id] < 0:
                self._kill(o, "starved")
        self.deaths_alive = len(self.orgs) - len(alive)
        self.orgs = alive

    # ---------- statistics ----------
    def stats(self):
        n = len(self.orgs)
        s = {"t": self.tick, "pop": n, "food": round(float(self.food.sum()), 1),
             "births": self.births, "deaths": self.deaths_alive,
             "d_starved": self.deaths_this["starved"], "d_age": self.deaths_this["age"],
             "d_eaten": self.deaths_this["eaten"]}
        if not n:
            return {**s, "mean": [0.0] * NG, "std": [0.0] * NG, "biomass": 0.0,
                    "energy": 0.0, "div": 0.0, "hue_div": 0.0}
        g = np.array([o.g for o in self.orgs], dtype=np.float64)
        e = np.fromiter((o.e for o in self.orgs), dtype=np.float64, count=n)
        s["mean"] = [round(v, 4) for v in g.mean(0)]
        s["std"] = [round(v, 4) for v in g.std(0)]
        s["biomass"] = round(float(e.sum()), 1)
        s["energy"] = round(float(e.mean()), 2)
        # Shannon diversity over a 4x4 (size, speed) bin grid: falls when one strategy
        # takes over, rises when the world splits into niches.
        b = (np.clip(g[:, 2], 0, 0.999) * 4).astype(int) * 4 \
            + (np.clip(g[:, 0], 0, 0.999) * 4).astype(int)
        c = np.bincount(b, minlength=16) / n
        c = c[c > 0]
        s["div"] = round(float(-(c * np.log(c)).sum()), 4)
        c = np.bincount((np.clip(g[:, 6], 0, 0.999) * 8).astype(int), minlength=8) / n
        c = c[c > 0]
        s["hue_div"] = round(float(-(c * np.log(c)).sum()), 4)
        return s

    # ---------- serialisation ----------
    def snapshot(self, cap=1000, grid=16):
        """Compact playback frame; subsamples when the crowd is larger than cap.

        Traits are packed as one row-major uint8 block (n x NG) rather than one array per
        trait, so the dashboard can colour or plot by any trait without the format changing.
        Also carries a `grid`x`grid` downsample of the food field so the replay shows patch
        dynamics without shipping 4096 values per frame.
        """
        p, n = self.p, len(self.orgs)
        fg = self.food.reshape(p.h, p.w)[:grid * (p.h // grid), :grid * (p.w // grid)]
        fg = fg.reshape(grid, p.h // grid, grid, p.w // grid).mean(axis=(1, 3))
        fgrid = np.fromiter((int(v * 255) for v in fg.ravel()), np.uint8, grid * grid)
        base = {"t": self.tick, "f": fgrid.tobytes().hex()}
        if not n:
            return {**base, "n": 0}
        picks = sorted(self.snap_rng.sample(range(n), cap)) if n > cap else range(n)
        sel = [self.orgs[i] for i in picks]
        m = len(sel)
        g = np.array([o.g for o in sel], dtype=np.float64)
        e = np.fromiter((o.e for o in sel), dtype=np.float64, count=m)
        return {**base, "n": m, "sampled": n > cap,
                "cell": np.fromiter((o.cell for o in sel), np.uint16, m).tobytes().hex(),
                "g": np.clip(g * 255, 0, 255).astype(np.uint8).tobytes().hex(),
                "e": np.fromiter((min(255, int(v / 55 * 255)) for v in e),
                                 np.uint8, m).tobytes().hex()}

    def lineage(self):
        return {"n": len(self.parent_of), "parent": self.parent_of,
                "hue": [round(v, 3) for v in self.hue_of],
                "size": [round(v, 3) for v in self.size_of],
                "born": self.born_of, "died": self.died_of, "deaths": self.deaths}

    def state(self):
        s = self.rng.getstate()
        return {
            "params": self.p.to_json(), "tick": self.tick, "next_id": self.next_id,
            "fertility": self.fertility.tobytes().hex(),
            "food": self.food.tobytes().hex(),
            "orgs": [[o.id, o.cell, o.e, o.age, o.parent] + o.g for o in self.orgs],
            "lineage": [self.parent_of, self.hue_of, self.size_of, self.born_of,
                        self.died_of, self.deaths],
            "rng": [s[0], list(s[1]), s[2]],
        }

    @classmethod
    def load(cls, blob):
        """Restore a world without re-deriving anything, so a resumed run is identical."""
        p = Params(**blob["params"])
        rng = random.Random()
        s = blob["rng"]
        rng.setstate((s[0], tuple(s[1]), s[2]))
        w = cls.__new__(cls)
        w.p, w.rng = p, rng
        w.cand = cls._build_cand(p)
        w.snap_rng = random.Random(p.seed + 9871)
        w.tick, w.next_id = blob["tick"], blob["next_id"]
        w.births, w.deaths_alive = 0, 0
        w.deaths_this = {"starved": 0, "age": 0, "eaten": 0}
        w.fertility = np.frombuffer(bytes.fromhex(blob["fertility"]), np.float64)
        w.food = np.frombuffer(bytes.fromhex(blob["food"]), np.float64).copy()
        pl, hl, sl, bl, dl, xs = blob["lineage"]
        w.parent_of, w.hue_of, w.size_of = list(pl), list(hl), list(sl)
        w.born_of, w.died_of, w.deaths = list(bl), list(dl), list(xs)
        w.orgs = []
        for row in blob["orgs"]:
            o = w._init_derived(Org(row[0], row[1], row[2], row[5:], row[4]))
            o.age = row[3]
            w.orgs.append(o)
        return w
