// The shaper: a Pi agent that turns a player's whim into a skein, working on a copy of the world.
// It can look closely, read other skeins, preview a plan by simulating it, and finally commit it.
// The model only proposes; the game validates every plan (checkPlan) before anything runs.
import { Agent } from "@mariozechner/pi-agent-core";
import { Type } from "typebox";
import * as WF from "../game/world.js";

export const MAX_TOOL_CALLS = 8;
export const PREVIEW_SECONDS = 20;
const TIME_LIMIT_MS = 240_000;

export const LANGUAGE = `You shape Glomus, a living landscape seen from above. The player points at a spot and tells you a
whim; you make it real by committing a plan. You work with tools on a copy of the world:

  look(area)           heights, water and ground in an area; small areas include a tile-by-tile height grid
  read_skein(id)       the full plan of an existing skein
  try_plan(plan)       check a plan and simulate it for ${PREVIEW_SECONDS} seconds on a copy; reports what changed
  commit(plan)         apply the plan to the real world. This ends your turn.

Work like this: look where you need detail, try_plan, fix what the preview shows is wrong, then commit.
You have at most ${MAX_TOOL_CALLS} tool calls, so don't over-explore. Always finish with commit, unless the player
only asked a question; then just answer in one or two sentences.

A PLAN is a JSON object:
{"name": "short title", "say": "one or two sentences to the player about what you made",
 "materials": [...], "edits": [...], "threads": [...], "switch_off": [skein ids]}
Leave out any list you don't need.

AREA, where something happens:
  "spot"                                the player's selected spot ("here")
  "everywhere"                          the whole map
  {"circle": [x, y, radius]}
  {"rect": [x, y, width, height]}
  {"path": [[x, y], [x, y], ...], "width": 2}   follows its points in order: streams, channels, walls, roads
x runs 0-95 from west to east; y runs 0-63 from north to south.

EDITS happen once, at commit. Each edit is {"area": AREA, ...} with one or more of:
  "lower": metres      dig (a channel 1.5-3 m deep carries a stream)
  "raise": metres      build up (hills, walls, dams, islands)
  "level": metres      flatten to this height
  "material": "name"   paint the ground
  "water": metres      pour water in

THREADS keep running, every moment, on every tile of their area, until switched off:
  {"name": "...", "area": AREA, "when": [CONDITIONS], "do": [ACTIONS]}
A tile acts only when all its conditions hold; an empty "when" always holds.
CONDITIONS:
  {"material": ["stone", "sand"]}            the tile is one of these
  {"water": [">", 0.2]}  {"height": ["<", 6]}   compare with > < >= <=
  {"near": "water", "count": [">=", 2]}       how many of the 8 neighbours are wet (or are a given material)
  {"chance": 0.1}                             chance per second; it thins out every action, including per-second
                                              amounts, so use it for growth and painting, not for water
  {"cycle": 30, "from": 0, "to": 10}          true from second 0 to 10 of every 30-second cycle: timers, gates, pulses
  {"raining": true}
  {"within": 60}                              only during the first 60 seconds after you commit: "for a minute"
  {"after": 120}                              only from 120 seconds after you commit: "after a while"
  {"not": CONDITION}
The world has no days; if the player names a long time, pick a span in seconds that suits the game (a few
minutes at most) and tell them what you chose.
ACTIONS, amounts are per second on EACH tile where the thread acts (so a big area multiplies them; the
built-in spring adds 2 per second on about 9 tiles):
  {"add_water": 1}   {"drain_water": 1}   {"raise": 0.2}   {"lower": 0.2}
  {"push_water": "east", "amount": 2}         move water to the neighbour north/south/east/west/downhill/uphill: pumps, currents
  {"set_material": "name"}
  {"spread": "name", "chance": 0.2, "onto": ["soil"]}   paint a random neighbour: growth, creep, infection

MATERIALS: soil, sand, stone, meadow and snow are built in; water is not a material. Invent new ones like
{"name": "glowmoss", "color": "#7fffb0", "erodes": 0.2}; erodes (0-1) is how fast running water wears it
away. Listing an existing material again changes its color or erodes.
SWITCH_OFF lists skein ids to turn off, for when the player wants something stopped.

How the world works: water flows downhill, pools in low ground and leaves over the south edge. Fast water
erodes soft ground and drops silt where it slows. It rains now and then. Nature (skein 1) is itself
written as threads, so you can switch it off or work alongside it.

Guidance:
- Do what the player asked, faithfully, and make it visible and alive. A whim doesn't need to be useful.
- Water only runs downhill by itself. To bring water somewhere, dig a channel that slopes down from the water
  to the target, or pump it with push_water. A stream, fountain or waterfall needs a source: unless its
  channel starts in existing water, add a thread at its start that adds water.
- Shapes are edits; behaviour is threads. Keep amounts modest: a source of 1-3 per second on a few tiles
  (a circle of radius 1-2) makes a stream.
- Trust the preview: if it says your water went nowhere or a thread never acted, fix the plan before committing.
- Leave other skeins alone: only use switch_off when the player asks for something to stop.
- Keep the world's variety: an edit that paints the whole map replaces every meadow, stone and sand tile.
  Prefer threads that act on the ground that is already there.
- In "say", describe only what your plan actually does. Never promise something the plan doesn't contain
  (an ending, regrowth, a later event); if the language can't do part of the whim, say so plainly.`;

