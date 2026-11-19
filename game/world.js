/* The Glomus world: terrain, water, weather and the thread language. No DOM; an ES module that runs in the
 page and in Node.

 The map is a grid of tiles. Each tile has a terrain height (metres), a water depth, carried silt and a
 material. Water flows downhill and leaves over the south edge; fast water erodes soft ground and drops
 silt where it slows. Everything else that happens is written in the thread language, including the
 built-in "Nature" skein, so a whim can read, extend or switch off any of it.

 A whim's plan (what the model returns) is JSON:
   { "name": "...", "say": "...", "materials": [...], "edits": [...], "threads": [...], "switch_off": [ids] }
 checkPlan() validates and normalizes it, keeping what is usable and listing what is not; acceptPlan()
 turns it into a skein that can be switched off or erased.

 Vocabulary: a thread is one rule that keeps running in the world; a skein is everything one whim made
 (its materials, edits and threads), which can be switched off or erased as a unit.
*/

const W = 96, H = 64, N = W * H;
const TPS = 10, DT = 1 / TPS;
const MAX_H = 30, WET = 0.05;
const DIRS = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] };
const N4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const N8 = N4.concat([[1, 1], [1, -1], [-1, 1], [-1, -1]]);
const BUILTIN = [
  { name: "soil", color: "#8a6a45", erodes: 0.6 },
  { name: "sand", color: "#d9c58f", erodes: 1 },
  { name: "stone", color: "#8e9096", erodes: 0.05 },
  { name: "meadow", color: "#6c9a46", erodes: 0.3 },
  { name: "snow", color: "#eef2f6", erodes: 0.1 },
];
const LIMITS = { threads: 6, edits: 8, materials: 4, powers: 3, species: 2, speciesTotal: 8, release: 6, creatures: 24, conds: 6, actions: 6, pathPoints: 40, skeins: 60, materialsTotal: 24 };

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const isNum = (v) => typeof v === "number" && Number.isFinite(v);

// ---------- randomness (seeded, saved with the world) ----------
function rand(world, stream = "rng") {
  let t = (world[stream] = (world[stream] + 0x6d2b79f5) | 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
function hash2(ix, iy, seed) {
  let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed, 1274126177)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
function noise(x, y, seed) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy, seed), b = hash2(ix + 1, iy, seed), c = hash2(ix, iy + 1, seed), d = hash2(ix + 1, iy + 1, seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}
function fbm(x, y, seed) {
  let v = 0, amp = 0.5, f = 1;
  for (let o = 0; o < 5; o++) { v += amp * noise(x * f, y * f, seed + o * 17); amp *= 0.5; f *= 2; }
  return v / 0.96875;
}

// ---------- the world ----------
function blank(seed) {
  return {
    version: 1, w: W, h: H, seed, tick: 0, rng: seed | 0, wrng: (seed ^ 0x5bd1e995) | 0,
    height: new Float32Array(N), water: new Float32Array(N), silt: new Float32Array(N),
    mat: new Uint8Array(N), flux: new Float32Array(N),
    materials: BUILTIN.map((m) => ({ ...m })), skeins: [], nextSkein: 1, nextUse: 1,
    species: [], creatures: [], graveyard: [], nextCreature: 1, crng: (seed ^ 0x2545f491) | 0, whims: 0,
    weather: { raining: false, until: 900 },
    _compiled: new Map(),
  };
}

function makeWorld(seed, warmTicks = 900) {
  seed = (seed >>> 0) || 1;
  const world = blank(seed);
  const h = world.height;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let v = 3 + 22 * Math.pow(1 - y / H, 1.4);
    v += (fbm(x / 20, y / 20, seed) - 0.5) * 14;
    v += 5 * Math.exp(-Math.pow((y - 9) / 6, 2)) * fbm(x / 9, y / 9, seed + 99);
    v -= 7 * Math.exp(-((x - 60) ** 2 + (y - 38) ** 2) / 128);
    h[y * W + x] = clamp(v, 0, MAX_H);
  }
  const soil = 0, sand = 1, stone = 2;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    const gx = h[y * W + Math.min(W - 1, x + 1)] - h[y * W + Math.max(0, x - 1)];
    const gy = h[Math.min(H - 1, y + 1) * W + x] - h[Math.max(0, y - 1) * W + x];
    const slope = Math.hypot(gx, gy) / 2;
    world.mat[i] = h[i] > 20 || slope > 1.6 ? stone : h[i] < 4.5 ? sand : soil;
  }
  let spring = [28, 12], best = -1;
  for (let y = 8; y <= 18; y++) for (let x = 14; x <= 42; x++) if (h[y * W + x] > best) { best = h[y * W + x]; spring = [x, y]; }
  addSkein(world, {
    kind: "nature", name: "Nature (built in)",
    say: "How this world behaves on its own. It is written in the same thread language as every whim.",
    threads: NATURE(spring),
  });
  for (let t = 0; t < warmTicks; t++) step(world);
  world.tick = 0;
  world.weather = { raining: false, until: 600 };
  addWildlife(world);
  return world;
}

const NATURE = (spring) => [
  { name: "The old spring", area: { circle: [spring[0], spring[1], 1.5] }, when: [], do: [{ add_water: 2 }] },
  { name: "Meadows grow beside water", area: "everywhere",
    when: [{ material: ["soil"] }, { near: "water", count: [">=", 2] }, { chance: 0.08 }], do: [{ set_material: "meadow" }] },
  { name: "Meadows wither when dry", area: "everywhere",
    when: [{ material: ["meadow"] }, { near: "water", count: ["<", 1] }, { chance: 0.01 }], do: [{ set_material: "soil" }] },
  { name: "Snow falls on the peaks", area: "everywhere",
    when: [{ raining: true }, { height: [">", 23] }, { material: ["stone"] }, { chance: 0.1 }], do: [{ set_material: "snow" }] },
  { name: "Snow melts into water", area: "everywhere",
    when: [{ material: ["snow"] }, { raining: false }], do: [{ add_water: 0.01 }] },
  { name: "Snow clears off", area: "everywhere",
    when: [{ material: ["snow"] }, { raining: false }, { chance: 0.015 }], do: [{ set_material: "stone" }] },
];

// ---------- physics ----------
function weather(world) {
  const wx = world.weather;
  if (world.tick < wx.until) return;
  wx.raining = !wx.raining;
  wx.until = world.tick + Math.round((wx.raining ? 15 + 15 * rand(world, "wrng") : 60 + 70 * rand(world, "wrng")) * TPS);
}

function flowWater(world) {
  const h = world.height, w = world.water, s = world.silt, flux = world.flux;
  const dw = world._dw || (world._dw = new Float32Array(N));
  const ds = world._ds || (world._ds = new Float32Array(N));
  dw.fill(0); ds.fill(0);
  const d = [0, 0, 0, 0], target = [0, 0, 0, 0];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, wi = w[i];
    if (wi < 1e-4) { flux[i] = 0; continue; }
    const head = h[i] + wi;
    let total = 0;
    for (let k = 0; k < 4; k++) {
      const nx = x + N4[k][0], ny = y + N4[k][1];
      let nhead, j = -1;
      if (ny >= H) nhead = h[i] - 0.5; // The south edge drains off the map.
      else if (nx < 0 || ny < 0 || nx >= W) nhead = Infinity;
      else { j = ny * W + nx; nhead = h[j] + w[j]; }
      const diff = head - nhead;
      d[k] = diff > 0 ? diff : 0; target[k] = j; total += d[k];
    }
    if (total <= 0) { flux[i] = 0; continue; }
    const out = Math.min(wi, total * 0.2), scale = out / total, siltOut = s[i] * (out / wi);
    flux[i] = out;
    for (let k = 0; k < 4; k++) {
      if (d[k] <= 0 || target[k] < 0) continue;
      dw[target[k]] += d[k] * scale;
      ds[target[k]] += siltOut * (d[k] / total);
    }
    dw[i] -= out; ds[i] -= siltOut;
  }
  for (let i = 0; i < N; i++) {
    w[i] = Math.max(0, w[i] + dw[i]);
    s[i] = Math.max(0, s[i] + ds[i]);
  }
}

function erodeAndEvaporate(world) {
  const h = world.height, w = world.water, s = world.silt, flux = world.flux, mats = world.materials;
  const rain = world.weather.raining ? 0.006 * DT : 0;
  for (let i = 0; i < N; i++) {
    const cap = flux[i] * 0.6;
    if (s[i] < cap) {
      const e = Math.min((cap - s[i]) * 0.02 * (mats[world.mat[i]] ? mats[world.mat[i]].erodes : 0.5), 0.01, h[i]);
      h[i] -= e; s[i] += e;
    } else if (s[i] > 0) {
      const dep = (s[i] - cap) * 0.1;
      h[i] = Math.min(MAX_H, h[i] + dep); s[i] -= dep;
      if (dep > 0.0004 && (world.mat[i] === 0 || world.mat[i] === 3) && rand(world) < 0.02) world.mat[i] = 1;
    }
    // Evaporation everywhere; shallow water also soaks into the ground.
    let wi = w[i] + rain - (w[i] < 0.25 ? 0.008 : 0.002) * DT;
    if (wi < 0.003) { h[i] = Math.min(MAX_H, h[i] + s[i]); s[i] = 0; wi = 0; }
    w[i] = wi;
  }
}

function step(world) {
  weather(world);
  flowWater(world);
  erodeAndEvaporate(world);
  runThreads(world);
  stepCreatures(world);
  world.tick++;
}

// ---------- areas ----------
function areaShape(area) {
  const cells = [], weight = [];
  if (area === "everywhere") {
    for (let i = 0; i < N; i++) { cells.push(i); weight.push(1); }
  } else if (area.circle) {
    const [cx, cy, r] = area.circle;
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const dist = Math.hypot(x - cx, y - cy);
      if (dist > r + 0.25) continue;
      cells.push(y * W + x); weight.push(0.5 * (1 + Math.cos(Math.PI * Math.min(1, dist / (r + 0.5)))));
    }
  } else if (area.rect) {
    const [rx, ry, rw, rh] = area.rect;
    for (let y = ry; y < ry + rh; y++) for (let x = rx; x < rx + rw; x++) {
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      cells.push(y * W + x); weight.push(1);
    }
  } else if (area.path) {
    const pts = area.path, half = area.width / 2, best = new Map();
    const segs = pts.length === 1 ? [[pts[0], pts[0]]] : pts.slice(1).map((p, k) => [pts[k], p]);
    for (const [a, b] of segs) {
      const x0 = Math.floor(Math.min(a[0], b[0]) - half - 1), x1 = Math.ceil(Math.max(a[0], b[0]) + half + 1);
      const y0 = Math.floor(Math.min(a[1], b[1]) - half - 1), y1 = Math.ceil(Math.max(a[1], b[1]) + half + 1);
      const dx = b[0] - a[0], dy = b[1] - a[1], len2 = dx * dx + dy * dy;
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const t = len2 ? clamp(((x - a[0]) * dx + (y - a[1]) * dy) / len2, 0, 1) : 0;
        const dist = Math.hypot(x - (a[0] + t * dx), y - (a[1] + t * dy));
        if (dist > half + 0.25) continue;
        const wt = dist <= half * 0.6 ? 1 : 0.5 * (1 + Math.cos(Math.PI * (dist - half * 0.6) / (half * 0.4 + 0.5)));
        const i = y * W + x;
        if (!best.has(i) || best.get(i) < wt) best.set(i, wt);
      }
    }
    for (const [i, wt] of best) { cells.push(i); weight.push(wt); }
  }
  return { cells: Int32Array.from(cells), weight: Float32Array.from(weight) };
}

