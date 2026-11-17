// Cut the raw recording into the demo: model-working stretches are sped up so each lasts about 8 seconds.
//
//   node tools/edit-demo.js        reads demo/out/raw.webm and marks.json, writes demo/out/glomus-demo.mp4
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "demo", "out");
// The recorder drops frames while the page is busy, so its timeline runs shorter than the wall clock;
// scale the marks to the video's real length.
const rawMarks = JSON.parse(fs.readFileSync(path.join(OUT, "marks.json"), "utf8"));
const duration = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0",
  path.join(OUT, "raw.webm")]).toString().trim());
const scale = duration / rawMarks.find((m) => m.name === "end").t;
const marks = rawMarks.map((m) => ({ ...m, t: m.t * scale }));
const end = duration;

const segments = [];
let t = 0;
for (let k = 0; k < marks.length; k++) {
  if (marks[k].name !== "work-start") continue;
  const a = marks[k].t, b = marks.find((m, j) => j > k && m.name === "work-end").t;
  if (a > t) segments.push({ from: t, to: a, speed: 1 });
  segments.push({ from: a, to: b, speed: Math.max(2, (b - a) / 8) });
  t = b;
}
segments.push({ from: t, to: end, speed: 1 });

const parts = segments.map((s, k) =>
  `[0:v]trim=start=${s.from.toFixed(2)}:end=${s.to.toFixed(2)},setpts=(PTS-STARTPTS)/${s.speed.toFixed(3)},fps=30[v${k}]`);
const filter = parts.join(";") + ";" + segments.map((_, k) => `[v${k}]`).join("") + `concat=n=${segments.length}:v=1:a=0[out]`;
const mp4 = path.join(OUT, "glomus-demo.mp4");
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", path.join(OUT, "raw.webm"), "-filter_complex", filter, "-map", "[out]",
  "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart", mp4], { stdio: "inherit" });
for (const s of segments) console.log(`${s.from.toFixed(1)}-${s.to.toFixed(1)}s at ${s.speed.toFixed(1)}×`);
const length = segments.reduce((sum, s) => sum + (s.to - s.from) / s.speed, 0);
console.log(`Saved ${path.relative(ROOT, mp4)} (${length.toFixed(0)} s)`);
