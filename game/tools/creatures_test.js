// Creatures, steps 1 and 2 (docs/CREATURES.md), written before the feature: these tests specify it.
// Run: npm run test:creatures. Once they pass, this file joins `npm test`.
import assert from "node:assert";
import * as WF from "../world.js";
import { requestNeeds } from "../../server/claims.js";

const { W, H } = WF;
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log("ok   " + name); }
  catch (e) { failed++; console.log("FAIL " + name + "\n     " + String(e.message).split("\n")[0]); process.exitCode = 1; }
}
const at = (x, y) => y * W + x;
const run = (world, seconds) => { for (let t = 0; t < Math.round(seconds * WF.TPS); t++) WF.step(world); };
const tileOf = (c) => at(Math.floor(c.x), Math.floor(c.y));
const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b}`);

/**
 * A flat, still test world: ground 5 m everywhere, all soil, no water, no rain, nature switched off, no animals.
 * Ponds and patches are added per test, so each behaviour is tested on its own.
 */
function flat() {
  const w = WF.makeWorld(11, 0);
  for (const s of w.skeins) s.on = false;
  w.height.fill(5); w.water.fill(0); w.silt.fill(0); w.flux.fill(0); w.mat.fill(0);
  w.weather = { raining: false, until: 1e9 };
  w.creatures = [];
  return w;
}
/** A pond that stays put: a basin `depth` m deep filled to the brim, so its surface is level with the ground. */
function pond(w, x, y, r, depth = 2) {
  for (const i of WF.areaShape({ circle: [x, y, r] }).cells) { w.height[i] = 5 - depth; w.water[i] = depth; }
}
function paint(w, name, x, y, r) {
  const m = w.materials.findIndex((k) => k.name === name);
  for (const i of WF.areaShape({ circle: [x, y, r] }).cells) w.mat[i] = m;
}
const grazer = (w, x, y, extra = {}) => Object.assign(WF.addCreature(w, { species: "grazer", x, y }), extra);
const LIZARD = { name: "lizard", look: { color: "#e8803a", pattern: "ring" }, eats: ["sand"], avoids: ["meadow"], wades: 0.1, climbs: 2, speed: 1.5, thirst: 180, hunger: 300 };

// ---------- step 1: the first animal ----------
test("a new world has one living grazer, Mossback, on a walkable tile within 12 tiles of water", () => {
  const w = WF.makeWorld(7);
  assert.ok(Array.isArray(w.creatures), "world.creatures exists");
  assert.strictEqual(w.creatures.length, 1);
  const c = w.creatures[0];
  assert.strictEqual(c.name, "Mossback");
  assert.strictEqual(c.species, "grazer");
  assert.ok(!c.dead);
  assert.ok(w.species.some((s) => s.name === "grazer"), "the grazer species is in world.species");
  assert.ok(w.skeins.some((s) => s.kind === "nature" && /Wildlife/.test(s.name)), "it belongs to a built-in Wildlife skein");
  const i = tileOf(c);
  assert.ok(w.water[i] <= 0.3, "not standing in deep water");
  let wet = false;
  for (let dy = -12; dy <= 12 && !wet; dy++) for (let dx = -12; dx <= 12; dx++) {
    const x = Math.floor(c.x) + dx, y = Math.floor(c.y) + dy;
    if (x >= 0 && y >= 0 && x < W && y < H && Math.hypot(dx, dy) <= 12 && w.water[at(x, y)] > 0.05) { wet = true; break; }
  }
  assert.ok(wet, "water within 12 tiles");
});

test("the same seed gives the same animal doing the same things; animals never draw from the weather stream", () => {
  const a = WF.makeWorld(7), b = WF.makeWorld(7);
  run(a, 60); run(b, 60);
  assert.deepStrictEqual([a.creatures[0].x, a.creatures[0].y, a.creatures[0].thirst], [b.creatures[0].x, b.creatures[0].y, b.creatures[0].thirst]);
  const c = WF.makeWorld(7); c.creatures = [];
  const d = WF.makeWorld(7);
  run(c, 60); run(d, 60);
  assert.strictEqual(c.wrng, d.wrng, "the weather stream is untouched by animals");
  assert.deepStrictEqual(c.weather, d.weather);
  assert.ok("crng" in d, "animals have their own random stream");
});

test("needs drain at the species' rates (grazer: 120 s of water, 240 s of food)", () => {
  const w = flat(), c = grazer(w, 48, 32);
  run(w, 30);
  near(c.thirst, 1 - 30 / 120, 0.02, "thirst after 30 s");
  near(c.hunger, 1 - 30 / 240, 0.02, "hunger after 30 s");
});

test("with no water anywhere it dies of thirst on time, and leaves a marker for 30 s", () => {
  const w = flat(), c = grazer(w, 48, 32);
  run(w, 118);
  assert.ok(!c.dead, "alive at 118 s");
  run(w, 3);
  assert.ok(c.dead, "dead by 121 s");
  assert.strictEqual(c.diedOf, "thirst");
  assert.ok(w.creatures.includes(c), "its marker stays on the map");
  run(w, 31);
  assert.ok(!w.creatures.includes(c), "the marker is gone after 30 s");
  const life = WF.lifeStats(w).find((l) => l.id === c.id);
  assert.ok(life && life.diedOf === "thirst" && !life.alive, "lifeStats still remembers it");
});

test("a thirsty animal walks to a pond it can see and drinks back to full", () => {
  const w = flat();
  pond(w, 60, 32, 3);
  const c = grazer(w, 50, 32, { thirst: 0.3 });
  run(w, 2);
  assert.strictEqual(c.state, "seeking water");
  // Once full it may wander off again, so track how close it got and how full it drank.
  let closest = Infinity, fullest = 0;
  for (let t = 0; t < 18 * WF.TPS; t++) { WF.step(w); closest = Math.min(closest, Math.hypot(c.x - 60, c.y - 32)); fullest = Math.max(fullest, c.thirst); }
  assert.ok(closest < 5, `reached the pond: closest ${closest.toFixed(1)} tiles from its centre`);
  assert.ok(fullest > 0.9, "drank back to full: " + fullest);
});

test("a hungry animal eats meadow, and the meadow it ate turns to soil", () => {
  const w = flat();
  paint(w, "meadow", 40, 32, 1);
  const meadow = w.materials.findIndex((k) => k.name === "meadow");
  const before = WF.areaShape({ circle: [40, 32, 1] }).cells.filter((i) => w.mat[i] === meadow).length;
  const c = grazer(w, 35, 32, { hunger: 0.3 });
  run(w, 15);
  assert.ok(c.hunger > 0.8, "ate: " + c.hunger);
  const after = WF.areaShape({ circle: [40, 32, 1] }).cells.filter((i) => w.mat[i] === meadow).length;
  assert.ok(after < before, `meadow eaten: ${before} → ${after}`);
});

test("needing something it can't see, it goes searching", () => {
  const w = flat(), c = grazer(w, 48, 32, { thirst: 0.3 });
  run(w, 3);
  assert.strictEqual(c.state, "searching for water");
  assert.ok(Math.hypot(c.x - 48.5, c.y - 32.5) >= 1, "it moved");
});

test("it never walks into water deeper than it wades, onto ground it avoids, or up a step taller than it climbs", () => {
  const w = flat();
  for (let y = 0; y < H; y++) { w.mat[at(40, y)] = w.materials.findIndex((k) => k.name === "snow"); }   // a snow wall it avoids…
  for (let y = 0; y < 28; y++) w.mat[at(40, y)] = 0;                                                     // …with a gap in the north
  for (let y = 0; y < H; y++) for (let x = 50; x < W; x++) w.height[at(x, y)] = 9;                       // a 4 m cliff
  pond(w, 45, 32, 2, 1);                                                                                // water 1 m deep
  const snow = w.materials.findIndex((k) => k.name === "snow");
  const c = grazer(w, 30, 32, { thirst: 0.3 });
  let last = tileOf(c);
  for (let t = 0; t < 60 * WF.TPS && !c.dead; t++) {
    WF.step(w);
    const i = tileOf(c);
    assert.ok(w.water[i] <= 0.3 + 1e-6, `stood in ${w.water[i].toFixed(2)} m of water at tick ${t}`);
    assert.notStrictEqual(w.mat[i], snow, `stood on snow at tick ${t}`);
    assert.ok(Math.abs(w.height[i] - w.height[last]) <= 1.5 + 1e-6, `climbed ${Math.abs(w.height[i] - w.height[last]).toFixed(1)} m at tick ${t}`);
    last = i;
  }
});

test("it flees a flood onto dry ground", () => {
  const w = flat();
  pond(w, 48, 32, 1, 1);
  const c = grazer(w, 48, 32);
  run(w, 3);
  assert.ok(!c.dead);
  assert.ok(w.water[tileOf(c)] <= 0.3, "out of the water");
});

test("trapped in deep water, it drowns", () => {
  const w = flat();
  pond(w, 48, 32, 6, 2);
  const c = grazer(w, 48, 32);
  run(w, 6);
  assert.ok(c.dead);
  assert.strictEqual(c.diedOf, "drowned");
});

test("save/load and rewind keep an animal's state, and it carries on identically", () => {
  const w = flat();
  pond(w, 60, 32, 3);
  grazer(w, 50, 32, { thirst: 0.4 });
  run(w, 5);
  const loaded = WF.load(WF.save(w)), snap = WF.snapshot(w);
  run(w, 20); run(loaded, 20);
  assert.deepStrictEqual([loaded.creatures[0].x, loaded.creatures[0].y, loaded.creatures[0].thirst], [w.creatures[0].x, w.creatures[0].y, w.creatures[0].thirst]);
  const after = [w.creatures[0].x, w.creatures[0].y];
  WF.restore(w, snap); run(w, 20);
  assert.deepStrictEqual([w.creatures[0].x, w.creatures[0].y], after, "rewind replays the same way");
});

test("lifeStats counts age, time thriving and whims since birth; tool uses count as whims", () => {
  const w = flat();
  pond(w, 52, 32, 2); paint(w, "meadow", 44, 32, 2);
  const c = grazer(w, 48, 32);
  run(w, 10);
  let life = WF.lifeStats(w).find((l) => l.id === c.id);
  near(life.ageSeconds, 10, 0.2, "age");
  near(life.thrivingSeconds, 10, 0.2, "thriving (both needs above half)");
  assert.strictEqual(life.whimsSince, 0);
  const s = WF.acceptPlan(w, WF.checkPlan(w, { name: "Hill", powers: [{ name: "Hill", brush: 1, edits: [{ raise: 1 }] }] }, null).clean, { whim: "a hill tool" });
  WF.usePower(w, s.powers[0].id, { x: 10, y: 10 });
  life = WF.lifeStats(w).find((l) => l.id === c.id);
  assert.strictEqual(life.whimsSince, 2, "one whim and one tool use");
});

// ---------- step 2: species as data ----------
test("checkPlan accepts a species, fills its defaults, and accepts releases", () => {
  const w = flat();
  const { clean, problems } = WF.checkPlan(w, { species: [{ name: "Beetle", look: { color: "#334455" }, eats: ["soil"] }],
    release: [{ species: "beetle", area: { circle: [30, 30, 3] }, count: 2 }] }, null);
  assert.deepStrictEqual(problems, []);
  assert.deepStrictEqual(clean.species[0], { name: "beetle", look: { color: "#334455", pattern: "dot" }, eats: ["soil"], avoids: [],
    wades: 0.3, climbs: 1.5, speed: 1, thirst: 120, hunger: 240 });
  assert.deepStrictEqual(clean.release[0], { species: "beetle", area: { circle: [30, 30, 3] }, count: 2 });
});

test("checkPlan explains what it drops or adjusts in a species", () => {
  const w = flat();
  const { clean, problems } = WF.checkPlan(w, { species: [
    { ...LIZARD, look: { color: "#e8803a", pattern: "sparkles" }, speed: 9 },
    { name: "eater", look: { color: "#000000" }, eats: ["unobtainium"] },
    { name: "grazer", look: { color: "#ffffff" }, eats: ["meadow"] },
    { name: "fourth", look: { color: "#111111" }, eats: ["soil"] },
  ], release: [{ species: "unicorn", area: "everywhere", count: 1 }, { species: "lizard", area: { circle: [30, 30, 3] }, count: 40 }] }, null);
  assert.deepStrictEqual(clean.species.map((s) => s.name), ["lizard"]);
  assert.strictEqual(clean.species[0].look.pattern, "dot", "an unknown pattern falls back to dot");
  assert.strictEqual(clean.species[0].speed, 3, "speed clamped to 3");
  const all = problems.join("\n");
  assert.match(all, /pattern/); assert.match(all, /unobtainium/); assert.match(all, /already a species grazer/);
  assert.match(all, /only the first 2 species/); assert.match(all, /no species unicorn/);
  assert.strictEqual(clean.release.find((r) => r.species === "lizard").count, 6, "at most 6 released per plan");
});

test("a release lands animals on walkable tiles in its area; erasing the skein removes them and its species", () => {
  const w = flat();
  paint(w, "sand", 30, 30, 4);
  const s = WF.acceptPlan(w, WF.checkPlan(w, { species: [LIZARD], release: [{ species: "lizard", area: { circle: [30, 30, 4] }, count: 3, names: ["Ember"] }] }, null).clean, {});
  const lizards = w.creatures.filter((c) => c.species === "lizard");
  assert.strictEqual(lizards.length, 3);
  assert.strictEqual(lizards[0].name, "Ember");
  for (const c of lizards) assert.ok(Math.hypot(c.x - 30.5, c.y - 30.5) <= 5 && w.water[tileOf(c)] <= 0.1);
  assert.ok(w.species.some((sp) => sp.name === "lizard"));
  WF.eraseSkein(w, s.id);
  assert.strictEqual(w.creatures.filter((c) => c.species === "lizard").length, 0);
  assert.ok(!w.species.some((sp) => sp.name === "lizard"));
});

test("a species can't avoid what it eats (from playtest: 'eats sand, avoids sand')", () => {
  const w = flat();
  const { clean, problems } = WF.checkPlan(w, { species: [{ ...LIZARD, avoids: ["sand", "meadow"] }] }, null);
  assert.deepStrictEqual(clean.species[0].avoids, ["meadow"]);
  assert.match(problems.join("\n"), /can't both eat and avoid sand/);
});

test("when fewer animals find ground to stand on than were released, 'What it does' says so", () => {
  const w = flat();
  paint(w, "meadow", 30, 30, 4);   // lizards avoid meadow: one sand tile in the middle is all they can stand on
  w.mat[at(30, 30)] = 1;
  const plan = WF.checkPlan(w, { species: [LIZARD], release: [{ species: "lizard", area: { circle: [30, 30, 3.5] }, count: 6 }] }, null).clean;
  const s = WF.acceptPlan(w, plan, {});
  const placed = w.creatures.filter((c) => c.species === "lizard").length;
  assert.ok(placed < 6, "placed " + placed);
  assert.match(WF.explainPlan(s, w).join("\n"), new RegExp(`Releases 6 lizards .*Only ${placed} found ground`));
});

test("describe() tells the model about each animal and its needs", () => {
  const text = WF.describe(WF.makeWorld(7), null);
  assert.match(text, /Mossback \(grazer\) at \(\d+,\d+\): thirst \d+%, hunger \d+%/);
  assert.match(text, /eats meadow/);
});

test("explainPlan describes a species from its data, and a release", () => {
  const w = flat();
  const lines = WF.explainPlan(WF.checkPlan(w, { species: [LIZARD], release: [{ species: "lizard", area: { circle: [30, 30, 4] }, count: 2 }] }, null).clean, w);
  const text = lines.join("\n");
  assert.match(text, /New animal: lizard/);
  assert.match(text, /eats sand/); assert.match(text, /wades up to 0\.1 m/); assert.match(text, /3 min without water/);
  assert.match(text, /Releases 2 lizards/);
});

test("the request check no longer refuses animals, but still refuses herds, flying and following the mouse", () => {
  const needs = (whim) => requestNeeds(whim).map((n) => n.what);
  assert.deepStrictEqual(needs("A little orange lizard that loves warm sand and hates water"), []);
  assert.ok(needs("a herd of deer that wanders the meadows").includes("herds and packs"));
  assert.ok(needs("a bird that flies over the lake").includes("flying"));
  assert.ok(needs("a dog that follows my mouse").includes("following the mouse pointer"));
});

console.log(`\n${passed} passed, ${failed} failing`);