function describeArea(area) {
  if (area === "everywhere") return "everywhere";
  if (area.circle) return `circle at (${area.circle[0]},${area.circle[1]}) r ${area.circle[2]}`;
  if (area.rect) return `rect from (${area.rect[0]},${area.rect[1]}) size ${area.rect[2]}x${area.rect[3]}`;
  const p = area.path;
  return `path (${p[0][0]},${p[0][1]})→(${p[p.length - 1][0]},${p[p.length - 1][1]}) width ${area.width}`;
}

// ---------- validation: turn a model's plan into something safe to run ----------
const ALIASES = {
  set: "set_material", become: "set_material", turn_into: "set_material", material: "set_material",
  add: "add_water", water: "add_water", spring: "add_water", drain: "drain_water", remove_water: "drain_water",
  push: "push_water", move_water: "push_water", pump: "push_water", grow: "spread",
};
const ACTIONS = ["set_material", "raise", "lower", "add_water", "drain_water", "push_water", "spread"];

function lowerName(v) { return typeof v === "string" ? v.trim().toLowerCase() : ""; }

function checkNumber(v, lo, hi, what, problems) {
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) v = Number(v);
  if (!isNum(v)) { problems.push(`${what} must be a number`); return null; }
  if (v < lo || v > hi) { problems.push(`${what} ${v} was outside ${lo}..${hi}, so it was clamped`); v = clamp(v, lo, hi); }
  return v;
}

function checkArea(raw, problems, spot) {
  if (raw === undefined || raw === null) { problems.push("missing area"); return null; }
  if (typeof raw === "string") {
    const s = lowerName(raw);
    if (["everywhere", "all", "map", "anywhere", "whole map", "world"].includes(s)) return "everywhere";
    if (["spot", "here", "selected", "the spot", "selection"].includes(s)) {
      if (spot) return { circle: [spot.x, spot.y, spot.r] };
      problems.push("area \"spot\" used but no spot is selected"); return null;
    }
    problems.push(`unknown area "${raw}"`); return null;
  }
  if (typeof raw !== "object") { problems.push("area must be an object or \"everywhere\""); return null; }
  const xy = (x, y, what) => {
    const cx = checkNumber(x, -10, W + 10, what + " x", problems), cy = checkNumber(y, -10, H + 10, what + " y", problems);
    return cx === null || cy === null ? null : [Math.round(clamp(cx, 0, W - 1)), Math.round(clamp(cy, 0, H - 1))];
  };
  let c = raw.circle;
  if (c === undefined && "r" in raw && "x" in raw && "y" in raw) c = [raw.x, raw.y, raw.r];
  if (c && !Array.isArray(c) && typeof c === "object") c = [c.x, c.y, c.r ?? c.radius];
  if (Array.isArray(c)) {
    const p = xy(c[0], c[1], "circle"), r = checkNumber(c[2], 0.5, 40, "circle radius", problems);
    return p && r !== null ? { circle: [p[0], p[1], Math.round(r * 2) / 2] } : null;
  }
  let rc = raw.rect;
  if (rc === undefined && "w" in raw && "h" in raw && "x" in raw && "y" in raw) rc = [raw.x, raw.y, raw.w, raw.h];
  if (rc && !Array.isArray(rc) && typeof rc === "object") rc = [rc.x, rc.y, rc.w ?? rc.width, rc.h ?? rc.height];
  if (Array.isArray(rc)) {
    const p = xy(rc[0], rc[1], "rect"), rw = checkNumber(rc[2], 1, W, "rect width", problems), rh = checkNumber(rc[3], 1, H, "rect height", problems);
    return p && rw !== null && rh !== null ? { rect: [p[0], p[1], Math.round(rw), Math.round(rh)] } : null;
  }
  const path = raw.path || raw.line || raw.points;
  if (Array.isArray(path)) {
    if (path.length < 1) { problems.push("path needs at least one point"); return null; }
    if (path.length > LIMITS.pathPoints) problems.push(`path had ${path.length} points; kept the first ${LIMITS.pathPoints}`);
    const pts = [];
    for (const pt of path.slice(0, LIMITS.pathPoints)) {
      const p = Array.isArray(pt) ? xy(pt[0], pt[1], "path point") : pt && typeof pt === "object" ? xy(pt.x, pt.y, "path point") : null;
      if (!p) { problems.push("each path point must be [x, y]"); return null; }
      pts.push(p);
    }
    const width = raw.width === undefined ? 2 : checkNumber(raw.width, 1, 12, "path width", problems);
    return width === null ? null : { path: pts, width: Math.round(width * 2) / 2 };
  }
  problems.push("area must have circle, rect or path");
  return null;
}

function checkCompare(raw, what, lo, hi, problems) {
  let op, value;
  if (Array.isArray(raw)) [op, value] = raw;
  else if (typeof raw === "string") { const m = raw.trim().match(/^(>=|<=|>|<)\s*(-?[\d.]+)$/); if (m) { op = m[1]; value = Number(m[2]); } }
  else if (isNum(raw)) { op = ">="; value = raw; }
  else if (raw && typeof raw === "object") {
    if ("op" in raw) { op = raw.op; value = raw.value; }
    else { const k = Object.keys(raw)[0]; op = k; value = raw[k]; }
  }
  if (op === "==" || op === "=") op = ">=";
  if (![">", "<", ">=", "<="].includes(op)) { problems.push(`${what} needs a comparison like [">", 0.2]`); return null; }
  const v = checkNumber(value, lo, hi, what, problems);
  return v === null ? null : [op, v];
}

function checkCond(raw, names, problems) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) { problems.push("each condition must be an object"); return null; }
  if ("not" in raw) { const inner = checkCond(raw.not, names, problems); return inner ? { not: inner } : null; }
  if ("material" in raw) {
    const list = (Array.isArray(raw.material) ? raw.material : [raw.material]).map(lowerName);
    const bad = list.filter((m) => !names.has(m));
    if (bad.length) { problems.push(`unknown material ${bad.join(", ")}`); return null; }
    return { material: list };
  }
  if ("water" in raw) { const c = checkCompare(raw.water, "water", 0, 40, problems); return c && { water: c }; }
  if ("height" in raw) { const c = checkCompare(raw.height, "height", 0, MAX_H, problems); return c && { height: c }; }
  if ("near" in raw) {
    const what = lowerName(raw.near);
    if (what !== "water" && !names.has(what)) { problems.push(`near: unknown material ${raw.near}`); return null; }
    const c = raw.count === undefined ? [">=", 1] : checkCompare(raw.count, "near count", 0, 8, problems);
    return c && { near: what, count: c };
  }
  if ("chance" in raw) { const c = checkNumber(raw.chance, 0, 1, "chance", problems); return c === null ? null : { chance: c }; }
  if ("cycle" in raw) {
    const cyc = checkNumber(raw.cycle, 1, 600, "cycle seconds", problems);
    if (cyc === null) return null;
    const from = raw.from === undefined ? 0 : checkNumber(raw.from, 0, cyc, "cycle from", problems);
    const to = raw.to === undefined ? cyc / 2 : checkNumber(raw.to, 0, cyc, "cycle to", problems);
    return from === null || to === null ? null : { cycle: cyc, from, to };
  }
  if ("raining" in raw) return { raining: !!raw.raining };
  for (const k of ["within", "after"]) {
    if (k in raw) { const v = checkNumber(raw[k], 1, 3600, k + " seconds", problems); return v === null ? null : { [k]: v }; }
  }
  problems.push(`unknown condition ${JSON.stringify(raw).slice(0, 60)}`);
  return null;
}

function checkAction(raw, names, problems) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) { problems.push("each action must be an object"); return null; }
  let key = Object.keys(raw).find((k) => ACTIONS.includes(k)) || Object.keys(raw).find((k) => ALIASES[k]);
  if (!key) { problems.push(`unknown action ${JSON.stringify(raw).slice(0, 60)}`); return null; }
  const name = ACTIONS.includes(key) ? key : ALIASES[key], v = raw[key];
  if (name === "set_material") {
    const m = lowerName(v);
    if (!names.has(m)) { problems.push(`set_material: unknown material ${v}`); return null; }
    return { set_material: m };
  }
  if (name === "raise" || name === "lower") { const n = checkNumber(v, 0, 5, name + " per second", problems); return n === null ? null : { [name]: n }; }
  if (name === "add_water" || name === "drain_water") { const n = checkNumber(v, 0, 10, name + " per second", problems); return n === null ? null : { [name]: n }; }
  if (name === "push_water") {
    const dir = lowerName(v);
    if (!DIRS[dir] && dir !== "downhill" && dir !== "uphill") { problems.push(`push_water direction must be north, south, east, west, downhill or uphill`); return null; }
    const amount = raw.amount === undefined ? 1 : checkNumber(raw.amount, 0, 10, "push_water amount", problems);
    return amount === null ? null : { push_water: dir, amount };
  }
  if (name === "spread") {
    const m = lowerName(v);
    if (!names.has(m)) { problems.push(`spread: unknown material ${v}`); return null; }
    const chance = raw.chance === undefined ? 0.2 : checkNumber(raw.chance, 0, 1, "spread chance", problems);
    const onto = raw.onto === undefined ? null : (Array.isArray(raw.onto) ? raw.onto : [raw.onto]).map(lowerName);
    if (onto && onto.some((o) => !names.has(o))) { problems.push(`spread onto: unknown material`); return null; }
    if (chance === null) return null;
    return onto ? { spread: m, chance, onto } : { spread: m, chance };
  }
  return null;
}

// Models sometimes pack several conditions into one object ({"material": [...], "chance": 0.1, "within": 60}).
// Reading only the first key would silently drop the rest (including a promised time limit), so split them.
const COND_KEYS = ["not", "material", "water", "height", "near", "chance", "cycle", "raining", "within", "after"];
const COND_COMPANIONS = { near: ["count"], cycle: ["from", "to"] };
function splitConds(list) {
  const out = [];
  for (const c of list) {
    const keys = c && typeof c === "object" && !Array.isArray(c) ? COND_KEYS.filter((k) => k in c) : [];
    if (keys.length <= 1) { out.push(c); continue; }
    for (const k of keys) {
      const one = { [k]: c[k] };
      for (const extra of COND_COMPANIONS[k] || []) if (extra in c) one[extra] = c[extra];
      out.push(one);
    }
  }
  return out;
}

function checkThread(raw, names, problems, spot) {
  const label = raw && typeof raw.name === "string" ? raw.name.trim().slice(0, 60) : "";
  const p = [];
  if (!raw || typeof raw !== "object") { problems.push("each thread must be an object"); return null; }
  const area = checkArea(raw.area ?? raw.where ?? raw.shape, p, spot);
  const whenRaw = splitConds(raw.when === undefined ? [] : Array.isArray(raw.when) ? raw.when : [raw.when]);
  const doRaw = raw.do === undefined ? (raw.then === undefined ? [] : raw.then) : raw.do;
  const acts = (Array.isArray(doRaw) ? doRaw : [doRaw]).slice(0, LIMITS.actions).map((a) => checkAction(a, names, p)).filter(Boolean);
  const conds = whenRaw.slice(0, LIMITS.conds).map((c) => checkCond(c, names, p)).filter(Boolean);
  const dropped = whenRaw.length - conds.length;
  for (const msg of p) problems.push(`thread "${label || "unnamed"}": ${msg}`);
  if (!area || !acts.length) { problems.push(`thread "${label || "unnamed"}" was dropped (${!area ? "no usable area" : "no usable action"})`); return null; }
  if (dropped > 0) { problems.push(`thread "${label || "unnamed"}" was dropped because ${dropped} condition(s) could not be read`); return null; }
  const chance = conds.filter((c) => "chance" in c).reduce((p, c) => p * c.chance, 1);
  const rated = acts.filter((a) => ["raise", "lower", "add_water", "drain_water"].some((k) => k in a) || a.push_water);
  if (chance < 1 && rated.length) {
    const [k, v] = Object.entries(rated[0])[0];
    problems.push(`note: thread "${label || "unnamed"}" has chance ${chance}, which also thins its per-second amounts: ${k} ${v} averages about ${+(Number(v) * chance).toFixed(3) || "a fraction"} per second. Leave chance out for a steady effect.`);
  }
  return { name: label || "Unnamed thread", area, when: conds, do: acts };
}

