// Headless render check. Runs the dashboard's own JS against a fake DOM that records every
// canvas draw call *with its arguments and its style*, then compares that draw tape against
// a blessed golden.
//
// Counting draw calls, as this used to do, cannot tell a correct chart from one drawn
// off-axis, off-scale or in the wrong colour. The tape can: it is the exact sequence of
// marks the page asked for.
//
// usage: node tools/render_check.js out/arms.html          # compare against the golden
//        node tools/render_check.js out/arms.html --bless  # rewrite the golden
//        node tools/render_check.js out/arms.html --sheet  # also write out/sheet.svg
//        node tools/render_check.js out/arms.html --dump   # write full tapes to out/tape/
//
// Goldens live in tests/golden/render/<artifact>.json: a digest of the whole tape per canvas
// plus counts, extent and the first ops. They pin geometry and colour but not rasterisation,
// so they are stable across machines - unlike screenshot diffs. What a tape cannot see
// (series colours too close to tell apart, text overflowing its box, one chart painted behind
// another) is what --sheet is for: it replays the tape as SVG to eyeball.
const fs = require("fs"), path = require("path"), vm = require("vm"), crypto = require("crypto");

const argv = process.argv.slice(2);
const has = f => argv.includes(f);
const target = argv.find(a => !a.startsWith("--"));
const GOLDEN_DIR = process.env.EVO_RENDER_GOLDEN || path.join("tests", "golden", "render");

/* ---------------- draw tape ---------------- */

// Calls the dashboard is allowed to make on a 2d context. Anything else still resolves to a
// no-op so an unlisted call fails loudly as "not a function" rather than silently.
const CALLS = new Set(["setTransform", "clearRect", "fillRect", "beginPath", "moveTo",
  "lineTo", "closePath", "arc", "fill", "stroke", "save", "restore", "translate", "rotate",
  "setLineDash", "fillText", "strokeText"]);
// Style that changes how a mark looks. Recorded so a colour regression is a tape diff.
const STYLE = ["fillStyle", "strokeStyle", "lineWidth", "font", "globalAlpha", "textAlign",
  "textBaseline", "shadowColor", "shadowBlur"];
// Ops that put ink down - the style at these moments is what matters.
const DRAW = new Set(["fill", "stroke", "fillText", "strokeText", "fillRect", "strokeRect"]);
// Ops whose (x, y) pairs bound the drawing. Pre-transform: a summary, not a visual bbox.
const GEOM = new Set(["moveTo", "lineTo", "arc", "rect", "fillRect", "strokeRect", "translate"]);

const traces = {};                       // canvas id -> {ops, counts, argbox}
const traceFor = id => traces[id] || (traces[id] = {
  ops: [], counts: {}, argbox: [Infinity, Infinity, -Infinity, -Infinity],
});
const num = v => typeof v === "number" ? (Object.is(v, -0) ? "0" : String(v))
  : JSON.stringify(v);

