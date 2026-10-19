// Headless render check: run the dashboard's own JS against a fake DOM that records
// every canvas draw call. Proves (a) no runtime errors, (b) each chart draws something.
// usage: node tools/render_check.js out/arms.html
const fs = require("fs"), vm = require("vm");

const html = fs.readFileSync(process.argv[2] || "out/arms.html", "utf8");
/* Run every inline script block in order, so this exercises the artifact a browser would
   load rather than a hand-picked pair of blocks. */
const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
if (!blocks.length) throw new Error("no inline script blocks found");
if (!/const TRACE = /.test(blocks[0])) throw new Error("first block is not the trace");

const ops = {};          // canvas id -> {opName: count}
function ctxFor(id) {
  const rec = ops[id] || (ops[id] = {});
  const c = new Proxy({}, {
    get(t, k) {
      if (k === "canvas") return {width: 512, height: 512};
      if (typeof k === "string" && !(k in t)) {
        // record drawing calls, allow style/number properties to be set freely
        t[k] = ["setTransform", "clearRect", "fillRect", "beginPath", "moveTo", "lineTo",
                "closePath", "arc", "fill", "stroke", "save", "restore", "translate",
                "rotate", "setLineDash", "fillText", "strokeText"].includes(k)
          ? (...a) => { rec[k] = (rec[k] || 0) + 1; }
          : (k === "measureText" ? (s) => ({width: String(s).length * 6}) : 0);
      }
      return t[k];
    },
    set(t, k, v) { t[k] = v; return true; },
  });
  return c;
}
const VALS = {colorsel: "hue", fps: "12", tips: "320", lcolor: "hue", scrub: "0",
              livetpf: "4"};