function checkEdit(raw, names, problems, spot) {
  const p = [];
  if (!raw || typeof raw !== "object") { problems.push("each edit must be an object"); return null; }
  const area = checkArea(raw.area ?? raw.shape ?? raw.where, p, spot);
  const edit = { area };
  for (const k of ["raise", "lower"]) if (raw[k] !== undefined) { const n = checkNumber(raw[k], 0, 15, k, p); if (n !== null) edit[k] = n; }
  if (raw.level !== undefined) { const n = checkNumber(raw.level, 0, MAX_H, "level", p); if (n !== null) edit.level = n; }
  if (raw.water !== undefined) { const n = checkNumber(raw.water, 0, 10, "water", p); if (n !== null) edit.water = n; }
  if (raw.material !== undefined) { const m = lowerName(raw.material); if (names.has(m)) edit.material = m; else p.push(`unknown material ${raw.material}`); }
  for (const msg of p) problems.push("edit: " + msg);
  if (!area || Object.keys(edit).length < 2) { problems.push("an edit was dropped (" + (!area ? "no usable area" : "nothing to change") + ")"); return null; }
  if (area === "everywhere" && (edit.raise || edit.lower || edit.level !== undefined)) { problems.push("an edit that reshapes the whole map was dropped"); return null; }
  return edit;
}

function checkMaterial(raw, problems) {
  if (!raw || typeof raw !== "object") { problems.push("each material must be an object"); return null; }
  const name = lowerName(raw.name);
  if (!/^[a-z][a-z0-9 _-]{0,19}$/.test(name) || name === "water") { problems.push(`material name "${raw.name}" must be 1-20 lowercase letters and not "water"`); return null; }
  const color = typeof raw.color === "string" && /^#[0-9a-f]{6}$/i.test(raw.color.trim()) ? raw.color.trim().toLowerCase() : null;
  const out = { name };
  if (color) out.color = color; else if (raw.color !== undefined) problems.push(`material ${name}: color must look like #a1b2c3`);
  if (raw.erodes !== undefined) { const e = checkNumber(raw.erodes, 0, 1, `material ${name} erodes`, problems); if (e !== null) out.erodes = e; }
  return out;
}

// A tool's icon: one emoji. Flags are left out: Windows shows them as letters.
const GRAPHEMES = typeof Intl !== "undefined" && Intl.Segmenter ? new Intl.Segmenter("en", { granularity: "grapheme" }) : null;
function checkIcon(v) {
  if (typeof v !== "string") return "";
  const t = v.trim();
  if (!t || t.length > 16 || !/\p{Extended_Pictographic}/u.test(t) || /[\u{1F1E6}-\u{1F1FF}]/u.test(t)) return "";
  if (GRAPHEMES && [...GRAPHEMES.segment(t)].length !== 1) return "";
  return t;
}

/** The tool a new one replaces: by id ("3.0") or by name, among tools still in the palette. */
function findReplaced(world, ref) {
  const key = String(ref).trim().toLowerCase();
  for (const s of world.skeins) for (const p of s.powers || []) if (!p.retired && (p.id === key || p.name.toLowerCase() === key)) return p;
  return null;
}

// A tool's edits and threads act where the player uses it, so they have no area of their own. While checking them,
// this stand-in area takes the place of the use's circle.
const USE_AREA = { circle: [0, 0, 1] };
function checkPower(raw, names, problems, world) {
  if (!raw || typeof raw !== "object") { problems.push("each tool must be an object"); return null; }
  const name = typeof raw.name === "string" ? raw.name.trim().slice(0, 24) : "";
  const label = `tool "${name || "unnamed"}"`;
  if (!name) { problems.push("a tool needs a name, so one was dropped"); return null; }
  const b = raw.brush ?? raw.radius ?? raw.size;
  let r = 3, stroke = null;
  if (isNum(b) || (typeof b === "string" && b.trim() !== "" && Number.isFinite(Number(b)))) r = Number(b);
  else if (typeof b === "string" && /^(stroke|drag|path|line)$/i.test(b.trim())) stroke = 2;
  else if (b && typeof b === "object") {
    const sw = b.stroke ?? b.path ?? b.line ?? b.drag;
    if (sw !== undefined) stroke = sw === true || typeof sw === "object" ? (b.width ?? 2) : sw;
    else { r = b.circle ?? b.radius ?? b.r ?? 3; if (Array.isArray(r)) r = r[r.length - 1]; }
  }
  let brush;
  if (stroke !== null) {
    const w = checkNumber(stroke, 1, 8, `${label} stroke width`, problems);
    if (w === null) return null;
    brush = { stroke: Math.round(w * 2) / 2 };
  } else {
    r = checkNumber(r, 1, 12, `${label} brush radius`, problems);
    if (r === null) return null;
    brush = { circle: Math.round(r * 2) / 2 };
  }
  const sub = [];
  const asUse = (x, what) => {
    if (!x || typeof x !== "object") return x;
    if (x.area !== undefined || x.where !== undefined || x.shape !== undefined) sub.push(`${what} area was ignored: a tool acts where the player clicks`);
    const { where, shape, ...rest } = x;
    return { ...rest, area: USE_AREA };
  };
  const listOf = (v) => (Array.isArray(v) ? v : v ? [v] : []);
  const edits = listOf(raw.edits).slice(0, 4).map((e) => checkEdit(asUse(e, "an edit's"), names, sub, null)).filter(Boolean).map(({ area, ...e }) => e);
  const threads = listOf(raw.threads ?? raw.rules).slice(0, 3).map((t) => checkThread(asUse(t, "a thread's"), names, sub, null)).filter(Boolean).map(({ area, ...t }) => t);
  for (const m of sub) problems.push(`${label}: ${m}`);
  if (!edits.length && !threads.length) { problems.push(`${label} was dropped: it has no usable edits or threads`); return null; }
  const icon = checkIcon(raw.icon);
  if (raw.icon !== undefined && raw.icon !== "" && !icon) problems.push(`${label}: its icon must be one emoji (no flags), so it shows its initials instead`);
  const out = { name, icon, brush, edits, threads };
  if (raw.replaces !== undefined && raw.replaces !== null && raw.replaces !== "") {
    const old = world && findReplaced(world, raw.replaces);
    if (old) out.replaces = old.id; else problems.push(`${label}: there is no tool "${raw.replaces}" to replace, so it was added as a new tool`);
  }
  return out;
}

function skeinId(v) {
  if (isNum(v)) return Math.round(v);
  const m = typeof v === "string" && v.match(/(\d+)/);
  return m ? Number(m[1]) : null;
}

/** Validate a plan. Returns { clean, problems, usable }. Keeps what is usable; lists everything dropped or adjusted. */
function checkPlan(world, plan, spot) {
  const problems = [];
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) return { clean: null, problems: ["the reply was not a JSON object"], usable: false };
  const list = (v, what) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : (problems.push(`${what} should be a list`), [v]));
  const names = new Set(world.materials.map((m) => m.name));
  const mats = list(plan.materials, "materials");
  if (mats.length > LIMITS.materials) problems.push(`only the first ${LIMITS.materials} materials were kept`);
  const materials = [];
  for (const raw of mats.slice(0, LIMITS.materials)) {
    const m = checkMaterial(raw, problems);
    if (!m) continue;
    if (!names.has(m.name) && !m.color) { problems.push(`new material ${m.name} needs a color`); continue; }
    if (!names.has(m.name) && names.size >= LIMITS.materialsTotal) { problems.push("the world has no room for more materials"); continue; }
    names.add(m.name); materials.push(m);
  }
  const ids = new Set(world.skeins.map((l) => l.id));
  const switchOff = [];
  for (const v of list(plan.switch_off, "switch_off")) {
    const id = skeinId(v);
    if (id !== null && ids.has(id)) switchOff.push(id); else problems.push(`switch_off: no skein ${v}`);
  }
  const editsRaw = list(plan.edits, "edits"), threadsRaw = list(plan.threads ?? plan.rules, "threads");
  if (editsRaw.length > LIMITS.edits) problems.push(`only the first ${LIMITS.edits} edits were kept`);
  if (threadsRaw.length > LIMITS.threads) problems.push(`only the first ${LIMITS.threads} threads were kept`);
  const edits = editsRaw.slice(0, LIMITS.edits).map((e) => checkEdit(e, names, problems, spot)).filter(Boolean);
  const threads = threadsRaw.slice(0, LIMITS.threads).map((r) => checkThread(r, names, problems, spot)).filter(Boolean);
  const taken = new Set(world.species.map((sp) => sp.name)), speciesRaw = list(plan.species ?? plan.animals, "species");
  if (speciesRaw.length > LIMITS.species) problems.push(`only the first ${LIMITS.species} species were kept`);
  const species = [];
  speciesRaw.forEach((raw, k) => {
    const sp = checkSpecies(raw, names, taken, problems);
    if (!sp || k >= LIMITS.species) return;
    if (taken.size >= LIMITS.speciesTotal) { problems.push("the world has no room for more species"); return; }
    taken.add(sp.name); species.push(sp);
  });
  let budget = LIMITS.release;
  const release = list(plan.release, "release").map((r) => checkRelease(r, taken, problems, spot)).filter(Boolean).filter((r) => {
    if (budget <= 0) { problems.push(`a plan can release at most ${LIMITS.release} animals`); return false; }
    if (r.count > budget) { problems.push(`a plan can release at most ${LIMITS.release} animals, so fewer were released`); r.count = budget; }
    budget -= r.count; return true;
  });
  const powersRaw = list(plan.powers ?? plan.tools, "powers");
  if (powersRaw.length > LIMITS.powers) problems.push(`only the first ${LIMITS.powers} tools were kept`);
  const powers = powersRaw.slice(0, LIMITS.powers).map((t) => checkPower(t, names, problems, world)).filter(Boolean);
  const say = typeof plan.say === "string" ? plan.say.trim().slice(0, 400) : "";
  const name = typeof plan.name === "string" ? plan.name.trim().slice(0, 60) : "";
  const usable = materials.length + switchOff.length + edits.length + threads.length + powers.length + species.length + release.length > 0;
  if (!usable && !say) problems.push("nothing in the reply could be used");
  return { clean: { name, say, materials, switch_off: switchOff, edits, threads, powers, species, release }, problems, usable };
}

// ---------- compiling threads ----------
function matIndex(world, name) { return world.materials.findIndex((m) => m.name === name); }

function compare([op, v]) {
  return op === ">" ? (x) => x > v : op === "<" ? (x) => x < v : op === ">=" ? (x) => x >= v : (x) => x <= v;
}

function perTick(chancePerSecond) { return chancePerSecond >= 1 ? 1 : 1 - Math.pow(1 - chancePerSecond, DT); }

function countNear(world, i, what) {
  const x = i % W, y = (i - x) / W;
  let n = 0;
  for (const [dx, dy] of N8) {
    const nx = x + dx, ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
    const j = ny * W + nx;
    if (what < 0 ? world.water[j] > WET : world.mat[j] === what) n++;
  }
  return n;
}