const AreaParam = Type.Any({ description: 'An AREA: "spot", "everywhere", {"circle":[x,y,r]}, {"rect":[x,y,w,h]} or {"path":[[x,y],...],"width":2}' });
const PlanParam = Type.Object({
  name: Type.Optional(Type.String()),
  say: Type.Optional(Type.String()),
  materials: Type.Optional(Type.Array(Type.Any())),
  edits: Type.Optional(Type.Array(Type.Any())),
  threads: Type.Optional(Type.Array(Type.Any())),
  switch_off: Type.Optional(Type.Array(Type.Any())),
});

export function localModel(config) {
  return {
    id: config.alias, name: config.alias, api: "openai-completions", provider: "local",
    baseUrl: config.baseUrl, reasoning: false, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: config.contextWindow || 32768, maxTokens: config.maxTokens || 3000,
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: false, supportsStore: false,
      supportsStrictMode: false, maxTokensField: "max_tokens" },
  };
}

const text = (t, details = {}) => ({ content: [{ type: "text", text: t }], details });
const fmt = (v, d = 1) => (Math.round(v * 10 ** d) / 10 ** d).toString();

/** Parse an area exactly as plans do (via checkPlan), so look() accepts the same forms. */
function cellsOf(world, area, spot) {
  const { clean, problems } = WF.checkPlan(world, { edits: [{ area, water: 0.0001 }] }, spot);
  if (!clean || !clean.edits.length) throw new Error("Couldn't read that area: " + problems.join("; "));
  return { area: clean.edits[0].area, cells: WF.areaShape(clean.edits[0].area).cells };
}

/** Area statistics, plus a tile grid for small areas so the model can plan paths. */
export function lookAt(world, area, spot) {
  const { area: a, cells } = cellsOf(world, area, spot);
  if (!cells.length) throw new Error("That area has no tiles on the map.");
  let hmin = 99, hmax = 0, hsum = 0, wsum = 0, wet = 0, xs = [], ys = [];
  const counts = new Map();
  for (const i of cells) {
    const x = i % WF.W, y = Math.floor(i / WF.W);
    xs.push(x); ys.push(y);
    hmin = Math.min(hmin, world.height[i]); hmax = Math.max(hmax, world.height[i]); hsum += world.height[i];
    wsum += world.water[i]; if (world.water[i] > WF.WET) wet++;
    const m = world.materials[world.mat[i]].name; counts.set(m, (counts.get(m) || 0) + 1);
  }
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const lines = [
    `${WF.describeArea(a)}: ${cells.length} tiles spanning x ${x0}-${x1}, y ${y0}-${y1}.`,
    `Ground height ${fmt(hmin)}-${fmt(hmax)} m, average ${fmt(hsum / cells.length)}. Water ${fmt(wsum)} m³ in total, ${wet} wet tiles.`,
    "Ground: " + [...counts].sort((p, q) => q[1] - p[1]).map(([n, c]) => `${n} ${c}`).join(", ") + ".",
  ];
  if (x1 - x0 < 24 && y1 - y0 < 24) {
    lines.push("Height grid in whole metres (~ marks water deeper than 0.05 m):");
    lines.push("      " + Array.from({ length: x1 - x0 + 1 }, (_, k) => String(x0 + k).padStart(4)).join(""));
    for (let y = y0; y <= y1; y++) {
      let row = `y ${String(y).padStart(2)} `;
      for (let x = x0; x <= x1; x++) {
        const i = y * WF.W + x;
        row += (String(Math.round(world.height[i])) + (world.water[i] > WF.WET ? "~" : "")).padStart(4);
      }
      lines.push(row);
    }
  } else {
    lines.push("(Look at a smaller area, under 24 tiles across, for a tile-by-tile grid.)");
  }
  return lines.join("\n");
}

