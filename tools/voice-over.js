// Voice the demo videos with Kokoro (the Sky voice), locally on the CPU, and mix the lines in.
//
//   node tools/voice-over.js          reads demo/voiceover.json, writes demo/out/*-voiced.mp4
//
// Each line is spoken starting at its "at" second. Lines that would overlap the next one are reported.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { KokoroTTS } from "kokoro-js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "demo", "out");
const VO = path.join(OUT, "vo");
const config = JSON.parse(fs.readFileSync(path.join(ROOT, "demo", "voiceover.json"), "utf8"));
fs.mkdirSync(VO, { recursive: true });

const tts = await KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", { dtype: "q8", device: "cpu" });
const seconds = (file) => Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).toString());

for (const video of config.videos) {
  const input = path.join(OUT, video.input);
  const clips = [];
  for (const [k, line] of video.lines.entries()) {
    const file = path.join(VO, `${path.parse(video.input).name}-${String(k).padStart(2, "0")}.wav`);
    const audio = await tts.generate(line.text, { voice: config.voice, speed: config.speed });
    await audio.save(file);
    clips.push({ ...line, file, length: seconds(file) });
  }
  clips.forEach((c, k) => {
    const next = clips[k + 1];
    const end = c.at + c.length;
    console.log(`${c.at.toFixed(1)}–${end.toFixed(1)}s  ${c.text}${next && end > next.at ? `   ⚠ overlaps the next line by ${(end - next.at).toFixed(1)}s` : ""}`);
  });
  // Delay each clip to its time, mix them, and lay the mix under the (silent) video.
  const args = ["-y", "-loglevel", "error", "-i", input];
  for (const c of clips) args.push("-i", c.file);
  const delays = clips.map((c, k) => `[${k + 1}:a]adelay=${Math.round(c.at * 1000)}:all=1,volume=1.0[a${k}]`).join(";");
  const mix = `${clips.map((_, k) => `[a${k}]`).join("")}amix=inputs=${clips.length}:normalize=0:dropout_transition=0,apad[vo]`;
  const output = path.join(OUT, video.output);
  execFileSync("ffmpeg", [...args, "-filter_complex", `${delays};${mix}`, "-map", "0:v", "-map", "[vo]", "-c:v", "copy",
    "-c:a", "aac", "-b:a", "160k", "-shortest", "-movflags", "+faststart", output], { stdio: "inherit" });
  console.log(`Saved ${path.relative(ROOT, output)} (${seconds(output).toFixed(0)} s)\n`);
}