/** since: the tick a thread's clock starts (its skein's commit, or a tool's use). */
function compileCond(world, c, since) {
  if (c.not) { const inner = compileCond(world, c.not, since); return { global: inner.global, test: (i) => !inner.test(i) }; }
  if (c.material) { const set = new Set(c.material.map((m) => matIndex(world, m))); return { test: (i) => set.has(world.mat[i]) }; }
  if (c.water) { const f = compare(c.water); return { test: (i) => f(world.water[i]) }; }
  if (c.height) { const f = compare(c.height); return { test: (i) => f(world.height[i]) }; }
  if (c.near) { const what = c.near === "water" ? -1 : matIndex(world, c.near), f = compare(c.count); return { test: (i) => f(countNear(world, i, what)) }; }
  if ("chance" in c) { const p = perTick(c.chance); return { test: () => rand(world) < p }; }
  if (c.cycle) {
    const len = Math.max(1, Math.round(c.cycle * TPS)), from = c.from * TPS, to = c.to * TPS;
    return { global: true, kind: "cycle", test: () => { const t = world.tick % len; return from <= to ? t >= from && t < to : t >= from || t < to; } };
  }
  if ("raining" in c) return { global: true, kind: c.raining ? "rain" : "dry", test: () => world.weather.raining === c.raining };
  // Time since the skein was committed or the tool was used: "for a minute" is within 60, "after a while" is after N.
  if ("within" in c) { const end = since + c.within * TPS; return { global: true, kind: "time", test: () => world.tick < end }; }
  if ("after" in c) { const start = since + c.after * TPS; return { global: true, kind: "time", test: () => world.tick >= start }; }
  return { test: () => false };
}

function neighborFor(world, i, dir) {
  const x = i % W, y = (i - x) / W;
  if (DIRS[dir]) {
    const nx = x + DIRS[dir][0], ny = y + DIRS[dir][1];
    return nx < 0 || ny < 0 || nx >= W || ny >= H ? -1 : ny * W + nx;
  }
  let best = -1, bestH = dir === "downhill" ? Infinity : -Infinity;
  for (const [dx, dy] of N4) {
    const nx = x + dx, ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
    const j = ny * W + nx, hj = world.height[j];
    if (dir === "downhill" ? hj < bestH : hj > bestH) { bestH = hj; best = j; }
  }
  return best;
}

// ---------- change records: what a skein or a tool use did to the ground ----------
// h: tile -> height change (metres, after clamping), m: tile -> [material before its first write, material it last
// wrote]. Undo subtracts the height change and puts a material back only where the tile still holds what this record
// wrote, so later changes by other whims survive. Water and silt are never recorded: water moves on.
function newRec() { return { h: {}, m: {} }; }
function recHeight(rec, i, d) { if (d) rec.h[i] = (rec.h[i] || 0) + d; }
/** reach: a tool use's live tile list; tiles it paints join it, so its later rules follow what it spread. */
function recMat(rec, i, before, after, reach) {
  const r = rec.m[i];
  if (r) { r[1] = after; return; }
  rec.m[i] = [before, after];
  if (reach && !reach.set.has(i)) { reach.set.add(i); reach.cells.push(i); }
}
function undoRec(world, rec) {
  if (!rec) return;
  for (const k in rec.h) { const i = +k; world.height[i] = clamp(world.height[i] - rec.h[k], 0, MAX_H); }
  for (const k in rec.m) { const i = +k, [before, after] = rec.m[k]; if (world.mat[i] === after) world.mat[i] = before; }
}
/** Fold a newer record into an older aggregate: changes add up; a material keeps its earliest before and latest after. */
function foldRec(into, rec) {
  for (const k in rec.h) into.h[k] = (into.h[k] || 0) + rec.h[k];
  for (const k in rec.m) into.m[k] = into.m[k] ? [into.m[k][0], rec.m[k][1]] : rec.m[k].slice();
}
const recSize = (rec) => (rec ? Object.keys(rec.h).length + Object.keys(rec.m).length : 0);

function compileAction(world, a, rec, reach) {
  const h = world.height, w = world.water, s = world.silt;
  if (a.set_material) {
    const m = matIndex(world, a.set_material);
    return rec ? (i) => { const b = world.mat[i]; if (b !== m) { world.mat[i] = m; recMat(rec, i, b, m, reach); } } : (i) => { world.mat[i] = m; };
  }
  if ("raise" in a) { const d = a.raise * DT; return rec ? (i) => { const b = h[i]; h[i] = Math.min(MAX_H, b + d); recHeight(rec, i, h[i] - b); } : (i) => { h[i] = Math.min(MAX_H, h[i] + d); }; }
  if ("lower" in a) { const d = a.lower * DT; return rec ? (i) => { const b = h[i]; h[i] = Math.max(0, b - d); recHeight(rec, i, h[i] - b); } : (i) => { h[i] = Math.max(0, h[i] - d); }; }
  if ("add_water" in a) { const d = a.add_water * DT; return (i) => { w[i] += d; }; }
  if ("drain_water" in a) { const d = a.drain_water * DT; return (i) => { w[i] = Math.max(0, w[i] - d); }; }
  if (a.push_water) {
    const frac = Math.min(1, a.amount * DT);
    return (i) => {
      const j = neighborFor(world, i, a.push_water);
      if (j < 0 || w[i] <= 0) return;
      const move = w[i] * frac, sm = s[i] * frac;
      w[i] -= move; w[j] += move; s[i] -= sm; s[j] += sm;
    };
  }
  if (a.spread) {
    const m = matIndex(world, a.spread), p = perTick(a.chance), onto = a.onto ? new Set(a.onto.map((o) => matIndex(world, o))) : null;
    return (i) => {
      if (rand(world) >= p) return;
      const [dx, dy] = N8[Math.floor(rand(world) * 8)];
      const x = (i % W) + dx, y = Math.floor(i / W) + dy;
      if (x < 0 || y < 0 || x >= W || y >= H) return;
      const j = y * W + x, b = world.mat[j];
      if ((!onto || onto.has(b)) && b !== m) { world.mat[j] = m; if (rec) recMat(rec, j, b, m, reach); }
    };
  }
  return () => {};
}

function compileThread(world, t, cells, since, rec, reach, use) {
  const conds = t.when.map((c) => compileCond(world, c, since));
  return {
    cells, use, useId: use ? use.id : undefined, global: conds.filter((c) => c.global).map((c) => c.test), globalKinds: conds.filter((c) => c.global).map((c) => c.kind),
    local: conds.filter((c) => !c.global).map((c) => c.test), localConds: t.when.filter((_, j) => !conds[j].global), acts: t.do.map((a) => compileAction(world, a, rec, reach)), fires: 0,
  };
}

/** The area one use acts on: a circle around the click, or a path along the drag. */
function useArea(use) { return use.path ? { path: use.path, width: use.w } : { circle: [use.at[0], use.at[1], use.r] }; }

/** A use's footprint plus every tile it has painted: where its lingering rules run. */
function useReach(use) {
  const cells = Array.from(areaShape(useArea(use)).cells), set = new Set(cells);
  for (const k in use.rec ? use.rec.m : {}) { const i = +k; if (!set.has(i)) { set.add(i); cells.push(i); } }
  return { cells, set };
}

function compiled(world, skein) {
  let threads = world._compiled.get(skein.id);
  if (!threads) {
    const rec = skein.kind === "nature" ? null : skein.rec || null;
    threads = skein.threads.map((t) => compileThread(world, t, areaShape(t.area).cells, skein.tick, rec, null));
    for (const p of skein.powers || []) {
      if (!p.threads.length) continue;
      for (const u of p.uses) {
        const reach = useReach(u);
        for (const t of p.threads) threads.push(compileThread(world, t, reach.cells, u.tick, u.rec || p.rec, reach, u));
      }
    }
    world._compiled.set(skein.id, threads);
  }
  return threads;
}

function runThreads(world) {
  for (const skein of world.skeins) {
    if (!skein.on) continue;
    for (const r of compiled(world, skein)) {
      r.fires = 0;
      if (r.global.some((t) => !t())) continue;
      // Tiles a use reaches this tick join its area from the next tick on, so spreading can't race across the map.
      const cells = r.cells, n = cells.length, local = r.local, acts = r.acts;
      outer: for (let k = 0; k < n; k++) {
        const i = cells[k];
        for (let c = 0; c < local.length; c++) if (!local[c](i)) continue outer;
        for (let a = 0; a < acts.length; a++) acts[a](i);
        r.fires++;
      }
      if (r.use && r.fires && !r.use.acted) r.use.acted = true;
    }
  }
}

/** How many tiles each of a skein's own threads acted on in the last tick (tool uses: see useStates). */
function threadActivity(world, skein) {
  return skein.on ? compiled(world, skein).slice(0, skein.threads.length).map((r) => r.fires) : skein.threads.map(() => 0);
}

// ---------- skeins ----------
function addSkein(world, spec) {
  const skein = {
    id: world.nextSkein++, kind: spec.kind || "whim", name: spec.name || "Untitled", whim: spec.whim || "", say: spec.say || "",
    on: true, tick: world.tick, threads: spec.threads || [], edits: spec.edits || [], materials: spec.materials || [],
    switched: spec.switched || [], undo: { cells: [], height: [], mat: [] }, materialBefore: [], spot: spec.spot || null,
    rec: spec.kind === "nature" ? null : newRec(), powers: [],
  };
  world.skeins.push(skein);
  return skein;
}

/** Apply edits once, recording into rec. area overrides each edit's own area (a tool's use). Returns tiles changed. */
function applyEditList(world, edits, rec, area) {
  let changed = 0;
  const touched = new Set();
  for (const e of edits) {
    const { cells, weight } = areaShape(area || e.area), m = e.material ? matIndex(world, e.material) : -1;
    for (let k = 0; k < cells.length; k++) {
      const i = cells[k], wt = weight[k], before = world.height[i];
      let v = before;
      if (e.raise) v += e.raise * wt;
      if (e.lower) v -= e.lower * wt;
      if (e.level !== undefined) v += (e.level - v) * wt;
      world.height[i] = clamp(v, 0, MAX_H);
      const dh = world.height[i] - before;
      if (rec) recHeight(rec, i, dh);
      let hit = Math.abs(dh) > 0.01;
      if (m >= 0 && wt > 0.25 && world.mat[i] !== m) { if (rec) recMat(rec, i, world.mat[i], m, null); world.mat[i] = m; hit = true; }
      if (e.water && e.water * wt > 0.005) { world.water[i] += e.water * wt; hit = true; }
      if (hit) touched.add(i);
    }
  }
  changed = touched.size;
  return changed;
}
function applyEdits(world, skein) { applyEditList(world, skein.edits, skein.rec); }

/** Accept a checked plan as a new skein. Returns the skein, or null when the plan only talked. */
function acceptPlan(world, clean, meta = {}) {
  const powers = clean.powers || [], species = clean.species || [], release = clean.release || [];
  if (!clean.materials.length && !clean.switch_off.length && !clean.edits.length && !clean.threads.length && !powers.length && !species.length && !release.length) return null;
  world.whims = (world.whims || 0) + 1;
  const skein = addSkein(world, {
    name: clean.name || (powers[0] && powers[0].name) || (clean.threads[0] && clean.threads[0].name) || (meta.whim || "A whim").slice(0, 40),
    whim: meta.whim || "", say: clean.say, spot: meta.spot || null,
    threads: clean.threads, edits: clean.edits, materials: clean.materials,
  });
  skein.powers = powers.map((p, k) => ({ ...JSON.parse(JSON.stringify(p)), id: `${skein.id}.${k}`, uses: [], rec: newRec() }));
  // A tool that replaces an older one takes its place in the palette; the old tool's past uses keep acting.
  for (const p of skein.powers) if (p.replaces) { const old = findPower(world, p.replaces); if (old && !old.power.retired) old.power.retired = "replaced"; }
  for (const m of clean.materials) {
    const existing = world.materials.find((x) => x.name === m.name);
    if (existing) {
      skein.materialBefore.push({ name: m.name, before: { color: existing.color, erodes: existing.erodes } });
      Object.assign(existing, m);
    } else {
      skein.materialBefore.push({ name: m.name, before: null });
      world.materials.push({ erodes: 0.5, ...m });
    }
  }
  for (const id of clean.switch_off) {
    const other = world.skeins.find((l) => l.id === id);
    if (other && other.on) { other.on = false; skein.switched.push(id); }
  }
  applyEdits(world, skein);
  for (const sp of species) world.species.push({ ...JSON.parse(JSON.stringify(sp)), from: skein.id });
  skein.species = species.map((sp) => sp.name);
  skein.release = JSON.parse(JSON.stringify(release));
  releaseAnimals(world, skein, release);
  tidyRecords(world);
  return skein;
}

