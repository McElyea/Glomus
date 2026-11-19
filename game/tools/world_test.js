// Checks for the world, its threads and the plan language. Run: node game/tools/world_test.js
import assert from "node:assert";
import * as WF from "../world.js";
const { W } = WF;

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log("ok   " + name); }
  catch (e) { console.log("FAIL " + name + "\n     " + e.message); process.exitCode = 1; }
}
const fresh = () => WF.makeWorld(11, 300);
const at = (x, y) => y * W + x;
const run = (world, seconds) => { for (let t = 0; t < seconds * WF.TPS; t++) WF.step(world); };

test("a new world has a nature skein, a running spring and some water", () => {
  const w = fresh();
  assert.deepStrictEqual(w.skeins.map((k) => [k.kind, k.name]), [["nature", "Nature (built in)"], ["nature", "Wildlife (built in)"]]);
  let wet = 0; for (let i = 0; i < WF.N; i++) if (w.water[i] > WF.WET) wet++;
  assert.ok(wet > 100, "only " + wet + " wet tiles");
});

test("checkPlan keeps usable parts and explains the rest", () => {
  const w = fresh();
  const { clean, problems, usable } = WF.checkPlan(w, {
    threads: [
      { name: "good", area: { circle: [10, 10, 3] }, when: [{ water: [">", 0.1] }], do: [{ add_water: 1 }] },
      { name: "bad material", area: "everywhere", when: [], do: [{ set_material: "unobtainium" }] },
      { name: "bad condition", area: "everywhere", when: [{ moon: "full" }], do: [{ add_water: 1 }] },
    ],
  }, null);
  assert.ok(usable);
  assert.deepStrictEqual(clean.threads.map((r) => r.name), ["good"]);
  assert.ok(problems.some((p) => p.includes("unobtainium")));
  assert.ok(problems.some((p) => p.includes("bad condition") && p.includes("dropped")));
});

test("loose model spellings are normalized", () => {
  const w = fresh();
  const { clean } = WF.checkPlan(w, {
    threads: [{ name: "loose", where: { x: 5, y: 6, r: 2 }, when: [{ water: ">0.2" }, { height: { "<": 9 } }], then: [{ pump: "East", amount: "2" }] }],
  }, null);
  assert.deepStrictEqual(clean.threads[0].area, { circle: [5, 6, 2] });
  assert.deepStrictEqual(clean.threads[0].when, [{ water: [">", 0.2] }, { height: ["<", 9] }]);
  assert.deepStrictEqual(clean.threads[0].do, [{ push_water: "east", amount: 2 }]);
});

test("\"spot\" resolves to the player's spot, and fails cleanly without one", () => {
  const w = fresh();
  const plan = { edits: [{ area: "spot", raise: 2 }] };
  assert.deepStrictEqual(WF.checkPlan(w, plan, { x: 20, y: 30, r: 4 }).clean.edits[0].area, { circle: [20, 30, 4] });
  const none = WF.checkPlan(w, plan, null);
  assert.ok(!none.usable && none.problems.some((p) => p.includes("no spot")));
});

test("a new material can be defined and used in the same plan", () => {
  const w = fresh();
  const { clean, usable } = WF.checkPlan(w, {
    materials: [{ name: "Glowmoss", color: "#7fffb0" }],
    threads: [{ name: "creep", area: "everywhere", when: [{ material: "glowmoss" }], do: [{ spread: "glowmoss", chance: 1, onto: ["meadow", "soil"] }] }],
  }, null);
  assert.ok(usable);
  const skein = WF.acceptPlan(w, clean, { whim: "moss" });
  assert.ok(w.materials.some((m) => m.name === "glowmoss"));
  assert.ok(skein.threads.length === 1);
});

