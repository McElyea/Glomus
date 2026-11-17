// Turn the timelapse frames into a stop-motion, tilt-shift "miniature" video.
//
//   node tools/edit-timelapse.js [--seconds 60]
//
// Each captured frame becomes one stop-motion frame (held, so motion steps instead of gliding), then: boosted
// colour, a slight fake camera tilt (the top edge pulled in), a band of focus across the middle with
// blur above and below, and a vignette. Reads demo/out/timelapse-frames, writes demo/out/glomus-miniature.mp4.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "demo", "out");
const FRAMES = path.join(OUT, process.argv.includes("--frames") ? process.argv[process.argv.indexOf("--frames") + 1] : "timelapse-frames");
const target = Number(process.argv[process.argv.indexOf("--seconds") + 1]) || 60;
const count = fs.readdirSync(FRAMES).filter((f) => f.endsWith(".png")).length;
const stepRate = Math.min(15, Math.max(8, count / target)); // stop-motion frames per second
const seconds = count / stepRate;

const look = [
  "scale=1920:1280:flags=lanczos",
  "eq=saturation=1.65:contrast=1.15:brightness=0.02:gamma=0.97",
  "split[a][b]", "[b]gblur=sigma=18[bl]",
  // Sharp band of focus a little below centre; blur ramps in above and below it.
  "[a][bl]blend=all_expr='A+(B-A)*clip((abs(Y/H-0.55)-0.08)*3.2\\,0\\,1)'",
  // Pull the top corners in, as if the camera looks down at a tabletop at an angle, then crop the edges.
  "perspective=x0=W*0.1:y0=0:x1=W*0.9:y1=0:x2=0:y2=H:x3=W:y3=H:sense=destination:eval=init",
  "crop=iw*0.8:ih*0.84:iw*0.1:ih*0.03", "scale=1920:-2:flags=lanczos",
  "vignette=PI/4.5",
  "fps=24", // Hold each stop-motion frame for several video frames.
  `fade=t=in:st=0:d=1,fade=t=out:st=${Math.max(0, seconds - 1.5).toFixed(2)}:d=1.5`,
].join(",").replace("split[a][b],[b]", "split[a][b];[b]").replace("[bl],[a]", "[bl];[a]");

const mp4 = path.join(OUT, "glomus-miniature.mp4");
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", stepRate.toFixed(3), "-i", path.join(FRAMES, "%05d.png"),
  "-filter_complex", look, "-c:v", "libx264", "-preset", "slow", "-crf", "19", "-pix_fmt", "yuv420p", "-movflags", "+faststart", mp4],
  { stdio: "inherit" });
console.log(`${count} frames at ${stepRate.toFixed(1)} steps/s → ${seconds.toFixed(0)} s. Saved ${path.relative(ROOT, mp4)}`);