function setSkeinOn(world, id, on) {
  const skein = world.skeins.find((l) => l.id === id);
  if (skein) skein.on = !!on;
}

/**
 * Erase a whim: stop its threads and tools, take back what it and every use of its tools did to the ground (by change,
 * so later whims' changes stay), and undo its switches and recolors. It doesn't replay the world; Rewind does that.
 */
function eraseSkein(world, id) {
  const k = world.skeins.findIndex((l) => l.id === id);
  if (k < 0 || world.skeins[k].kind === "nature") return false;
  const skein = world.skeins[k];
  for (const p of skein.powers || []) {
    for (let n = p.uses.length - 1; n >= 0; n--) undoRec(world, p.uses[n].rec);
    undoRec(world, p.rec);
    // Erasing a replacement puts the tool it replaced back in the palette.
    if (p.replaces) { const old = findPower(world, p.replaces); if (old && old.power.retired === "replaced") delete old.power.retired; }
  }
  undoRec(world, skein.rec);
  // Saves from before change records used before-values.
  for (let n = skein.undo.cells.length - 1; n >= 0; n--) {
    const i = skein.undo.cells[n];
    world.height[i] = skein.undo.height[n]; world.mat[i] = skein.undo.mat[n];
  }
  for (const mb of skein.materialBefore) if (mb.before) Object.assign(world.materials.find((m) => m.name === mb.name) || {}, mb.before);
  for (const sid of skein.switched) setSkeinOn(world, sid, true);
  // Its animals go; a species it defined goes too, unless other skeins released animals of it.
  world.creatures = (world.creatures || []).filter((c) => c.skein !== id);
  world.species = (world.species || []).filter((sp) => sp.from !== id || world.creatures.some((c) => c.species === sp.name));
  world.skeins.splice(k, 1);
  world._compiled.delete(id);
  return true;
}

// ---------- tools (powers) and their uses ----------
const UNDO_USES = 50, LIVE_USES = 24, RECORD_BUDGET = 200000;

function findPower(world, powerId) {
  for (const s of world.skeins) for (const p of s.powers || []) if (p.id === powerId) return { skein: s, power: p };
  return null;
}

/** Where a thread is in its own time: open (may act now), ended (never again), or starting in some seconds. */
function threadWindow(t, since, now) {
  const w = t.when.find((c) => "within" in c), a = t.when.find((c) => "after" in c);
  const ended = !!w && now >= since + w.within * TPS;
  const start = a ? since + a.after * TPS : since;
  return { ended, open: !ended && now >= start, startsIn: now < start ? (start - now) / TPS : 0 };
}

/**
 * The state of every tool use: pending (before its after), acting, waiting (a world condition like rain or a cycle
 * is false), holding (has acted; none of its tiles match now, e.g. at its height limit; can wake again), idle (never
 * matched anything: "only acts where…"), starting (just used), expired (can never act again), done (instant only),
 * off (its skein is switched off). Map useId -> {state, text}.
 */
function useStates(world) {
  const out = new Map(), now = world.tick;
  for (const s of world.skeins) for (const p of s.powers || []) {
    const entries = p.threads.length && s.on ? compiled(world, s).filter((e) => e.useId !== undefined) : [];
    for (const u of p.uses) {
      if (!p.threads.length) { out.set(u.id, { state: "done", text: "done" }); continue; }
      const wins = p.threads.map((t) => threadWindow(t, u.tick, now));
      if (wins.every((w) => w.ended)) { out.set(u.id, { state: "expired", text: "finished" }); continue; }
      if (!s.on) { out.set(u.id, { state: "off", text: "switched off" }); continue; }
      const mine = entries.filter((e) => e.useId === u.id);
      if (mine.some((e) => e.fires > 0)) { u.acted = true; out.set(u.id, { state: "acting", text: "acting" }); continue; }
      const open = p.threads.map((t, k) => ({ t, e: mine[k], w: wins[k] })).filter((x) => x.w.open);
      if (!open.length) {
        const secs = Math.ceil(Math.min(...wins.filter((w) => !w.ended).map((w) => w.startsIn)));
        out.set(u.id, { state: "pending", text: `starts in ${secs} s` }); continue;
      }
      const blocked = open.map((x) => x.e && x.e.globalKinds.find((kind, j) => kind !== "time" && !x.e.global[j]()));
      if (blocked.every(Boolean)) {
        const kind = blocked[0];
        out.set(u.id, { state: "waiting", text: kind === "rain" ? "waiting for rain" : kind === "dry" ? "waiting for dry weather" : "between pulses" }); continue;
      }
      if (u.acted) {
        out.set(u.id, { state: "holding", text: holdingText(open[0].e) }); continue;
      }
      if (now - u.tick < 2 * TPS) { out.set(u.id, { state: "starting", text: "starting" }); continue; }
      const local = open[0].t.when.filter((c) => !("within" in c || "after" in c || c.cycle || "raining" in c || (c.not && "raining" in c.not))).map(condText);
      out.set(u.id, { state: "idle", text: local.length ? `nothing here matches: it only acts ${local.join(", ")}` : "nothing to do here" });
    }
  }
  return out;
}

/** Why a use that has acted is resting now: the condition that fails on most of its tiles, in plain words. */
function holdingText(e) {
  if (!e) return "resting";
  let worst = -1, most = -1;
  const sample = e.cells.length > 300 ? e.cells.filter((_, k) => k % Math.ceil(e.cells.length / 300) === 0) : e.cells;
  e.localConds.forEach((c, j) => {
    if ("chance" in c) return;
    let fails = 0; for (const i of sample) if (!e.local[j](i)) fails++;
    if (fails > most) { most = fails; worst = j; }
  });
  const c = e.localConds[worst];
  if (!c) return "resting";
  if (c.height) return `holding at ${num(c.height[1])} m`;
  if (c.water) return c.water[0].includes("<") ? "the water has arrived" : "waiting for water here";
  if (c.material) return `resting: nothing here is ${c.material.join(" or ")} now`;
  if (c.near) return `resting: ${condText(c)} isn't true here now`;
  return "resting";
}

const LIVE = new Set(["pending", "acting", "waiting", "holding", "idle", "starting", "off"]);

/**
 * Use a tool at (x, y) with radius r. Applies its edits once there and attaches its threads. Returns
 * {ok: true, use, changed} or {ok: false, message}. Refuses when its skein is off or it already acts in 24 places.
 */
function usePower(world, powerId, where) {
  const f = findPower(world, powerId);
  if (!f) return { ok: false, message: "That tool no longer exists." };
  const { skein, power } = f;
  if (power.retired) return { ok: false, message: `${power.name} isn't in the palette any more.` };
  if (!skein.on) return { ok: false, message: `${power.name} is switched off. Switch its skein on to use it.` };
  if (power.threads.length) {
    const states = useStates(world), live = power.uses.filter((u) => LIVE.has((states.get(u.id) || {}).state)).length;
    if (live >= LIVE_USES) return { ok: false, message: `${power.name} is acting in ${LIVE_USES} places. Undo or erase some first.` };
  }
  let use;
  if (power.brush.stroke) {
    // A drag: its points, thinned to at most 40 with both ends kept, at the chosen width.
    let pts = (where.path || [[where.x, where.y]]).map(([px, py]) => [clamp(Math.round(px), 0, W - 1), clamp(Math.round(py), 0, H - 1)]);
    if (pts.length > LIMITS.pathPoints) { const n = LIMITS.pathPoints, step = (pts.length - 1) / (n - 1); pts = Array.from({ length: n }, (_, k) => pts[Math.round(k * step)]); }
    const w = clamp(Math.round((where.w ?? where.r ?? power.brush.stroke) * 2) / 2, 1, 8);
    use = { id: world.nextUse++, at: pts[pts.length - 1], path: pts, w, r: w / 2, tick: world.tick, rec: newRec() };
  } else {
    const x = clamp(Math.round(where.x), 0, W - 1), y = clamp(Math.round(where.y), 0, H - 1);
    const r = clamp(Math.round((where.r ?? power.brush.circle) * 2) / 2, 1, 12);
    use = { id: world.nextUse++, at: [x, y], r, tick: world.tick, rec: newRec() };
  }
  const changed = applyEditList(world, power.edits, use.rec, useArea(use));
  power.uses.push(use);
  world.whims = (world.whims || 0) + 1;
  world._compiled.delete(skein.id);
  tidyUses(world);
  tidyRecords(world);
  return { ok: true, use, changed };
}

/** Take a tool off the palette (removed: true) or put it back. Everything it made, and its uses, stay. */
function setPowerRemoved(world, powerId, removed) {
  const f = findPower(world, powerId);
  if (!f) return false;
  if (removed) f.power.retired = f.power.retired || "removed"; else delete f.power.retired;
  return true;
}

/** Take back one use: stop its rules and subtract what it did to the ground. */
function undoUse(world, useId) {
  for (const s of world.skeins) for (const p of s.powers || []) {
    const k = p.uses.findIndex((u) => u.id === useId);
    if (k < 0) continue;
    undoRec(world, p.uses[k].rec);
    p.uses.splice(k, 1);
    world._compiled.delete(s.id);
    return true;
  }
  return false;
}

/** The most recent use that can still be undone, or null. */
function lastUse(world) {
  let best = null;
  for (const s of world.skeins) for (const p of s.powers || []) for (const u of p.uses) if (u.rec && (!best || u.id > best.use.id)) best = { use: u, power: p, skein: s };
  return best;
}

/** Keep per-use records for the last 50 uses; older uses that can never act again fold into their tool's record. */
function tidyUses(world) {
  const all = [];
  for (const s of world.skeins) for (const p of s.powers || []) for (const u of p.uses) all.push({ s, p, u });
  if (all.length <= UNDO_USES) return;
  all.sort((a, b) => b.u.id - a.u.id);
  const states = useStates(world);
  for (const { s, p, u } of all.slice(UNDO_USES)) {
    const st = (states.get(u.id) || {}).state;
    if (st !== "expired" && st !== "done") continue;
    foldRec(p.rec, u.rec);
    p.uses.splice(p.uses.indexOf(u), 1);
    world._compiled.delete(s.id);
  }
}

/** Bound the world's change records. Past the budget, the oldest skeins can no longer take back their ground changes. */
function tidyRecords(world) {
  let total = 0;
  const per = world.skeins.map((s) => {
    const n = recSize(s.rec) + (s.powers || []).reduce((t, p) => t + recSize(p.rec) + p.uses.reduce((q, u) => q + recSize(u.rec), 0), 0);
    total += n; return n;
  });
  for (let k = 0; k < world.skeins.length && total > RECORD_BUDGET; k++) {
    const s = world.skeins[k];
    if (s.kind === "nature" || !per[k]) continue;
    s.rec = null; for (const p of s.powers || []) { p.rec = null; for (const u of p.uses) u.rec = null; }
    s.recDropped = true; total -= per[k];
    world._compiled.delete(s.id);
  }
}