test("edits change the ground and erasing puts it back", () => {
  const w = fresh();
  const before = w.height.slice(), matBefore = w.mat.slice();
  const { clean } = WF.checkPlan(w, { edits: [{ area: { path: [[10, 20], [40, 20]], width: 3 }, lower: 3, material: "sand" }] }, null);
  const skein = WF.acceptPlan(w, clean, { whim: "dig" });
  assert.ok(w.height[at(25, 20)] < before[at(25, 20)] - 2.5, "the channel was not dug");
  assert.strictEqual(w.materials[w.mat[at(25, 20)]].name, "sand");
  WF.eraseSkein(w, skein.id);
  assert.strictEqual(w.height[at(25, 20)], before[at(25, 20)]);
  assert.strictEqual(w.mat[at(25, 20)], matBefore[at(25, 20)]);
  assert.ok(w.skeins.every((k) => k.kind === "nature"), "only the built-in skeins are left");
});

test("a thread that adds water makes the area wet, and switching it off stops it", () => {
  const w = fresh();
  const spot = { x: 70, y: 12, r: 2 };
  const { clean } = WF.checkPlan(w, { threads: [{ name: "fountain", area: "spot", when: [], do: [{ add_water: 3 }] }] }, spot);
  const skein = WF.acceptPlan(w, clean, { whim: "fountain", spot });
  run(w, 5);
  assert.ok(WF.threadActivity(w, skein)[0] > 0);
  WF.setSkeinOn(w, skein.id, false);
  assert.strictEqual(WF.threadActivity(w, skein)[0], 0);
});

test("push_water uphill moves water against the slope", () => {
  const w = WF.makeWorld(3, 0);
  w.skeins[0].on = false; // No spring, no meadows: an isolated test.
  w.water.fill(0);
  for (let x = 0; x < W; x++) { // A walled trough whose floor rises to the east.
    w.height[at(x, 40)] = 5 + x * 0.1; w.height[at(x, 39)] = 25; w.height[at(x, 41)] = 25;
  }
  w.water[at(20, 40)] = 2;
  const { clean } = WF.checkPlan(w, { threads: [{ name: "pump", area: { rect: [10, 40, 40, 1] }, when: [], do: [{ push_water: "east", amount: 8 }] }] }, null);
  WF.acceptPlan(w, clean, {});
  run(w, 2);
  let east = 0, west = 0;
  for (let x = 30; x < 60; x++) east += w.water[at(x, 40)];
  for (let x = 0; x < 30; x++) west += w.water[at(x, 40)];
  assert.ok(east > 0.5 && east > west * 5, `water east ${east.toFixed(3)}, west ${west.toFixed(3)}`);
});

test("cycle conditions are on only during their window", () => {
  const w = WF.makeWorld(5, 0);
  w.skeins[0].on = false;
  const { clean } = WF.checkPlan(w, { threads: [{ name: "gate", area: { circle: [50, 50, 1] }, when: [{ cycle: 10, from: 0, to: 2 }], do: [{ add_water: 1 }] }] }, null);
  const skein = WF.acceptPlan(w, clean, {});
  let on = 0;
  for (let t = 0; t < 100; t++) { WF.step(w); if (WF.threadActivity(w, skein)[0] > 0) on++; }
  assert.strictEqual(on, 20);
});

test("switch_off turns other skeins off, and erasing the whim turns them back on", () => {
  const w = fresh();
  const { clean } = WF.checkPlan(w, { switch_off: ["skein 1"], say: "Nature rests." }, null);
  const skein = WF.acceptPlan(w, clean, { whim: "stop nature" });
  assert.strictEqual(w.skeins[0].on, false);
  WF.eraseSkein(w, skein.id);
  assert.strictEqual(w.skeins[0].on, true);
});

test("a talk-only reply makes no skein", () => {
  const w = fresh();
  const checked = WF.checkPlan(w, { say: "The river runs south." }, null);
  assert.ok(!checked.usable);
  assert.strictEqual(WF.acceptPlan(w, checked.clean, {}), null);
});

