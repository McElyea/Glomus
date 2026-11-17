// Run the eval cases through the real shaper and the local model, headless.
//
//   node tools/eval.js                      every case once
//   node tools/eval.js --only floodgate,island --repeat 3
//
// Each case starts from the same seeded world. If the shaper commits, the plan is applied to one copy and the
// world is simulated for after_seconds next to an untouched copy; the checks compare the two. Results, plans
// and full transcripts go to workspace/evals/run-<time>.json, ready for a reviewer (or Claude) to judge
// whether each result actually matches its whim.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as WF from "../game/world.js";
import * as Model from "../server/model.js";
import { shapeWhim, localModel } from "../server/shaper.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = (name) => { const k = args.indexOf(name); return k >= 0 ? args[k + 1] : null; };
const suite = JSON.parse(fs.readFileSync(path.join(ROOT, "evals", "cases.json"), "utf8"));
const only = opt("--only") ? new Set(opt("--only").split(",")) : null;
const repeat = Math.max(1, Number(opt("--repeat")) || 1);
const config = Model.loadConfig(ROOT);

const st = await Model.status(config);
if (!st.ready) { console.error("Model not ready: " + st.reason); process.exit(2); }

const base = WF.save(WF.makeWorld(suite.seed));
const water = (w, cells) => { let s = 0; for (const i of cells) s += w.water[i]; return s; };
const height = (w, cells) => { let s = 0; for (const i of cells) s += w.height[i]; return cells.length ? s / cells.length : 0; };
const wetTiles = (w) => { let n = 0; for (let i = 0; i < WF.N; i++) if (w.water[i] > WF.WET) n++; return n; };

function judge(check, ctx) {
  const { result, without, withPlan, fires, ticks, plan, newMaterials } = ctx;
  const cells = check.area ? WF.areaShape(check.area).cells : null;
  switch (check.type) {
    case "committed": return [result.committed, result.committed ? "committed" : "no commit" + (result.error ? ": " + result.error : "")];
    case "not_committed": return [!result.committed, result.committed ? "committed a plan" : "answered without a plan"];
    case "says": { const ok = new RegExp(check.pattern, "i").test(result.say || ""); return [ok, `said: ${(result.say || "").slice(0, 80)}`]; }
    case "more_water": case "less_water": {
      if (!plan) return [false, "no plan"];
      const d = water(withPlan, cells) - water(without, cells), ok = check.type === "more_water" ? d >= check.min : -d >= check.min;
      return [ok, `water ${d >= 0 ? "+" : ""}${d.toFixed(1)} m³`];
    }
    case "higher": case "lower": {
      if (!plan) return [false, "no plan"];
      const d = height(withPlan, cells) - height(without, cells), ok = check.type === "higher" ? d >= check.min : -d >= check.min;
      return [ok, `ground ${d >= 0 ? "+" : ""}${d.toFixed(2)} m`];
    }
    case "more_wet_tiles": { if (!plan) return [false, "no plan"]; const d = wetTiles(withPlan) - wetTiles(without); return [d >= check.min, `wet tiles ${d >= 0 ? "+" : ""}${d}`]; }
    case "thread_acts": { const any = fires.some((f) => f.ticks > 0); return [any, any ? "a thread acted" : "no thread ever acted"]; }
    case "intermittent": {
      const best = fires.map((f) => f.ticks / ticks).find((r) => r > 0.1 && r < 0.9);
      return [best !== undefined, "active " + fires.map((f) => Math.round((100 * f.ticks) / ticks) + "%").join("/")];
    }
    case "new_material_grows": {
      let n = 0; for (let i = 0; i < WF.N; i++) if (newMaterials.has(withPlan.mat[i])) n++;
      return [n >= check.min, `${n} tiles of new materials`];
    }
    case "no_switch_off": return [!plan || !plan.switch_off.length, plan && plan.switch_off.length ? `switched off ${plan.switch_off.join(", ")}` : "left other skeins alone"];
    case "uses_condition": {
      const has = (c) => check.condition in c || (c.not && has(c.not));
      const used = !!plan && plan.threads.some((t) => t.when.some(has));
      return [used, used ? `uses ${check.condition}` : `no ${check.condition}`];
    }
    case "keeps": {
      const k = withPlan.materials.findIndex((m) => m.name === check.material);
      let a = 0, b = 0; for (let i = 0; i < WF.N; i++) { if (without.mat[i] === k) a++; if (withPlan.mat[i] === k) b++; }
      return [b >= a * check.fraction, `${check.material} ${a} → ${b} tiles`];
    }
    case "uses": {
      const used = !!plan && plan.threads.some((t) => t.do.some((a) => check.action in a));
      return [used, used ? `uses ${check.action}` : `no ${check.action}`];
    }
    default: return [false, "unknown check " + check.type];
  }
}