/** A copy of a save without change records: the model doesn't need them, and requests stay small. */
function saveForModel(world) {
  const out = save(world);
  for (const s of out.skeins) {
    delete s.rec;
    for (const p of s.powers || []) { delete p.rec; p.uses = p.uses.map(({ rec, ...u }) => u); }
  }
  return out;
}

// ---------- animals ----------
// Species are data, like materials; animals act on their own and only read the world. The built-in grazer is written
// in the same format a whim uses to invent one. Animals draw randomness from their own stream (crng), never the
// weather's. See docs/CREATURES.md.
const PATTERNS = ["dot", "ring", "stripe", "diamond", "cross"];
const GRAZER = { name: "grazer", look: { color: "#e8d27a", pattern: "dot" }, eats: ["meadow"], avoids: ["snow"], wades: 0.3, climbs: 1.5, speed: 1, thirst: 120, hunger: 240 };
const SIGHT = 12, DRINK_SECONDS = 5, EAT_SECONDS = 6, GRAZE_SECONDS = 3, DOOM_SECONDS = 5, MARKER_SECONDS = 30;

const speciesOf = (world, name) => world.species.find((s) => s.name === name);
const tileIndex = (c) => clamp(Math.floor(c.y), 0, H - 1) * W + clamp(Math.floor(c.x), 0, W - 1);

function avoidsSet(world, sp) { return new Set(sp.avoids.map((m) => matIndex(world, m))); }
function standable(world, sp, avoid, i) { return world.water[i] <= sp.wades && !avoid.has(world.mat[i]); }
function canStep(world, sp, avoid, from, to) { return standable(world, sp, avoid, to) && Math.abs(world.height[to] - world.height[from]) <= sp.climbs; }

/** An unnamed animal is called after its species and how many of them there have been: "Sunscale 3". */
function defaultName(world, species) {
  const n = world.creatures.filter((c) => c.species === species).length + (world.graveyard || []).filter((c) => c.species === species).length + 1;
  return species.charAt(0).toUpperCase() + species.slice(1) + " " + n;
}

/** Add an animal at tile (x, y). Returns it. */
function addCreature(world, spec) {
  const sp = speciesOf(world, spec.species);
  if (!sp) throw new Error(`no species ${spec.species}`);
  const id = world.nextCreature++;
  const c = {
    id, species: sp.name, name: spec.name || defaultName(world, sp.name), x: Math.floor(spec.x) + 0.5, y: Math.floor(spec.y) + 0.5,
    thirst: 1, hunger: 1, state: "wandering", born: world.tick, skein: spec.skein ?? null, thriving: 0, whimsAtBirth: world.whims || 0,
    goal: null, next: -1, decideAt: world.tick, eaten: 0, doom: 0,
  };
  world.creatures.push(c);
  return c;
}

/** Nearest tile within SIGHT that passes test, scanning outward. Returns an index or -1. */
function nearestTile(c, test) {
  const cx = Math.floor(c.x), cy = Math.floor(c.y);
  let best = -1, bestD = Infinity;
  for (let dy = -SIGHT; dy <= SIGHT; dy++) for (let dx = -SIGHT; dx <= SIGHT; dx++) {
    const x = cx + dx, y = cy + dy, d = dx * dx + dy * dy;
    if (x < 0 || y < 0 || x >= W || y >= H || d > SIGHT * SIGHT || d >= bestD) continue;
    const i = y * W + x;
    if (test(i)) { best = i; bestD = d; }
  }
  return best;
}
function besideWater(world, i) {
  const x = i % W, y = (i - x) / W;
  if (world.water[i] >= WET) return true;
  for (const [dx, dy] of N8) { const nx = x + dx, ny = y + dy; if (nx >= 0 && ny >= 0 && nx < W && ny < H && world.water[ny * W + nx] >= WET) return true; }
  return false;
}

function die(world, c, cause) { c.dead = true; c.diedOf = cause; c.diedAt = world.tick; c.state = "dead"; c.next = -1; c.goal = null; }

/** Once a second (or when idle): flee, drink, eat or wander, in that order. */
function decide(world, c, sp, avoid) {
  const i = tileIndex(c), food = new Set(sp.eats.map((m) => matIndex(world, m)));
  const goTo = (target, state) => { c.goal = target; c.state = state; };
  const search = (what) => {
    const ang = rand(world, "crng") * Math.PI * 2;
    const gx = clamp(Math.round(c.x + Math.cos(ang) * SIGHT), 0, W - 1), gy = clamp(Math.round(c.y + Math.sin(ang) * SIGHT), 0, H - 1);
    goTo(gy * W + gx, "searching for " + what);
  };
  if (!standable(world, sp, avoid, i)) {
    const safe = nearestTile(c, (j) => standable(world, sp, avoid, j));
    goTo(safe, "fleeing"); return;
  }
  // Once it starts on a need (seeking, drinking, searching), it keeps at it until it's nearly full.
  const onWater = /water$|^drinking$/.test(c.state) && c.thirst < 0.95;
  if (c.thirst < 0.5 || onWater) {
    if (besideWater(world, i)) { c.goal = null; c.state = "drinking"; return; }
    const t = nearestTile(c, (j) => standable(world, sp, avoid, j) && besideWater(world, j));
    if (t >= 0) goTo(t, "seeking water"); else if (!c.state.startsWith("searching for water") || c.goal === null) search("water");
    return;
  }
  const onFood = /food$|^eating$/.test(c.state) && c.hunger < 0.95;
  if (c.hunger < 0.5 || onFood) {
    if (food.has(world.mat[i])) { c.goal = null; c.state = "eating"; return; }
    const t = nearestTile(c, (j) => standable(world, sp, avoid, j) && food.has(world.mat[j]));
    if (t >= 0) goTo(t, "seeking food"); else if (!c.state.startsWith("searching for food") || c.goal === null) search("food");
    return;
  }
  if (c.state !== "wandering" || c.goal === null) {
    for (let k = 0; k < 8; k++) {
      const gx = clamp(Math.floor(c.x) + Math.round((rand(world, "crng") - 0.5) * 12), 0, W - 1);
      const gy = clamp(Math.floor(c.y) + Math.round((rand(world, "crng") - 0.5) * 12), 0, H - 1);
      if (standable(world, sp, avoid, gy * W + gx)) { goTo(gy * W + gx, "wandering"); return; }
    }
    c.goal = null; c.state = "resting";
  }
}

/** Walk from tile centre to neighbouring tile centre, choosing greedily the step that most reduces the distance. */
function move(world, c, sp, avoid) {
  if (c.goal === null || c.goal < 0) return;
  let step = sp.speed * DT;
  while (step > 1e-9) {
    if (c.next < 0) {
      const i = tileIndex(c), x = i % W, y = (i - x) / W, gx = c.goal % W, gy = (c.goal - gx) / W;
      if (i === c.goal) { c.goal = null; return; }
      let best = -1, bestD = Math.hypot(gx - x, gy - y) - 1e-6;
      for (const [dx, dy] of N8) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const j = ny * W + nx, d = Math.hypot(gx - nx, gy - ny);
        if (d < bestD && canStep(world, sp, avoid, i, j)) { best = j; bestD = d; }
      }
      if (best < 0) { c.goal = null; c.decideAt = world.tick + TPS; return; }   // stuck: try again in a second
      c.next = best;
    }
    const tx = (c.next % W) + 0.5, ty = Math.floor(c.next / W) + 0.5, d = Math.hypot(tx - c.x, ty - c.y);
    if (d <= step) { c.x = tx; c.y = ty; c.next = -1; step -= d; }
    else { c.x += ((tx - c.x) / d) * step; c.y += ((ty - c.y) / d) * step; step = 0; }
  }
}

function stepCreatures(world) {
  if (!world.creatures || !world.creatures.length) return;
  const keep = [];
  for (const c of world.creatures) {
    if (c.dead) {
      if (world.tick - c.diedAt < MARKER_SECONDS * TPS) keep.push(c);
      else { world.graveyard.push(lifeOf(world, c)); if (world.graveyard.length > 20) world.graveyard.shift(); }
      continue;
    }
    keep.push(c);
    const owner = c.skein === null ? null : world.skeins.find((s) => s.id === c.skein);
    if (owner && !owner.on) continue;   // its skein is switched off: paused
    const sp = speciesOf(world, c.species);
    if (!sp) continue;
    const avoid = avoidsSet(world, sp);
    c.thirst -= DT / sp.thirst; c.hunger -= DT / sp.hunger;
    if (c.thirst <= 0) { c.thirst = 0; die(world, c, "thirst"); continue; }
    if (c.hunger <= 0) { c.hunger = 0; die(world, c, "hunger"); continue; }
    if (c.thirst > 0.5 && c.hunger > 0.5) c.thriving += DT;
    const i = tileIndex(c);
    // Deep water drowns it and avoided ground (fire, say) kills it, after five seconds.
    const avoided = avoid.has(world.mat[i]);
    if (world.water[i] > sp.wades + 1 || avoided) {
      if (++c.doom >= DOOM_SECONDS * TPS) { die(world, c, avoided ? world.materials[world.mat[i]].name : "drowned"); continue; }
    } else c.doom = 0;
    if (world.tick >= c.decideAt || c.goal === null && c.next < 0 && !["drinking", "eating"].includes(c.state)) {
      decide(world, c, sp, avoid);
      c.decideAt = world.tick + TPS;
    }
    if (c.state === "drinking") {
      c.thirst = Math.min(1, c.thirst + DT / DRINK_SECONDS);
      if (c.thirst >= 1) c.state = "wandering";
    } else if (c.state === "eating") {
      const food = new Set(sp.eats.map((m) => matIndex(world, m)));
      if (food.has(world.mat[i])) {
        c.hunger = Math.min(1, c.hunger + DT / EAT_SECONDS);
        if (++c.eaten >= GRAZE_SECONDS * TPS) { world.mat[i] = 0; c.eaten = 0; }   // grazed down to soil
      }
      if (c.hunger >= 1) c.state = "wandering";
    } else move(world, c, sp, avoid);
  }
  world.creatures = keep;
}

function lifeOf(world, c) {
  const end = c.dead ? c.diedAt : world.tick;
  return { id: c.id, name: c.name, species: c.species, alive: !c.dead, ageSeconds: (end - c.born) / TPS, thrivingSeconds: c.thriving,
    whimsSince: (world.whims || 0) - c.whimsAtBirth, diedOf: c.diedOf || null, state: c.state };
}
/** Every animal on the map, alive or a fresh marker, plus the recently gone: age, time thriving, whims since birth. */
function lifeStats(world) {
  return world.creatures.map((c) => lifeOf(world, c)).concat(world.graveyard || []);
}

/** A walkable meadow or soil tile within 12 tiles of water, nearest the map centre, for a grazer to start on. */
function grazerHome(world) {
  const sp = speciesOf(world, "grazer"), avoid = avoidsSet(world, sp), ok = new Set([matIndex(world, "meadow"), matIndex(world, "soil")]);
  let best = -1, bestD = Infinity;
  for (let y = 2; y < H - 2; y++) for (let x = 2; x < W - 2; x++) {
    const i = y * W + x, d = Math.hypot(x - W / 2, y - H / 2);
    if (d >= bestD || !ok.has(world.mat[i]) || !standable(world, sp, avoid, i)) continue;
    if (nearestTile({ x: x + 0.5, y: y + 0.5 }, (j) => world.water[j] > WET) >= 0) { best = i; bestD = d; }
  }
  return best;
}

/** Release a grazer named `name` at a good home. Used for the first animal and for "Release another". */
function releaseGrazer(world, name) {
  const home = grazerHome(world), wild = world.skeins.find((s) => s.kind === "nature" && /Wildlife/.test(s.name));
  if (home < 0) return null;
  return addCreature(world, { species: "grazer", x: home % W, y: Math.floor(home / W), name, skein: wild ? wild.id : null });
}