test("save and load continue identically", () => {
  const a = fresh();
  const { clean } = WF.checkPlan(a, { threads: [{ name: "moss", area: "everywhere", when: [{ material: ["meadow"] }], do: [{ spread: "meadow", chance: 0.5 }] }] }, null);
  WF.acceptPlan(a, clean, {});
  run(a, 3);
  const b = WF.load(JSON.parse(JSON.stringify(WF.save(a))));
  run(a, 5); run(b, 5);
  assert.deepStrictEqual(Array.from(b.mat), Array.from(a.mat));
  assert.deepStrictEqual(Array.from(b.height), Array.from(a.height));
});

test("rewinding to a snapshot restores the world exactly", () => {
  const w = fresh();
  run(w, 2);
  const snap = WF.snapshot(w), h = w.height.slice(), skeins = w.skeins.length;
  const { clean } = WF.checkPlan(w, { edits: [{ area: { circle: [30, 30, 5] }, raise: 4 }] }, null);
  WF.acceptPlan(w, clean, {});
  run(w, 3);
  WF.restore(w, snap);
  assert.deepStrictEqual(Array.from(w.height), Array.from(h));
  assert.strictEqual(w.skeins.length, skeins);
});

test("the report names the spot, the skeins and the coarse map", () => {
  const w = fresh();
  const text = WF.describe(w, { x: 30, y: 30, r: 4 });
  assert.ok(text.includes("The player's spot"));
  assert.ok(text.includes("1. Nature"));
  assert.strictEqual(text.split("\n").filter((l) => /^\s+y\s+\d/.test(l)).length, 8);
});

test("the model may still say \"rules\" for threads", () => {
  const w = fresh();
  const { clean } = WF.checkPlan(w, { rules: [{ name: "old word", area: "everywhere", when: [], do: [{ add_water: 0.1 }] }] }, null);
  assert.strictEqual(clean.threads.length, 1);
});

test("a cleaned plan passes checkPlan again unchanged", () => {
  const w = fresh();
  const spot = { x: 30, y: 30, r: 3 };
  const first = WF.checkPlan(w, {
    materials: [{ name: "Ember", color: "#FF6633" }],
    edits: [{ area: { path: [[10, 10], [20, 12]] }, lower: 2 }, { area: "spot", material: "ember" }],
    threads: [{ name: "glow", area: "spot", when: [{ cycle: 20, from: 0, to: 5 }, { not: { raining: true } }, { near: "water", count: ">=1" }],
      do: [{ spread: "ember", chance: 0.1, onto: "soil" }, { pump: "downhill", amount: 1 }] }],
  }, spot).clean;
  const second = WF.checkPlan(w, first, null);
  assert.deepStrictEqual(second.problems, []);
  assert.deepStrictEqual(second.clean, first);
});

test("a whim's chance threads don't change the weather", () => {
  const a = WF.makeWorld(9, 0), b = WF.makeWorld(9, 0);
  const { clean } = WF.checkPlan(b, { threads: [{ name: "dice", area: "everywhere", when: [{ chance: 0.5 }], do: [{ add_water: 0.001 }] }] }, null);
  WF.acceptPlan(b, clean, {});
  const flips = (w) => { const out = []; let last = w.weather.raining; for (let t = 0; t < 4000; t++) { WF.step(w); if (w.weather.raining !== last) { out.push(w.tick); last = w.weather.raining; } } return out; };
  assert.deepStrictEqual(flips(b), flips(a));
});

test("within and after time a thread from when its whim was committed", () => {
  const w = WF.makeWorld(5, 0);
  w.skeins[0].on = false;
  run(w, 3); // The whim arrives at tick 30, not at the start of the world.
  const { clean, problems } = WF.checkPlan(w, { threads: [
    { name: "first minute", area: { circle: [20, 20, 1] }, when: [{ within: 5 }], do: [{ add_water: 1 }] },
    { name: "later", area: { circle: [60, 20, 1] }, when: [{ after: 5 }], do: [{ add_water: 1 }] },
  ] }, null);
  assert.deepStrictEqual(problems, []);
  const skein = WF.acceptPlan(w, clean, {});
  const on = [0, 0];
  for (let t = 0; t < 100; t++) { WF.step(w); WF.threadActivity(w, skein).forEach((f, k) => { if (f > 0) on[k]++; }); }
  assert.deepStrictEqual(on, [50, 50]);
});

