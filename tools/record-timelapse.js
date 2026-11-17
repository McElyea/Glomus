// Record a busy session for the tilt-shift timelapse: many whims back to back while the world runs fast.
// Captures only the map canvas, twice a second, to demo/out/timelapse-frames/.
//
//   node tools/record-timelapse.js        (the game server and the model must be running)
//   node tools/edit-timelapse.js          then turns the frames into the miniature-look video
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FRAMES = path.join(ROOT, "demo", "out", "timelapse-frames");
const URL = process.env.GLOMUS_URL || "http://127.0.0.1:8840/?seed=7";
fs.rmSync(FRAMES, { recursive: true, force: true });
fs.mkdirSync(FRAMES, { recursive: true });

// [x, y, radius or null for no spot, whim]
const WHIMS = [
  [80, 20, 4, "A waterfall that pours off this ridge into a pool below"],
  [50, 24, 6, "A wildfire that sweeps these hills for one minute, then burns out"],
  [null, null, null, "Let glowing moss creep along every riverbank"],
  [62, 46, 6, "Dig a deep round lake here and fill it"],
  [30, 41, 3, "Raise a ring of little islands in this lake"],
  [70, 12, 4, "Crystal spires that slowly grow outward from here across the stone"],
  [86, 50, 4, "A volcano here that builds itself up and spills glowing lava down its sides"],
  [null, null, null, "Paint all the snowy peaks lavender"],
  [45, 55, 8, "A tide that floods this low ground for 10 seconds every 30 seconds"],
  [20, 20, 5, "A grove of red autumn trees that spreads wherever the ground is wet"],
];

const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2 })).newPage();
await page.goto(URL);
await page.waitForSelector("#map");
const t0 = Date.now();
const log = (s) => console.log(`${((Date.now() - t0) / 1000).toFixed(0)}s ${s}`);

let frameNo = 0, capturing = true;
const grabber = (async () => {
  while (capturing) {
    const started = Date.now();
    try {
      const data = await page.evaluate(() => document.getElementById("map").toDataURL("image/png"));
      fs.writeFileSync(path.join(FRAMES, String(frameNo++).padStart(5, "0") + ".png"), Buffer.from(data.split(",")[1], "base64"));
    } catch { /* closing */ }
    await new Promise((r) => setTimeout(r, Math.max(0, 500 - (Date.now() - started))));
  }
})();

// Run the world at 4x, and queue each whim with its spot. The page sends them to the model one at a time.
const setSpeed = async (target) => { for (let k = 0; k < 4 && !(await page.textContent("#speed")).startsWith(target); k++) await page.click("#speed"); };
await setSpeed("4");
const box = await page.locator("#map").boundingBox();
const tileXY = (x, y) => [box.x + ((x + 0.5) * box.width) / 96, box.y + ((y + 0.5) * box.height) / 64];
for (const [x, y, r, text] of WHIMS) {
  if (x !== null) {
    const [px, py] = tileXY(x, y), [rx] = tileXY(x + r, y);
    await page.mouse.move(px, py); await page.mouse.down(); await page.mouse.move(rx, py, { steps: 4 }); await page.mouse.up();
  } else {
    await page.click("#clearSpot").catch(() => {});
  }
  await page.fill("#whim", text);
  await page.click("#ask");
  log("queued: " + text);
  await page.mouse.move(5, 5);
  await page.keyboard.press("Escape"); // Clear the spot ring so it doesn't sit in the shot.
  await page.waitForTimeout(800);
}
// Wait for the model to work through the queue, raining now and then.
let rainToggles = 0;
for (;;) {
  const pending = await page.evaluate(() => [...document.querySelectorAll("#queue .card")].filter((c) => /working|waiting/.test(c.textContent)).length);
  if (!pending) break;
  if ((Date.now() - t0) / 1000 > 90 * (rainToggles + 1)) { await page.click("#rain"); rainToggles++; log("rain toggled"); }
  if ((Date.now() - t0) / 1000 > 1200) { log("giving up on the queue"); break; }
  await page.waitForTimeout(3000);
}
const summary = await page.evaluate(() => ({
  skeins: [...document.querySelectorAll("#skeins .card .name")].map((n) => n.textContent),
  fizzled: [...document.querySelectorAll("#queue .card")].filter((c) => /fizzled/.test(c.textContent)).map((c) => c.querySelector(".name").textContent),
}));
log("all whims done; " + summary.skeins.length + " skeins, fizzled: " + JSON.stringify(summary.fizzled));
// Let the tangled world run on at 8x for a while.
await setSpeed("8");
await page.waitForTimeout(40000);
capturing = false;
await grabber;
log(`${frameNo} frames`);
fs.writeFileSync(path.join(FRAMES, "..", "timelapse-summary.json"), JSON.stringify(summary, null, 1));
await browser.close();