function addWildlife(world) {
  world.species.push(JSON.parse(JSON.stringify(GRAZER)));
  const s = addSkein(world, { kind: "nature", name: "Wildlife (built in)", say: "The animals this world starts with. A species is written in the same format a whim uses to invent one." });
  s.species = ["grazer"];
  releaseGrazer(world, "Mossback");
}

// ---------- validating species and releases ----------
function checkSpecies(raw, names, taken, problems) {
  if (!raw || typeof raw !== "object") { problems.push("each species must be an object"); return null; }
  const name = lowerName(raw.name);
  if (!/^[a-z][a-z -]{0,19}$/.test(name)) { problems.push(`species name "${raw.name}" must be 1-20 lowercase letters`); return null; }
  if (taken.has(name)) { problems.push(`there is already a species ${name}, so a second one was dropped`); return null; }
  const look = raw.look && typeof raw.look === "object" ? raw.look : { color: raw.color, pattern: raw.pattern };
  const color = typeof look.color === "string" && /^#[0-9a-f]{6}$/i.test(look.color.trim()) ? look.color.trim().toLowerCase() : null;
  if (!color) { problems.push(`species ${name} needs a color like #a1b2c3, so it was dropped`); return null; }
  let pattern = lowerName(look.pattern) || "dot";
  if (!PATTERNS.includes(pattern)) { problems.push(`species ${name}: pattern "${look.pattern}" isn't one of ${PATTERNS.join(", ")}; using dot`); pattern = "dot"; }
  const listOf = (v) => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]).map(lowerName);
  const eats = listOf(raw.eats).slice(0, 3);
  const unknown = eats.filter((m) => !names.has(m));
  if (!eats.length || unknown.length) { problems.push(`species ${name} eats ${unknown.length ? "unknown material " + unknown.join(", ") : "nothing"}, so it was dropped`); return null; }
  const avoids = listOf(raw.avoids).slice(0, 3).filter((m) => names.has(m) || (problems.push(`species ${name}: avoids unknown material ${m}; ignored`), false))
    // It has to stand on its food to eat it, so it can't avoid what it eats.
    .filter((m) => !eats.includes(m) || (problems.push(`species ${name} can't both eat and avoid ${m}; it no longer avoids it`), false));
  const num = (k, lo, hi, def) => (raw[k] === undefined ? def : checkNumber(raw[k], lo, hi, `species ${name} ${k}`, problems) ?? def);
  return { name, look: { color, pattern }, eats, avoids, wades: num("wades", 0, 2, 0.3), climbs: num("climbs", 0.5, 5, 1.5), speed: num("speed", 0.2, 3, 1),
    thirst: num("thirst", 30, 1200, 120), hunger: num("hunger", 30, 1200, 240) };
}

function checkRelease(raw, speciesNames, problems, spot) {
  if (!raw || typeof raw !== "object") { problems.push("each release must be an object"); return null; }
  const species = lowerName(raw.species);
  if (!speciesNames.has(species)) { problems.push(`release: no species ${raw.species}`); return null; }
  const p = [];
  const area = checkArea(raw.area ?? raw.where ?? "spot", p, spot);
  for (const m of p) problems.push("release: " + m);
  if (!area) return null;
  const count = raw.count === undefined ? 1 : checkNumber(raw.count, 1, LIMITS.release, "release count", problems);
  if (count === null) return null;
  const out = { species, area, count: Math.round(count) };
  if (Array.isArray(raw.names)) out.names = raw.names.filter((n) => typeof n === "string").map((n) => n.trim().slice(0, 20)).filter(Boolean).slice(0, out.count);
  return out;
}

/** Put released animals on standable tiles of their area, spread out at random. */
function releaseAnimals(world, skein, release) {
  for (const r of release) {
    const sp = speciesOf(world, r.species), avoid = avoidsSet(world, sp);
    const cells = Array.from(areaShape(r.area).cells).filter((i) => standable(world, sp, avoid, i));
    let placed = 0;
    for (let k = 0; k < r.count && cells.length; k++, placed++) {
      const i = cells.splice(Math.floor(rand(world, "crng") * cells.length), 1)[0];
      addCreature(world, { species: sp.name, x: i % W, y: Math.floor(i / W), name: r.names && r.names[k], skein: skein.id });
    }
    // Recorded on the skein's copy of the release, so "What it does" says how many really found ground to stand on.
    const mine = (skein.release || []).find((x) => x.species === r.species && x.count === r.count && x.released === undefined);
    if (mine) mine.released = placed;
  }
}

function speciesText(sp) {
  const parts = [`eats ${sp.eats.join(" or ")}`];
  if (sp.avoids.length) parts.push(`avoids ${sp.avoids.join(" and ")}`);
  parts.push(`wades up to ${num(sp.wades)} m`, `climbs ${num(sp.climbs)} m steps`);
  return `New animal: ${sp.name} (${sp.look.color} ${sp.look.pattern}). It ${parts.join(", ")} and walks ${num(sp.speed)} tile${sp.speed === 1 ? "" : "s"} a second. ` +
    `It can go ${secs(sp.thirst)} without water and ${secs(sp.hunger)} without food.`;
}

// ---------- plain-language descriptions, generated from the plan (never from the model's prose) ----------
const num = (v) => String(Math.round(v * 100) / 100);
const secs = (s) => (s >= 60 && s % 60 === 0 ? `${s / 60} min` : `${num(s)} s`);
const spanText = secs;   // for describe(), where a local named secs is the clock

function placeText(area) {
  if (area === "everywhere") return "everywhere";
  if (area.circle) return `in a circle at (${area.circle[0]},${area.circle[1]}) r ${area.circle[2]}`;
  if (area.rect) return `in a ${area.rect[2]}×${area.rect[3]} rectangle from (${area.rect[0]},${area.rect[1]})`;
  const p = area.path;
  return `along a path (${p[0][0]},${p[0][1]})→(${p[p.length - 1][0]},${p[p.length - 1][1]}), ${area.width} wide`;
}

function condText(c) {
  if (c.not && "raining" in c.not) return condText({ raining: !c.not.raining });
  if (c.not) return "unless " + condText(c.not);
  if (c.material) return "on " + c.material.join(" or ");
  if (c.water) return `where water is ${c.water[0].includes(">") ? "over" : "under"} ${num(c.water[1])} m deep`;
  if (c.height) return `where the ground is ${c.height[0].includes(">") ? "above" : "below"} ${num(c.height[1])} m`;
  if (c.near) {
    const [op, n] = c.count, what = c.near === "water" ? "wet" : c.near;
    if (op === "<" && n <= 1) return `with no ${what} tiles beside it`;
    return `next to ${op === ">" ? "more than " + num(n) : op === ">=" ? "at least " + num(n) : op === "<" ? "fewer than " + num(n) : "at most " + num(n)} ${what} tile${n === 1 && op !== ">" ? "" : "s"}`;
  }
  if ("chance" in c) return `${num(c.chance * 100)}% chance per second`;
  if (c.cycle) return `from ${num(c.from)} to ${num(c.to)} s of every ${num(c.cycle)} s`;
  if ("raining" in c) return c.raining ? "while it rains" : "while it's dry";
  if ("within" in c) return `for the first ${secs(c.within)}`;
  if ("after" in c) return `starting ${secs(c.after)} in`;
  return "?";
}

function actionText(a) {
  if (a.set_material) return `turns the ground to ${a.set_material}`;
  if ("raise" in a) return `raises the ground ${num(a.raise)} m a second`;
  if ("lower" in a) return `lowers the ground ${num(a.lower)} m a second`;
  if ("add_water" in a) return `adds ${num(a.add_water)} m of water a second (it flows away downhill)`;
  if ("drain_water" in a) return `removes ${num(a.drain_water)} m of water a second`;
  if (a.push_water) return `pushes water ${a.push_water} (${num(a.amount)}× a second)`;
  if (a.spread) return `spreads ${a.spread} to neighbouring tiles${a.onto ? " of " + a.onto.join(" or ") : ""}, ${num(a.chance * 100)}% chance a second (it can spread beyond this area)`;
  return "?";
}

/** How a thread ends, if ever. "Holding" limits (height) are not endings: they start again if the ground changes. */
function endingText(t, since = "it lands") {
  const within = t.when.find((c) => "within" in c);
  if (within) return `Stops for good ${secs(within.within)} after ${since}.`;
  const lowers = t.do.some((a) => "lower" in a), raises = t.do.some((a) => "raise" in a);
  const h = t.when.find((c) => c.height), wetStop = t.when.find((c) => c.water && c.water[0].includes("<"));
  if (wetStop && (lowers || raises || t.do.some((a) => "add_water" in a))) {
    const floor = h && lowers && h.height[0].includes(">") ? ` (and never below ${num(h.height[1])} m)` : "";
    return `Stops on each tile once water there is ${num(wetStop.water[1])} m deep${floor}, and starts again if it dries; runs until switched off.`;
  }
  if (h && lowers && h.height[0].includes(">")) return `Stops lowering at ${num(h.height[1])} m, and lowers again if the ground rises; runs until switched off.`;
  if (h && raises && h.height[0].includes("<")) return `Stops raising at ${num(h.height[1])} m, and raises again if the ground sinks; runs until switched off.`;
  return "Never stops on its own.";
}

/** A thread in plain words: when and where, what it does, and whether it ever stops. */
function threadText(t, where, since) {
  const timing = t.when.filter((c) => "after" in c || c.cycle || "raining" in c || (c.not && "raining" in c.not)).map(condText);
  const local = t.when.filter((c) => !("within" in c || "after" in c || c.cycle || "raining" in c || (c.not && "raining" in c.not))).map(condText);
  const head = [timing.join(", "), where, local.join(", ")].filter(Boolean).join(", ");
  const s = head.charAt(0).toUpperCase() + head.slice(1);
  const acts = t.do.map(actionText).join("; ");
  return `“${t.name}” — ${s}: ${since ? acts.replace("(it can spread beyond this area)", "(it can spread beyond where you click; this use's rules follow it)") : acts}. ${endingText(t, since)}`;
}

function editParts(e) {
  const parts = [];
  if (e.level !== undefined) parts.push(`flattens the ground toward ${num(e.level)} m`);
  if (e.lower) parts.push(`lowers the ground up to ${num(e.lower)} m`);
  if (e.raise) parts.push(`raises the ground up to ${num(e.raise)} m`);
  if (e.material) parts.push(`paints it ${e.material}`);
  if (e.water) parts.push(`pours in up to ${num(e.water)} m of water`);
  return parts.join(", ");
}
function editText(e) { return `Once, when it lands, ${placeText(e.area)}: ${editParts(e)}.`; }

/** What one use of a tool does at once, in a few words ("raises the ground up to 3 m"), or "". */
function powerOnceText(p) { return p.edits.map(editParts).join("; "); }

/** A tool in plain words: how it's used, what each use does once, and what each use keeps doing. */
function powerText(p) {
  const drag = !!p.brush.stroke, where = drag ? "along where you dragged" : "where you clicked";
  const head = `Tool ${p.icon ? p.icon + " " : ""}“${p.name}” (${drag ? `drag across the map to use it; ${num(p.brush.stroke)} wide to start` : `click the map to use it; radius ${num(p.brush.circle)} to start`}).`;
  const once = p.edits.map((e) => `Each use, once, ${where}: ${editParts(e)}.`);
  const keeps = p.threads.map((t) => `Each use ${p.edits.length ? "then " : ""}keeps going: ` + threadText(t, where, "each use"));
  const repl = p.replaces ? ` It replaces tool ${p.replaces} in the palette; that tool's earlier uses keep going.` : "";
  return [head, ...once, ...keeps].join(" ") + repl;
}