test("several conditions packed into one object are all kept, not just the first", () => {
  const w = fresh();
  const { clean } = WF.checkPlan(w, { threads: [{ name: "Sparks", area: "everywhere",
    when: [{ material: ["soil"], chance: 0.005, within: 120 }, { near: "water", count: [">=", 2], cycle: 30, from: 0, to: 10 }], do: [{ set_material: "sand" }] }] }, null);
  assert.deepStrictEqual(clean.threads[0].when, [{ material: ["soil"] }, { chance: 0.005 }, { within: 120 },
    { near: "water", count: [">=", 2] }, { cycle: 30, from: 0, to: 10 }]);
});

// ---------- change records, tools and their uses (slice 2) ----------
// A still world: nature off, no water, no rain, so heights only change when a skein or a tool changes them.
function still() {
  const w = fresh();
  w.skeins[0].on = false; w.water.fill(0); w.silt.fill(0); w.flux.fill(0);
  w.weather = { raining: false, until: 1e9 };
  w.creatures = [];
  return w;
}
const add = (w, plan, spot = null) => WF.acceptPlan(w, WF.checkPlan(w, plan, spot).clean, { spot });
const tool = (w, power, spot = null) => add(w, { name: power.name, powers: [power] }, spot).powers[0];
const near1 = (a, b, what) => assert.ok(Math.abs(a - b) < 1e-3, `${what}: ${a} vs ${b}`);

test("erasing an older raise keeps a later one on the same tile (10 → +4 → +3, erase the first → 13)", () => {
  const w = still(), i = at(50, 30), a = { circle: [50, 30, 0.5] };
  w.height[i] = 10;
  const A = add(w, { edits: [{ area: a, raise: 4 }] }), B = add(w, { edits: [{ area: a, raise: 3 }] });
  near1(w.height[i], 17, "after both");
  WF.eraseSkein(w, A.id);
  near1(w.height[i], 13, "after erasing A");
  WF.eraseSkein(w, B.id);
  near1(w.height[i], 10, "after erasing B");
});

test("erasing a sinking thread takes back what it lowered", () => {
  const w = still(), i = at(70, 40);
  w.height[i] = 10;
  const S = add(w, { threads: [{ name: "Sink", area: { circle: [70, 40, 0.5] }, when: [{ height: [">", 6] }], do: [{ lower: 1 }] }] });
  run(w, 10);
  near1(w.height[i], 6, "settled");
  WF.eraseSkein(w, S.id);
  near1(w.height[i], 10, "after erase");
});

test("a material is only put back where the tile still holds what the record wrote", () => {
  const w = still(), i = at(20, 20), a = { circle: [20, 20, 0.5] }, before = w.mat[i];
  const A = add(w, { edits: [{ area: a, material: "sand" }] });
  add(w, { edits: [{ area: a, material: "stone" }] });
  WF.eraseSkein(w, A.id);
  assert.strictEqual(w.materials[w.mat[i]].name, "stone", "a later whim's stone stays");
  const w2 = still(), A2 = add(w2, { edits: [{ area: a, material: "sand" }] });
  WF.eraseSkein(w2, A2.id);
  assert.strictEqual(w2.mat[i], before);
});