function ctxFor(id) {
  const tr = traceFor(id);
  let canvasEl;
  // Style is tracked here rather than read off the proxy at draw time, so that restore()
  // reverts it the way a real context does. Without that the tape would carry a colour
  // forward past the restore that cancelled it.
  const STYLE0 = {fillStyle: "#000", strokeStyle: "#000", lineWidth: "1", font: "10px sans-serif",
                  globalAlpha: "1", textAlign: "start", textBaseline: "alphabetic",
                  shadowColor: "rgba(0, 0, 0, 0)", shadowBlur: "0"};
  let cur = {...STYLE0};
  const stack = [];
  let pending = {};
  return new Proxy({}, {
    get(t, k) {
      if (k === "canvas") return canvasEl || (canvasEl = el(id));
      if (typeof k !== "string") return t[k];
      if (k === "measureText") return s => ({width: String(s).length * 6});
      if (!(k in t)) {
        t[k] = CALLS.has(k) ? (...a) => {
          tr.counts[k] = (tr.counts[k] || 0) + 1;
          if (k === "save") stack.push({...cur});
          if (k === "restore" && stack.length) {
            const prev = stack.pop();
            for (const s of STYLE) if (prev[s] !== cur[s]) pending[s] = prev[s];
            cur = prev;
          }
          if (GEOM.has(k)) {
            const b = tr.argbox;
            for (let i = 0; i + 1 < a.length; i += 2) {
              const x = a[i], y = a[i + 1];
              if (typeof x === "number" && typeof y === "number" && isFinite(x) && isFinite(y)) {
                if (x < b[0]) b[0] = x;
                if (y < b[1]) b[1] = y;
                if (x > b[2]) b[2] = x;
                if (y > b[3]) b[3] = y;
              }
            }
          }
          const op = {k, a: a.map(num)};
          if (DRAW.has(k)) { op.s = Object.keys(pending).length ? {...pending} : null; pending = {}; }
          tr.ops.push(op);
        } : 0;
      }
      return t[k];
    },
    set(t, k, v) {
      if (typeof k === "string" && STYLE.includes(k)) {
        cur[k] = String(v);
        pending[k] = String(v);
      }
      t[k] = v;
      return true;
    },
  });
}

// One line per op. This string *is* the thing being compared, so keep it total: every
// argument and every style change that reaches a mark.
const lineOf = o => o.k + "(" + o.a.join(",") + ")" +
  (o.s ? " {" + STYLE.filter(k => o.s[k] !== undefined)
    .map(k => k + "=" + o.s[k]).join(";") + "}" : "");
const tapeOf = tr => tr.ops.map(lineOf);
const digestOf = tape => crypto.createHash("sha256").update(tape.join("\n")).digest("hex").slice(0, 16);

/* ---------------- fake DOM ---------------- */

const html = fs.readFileSync(target || "out/arms.html", "utf8");
/* Run every inline script block in order, so this exercises the artifact a browser would
   load rather than a hand-picked pair of blocks. */
const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
if (!blocks.length) throw new Error("no inline script blocks found");
if (!/const TRACE = /.test(blocks[0])) throw new Error("first block is not the trace");

const VALS = {colorsel: "hue", fps: "12", tips: "320", lcolor: "hue", scrub: "0",
              livetpf: "4"};

// The page reads its palette with getComputedStyle(documentElement).getPropertyValue("--dim").
// Stubbing that to a constant would blind the tape to every colour defined in CSS, so take
// the real :root values - the default dark theme, which is what an empty dataset below means.
// The light theme is therefore not covered by these goldens.
const CSSVARS = {};
const rootBlock = /:root\s*\{([^}]*)\}/.exec(html);
if (rootBlock) {
  for (const m of rootBlock[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+)/g)) CSSVARS[m[1]] = m[2].trim();
}
if (!Object.keys(CSSVARS).length) throw new Error("no :root custom properties found - "
  + "the palette stub would be blind");

// Real canvas geometry as authored, so charts lay out at the height they will really have.
const SIZES = {};
for (const tag of html.matchAll(/<canvas\b[^>]*>/g)) {
  const at = name => {
    const m = new RegExp("\\b" + name + "=(\\d+)").exec(tag[0]);
    return m ? +m[1] : undefined;
  };
  const id = /\bid=(\S+)/.exec(tag[0]);
  if (id) SIZES[id[1]] = {width: at("width"), height: at("height")};
}


// The lineage tree draws a random subsample of tips (dashboard.html layoutTree), so an
// unseeded Math.random makes the draw tape different on every run. Seeding it pins the tape
// to one chosen subset. Note this only makes the *test* reproducible - in a real browser
// that tree still reshuffles whenever it is re-laid-out.
let _rs = 0x9e3779b9 >>> 0;
// Object.create, not spread: Math's properties are non-enumerable, so {...Math} is {}.
const MathS = Object.create(Math);
MathS.random = () => ((_rs = (_rs * 1664525 + 1013904223) >>> 0) / 4294967296);