/**
 * Plain lines saying what a clean plan (or a skein) does. Built only from the plan, so it can't promise
 * anything the plan doesn't contain. Accepts a checkPlan result's clean plan or a skein.
 */
function explainPlan(plan, world) {
  const lines = [];
  for (const m of plan.materials || []) {
    const known = BUILTIN.some((b) => b.name === m.name);
    lines.push(`${known ? "Changes" : "New ground:"} ${m.name}${m.color ? " (" + m.color + ")" : ""}${m.erodes !== undefined ? `, water wears it away at ${num(m.erodes)}` : ""}.`);
  }
  for (const e of plan.edits || []) lines.push(editText(e));
  for (const t of plan.threads || []) lines.push(threadText(t, placeText(t.area)));
  for (const p of plan.powers || []) lines.push(powerText(p));
  for (const sp of plan.species || []) {
    const def = typeof sp === "string" ? world && speciesOf(world, sp) : sp;
    if (def) lines.push(speciesText(def));
  }
  for (const r of plan.release || []) {
    const short = r.released !== undefined && r.released < r.count;
    lines.push(`Releases ${r.count} ${r.species}${r.count === 1 ? "" : "s"} ${placeText(r.area)}.` +
      (short ? ` Only ${r.released} found ground there ${r.released === 1 ? "it" : "they"} could stand on.` : ""));
  }
  for (const id of plan.switch_off || plan.switched || []) {
    const s = world && world.skeins.find((k) => k.id === id);
    lines.push(`Switches off skein ${id}${s ? " (" + s.name + ")" : ""}.`);
  }
  if (!lines.length) lines.push("Changes nothing.");
  return lines;
}

// ---------- reports for the model ----------
function nearestWet(world, x0, y0, r) {
  let best = null;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (world.water[y * W + x] <= 0.15) continue;
    const d = Math.hypot(x - x0, y - y0);
    if (d > r && (!best || d < best.d)) best = { x, y, d };
  }
  return best;
}

function describe(world, spot) {
  const lines = [];
  const secs = Math.floor(world.tick / TPS);
  lines.push(`Map: ${W} tiles wide (x 0-${W - 1}, west to east) by ${H} tall (y 0-${H - 1}, north to south). Heights 0-${MAX_H} m. Water leaves the map over the south edge.`);
  lines.push(`Time ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}. Weather: ${world.weather.raining ? "raining" : "clear"}.`);
  lines.push("Coarse map, one token per 8x8 block (height digit 0-9 = 0-30 m, then ~ water, , meadow, ^ stone, * snow, . soil or sand):");
  for (let by = 0; by < H / 8; by++) {
    const row = [];
    for (let bx = 0; bx < W / 8; bx++) {
      let hs = 0, wet = 0; const counts = new Map();
      for (let y = by * 8; y < by * 8 + 8; y++) for (let x = bx * 8; x < bx * 8 + 8; x++) {
        const i = y * W + x; hs += world.height[i]; if (world.water[i] > WET) wet++;
        counts.set(world.mat[i], (counts.get(world.mat[i]) || 0) + 1);
      }
      const top = [...counts].sort((a, b) => b[1] - a[1])[0][0], name = world.materials[top] ? world.materials[top].name : "";
      const mark = wet > 16 ? "~" : name === "meadow" ? "," : name === "stone" ? "^" : name === "snow" ? "*" : ".";
      row.push(Math.min(9, Math.floor(hs / 64 / 3.34)) + mark);
    }
    lines.push(`  y ${String(by * 8).padStart(2)}-${String(by * 8 + 7).padStart(2)}: ${row.join(" ")}`);
  }
  let deep = { v: 0, i: 0 }, hi = { v: -1, i: 0 }, lo = { v: 99, i: 0 }, wetCount = 0;
  for (let i = 0; i < N; i++) {
    if (world.water[i] > deep.v) deep = { v: world.water[i], i };
    if (world.height[i] > hi.v) hi = { v: world.height[i], i };
    if (world.height[i] < lo.v) lo = { v: world.height[i], i };
    if (world.water[i] > WET) wetCount++;
  }
  const at = (i) => `(${i % W},${Math.floor(i / W)})`;
  lines.push(`Highest ground ${hi.v.toFixed(1)} m at ${at(hi.i)}; lowest ${lo.v.toFixed(1)} m at ${at(lo.i)}. ${wetCount} tiles are wet; deepest water ${deep.v.toFixed(2)} m at ${at(deep.i)}.`);
  lines.push("Materials: water (always), " + world.materials.map((m) => `${m.name} ${m.color}`).join(", ") + ".");
  lines.push("Skeins (id, name, on/off, threads):");
  for (const l of world.skeins) {
    const threads = l.threads.map((r) => `"${r.name}" [${describeArea(r.area)}]`).join("; ") || "no threads";
    const tools = (l.powers || []).map((p) => `tool "${p.name}" (id ${p.id}, ${p.brush.stroke ? "drag, width " + p.brush.stroke : "click, radius " + p.brush.circle}, used ${p.uses.length} time${p.uses.length === 1 ? "" : "s"}${p.retired ? ", " + p.retired + ", not in the palette" : ""})`).join("; ");
    lines.push(`  ${l.id}. ${l.name} (${l.on ? "on" : "off"}): ${threads}${tools ? "; " + tools : ""}`);
  }
  const living = (world.creatures || []).filter((c) => !c.dead);
  if (living.length) {
    lines.push("Animals (they act on their own: they drink, eat and flee by themselves; you can only change the land around them):");
    for (const sp of world.species) {
      if (!living.some((c) => c.species === sp.name)) continue;
      lines.push(`  species ${sp.name}: drinks from water up to ${num(sp.wades)} m deep, eats ${sp.eats.join(" or ")}${sp.avoids.length ? ", avoids " + sp.avoids.join(" and ") : ""}, climbs steps up to ${num(sp.climbs)} m, sees ${SIGHT} tiles; lasts ${spanText(sp.thirst)} without water and ${spanText(sp.hunger)} without food.`);
    }
    for (const c of living.slice(0, 12)) lines.push(`  ${c.name} (${c.species}) at (${Math.floor(c.x)},${Math.floor(c.y)}): thirst ${Math.round(c.thirst * 100)}%, hunger ${Math.round(c.hunger * 100)}%, ${c.state}.`);
  }
  if (spot) {
    const { cells } = areaShape({ circle: [spot.x, spot.y, spot.r] });
    let hmin = 99, hmax = 0, hsum = 0, wsum = 0; const counts = new Map();
    for (const i of cells) {
      hmin = Math.min(hmin, world.height[i]); hmax = Math.max(hmax, world.height[i]); hsum += world.height[i]; wsum += world.water[i];
      const name = world.materials[world.mat[i]].name; counts.set(name, (counts.get(name) || 0) + 1);
    }
    const mats = [...counts].sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n} ${Math.round((100 * c) / cells.length)}%`).join(", ");
    const around = (dx, dy) => { const x = clamp(Math.round(spot.x + dx), 0, W - 1), y = clamp(Math.round(spot.y + dy), 0, H - 1); return world.height[y * W + x]; };
    const d = spot.r + 3, slopes = { north: around(0, -d), south: around(0, d), east: around(d, 0), west: around(-d, 0) };
    const downhill = Object.entries(slopes).sort((a, b) => a[1] - b[1])[0][0];
    const wet = nearestWet(world, spot.x, spot.y, spot.r);
    lines.push(`The player's spot ("here"): circle at (${spot.x},${spot.y}) radius ${spot.r}, ${cells.length} tiles. Height ${hmin.toFixed(1)}-${hmax.toFixed(1)} m (average ${(hsum / cells.length).toFixed(1)}). Average water ${(wsum / cells.length).toFixed(2)} m. Ground: ${mats}. Downhill is ${downhill} (${Object.entries(slopes).map(([k, v]) => `${k} ${v.toFixed(1)} m`).join(", ")} at ${d} tiles out).${wet ? ` Nearest open water outside it: (${wet.x},${wet.y}), ${wet.d.toFixed(0)} tiles away.` : ""}`);
  } else {
    lines.push("The player has not selected a spot.");
  }
  return lines.join("\n");
}

// ---------- saving ----------
function toB64(typed) {
  const bytes = new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromB64(str, Type, length) {
  const s = atob(str), bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  const out = new Type(bytes.buffer);
  if (out.length !== length) throw new Error("save is damaged");
  return out;
}
const META = ["seed", "tick", "rng", "wrng", "nextSkein", "nextUse", "nextCreature", "crng", "whims"];
const LIVES = ["species", "creatures", "graveyard"];

function save(world) {
  const out = { version: world.version };
  for (const k of META) out[k] = world[k];
  out.weather = { ...world.weather };
  out.materials = JSON.parse(JSON.stringify(world.materials));
  out.skeins = JSON.parse(JSON.stringify(world.skeins));
  for (const k of LIVES) out[k] = JSON.parse(JSON.stringify(world[k] || []));
  for (const k of ["height", "water", "silt", "flux"]) out[k] = toB64(world[k]);
  out.mat = toB64(world.mat);
  return out;
}

function load(data) {
  if (!data || data.version !== 1) throw new Error("unknown save version");
  const world = blank(data.seed);
  for (const k of META) if (data[k] !== undefined) world[k] = data[k];
  world.weather = { ...data.weather };
  world.materials = JSON.parse(JSON.stringify(data.materials));
  world.skeins = JSON.parse(JSON.stringify(data.skeins));
  for (const k of LIVES) world[k] = JSON.parse(JSON.stringify(data[k] || []));   // saves from before animals have none
  for (const k of ["height", "water", "silt", "flux"]) world[k] = fromB64(data[k], Float32Array, N);
  world.mat = fromB64(data.mat, Uint8Array, N);
  return world;
}

/** A quick in-memory copy for rewinding. */
function snapshot(world) {
  return {
    tick: world.tick, rng: world.rng, wrng: world.wrng, nextSkein: world.nextSkein, nextUse: world.nextUse, weather: { ...world.weather },
    nextCreature: world.nextCreature, crng: world.crng, whims: world.whims, lives: JSON.parse(JSON.stringify(LIVES.map((k) => world[k] || []))),
    materials: JSON.parse(JSON.stringify(world.materials)), skeins: JSON.parse(JSON.stringify(world.skeins)),
    height: world.height.slice(), water: world.water.slice(), silt: world.silt.slice(), flux: world.flux.slice(), mat: world.mat.slice(),
  };
}

function restore(world, snap) {
  world.tick = snap.tick; world.rng = snap.rng; world.wrng = snap.wrng; world.nextSkein = snap.nextSkein; world.nextUse = snap.nextUse ?? world.nextUse;
  world.nextCreature = snap.nextCreature; world.crng = snap.crng; world.whims = snap.whims;
  LIVES.forEach((k, j) => { world[k] = JSON.parse(JSON.stringify(snap.lives[j])); }); world.weather = { ...snap.weather };
  world.materials = JSON.parse(JSON.stringify(snap.materials)); world.skeins = JSON.parse(JSON.stringify(snap.skeins));
  for (const k of ["height", "water", "silt", "flux", "mat"]) world[k].set(snap[k]);
  world._compiled = new Map();
}

export {
  W, H, N, TPS, DT, MAX_H, WET, LIMITS, BUILTIN,
  makeWorld, step, checkPlan, acceptPlan, setSkeinOn, eraseSkein, describe, describeArea, areaShape,
  threadActivity, save, load, snapshot, restore, countNear, explainPlan,
  usePower, undoUse, lastUse, useStates, findPower, saveForModel, LIVE_USES, powerOnceText, useArea, setPowerRemoved,
  addCreature, lifeStats, releaseGrazer, speciesOf, PATTERNS,
};