test("tool uses: three on one tile, undo the latest, then erase the tool; also across save/load and rewind", () => {
  const check = (w, power, i) => {
    near1(w.height[i], 16, "three uses of +2");
    assert.strictEqual(WF.lastUse(w).use.id, power.uses[2].id);
    WF.undoUse(w, WF.lastUse(w).use.id);
    near1(w.height[i], 14, "after undoing the latest");
    WF.eraseSkein(w, w.skeins.find((s) => (s.powers || []).some((p) => p.id === power.id)).id);
    near1(w.height[i], 10, "after erasing the tool");
  };
  const w = still(), i = at(40, 20);
  w.height[i] = 10;
  const p = tool(w, { name: "Raise", brush: { circle: 1 }, edits: [{ raise: 2 }] });
  for (let k = 0; k < 3; k++) assert.ok(WF.usePower(w, p.id, { x: 40, y: 20 }).ok);
  const saved = WF.save(w), snap = WF.snapshot(w);
  check(w, p, i);
  const loaded = WF.load(saved);
  check(loaded, loaded.skeins.at(-1).powers[0], i);
  WF.restore(w, snap);
  check(w, w.skeins.at(-1).powers[0], i);
});

test("a tool's edits and threads act where it's used; areas the model gives them are ignored with a note", () => {
  const w = still();
  const { clean, problems } = WF.checkPlan(w, { powers: [
    { name: "Hill", icon: "⛰️", brush: { circle: 3 }, edits: [{ area: { circle: [5, 5, 2] }, raise: 4 }] },
    { name: "Pen", brush: { stroke: 2 }, edits: [{ lower: 1 }] },
    { name: "Flag", icon: "🇺🇸", brush: 2, threads: [{ name: "wet", when: [], do: [{ add_water: 1 }] }] },
  ] }, null);
  assert.deepStrictEqual(clean.powers.map((p) => p.name), ["Hill", "Pen", "Flag"]);
  assert.strictEqual(clean.powers[0].icon, "⛰️");
  assert.deepStrictEqual(clean.powers[1].brush, { stroke: 2 }, "a drag tool keeps its stroke width");
  assert.strictEqual(clean.powers[2].icon, "", "flags fall back to initials");
  assert.ok(!("area" in clean.powers[0].edits[0]));
  assert.ok(problems.some((m) => /area was ignored/.test(m)));
  assert.deepStrictEqual(WF.checkPlan(w, clean, null).clean.powers, clean.powers, "a clean plan with tools checks again unchanged");
});

test("nothing happens until a tool is used; each use acts where it was used", () => {
  const w = still(), p = tool(w, { name: "Rain", brush: { circle: 2 }, threads: [{ name: "rain", when: [{ within: 10 }], do: [{ add_water: 0.5 }] }] });
  run(w, 3);
  let total = 0; for (let i = 0; i < WF.N; i++) total += w.water[i];
  assert.ok(total < 1e-6, "water before any use: " + total);
  WF.usePower(w, p.id, { x: 30, y: 20 });
  run(w, 1);
  assert.ok(w.water[at(30, 20)] > 0.1, "rain at the use");
  assert.strictEqual(w.water[at(70, 50)], 0, "nothing elsewhere");
});

test("lifecycle: pending before after, acting, expired after within; switched off keeps counting time", () => {
  const w = still(), p = tool(w, { name: "Later", brush: 2, threads: [{ name: "late", when: [{ after: 10 }, { within: 20 }], do: [{ add_water: 0.1 }] }] });
  const u = WF.usePower(w, p.id, { x: 30, y: 30 }).use;
  run(w, 2);
  assert.strictEqual(WF.useStates(w).get(u.id).state, "pending");
  assert.match(WF.useStates(w).get(u.id).text, /starts in \d+ s/);
  run(w, 10);
  assert.strictEqual(WF.useStates(w).get(u.id).state, "acting");
  const s = w.skeins.at(-1);
  WF.setSkeinOn(w, s.id, false); run(w, 10); WF.setSkeinOn(w, s.id, true); run(w, 0.1);
  assert.strictEqual(WF.useStates(w).get(u.id).state, "expired", "its 20 s ran out while switched off");
});

