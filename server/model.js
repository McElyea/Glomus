// The local model server: find it, or start llama-server from config/model.json, and say whether it's ready.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export function loadConfig(root) {
  return JSON.parse(fs.readFileSync(path.join(root, "config", "model.json"), "utf8"));
}

const state = { process: null, problem: null, log: null };

async function fetchJson(url, ms = 3000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(ms) });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.json();
}

export async function status(config) {
  const root = config.baseUrl.replace(/\/v1\/?$/, "");
  try {
    const models = await fetchJson(config.baseUrl + "/models");
    if (!(models.data || []).some((m) => m.id === config.alias)) {
      return { ready: false, reason: `The model server on ${root} is running, but not as "${config.alias}".` };
    }
    try {
      const slots = await fetchJson(root + "/slots");
      if (Array.isArray(slots) && slots.some((s) => s.is_processing)) return { ready: false, busy: true, reason: "The local model is busy." };
    } catch { /* Not llama.cpp, or slots disabled: assume free. */ }
    return { ready: true, model: config.alias };
  } catch (error) {
    if (state.process && state.process.exitCode === null) return { ready: false, reason: "The local model is starting up (usually under a minute)." };
    if (state.process) return { ready: false, reason: "The local model server stopped while starting; see " + state.log };
    if (state.problem) return { ready: false, reason: "Couldn't start the local model: " + state.problem };
    return { ready: false, reason: `No local model at ${root}.` };
  }
}

/** Start llama-server unless something already answers at baseUrl. Only a server started here is stopped later. */
export async function ensureStarted(config, workspace) {
  const root = config.baseUrl.replace(/\/v1\/?$/, "");
  try { await fetchJson(root + "/health", 1500); return; } catch { /* Nothing there yet. */ }
  const launch = config.launch;
  if (!launch) { state.problem = "nothing answers at " + root + " and config/model.json has no launch section."; return; }
  for (const p of [launch.executable, launch.model]) if (!fs.existsSync(p)) { state.problem = p + " is missing."; return; }
  const url = new URL(root);
  fs.mkdirSync(workspace, { recursive: true });
  state.log = path.join(workspace, "llama-server.log");
  const out = fs.openSync(state.log, "a");
  state.process = spawn(launch.executable, ["--model", launch.model, "--alias", config.alias, "--host", url.hostname,
    "--port", url.port || "8080", ...(launch.args || [])], { stdio: ["ignore", out, out], windowsHide: true });
  state.process.on("error", (e) => { state.problem = e.message; });
}

export function stop() {
  if (state.process && state.process.exitCode === null) state.process.kill();
}