function el(id) {
  const e = {
    id, width: 512, height: 150, clientWidth: 400, value: VALS[id] || "",
    checked: id === "foodbg" || id === "trail" ? id === "foodbg" : true,
    innerHTML: "", textContent: "", max: "0",
    classList: {toggle() {}, contains: () => true, add() {}, remove() {}},
    dataset: {}, style: {},
    getContext: () => ctxFor(id),
    addEventListener() {}, appendChild() {},
  };
  return e;
}
const nodes = new Map();
const buttons = ["replay", "charts", "lineage", "about"].map(tab => {
  const b = el("nav-" + tab); b.dataset = {tab}; return b;
});
let rafQueue = [], clock = 0;
const sandbox = {
  console, Math, JSON, Date, Set, Map, Array, Object, Number, String, Int32Array,
  Float64Array, Uint8Array, Uint16Array, isFinite, parseInt, parseFloat, Error,
  setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0,
  requestAnimationFrame: cb => { rafQueue.push(cb); return rafQueue.length; },
  performance: {now: () => clock},
  getComputedStyle: () => ({getPropertyValue: () => "#fff"}),
  addEventListener: () => {},
  document: {
    documentElement: {dataset: {}},
    querySelector: sel => {
      const id = sel.replace(/^#/, "");
      if (!nodes.has(id)) nodes.set(id, el(id));
      return nodes.get(id);
    },
    querySelectorAll: sel => (sel === "nav button" ? buttons : []),
  },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
try {
  for (let i = 0; i < blocks.length; i++) {
    vm.runInContext(blocks[i], sandbox, {filename: `block${i}`});
  }
  // the app only paints a tab when it is clicked, so click every tab
  for (const b of buttons) b.onclick && b.onclick();
} catch (e) {
  console.log("RUNTIME ERROR:", e.stack.split("\n").slice(0, 4).join("\n"));
  process.exit(1);
}

/* Live mode: pump the animation loop the way a browser would, and confirm the world
   actually advanced rather than just surviving one paint. */
const ev = expr => vm.runInContext(expr, sandbox);   // `const` bindings are not sandbox props
const isLive = !!ev("typeof LIVE === 'object' && LIVE");

/* The page must boot the *right* world, not merely a world: compare its warm-up against
   the Python golden trace for the same preset+seed. Catches a mis-wired rng or params. */
if (isLive) {
  const gp = "evo/web/golden.json";
  const c = fs.existsSync(gp) && JSON.parse(fs.readFileSync(gp, "utf8")).cases
    .find(x => x.preset === ev("LIVE.preset") && x.seed === ev("LIVE.seed"));
  if (!c) {
    console.log(`golden: no case for ${ev("LIVE.preset")} seed=${ev("LIVE.seed")}`
      + " - emit with a seeded preset to cross-check");
  } else {
    const n = Math.min(15, ev("TRACE.stats.length"), c.rows.length);
    let worst = 0;
    for (let i = 0; i < n; i++) worst = Math.max(worst, Math.abs(ev(`TRACE.stats[${i}].pop`) - c.rows[i][0]));
    const tail = ev("TRACE.stats.length") - 1;
    const drift = Math.abs(ev(`TRACE.stats[${tail}].pop`) - c.rows[tail][0]) / c.rows[tail][0];
    const lived = ev("TRACE.lineage.n");
    console.log(`golden: first ${n} ticks max |pop diff| = ${worst}; `
      + `tick ${tail + 1} drift ${(drift * 100).toFixed(1)}%; lineage ${lived}`);
    if (worst > 0) { console.log("LIVE PAGE DOES NOT MATCH THE PYTHON WORLD"); process.exit(1); }
    if (drift > 0.09) { console.log("LIVE PAGE DRIFTED PAST TOLERANCE"); process.exit(1); }
    // lineage.n is capacity in the JS typed arrays unless ln is used - a wrong value here
    // fills the tree with organisms that never existed.
    if (lived > c.lived * 1.1) {
      console.log(`lineage: page reports ${lived} ever lived, Python says ${c.lived} `
        + `- likely array capacity instead of ln`);
      process.exit(1);
    }
  }
}

/* Live mode: pump the animation loop the way a browser would. Caps are shrunk first so
   the sliding-window path (splice, cache clear, tick rebasing) actually runs. */
if (isLive) {
  ev("LIVE.history = 150; LIVE.frames = 8;");
  const before = ev("LIVE.world.tick");
  try {
    for (let f = 0; f < 30; f++) {
      clock += 16.7;
      const q = rafQueue; rafQueue = [];
      for (const cb of q) cb(clock);
    }
  } catch (e) {
    console.log("LIVE LOOP ERROR:", e.stack.split("\n").slice(0, 4).join("\n"));
    process.exit(1);
  }
  const gained = ev("LIVE.world.tick") - before;
  const stats = ev("TRACE.stats.length"), snaps = ev("TRACE.snaps.length");
  console.log(`live: pumped 30 frames, tick ${before} -> ${ev("LIVE.world.tick")} `
    + `(+${gained}), stats ${stats}/${ev("LIVE.history")} frames ${snaps}/${ev("LIVE.frames")}`);
  if (gained <= 0) { console.log("LIVE LOOP DREW BUT NEVER ADVANCED"); process.exit(1); }
  if (stats > ev("LIVE.history") || snaps > ev("LIVE.frames")) {
    console.log("LIVE HISTORY NOT BOUNDED"); process.exit(1);
  }
  if (stats < ev("LIVE.history")) { console.log("WINDOW NEVER FILLED, trim untested"); process.exit(1); }
  // the ticks/frame select is rebuilt from --steps; read the markup the page wrote
  const tpfHtml = String(nodes.get("livetpf").innerHTML);
  if (!tpfHtml.includes(`selected>${ev("LIVE.steps")}<`)) {
    console.log(`ticks/frame control does not select ${ev("LIVE.steps")}; it rendered: ${tpfHtml}`);
    process.exit(1);
  }
  console.log("livestat:", nodes.get("livestat")?.textContent || "(none)");
  console.log("readout :", (nodes.get("readout")?.innerHTML || "(none)").replace(/<[^>]*>/g, " "));
}

const want = ["world", "c_pop", "c_deaths", "c_energy", "c_div", "t_mean", "t_std",
              "t_ridge_size", "t_ridge_speed", "t_scatter1", "t_scatter2", "c_flux",
              "c_fat", "tree", "t_depth"];
let bad = 0;
console.log("canvas            strokes  fills  texts");
for (const id of want) {
  const r = ops[id] || {};
  const st = r.stroke || 0, fi = r.fill || 0, tx = r.fillText || 0;
  const ok = st + fi > 0;
  if (!ok) bad++;
  console.log(`${id.padEnd(17)}${String(st).padStart(7)}${String(fi).padStart(7)}` +
              `${String(tx).padStart(7)}  ${ok ? "ok" : "NOTHING DRAWN"}`);
}
console.log("\nreadout:", nodes.get("readout")?.textContent || "(none)");
console.log("lstats :", (nodes.get("lstats")?.innerHTML || "").replace(/<[^>]*>/g, " ").trim());
console.log("meta   :", nodes.get("meta")?.textContent);
console.log(bad ? `\n${bad} canvas(es) drew nothing` : "\nall charts drew");
process.exit(bad ? 1 : 0);