function planAreas(clean) {
  return clean.edits.map((e) => e.area).concat(clean.threads.map((t) => t.area));
}

/** Simulate the plan on a copy and compare with the same copy left alone. */
export function preview(world, clean, spot, seconds = PREVIEW_SECONDS) {
  const without = WF.load(WF.save(world)), withPlan = WF.load(WF.save(world));
  const baseCounts = new Map(withPlan.materials.map((m, k) => [k, 0]));
  for (let i = 0; i < WF.N; i++) baseCounts.set(withPlan.mat[i], (baseCounts.get(withPlan.mat[i]) || 0) + 1);
  const skein = WF.acceptPlan(withPlan, clean, { spot });
  const fires = clean.threads.map(() => ({ total: 0, ticks: 0 }));
  for (let t = 0; t < seconds * WF.TPS; t++) {
    WF.step(without); WF.step(withPlan);
    if (skein) WF.threadActivity(withPlan, skein).forEach((f, k) => { fires[k].total += f; if (f > 0) fires[k].ticks++; });
  }
  const cells = new Set();
  for (const a of planAreas(clean)) for (const i of WF.areaShape(a).cells) cells.add(i);
  const stat = (w) => {
    let water = 0, wet = 0, h = 0;
    for (const i of cells) { water += w.water[i]; if (w.water[i] > WF.WET) wet++; h += w.height[i]; }
    let mapWet = 0; const counts = new Map();
    for (let i = 0; i < WF.N; i++) { if (w.water[i] > WF.WET) mapWet++; counts.set(w.mat[i], (counts.get(w.mat[i]) || 0) + 1); }
    return { water, wet, h: cells.size ? h / cells.size : 0, mapWet, counts };
  };
  const a = stat(without), b = stat(withPlan);
  const lines = [`Simulated ${seconds} s with the plan, compared with the same ${seconds} s without it.`];
  if (cells.size) {
    lines.push(`In the plan's areas (${cells.size} tiles): water ${fmt(a.water)} → ${fmt(b.water)} m³, wet tiles ${a.wet} → ${b.wet}, average ground ${fmt(a.h)} → ${fmt(b.h)} m.`);
  }
  lines.push(`Whole map: wet tiles ${a.mapWet} → ${b.mapWet}.`);
  const changes = [];
  withPlan.materials.forEach((m, k) => {
    const before = a.counts.get(k) || 0, after = b.counts.get(k) || 0;
    if (Math.abs(after - before) >= 3) changes.push(`${m.name} ${before} → ${after} tiles`);
  });
  if (changes.length) lines.push("Ground: " + changes.join(", ") + ".");
  clean.threads.forEach((t, k) => {
    const f = fires[k], ticks = seconds * WF.TPS;
    lines.push(f.ticks === 0
      ? `Thread "${t.name}" never acted: its conditions never held on any tile.`
      : `Thread "${t.name}": its conditions held on ${fmt(f.total / Math.max(1, f.ticks), 0)} tiles at a time, during ${Math.round((100 * f.ticks) / ticks)}% of the time (actions with their own chance change fewer tiles than that).`);
  });
  const timed = (c) => "within" in c || "after" in c || (c.not && timed(c.not));
  if (clean.threads.length && !clean.threads.some((t) => t.when.some(timed))) {
    lines.push("None of these threads ever stops on its own: they run until the player switches them off. If the whim has an end, add a within condition.");
  }
  for (const id of clean.switch_off) {
    const s = world.skeins.find((k) => k.id === id);
    lines.push(`This plan switches off skein ${id} (${s ? s.name : "?"}). Only do that if the player asked for it to stop.`);
  }
  return { text: lines.join("\n"), stats: { area: { tiles: cells.size, waterWithout: a.water, waterWith: b.water }, mapWet: [a.mapWet, b.mapWet], fires } };
}