const runs = [];
for (const c of suite.cases) {
  if (only && !only.has(c.id)) continue;
  for (let k = 0; k < repeat; k++) {
    process.stdout.write(`${c.id}${repeat > 1 ? " #" + (k + 1) : ""} … `);
    const result = await shapeWhim({ world: WF.load(base), spot: c.spot, whim: c.whim, model: localModel(config) });
    const without = WF.load(base), withPlan = WF.load(base);
    const knownMaterials = withPlan.materials.length;
    let plan = null, skein = null;
    if (result.committed) {
      const checked = WF.checkPlan(withPlan, result.plan, c.spot);
      plan = checked.clean; skein = WF.acceptPlan(withPlan, plan, { whim: c.whim, spot: c.spot });
    }
    const ticks = (suite.after_seconds || 30) * WF.TPS;
    const fires = plan ? plan.threads.map(() => ({ ticks: 0 })) : [];
    for (let t = 0; t < ticks; t++) {
      WF.step(without); WF.step(withPlan);
      if (skein) WF.threadActivity(withPlan, skein).forEach((f, j) => { if (f > 0) fires[j].ticks++; });
    }
    const newMaterials = new Set(withPlan.materials.map((_, j) => j).filter((j) => j >= knownMaterials));
    const checks = c.checks.map((check) => { const [ok, note] = judge(check, { result, without, withPlan, fires, ticks, plan, newMaterials }); return { type: check.type, ok, note }; });
    const passed = checks.every((x) => x.ok);
    console.log(`${passed ? "PASS" : "FAIL"}  ${result.seconds.toFixed(0)}s, ${result.toolCalls} tool calls  ` + checks.map((x) => `${x.ok ? "✓" : "✗"} ${x.type} (${x.note})`).join("  "));
    runs.push({ id: c.id, whim: c.whim, spot: c.spot, passed, checks, committed: result.committed, say: result.say, plan: result.plan,
      error: result.error, seconds: result.seconds, toolCalls: result.toolCalls, events: result.events, messages: result.messages });
  }
}

const n = runs.length, pass = runs.filter((r) => r.passed).length;
const checksAll = runs.flatMap((r) => r.checks), checksOk = checksAll.filter((x) => x.ok).length;
const avg = (f) => (runs.reduce((s, r) => s + f(r), 0) / Math.max(1, n));
const summary = { model: config.alias, seed: suite.seed, runs: n, passed: pass, checks: `${checksOk}/${checksAll.length}`,
  avgSeconds: +avg((r) => r.seconds).toFixed(1), avgToolCalls: +avg((r) => r.toolCalls).toFixed(1) };
console.log(`\n${pass}/${n} cases passed, ${checksOk}/${checksAll.length} checks, ${summary.avgSeconds}s and ${summary.avgToolCalls} tool calls per whim on average.`);
const dir = path.join(ROOT, "workspace", "evals");
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, "run-" + new Date().toISOString().replace(/[:.]/g, "-") + ".json");
fs.writeFileSync(file, JSON.stringify({ summary, runs }, null, 1));
console.log("Saved " + path.relative(ROOT, file));