function el(id) {
  const sz = SIZES[id] || {};
  // Height comes from the canvas attribute because the page trusts it (+cv.height). Width
  // does not: CSS is width:100%, so clientWidth is whatever the card lays out to and no
  // headless harness can know it. Fall back to the width attribute, then to a stand-in.
  const w = sz.width !== undefined ? sz.width : 400;
  const e = {
    id, width: w, height: sz.height !== undefined ? sz.height : 150,
    clientWidth: w, value: VALS[id] || "",
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
  console, Math: MathS, JSON, Date, Set, Map, Array, Object, Number, String, Int32Array,
  Float64Array, Uint8Array, Uint16Array, isFinite, parseInt, parseFloat, Error,
  setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0,
  requestAnimationFrame: cb => { rafQueue.push(cb); return rafQueue.length; },
  performance: {now: () => clock},
  getComputedStyle: () => ({getPropertyValue: p => CSSVARS[p] || ""}),
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
  let maxKills = 0, sawLerp = false;
  const FRAMES = 400;          // ~100 ticks at the 15 ticks/s default; clears tick 285,
                               // where predation starts in arms_race seed 1
  try {
    for (let f = 0; f < FRAMES; f++) {
      clock += 16.7;
      const q = rafQueue; rafQueue = [];
      for (const cb of q) cb(clock);
      if (ev("KILLS.length") > maxKills) maxKills = ev("KILLS.length");
      const u = ev("U");
      if (u > 0 && u < 1) sawLerp = true;
    }
  } catch (e) {
    console.log("LIVE LOOP ERROR:", e.stack.split("\n").slice(0, 4).join("\n"));
    process.exit(1);
  }
  const gained = ev("LIVE.world.tick") - before;
  const stats = ev("TRACE.stats.length"), snaps = ev("TRACE.snaps.length");
  console.log(`live: pumped ${FRAMES} frames, tick ${before} -> ${ev("LIVE.world.tick")} `
    + `(+${gained}), stats ${stats}/${ev("LIVE.history")} frames ${snaps}/${ev("LIVE.frames")}`);
  if (gained <= 0) { console.log("LIVE LOOP DREW BUT NEVER ADVANCED"); process.exit(1); }
  if (stats > ev("LIVE.history") || snaps > ev("LIVE.frames")) {
    console.log("LIVE HISTORY NOT BOUNDED"); process.exit(1);
  }
  if (stats < ev("LIVE.history")) { console.log("WINDOW NEVER FILLED, trim untested"); process.exit(1); }
  // the ticks/s select is rebuilt from --steps; read the markup the page wrote
  const tpsHtml = String(nodes.get("livetps").innerHTML);
  if (!tpsHtml.includes("selected>15<")) {
    console.log(`ticks/s control does not open at 15; it rendered: ${tpsHtml}`);
    process.exit(1);
  }
  const want = ev("LIVE.steps") * 60;
  if (!tpsHtml.includes(`>${want}<`)) {
    console.log(`ticks/s control dropped --steps ${ev("LIVE.steps")} (= ${want} ticks/s)`);
    process.exit(1);
  }
  // the picture must be a live frame: ids, plus the previous cell to interpolate from
  if (!ev("!!LIVEF && !!LIVEF.id") || ev("LIVEF.prev.length") !== ev("LIVEF.n")) {
    console.log("LIVE FRAME HAS NO ID OR NO PREVIOUS CELL, so nothing can interpolate");
    process.exit(1);
  }
  if (!sawLerp) {
    console.log("NEVER PAINTED BETWEEN TICKS, so playback is still stepping");
    process.exit(1);
  }
  if (maxKills === 0) {
    console.log("NO PREDATION REACHED THE RENDERER");
    process.exit(1);
  }
  console.log(`live: painted between ticks, ${maxKills} kill ring(s) on screen at once`);
}

/* ---------------- golden draw tape ---------------- */

const artifact = path.basename(target || "out/arms.html");

const actual = {};
for (const id of Object.keys(traces)) {
  const tr = traces[id], tape = tapeOf(tr);
  actual[id] = {
    ops: tr.ops.length,
    digest: digestOf(tape),
    counts: tr.counts,
    // Pre-transform extent of the geometry asked for. A scale or offset regression shows up
    // here even when the digest alone does not say where.
    argbox: tr.argbox.map(v => (isFinite(v) ? Math.round(v * 1000) / 1000 : null)),
    head: tape.slice(0, 40),
  };
  if (has("--dump")) (actual[id]._tape = tape);
}
if (has("--dump")) {
  const dir = path.join(path.dirname(target || "out/arms.html"), "tape", artifact.replace(/\.html$/, ""));
  fs.mkdirSync(dir, {recursive: true});
  for (const id of Object.keys(actual)) {
    fs.writeFileSync(path.join(dir, id + ".txt"), actual[id]._tape.join("\n") + "\n");
    delete actual[id]._tape;
  }
  console.log("dumped full draw tapes to", dir);
}
const gpath = path.join(GOLDEN_DIR, artifact.replace(/\.html$/, "") + ".json");
// The scenario identity: if this drifts, the artifact was emitted with different flags than
// the golden was blessed with, and every diff below is meaningless.
const scenario = nodes.get("meta")?.textContent || "";

let bad = 0;
if (has("--bless")) {
  fs.mkdirSync(GOLDEN_DIR, {recursive: true});
  fs.writeFileSync(gpath, JSON.stringify({artifact, scenario, canvases: actual}, null, 1));
  console.log(`blessed ${Object.keys(actual).length} canvases -> ${gpath}`);
  process.exit(0);
}

if (!fs.existsSync(gpath)) {
  console.log(`no golden for ${artifact} at ${gpath}\n`
    + `  run: node tools/render_check.js ${target} --bless`);
  process.exit(1);
}
const golden = JSON.parse(fs.readFileSync(gpath, "utf8"));
if (golden.scenario !== scenario) {
  console.log(`SCENARIO CHANGED: golden blessed for "${golden.scenario}", `
    + `this artifact is "${scenario}".\n  Different emit flags - the diffs below are noise.`);
  bad++;
}

const ids = [...new Set([...Object.keys(golden.canvases), ...Object.keys(actual)])].sort();
console.log("canvas             ops  digest            check");
for (const id of ids) {
  const g = golden.canvases[id], a = actual[id];
  let note = "ok";
  if (!a) { note = "in golden but DREW NOTHING NOW"; bad++; }
  else if (!g) { note = "draws but NOT IN GOLDEN (re-bless)"; bad++; }
  else if (g.digest !== a.digest) {
    note = "TAPE DIFFERS";
    bad++;
  }
  console.log(`${id.padEnd(17)}${String(a ? a.ops : g.ops).padStart(5)}  `
    + `${(a ? a.digest : g.digest).slice(0, 16)}  ${note}`);
  if (g && a && g.digest !== a.digest) {
    // Localise it. The golden keeps only the first ops, so an early change prints exactly;
    // a late one falls back to what changed in aggregate plus a pointer to the full tape.
    let i = 0;
    while (i < Math.min(g.head.length, a.head.length) && g.head[i] === a.head[i]) i++;
    if (i < Math.min(g.head.length, a.head.length)) {
      console.log(`       differs at op ${i}:`);
      console.log(`         golden  ${g.head[i]}`);
      console.log(`         actual  ${a.head[i]}`);
    } else {
      const keys = [...new Set([...Object.keys(g.counts), ...Object.keys(a.counts)])];
      const cd = keys.filter(k => (g.counts[k] || 0) !== (a.counts[k] || 0))
        .map(k => `${k} ${g.counts[k] || 0}->${a.counts[k] || 0}`);
      console.log(`       ops ${g.ops}->${a.ops}${cd.length ? ", calls " + cd.join(", ") : ""}`);
      console.log(`       argbox golden [${g.argbox}] actual [${a.argbox}]`);
      console.log(`       beyond the first ${g.head.length} ops - rerun both with --dump and diff`);
    }
  }
}

/* ---------------- contact sheet ---------------- */

if (has("--sheet")) {
  // Replay the tape as SVG. Transforms are honoured; clipping is not, and stroke width is
  // not scaled. Good enough to judge layout, colour and legibility - not pixel truth.
  const mul = (m, n) => [m[0]*n[0]+m[2]*n[1], m[1]*n[0]+m[3]*n[1],
                         m[0]*n[2]+m[2]*n[3], m[1]*n[2]+m[3]*n[3],
                         m[0]*n[4]+m[2]*n[5]+m[4], m[1]*n[4]+m[3]*n[5]+m[5]];
  const tp = (m, x, y) => [m[0]*x+m[2]*y+m[4], m[1]*x+m[3]*y+m[5]];
  const CELL = 300, COLS = 4, ROWH = CELL + 30;
  const cells = [], overflow = [];
  for (const id of ids) {
    const a = actual[id];
    if (!a) continue;
    const sz = el(id);
    let m = [1, 0, 0, 1, 0, 0];
    const stack = [];
    let st = {fillStyle: "#000", strokeStyle: "#000", lineWidth: 1, font: "10px sans-serif",
              globalAlpha: 1, textAlign: "start", textBaseline: "alphabetic"};
    let subs = [], cur = [];
    const body = [];
    // Where the page actually asked to draw, in canvas space, so marks landing outside the
    // canvas are reported instead of waiting for a human to notice them.
    const box = [Infinity, Infinity, -Infinity, -Infinity];
    const mark = (x, y) => {
      if (!isFinite(x) || !isFinite(y)) return;
      if (x < box[0]) box[0] = x;
      if (y < box[1]) box[1] = y;
      if (x > box[2]) box[2] = x;
      if (y > box[3]) box[3] = y;
    };
    const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const pathD = () => subs.concat(cur.length ? [cur] : [])
      .filter(s => s.length > 1)
      .map(s => "M" + s.map(p => p[0].toFixed(1) + " " + p[1].toFixed(1)).join("L")).join("");
    for (const o of traces[id].ops) {
      const A = o.a.map(Number);
      if (o.s) st = {...st, ...o.s};
      switch (o.k) {
        case "save": stack.push([m, {...st}]); break;
        case "restore": if (stack.length) [m, st] = stack.pop(); break;
        case "setTransform": m = A.slice(0, 6); break;
        case "translate": m = mul(m, [1, 0, 0, 1, A[0], A[1]]); break;
        case "rotate": {
          const c = Math.cos(A[0]), s = Math.sin(A[0]);
          m = mul(m, [c, s, -s, c, 0, 0]);
          break;
        }
        case "beginPath": subs = []; cur = []; break;
        case "moveTo": if (cur.length > 1) subs.push(cur); cur = [tp(m, A[0], A[1])]; break;
        case "lineTo": cur.push(tp(m, A[0], A[1])); break;
        case "closePath": if (cur.length > 1) subs.push(cur), cur = []; break;
        case "arc": {                       // polyline: fine for eyeballing, not exact
          const [cx, cy, r, a0, a1] = A;
          let span = a1 - a0;
          if (span < 0) span += 2 * Math.PI;
          const n = Math.max(6, Math.ceil(Math.abs(span) / (Math.PI / 12)));
          const pts = [];
          for (let i = 0; i <= n; i++) {
            const t = a0 + span * i / n;
            pts.push(tp(m, cx + r * Math.cos(t), cy + r * Math.sin(t)));
          }
          if (cur.length) { subs.push(cur); cur = []; }
          subs.push(pts);
          break;
        }
        case "fill": case "stroke": {
          const d = pathD();
          for (const s of subs.concat([cur])) for (const p of s) mark(p[0], p[1]);
          if (d) body.push(`<path d="${d}" ${o.k === "fill"
            ? `fill="${st.fillStyle}" fill-rule="nonzero"` : `fill="none"`
            } stroke="${o.k === "stroke" ? st.strokeStyle : "none"}" `
            + `stroke-width="${st.lineWidth}" opacity="${st.globalAlpha}"/>`);
          break;
        }
        case "fillRect": {
          const [x0, y0] = tp(m, A[0], A[1]), [x1, y1] = tp(m, A[0] + A[2], A[1] + A[3]);
          mark(x0, y0); mark(x1, y1);
          body.push(`<rect x="${Math.min(x0, x1).toFixed(1)}" y="${Math.min(y0, y1).toFixed(1)}" `
            + `width="${Math.abs(x1 - x0).toFixed(1)}" height="${Math.abs(y1 - y0).toFixed(1)}" `
            + `fill="${st.fillStyle}" opacity="${st.globalAlpha}"/>`);
          break;
        }
        case "fillText": {
          const [x, y] = tp(m, Number(o.a[1]), Number(o.a[2]));
          const size = /\d+(?:\.\d+)?px/.exec(st.font)?.[0].replace("px", "") || "10";
          const anchor = st.textAlign === "center" ? "middle"
            : (st.textAlign === "right" || st.textAlign === "end") ? "end" : "start";
          // Mark the glyph run, not just its anchor, or a label that runs off the right edge
          // looks in-bounds. Width is the same 0.6em-per-char guess the stub measureText uses.
          const tw = JSON.parse(o.a[0]).length * size * 0.6;
          const x0 = anchor === "middle" ? x - tw / 2 : anchor === "end" ? x - tw : x;
          mark(x0, y); mark(x0 + tw, y);
          body.push(`<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-size="${size}" `
            + `text-anchor="${anchor}" fill="${st.fillStyle}" opacity="${st.globalAlpha}" `
            + `font-family="sans-serif">${esc(JSON.parse(o.a[0]))}</text>`);
          break;
        }
        default: break;                     // clearRect, setLineDash: no visible geometry
      }
    }
    const pad = 1;                           // a mark 1px out is rounding, not a bug
    if (isFinite(box[0]) && (box[0] < -pad || box[1] < -pad
        || box[2] > sz.width + pad || box[3] > sz.height + pad)) {
      overflow.push(`${id} (${sz.width}x${sz.height}) drew to `
        + `[${box.map(v => Math.round(v)).join(", ")}]`);
    }
    cells.push({id, w: sz.width, h: sz.height, body: body.join("")});
  }
  const rows = Math.ceil(cells.length / COLS);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${COLS * (CELL + 12)}" `
    + `height="${rows * ROWH}" viewBox="0 0 ${COLS * (CELL + 12)} ${rows * ROWH}">`
    + `<rect width="100%" height="100%" fill="#14171c"/>`
    + cells.map((c, i) => {
        const x = (i % COLS) * (CELL + 12), y = Math.floor(i / COLS) * ROWH;
        const s = Math.min(CELL / c.w, CELL / c.h);
        return `<g transform="translate(${(x + 6).toFixed(1)},${(y + 22).toFixed(1)}) `
          + `scale(${s.toFixed(4)})">`
          + `<rect width="${c.w}" height="${c.h}" fill="none" stroke="#333"/>${c.body}</g>`
          + `<text x="${x + 6}" y="${y + 14}" fill="#8fa" font-size="12" `
          + `font-family="monospace">${c.id} ${c.w}x${c.h}</text>`;
      }).join("")
    + "</svg>";
  const out = path.join(path.dirname(target || "out/arms.html"), "sheet.svg");
  fs.writeFileSync(out, svg);
  console.log(`\nsheet: ${out} - open it and look for overlap, unreadable colours, `
    + "or text outside its panel");
  if (overflow.length) {
    console.log("OVERFLOW - drew outside its canvas:");
    for (const o of overflow) console.log("  " + o);
  }
}

console.log("\nreadout:", nodes.get("readout")?.textContent || "(none)");
console.log("lstats :", (nodes.get("lstats")?.innerHTML || "").replace(/<[^>]*>/g, " ").trim());
console.log("meta   :", scenario);
console.log(bad ? `\n${bad} mismatch(es) vs ${gpath}` : "\nall charts draw the blessed tape");
process.exit(bad ? 1 : 0);