function checked(world, plan, spot) {
  const result = WF.checkPlan(world, plan, spot);
  const head = result.problems.length ? "Problems:\n- " + result.problems.join("\n- ") : "The plan checks out.";
  return { ...result, head };
}

/**
 * Run the shaper on a whim. world is a world object (a private copy is used), spot may be null.
 * onEvent receives {kind, ...} progress events. Returns {committed, plan, say, events, messages, seconds, toolCalls}.
 */
export async function shapeWhim({ world, spot, whim, model, onEvent = () => {}, signal }) {
  const copy = WF.load(WF.save(world));
  const events = [];
  const emit = (e) => { const ev = { at: Date.now(), ...e }; events.push(ev); onEvent(ev); };
  let committed = null, toolCalls = 0, confirmedOff = "", lastTried = null, lastCall = "", repeats = 0;
  const started = Date.now();

  const tools = [
    {
      name: "look", label: "Look", description: "Heights, water and ground in an area. Areas under 24 tiles across include a tile-by-tile height grid.",
      parameters: Type.Object({ area: AreaParam }),
      execute: async (_id, p) => text(lookAt(copy, p.area, spot)),
    },
    {
      name: "read_skein", label: "Read skein", description: "The full plan (materials, edits, threads) of an existing skein, by id.",
      parameters: Type.Object({ id: Type.Number() }),
      execute: async (_id, p) => {
        const s = copy.skeins.find((k) => k.id === Math.round(p.id));
        if (!s) throw new Error(`No skein ${p.id}. Skeins: ${copy.skeins.map((k) => k.id).join(", ")}.`);
        return text(JSON.stringify({ id: s.id, name: s.name, on: s.on, materials: s.materials, edits: s.edits, threads: s.threads }));
      },
    },
    {
      name: "try_plan", label: "Try plan", description: `Check a plan and simulate it for ${PREVIEW_SECONDS} seconds on a copy of the world. Nothing real changes.`,
      parameters: Type.Object({ plan: PlanParam }),
      execute: async (_id, p) => {
        const c = checked(copy, p.plan, spot);
        if (!c.usable) throw new Error(c.head + "\nNothing in the plan could be used.");
        lastTried = { name: c.clean.name, say: c.clean.say };
        const pv = preview(copy, c.clean, spot);
        emit({ kind: "tried", name: c.clean.name, summary: pv.text.split("\n").slice(1, 3).join(" "), problems: c.problems.length });
        return text(c.head + "\n" + pv.text, { problems: c.problems, stats: pv.stats });
      },
    },
    {
      name: "commit", label: "Commit", description: "Apply the plan to the real world. This ends your turn.",
      parameters: Type.Object({ plan: PlanParam }),
      execute: async (_id, p) => {
        // Models sometimes drop name/say between preview and commit; carry them over from the last preview.
        const plan = { ...p.plan };
        if (lastTried && !plan.say) plan.say = lastTried.say;
        if (lastTried && !plan.name) plan.name = lastTried.name;
        const c = checked(copy, plan, spot);
        if (!c.usable) throw new Error(c.head + "\nNothing in the plan could be used, so nothing was committed.");
        if (!c.clean.say) throw new Error('Nothing was committed: add "say", one or two sentences telling the player what the plan does.');
        const offKey = c.clean.switch_off.slice().sort().join(",");
        if (offKey && offKey !== confirmedOff) {
          confirmedOff = offKey;
          const names = c.clean.switch_off.map((id) => `${id} (${(copy.skeins.find((k) => k.id === id) || {}).name || "?"})`).join(", ");
          throw new Error(`Nothing was committed yet: this plan switches off skein ${names}. Did the player ask for that to stop? If so, commit the same plan again. If not, remove switch_off and commit.`);
        }
        committed = { clean: c.clean, problems: c.problems };
        emit({ kind: "committed", name: c.clean.name, problems: c.problems.length });
        return { ...text(c.head + "\nCommitted."), terminate: true };
      },
    },
  ];

  const agent = new Agent({
    initialState: { systemPrompt: LANGUAGE, model, tools },
    getApiKey: async () => "local",
    toolExecution: "sequential",
    beforeToolCall: async ({ toolCall }) => {
      toolCalls++;
      // Stop a model that is stuck: the same call three times in a row, or far past the budget.
      const key = toolCall.name + JSON.stringify(toolCall.arguments);
      repeats = key === lastCall ? repeats + 1 : 0;
      lastCall = key;
      if (repeats >= 2 || toolCalls > MAX_TOOL_CALLS + 4) {
        emit({ kind: "error", message: repeats >= 2 ? "The model repeated the same failing call; stopping." : "The model used far more than its tool budget; stopping." });
        setTimeout(() => agent.abort(), 0);
        return { block: true, reason: "Stopped." };
      }
      if (toolCalls > MAX_TOOL_CALLS && toolCall.name !== "commit") {
        return { block: true, reason: `You have used all ${MAX_TOOL_CALLS} tool calls. Commit your best plan now, or stop.` };
      }
      return undefined;
    },
  });
  agent.subscribe((e) => {
    if (e.type === "tool_execution_start") {
      const a = e.args || {};
      const label = e.toolName === "look" ? `looked at ${describeLoose(a.area)}` : e.toolName === "read_skein" ? `read skein ${a.id}`
        : e.toolName === "try_plan" ? `tried "${(a.plan && a.plan.name) || "a plan"}"` : e.toolName === "commit" ? `committing "${(a.plan && a.plan.name) || "the plan"}"` : e.toolName;
      emit({ kind: "tool", tool: e.toolName, label });
    }
    if (e.type === "tool_execution_end" && e.isError) {
      const msg = (e.result && e.result.content && e.result.content[0] && e.result.content[0].text) || "error";
      emit({ kind: "tool_error", tool: e.toolName, message: msg.slice(0, 300) });
    }
    if (e.type === "message_end" && e.message.role === "assistant") {
      const said = (e.message.content || []).filter((c) => c.type === "text").map((c) => c.text).join(" ").trim();
      if (said) emit({ kind: "said", text: said.slice(0, 500) });
    }
  });
  const timer = setTimeout(() => agent.abort(), TIME_LIMIT_MS);
  const onAbort = () => agent.abort();
  if (signal) signal.addEventListener("abort", onAbort);
  emit({ kind: "start", whim });
  try {
    await agent.prompt("World report:\n" + WF.describe(copy, spot) + "\n\nThe player's whim: " + whim);
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
  const lastText = [...agent.state.messages].reverse().find((m) => m.role === "assistant");
  const reply = lastText ? (lastText.content || []).filter((c) => c.type === "text").map((c) => c.text).join(" ").trim() : "";
  const error = agent.state.errorMessage || null;
  if (error) emit({ kind: "error", message: String(error).slice(0, 300) });
  return {
    committed: !!committed, plan: committed ? committed.clean : null, problems: committed ? committed.problems : [],
    say: committed ? committed.clean.say || reply : reply, error, events, messages: agent.state.messages,
    seconds: (Date.now() - started) / 1000, toolCalls,
  };
}

function describeLoose(area) {
  if (area === "spot" || area === "here") return "the spot";
  if (area === "everywhere") return "the whole map";
  try { return WF.describeArea(area); } catch { return "an area"; }
}