test("a held height limit wakes again when something raises the ground", () => {
  const w = still(), i = at(60, 30);
  for (const k of WF.areaShape({ circle: [60, 30, 1] }).cells) w.height[k] = 10;
  const p = tool(w, { name: "Sink", brush: 1, threads: [{ name: "sink", when: [{ height: [">", 6] }], do: [{ lower: 1 }] }] });
  const u = WF.usePower(w, p.id, { x: 60, y: 30 }).use;
  run(w, 6);
  near1(w.height[i], 6, "settled at 6");
  assert.strictEqual(WF.useStates(w).get(u.id).state, "holding");
  assert.match(WF.useStates(w).get(u.id).text, /holding at 6 m/);
  add(w, { edits: [{ area: { circle: [60, 30, 0.5] }, raise: 3 }] });
  run(w, 0.2);
  assert.strictEqual(WF.useStates(w).get(u.id).state, "acting");
});

test("a use that never matches says what it's waiting for; rain-only uses wait for rain", () => {
  const w = still();
  const p = tool(w, { name: "Freeze", brush: 2, threads: [{ name: "freeze", when: [{ water: [">", 0.1] }], do: [{ set_material: "stone" }] }] });
  const q = tool(w, { name: "Storm", brush: 2, threads: [{ name: "storm", when: [{ raining: true }], do: [{ add_water: 0.1 }] }] });
  const a = WF.usePower(w, p.id, { x: 20, y: 30 }).use, b = WF.usePower(w, q.id, { x: 60, y: 30 }).use;
  run(w, 3);
  assert.strictEqual(WF.useStates(w).get(a.id).state, "idle");
  assert.match(WF.useStates(w).get(a.id).text, /only acts where water is over 0.1 m deep/);
  assert.strictEqual(WF.useStates(w).get(b.id).text, "waiting for rain");
});

test("fire from a tool burns out everywhere it spread, not only inside the click", () => {
  const w = still();
  const s = add(w, { materials: [{ name: "fire", color: "#ff5522" }], powers: [{ name: "Fire", brush: 2, edits: [{ material: "fire" }], threads: [
    { name: "spread", when: [{ material: ["fire"] }, { within: 6 }], do: [{ spread: "fire", chance: 0.9 }] },
    { name: "burn out", when: [{ material: ["fire"] }, { after: 8 }], do: [{ set_material: "sand" }] }] }] });
  const p = s.powers[0];
  assert.ok(p, "the tool was accepted");
  WF.usePower(w, p.id, { x: 48, y: 32 });
  run(w, 6);
  const fire = w.materials.findIndex((m) => m.name === "fire");
  const foot = new Set(WF.areaShape({ circle: [48, 32, 2] }).cells);
  let outside = 0; for (let i = 0; i < WF.N; i++) if (w.mat[i] === fire && !foot.has(i)) outside++;
  assert.ok(outside > 5, "fire spread beyond the click: " + outside);
  run(w, 4);
  let left = 0; for (let i = 0; i < WF.N; i++) if (w.mat[i] === fire) left++;
  assert.strictEqual(left, 0, "fire tiles left after the burn-out");
});

test("a tool acting in 24 places refuses a 25th use, with a message", () => {
  const w = still(), p = tool(w, { name: "Spring", brush: 1, threads: [{ name: "spring", when: [], do: [{ add_water: 0.01 }] }] });
  for (let k = 0; k < WF.LIVE_USES; k++) assert.ok(WF.usePower(w, p.id, { x: 2 + k * 3, y: 10 }).ok);
  const r = WF.usePower(w, p.id, { x: 5, y: 40 });
  assert.ok(!r.ok);
  assert.match(r.message, /acting in 24 places/);
});

test("a switched-off tool can't be used; saves for the model carry no change records", () => {
  const w = still(), p = tool(w, { name: "Raise", brush: 1, edits: [{ raise: 1 }] });
  WF.usePower(w, p.id, { x: 10, y: 10 });
  const forModel = WF.saveForModel(w);
  const s = forModel.skeins.at(-1);
  assert.ok(!("rec" in s) && !("rec" in s.powers[0]) && !("rec" in s.powers[0].uses[0]));
  WF.setSkeinOn(w, w.skeins.at(-1).id, false);
  assert.match(WF.usePower(w, p.id, { x: 10, y: 10 }).message, /switched off/);
});

