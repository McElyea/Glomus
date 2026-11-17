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
  assert.strictEqual(w.skeins.length, 1);
  assert.strictEqual(w.skeins[0].kind, "nature");
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
  assert.strictEqual(w.skeins.length, 1);
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

console.log(passed + " passed");
