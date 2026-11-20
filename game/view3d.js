// The 3D view: the same world, drawn with Strata (https://github.com/Preponderous-Software/strata, MIT).
//
// This file turns a Glomus world into plain arrays and hands them to the engine in 3d/glomus3d.wasm, built
// from view3d/glomus3d.cpp with Strata's web kit. It reads the world and never changes it: a tap only
// reports which tile was tapped, and the page decides what that means.
//
//   const view = await open3d({canvas, WF, world: () => world, spot: () => spot, rings: () => [], onTap(x, y) {}});
//   view.pause(); view.resume(); view.refresh();   // refresh: upload the world now, not at the next interval
//
// One tile is one metre, as world.js's heights are; the map's centre is the origin.

const BASE = new URL("./3d/", import.meta.url);
const REFRESH_MS = 250;

function script(src) {
  return new Promise((resolve, reject) => {
    if ([...document.scripts].some((s) => s.src === src)) return resolve();
    const s = document.createElement("script");
    s.src = src; s.onload = resolve; s.onerror = () => reject(new Error(`couldn't load ${src}`));
    document.head.append(s);
  });
}

// Glomus's colours are sRGB hex; Strata lights in linear RGB.
const linear = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
export function hexLinear(hex) {
  const n = parseInt(String(hex || "#ff00ff").slice(1), 16);
  return [linear((n >> 16) & 255), linear((n >> 8) & 255), linear(n & 255)];
}

/** Everything the engine draws, as arrays: the ground, the water, the animals and the outlines. */
export function sceneOf(WF, world, rings = []) {
  const { W, H } = WF, N = W * H, h = world.height, w = world.water, m = world.mat, f = world.flux || new Float32Array(N);
  const ox = -(W - 1) / 2, oz = -(H - 1) / 2;
  const mats = world.materials.map((mm) => hexLinear(mm.color));
  const heights = new Float32Array(N), colors = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    heights[i] = h[i];
    const c = mats[m[i]] || [1, 0, 1], damp = w[i] > 0.02 ? 0.72 : 1;   // wet ground reads darker
    colors[i * 3] = c[0] * damp; colors[i * 3 + 1] = c[1] * damp; colors[i * 3 + 2] = c[2] * damp;
  }
  // Water: one vertex per tile, so the surface is continuous. A dry vertex is tucked under the ground,
  // so the water's edge meets the bank instead of stepping. Only quads with some water are kept.
  const wet = (i) => w[i] > 0.02;
  const pos = new Float32Array(N * 3), wcol = new Float32Array(N * 3), idx = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, d = w[i], fast = Math.min(1, f[i] * 5);
    pos[i * 3] = ox + x; pos[i * 3 + 1] = wet(i) ? h[i] + d + 0.03 : h[i] - 0.15; pos[i * 3 + 2] = oz + y;
    const deep = Math.min(1, d / 1.5);
    wcol[i * 3] = 0.03 + 0.10 * fast; wcol[i * 3 + 1] = 0.12 + 0.18 * fast - 0.05 * deep; wcol[i * 3 + 2] = 0.35 + 0.15 * fast - 0.12 * deep;
  }
  for (let y = 0; y < H - 1; y++) for (let x = 0; x < W - 1; x++) {
    const a = y * W + x, b = a + 1, c = a + W, d = c + 1;
    if (!(wet(a) || wet(b) || wet(c) || wet(d))) continue;
    idx.push(a, c, b, b, c, d);
  }
  const ground = (tx, ty) => {   // the surface under a point in tile units, water included
    const x = Math.max(0, Math.min(W - 1, Math.round(tx))), y = Math.max(0, Math.min(H - 1, Math.round(ty)));
    return h[y * W + x] + (wet(y * W + x) ? w[y * W + x] : 0);
  };
  const marks = [];
  for (const c of world.creatures || []) {
    if (c.dead) continue;
    const sp = WF.speciesOf ? WF.speciesOf(world, c.species) : null, col = hexLinear(sp && sp.look ? sp.look.color : "#e8d08a");
    const tx = c.x - 0.5, ty = c.y - 0.5;
    marks.push(ox + tx, ground(tx, ty), oz + ty, 0.6, ...col);
  }
  const lines = [];
  for (const r of rings) {
    const n = Math.max(24, Math.round(r.r * 10)), col = r.color || [1, 1, 1, 0.95];
    let prev = null;
    for (let k = 0; k <= n; k++) {
      const a = (k / n) * Math.PI * 2, tx = r.x + Math.cos(a) * (r.r + 0.5), ty = r.y + Math.sin(a) * (r.r + 0.5);
      const p = [ox + tx, ground(tx, ty) + 0.25, oz + ty];
      if (prev) lines.push(...prev, ...p, ...col);
      prev = p;
    }
  }
  return { W, H, ox, oz, heights, colors, water: { pos, col: wcol, idx: Uint32Array.from(idx) }, marks: Float32Array.from(marks), lines: Float32Array.from(lines) };
}