test("a drag tool acts along the drag, thinned to 40 points, and undo takes it back", () => {
  const w = still(), p = tool(w, { name: "Dig", brush: { stroke: 2 }, edits: [{ lower: 2 }] });
  const before = w.height.slice();
  const path = Array.from({ length: 120 }, (_, k) => [10 + k * 0.5, 20]);
  const r = WF.usePower(w, p.id, { path });
  assert.ok(r.ok);
  assert.strictEqual(r.use.path.length, 40);
  assert.deepStrictEqual(r.use.path[0], [10, 20]); assert.deepStrictEqual(r.use.path.at(-1), [70, 20]);
  assert.ok(w.height[at(40, 20)] < before[at(40, 20)] - 1.5, "dug along the middle of the drag");
  near1(w.height[at(40, 30)], before[at(40, 30)], "untouched away from the drag");
  WF.undoUse(w, r.use.id);
  near1(w.height[at(40, 20)], before[at(40, 20)], "undo");
});

test("a replacement takes an old tool's place in the palette; the old one's uses keep acting; erasing it brings the old back", () => {
  const w = still();
  const old = tool(w, { name: "Rain", brush: 2, threads: [{ name: "rain", when: [], do: [{ add_water: 0.1 }] }] });
  const u = WF.usePower(w, old.id, { x: 30, y: 30 }).use;
  const { clean, problems } = WF.checkPlan(w, { powers: [{ name: "Heavy rain", replaces: "rain", brush: 3, threads: [{ name: "rain", when: [], do: [{ add_water: 0.3 }] }] }] }, null);
  assert.strictEqual(clean.powers[0].replaces, old.id, "found by name: " + problems.join("; "));
  const s = WF.acceptPlan(w, clean, {});
  assert.strictEqual(old.retired, "replaced");
  assert.match(WF.usePower(w, old.id, { x: 50, y: 30 }).message, /isn't in the palette/);
  run(w, 1);
  assert.strictEqual(WF.useStates(w).get(u.id).state, "acting", "the old tool's earlier use keeps raining");
  WF.eraseSkein(w, s.id);
  assert.ok(!old.retired, "erasing the replacement puts the old tool back");
  assert.match(WF.checkPlan(w, { powers: [{ name: "X", replaces: "9.9", brush: 2, edits: [{ raise: 1 }] }] }, null).problems.join(), /no tool "9.9"/);
});

test("removing a tool from the palette keeps what it made; putting it back works", () => {
  const w = still(), p = tool(w, { name: "Raise", brush: 1, edits: [{ raise: 2 }] }), i = at(12, 12);
  const before = w.height[i];
  WF.usePower(w, p.id, { x: 12, y: 12 });
  WF.setPowerRemoved(w, p.id, true);
  near1(w.height[i], before + 2, "the hill stays");
  assert.ok(!WF.usePower(w, p.id, { x: 20, y: 20 }).ok);
  WF.setPowerRemoved(w, p.id, false);
  assert.ok(WF.usePower(w, p.id, { x: 20, y: 20 }).ok);
});

test("explainPlan describes a tool by how it's used and what each use does", () => {
  const w = still();
  const lines = WF.explainPlan(WF.checkPlan(w, { powers: [{ name: "Sink", icon: "🕳️", brush: 4,
    threads: [{ name: "sink until wet", when: [{ water: ["<", 0.2] }, { height: [">", 1] }], do: [{ lower: 0.25 }] }] }] }, null).clean, w);
  assert.match(lines[0], /^Tool 🕳️ “Sink” \(click the map to use it; radius 4 to start\)/);
  assert.match(lines[0], /where you clicked, where water is under 0.2 m deep, where the ground is above 1 m: lowers the ground 0.25 m a second/i);
  assert.match(lines[0], /Stops on each tile once water there is 0\.2 m deep \(and never below 1 m\)/);
});

console.log(passed + " passed");