/** Nearest tile to a point in CSS pixels, by projecting tile centres; null off the map. */
export function tileAtPixel(kit, scene, px, py, radius) {
  let best = null, bestD = radius * radius;
  for (let y = 0; y < scene.H; y++) for (let x = 0; x < scene.W; x++) {
    const p = kit.project(scene.ox + x, scene.heights[y * scene.W + x], scene.oz + y);
    if (!p) continue;
    const d = (p.x - px) ** 2 + (p.y - py) ** 2;
    if (d < bestD) { bestD = d; best = { x, y, w: p.w }; }
  }
  return best;
}

/** Loads the engine into `canvas` and keeps it drawing the world. Rejects if WebGL 2 or the engine fails. */
export async function open3d({ canvas, mount, WF, world, spot = () => null, rings = () => [], onTap = () => {} }) {
  await script(new URL("strata-loader.js", BASE).href);
  await script(new URL("strata-kit.js", BASE).href);
  const module = await window.StrataLoader.load({
    script: new URL("glomus3d.js", BASE).href, factory: "createGlomus3d", wasm: new URL("glomus3d.wasm", BASE).href,
    title: "Glomus in 3D", mount: mount || canvas.parentElement, contain: true,
  });
  const M = module, bufs = new Map();
  const buf = (name, bytes) => {   // one malloc'd buffer per array, grown when needed
    let b = bufs.get(name);
    if (!b || b.bytes < bytes) { if (b) M._free(b.ptr); b = { ptr: M._malloc(Math.max(16, bytes)), bytes: Math.max(16, bytes) }; bufs.set(name, b); }
    return b.ptr;
  };
  const putF = (name, arr) => { const p = buf(name, arr.length * 4); M.HEAPF32.set(arr, p >> 2); return p; };
  const putU = (name, arr) => { const p = buf(name, arr.length * 4); M.HEAP32.set(new Int32Array(arr.buffer, arr.byteOffset, arr.length), p >> 2); return p; };

  let scene = null, lastTick = -1, lastAt = 0, lastRings = "";
  function upload(force) {
    const wd = world(), now = performance.now();
    const rs = [...(spot() ? [{ ...spot(), color: [1, 1, 1, 0.95] }] : []), ...rings()], key = JSON.stringify(rs);
    if (!force && wd.tick === lastTick && key === lastRings && scene) return;
    if (!force && now - lastAt < REFRESH_MS && key === lastRings) return;
    lastTick = wd.tick; lastAt = now; lastRings = key;
    scene = sceneOf(WF, wd, rs);
    M._g3_set_ground(putF("h", scene.heights), putF("c", scene.colors), scene.W, scene.H, 1.0, scene.ox, scene.oz);
    const wt = scene.water;
    M._g3_set_water(putF("wp", wt.pos), putF("wc", wt.col), wt.pos.length / 3, putU("wi", wt.idx), wt.idx.length, 0.72);
    M._g3_set_marks(putF("m", scene.marks), scene.marks.length / 7);
    M._g3_set_lines(putF("l", scene.lines), scene.lines.length / 10);
  }

  const kit = window.StrataKit.create({
    module, canvas,
    camera: { yaw: Math.PI / 2, pitch: 0.75, dist: 95, tx: 0, ty: 6, tz: 0 },
    limits: { minDist: 12, maxDist: 220 },
    idleOrbit: false,
    frame() { upload(false); },
    onRestore() { upload(true); },
    pick(x, y, radius) { return scene ? tileAtPixel(kit, scene, x, y, Math.max(radius, 24)) : null; },
    idOf: (hit) => `${hit.x},${hit.y}`,
    onTap(hit) { if (hit) onTap(hit.x, hit.y); },
    onSlow: () => window.StrataLoader.slow(),
    onFatal: (code, message) => window.StrataLoader.fallback(code, message),
  });
  upload(true);
  kit.start();
  window.StrataLoader.done();
  return {
    kit,
    refresh: () => upload(true),
    pause() { kit.running = false; },
    resume() { upload(true); kit.start(); },
    get scene() { return scene; },
  };
}
