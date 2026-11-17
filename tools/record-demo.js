// Record a demo of Glomus: a scripted play session in Edge, with a visible cursor and captions.
//
//   node tools/record-demo.js          (the game server and the model must be running)
//
// Writes demo/out/raw.webm and demo/out/marks.json (when the model was working, for the edit).
// Then run: node tools/edit-demo.js
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "demo", "out");
const URL = process.env.GLOMUS_URL || "http://127.0.0.1:8840/?seed=7";
const W = 96, H = 64;
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ channel: "msedge", headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1,
  recordVideo: { dir: OUT, size: { width: 1280, height: 720 } } });
const page = await context.newPage();
const t0 = Date.now();
const marks = [];
const mark = (name) => { marks.push({ name, t: (Date.now() - t0) / 1000 }); console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s ${name}`); };
const pause = (s) => page.waitForTimeout(s * 1000);

await page.goto(URL);
await page.waitForSelector("#map");
await page.addStyleTag({ content: `
  #demo-cap { position: fixed; bottom: 34px; transform: translateX(-50%); background: rgba(10,12,15,.86); color: #eef1f4;
    font: 600 19px/1.35 system-ui, "Segoe UI", sans-serif; padding: 11px 18px; border-radius: 10px; max-width: 760px; text-align: center;
    opacity: 0; transition: opacity .45s; z-index: 99; pointer-events: none; box-shadow: 0 6px 24px rgba(0,0,0,.4); }
  #demo-cap.on { opacity: 1; }
  #demo-cap small { display: block; font-weight: 400; font-size: 14px; color: #b9c2cb; margin-top: 3px; }
  #demo-cur { position: fixed; left: -50px; top: -50px; width: 20px; height: 20px; border-radius: 50%; border: 2px solid #fff;
    background: rgba(255,255,255,.22); box-shadow: 0 0 0 2px rgba(0,0,0,.45); transform: translate(-50%,-50%);
    z-index: 100; pointer-events: none; transition: width .12s, height .12s, background .12s; }
  #demo-cur.down { width: 13px; height: 13px; background: rgba(255,255,255,.75); }` });
await page.evaluate(() => {
  const cap = document.createElement("div"); cap.id = "demo-cap"; document.body.appendChild(cap);
  const cur = document.createElement("div"); cur.id = "demo-cur"; document.body.appendChild(cur);
  addEventListener("mousemove", (e) => { cur.style.left = e.clientX + "px"; cur.style.top = e.clientY + "px"; }, true);
  addEventListener("mousedown", () => cur.classList.add("down"), true);
  addEventListener("mouseup", () => cur.classList.remove("down"), true);
  const map = document.getElementById("map").getBoundingClientRect();
  cap.style.left = map.left + map.width / 2 + "px";
});

async function caption(text, sub = "") {
  await page.evaluate(([t, s]) => {
    const cap = document.getElementById("demo-cap");
    cap.innerHTML = ""; cap.append(t);
    if (s) { const sm = document.createElement("small"); sm.textContent = s; cap.append(sm); }
    cap.classList.toggle("on", !!t);
  }, [text, sub]);
}
async function tile(tx, ty) {
  const r = await page.locator("#map").boundingBox();
  return [r.x + ((tx + 0.5) * r.width) / W, r.y + ((ty + 0.5) * r.height) / H];
}
async function moveTo(x, y) { await page.mouse.move(x, y, { steps: 28 }); }
async function pickSpot(tx, ty, r) {
  const [x, y] = await tile(tx, ty);
  await moveTo(x, y); await page.mouse.down();
  if (r) { const [x2, y2] = await tile(tx + r, ty); await page.mouse.move(x2, y2, { steps: 14 }); }
  await page.mouse.up();
}
async function clickOn(selector) {
  const b = await page.locator(selector).first().boundingBox();
  await moveTo(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down(); await page.waitForTimeout(80); await page.mouse.up();
  await page.locator(selector).first().click({ force: true, position: { x: b.width / 2, y: b.height / 2 } }).catch(() => {});
}
async function whim(text) {
  await clickOn("#whim");
  await page.keyboard.type(text, { delay: 38 });
  await pause(0.6);
  await clickOn("#ask");
  mark("work-start");
  await page.waitForFunction(() => !document.querySelector("#queue .status-asking") &&
    ![...document.querySelectorAll("#queue .card")].some((c) => /waiting/.test(c.textContent)), null, { timeout: 300000, polling: 500 });
  mark("work-end");
  const fizzled = await page.locator("#queue .status-fizzled").count();
  if (fizzled) console.log("  (this whim fizzled)");
  return page.evaluate(() => { const c = document.querySelector("#skeins .card"); return c ? c.querySelector(".say")?.textContent || "" : ""; });
}
async function setSpeed(target) {
  for (let k = 0; k < 4; k++) {
    if ((await page.textContent("#speed")).startsWith(target)) return;
    await clickOn("#speed"); await pause(0.25);
  }
}

// Clean landscape frames for the tilt-shift timelapse: the canvas pixels only, no captions or interface.
const FRAMES = path.join(OUT, "frames");
fs.rmSync(FRAMES, { recursive: true, force: true });
fs.mkdirSync(FRAMES, { recursive: true });
let frameNo = 0, capturing = true;
const grabber = (async () => {
  while (capturing) {
    const started = Date.now();
    try {
      const data = await page.evaluate(() => document.getElementById("map").toDataURL("image/png"));
      fs.writeFileSync(path.join(FRAMES, String(frameNo++).padStart(5, "0") + ".png"), Buffer.from(data.split(",")[1], "base64"));
    } catch { /* The page is closing. */ }
    await new Promise((r) => setTimeout(r, Math.max(0, 500 - (Date.now() - started))));
  }
})();

// ---- The session ----
await pause(1.5);
await caption("Glomus", "A living landscape that a local AI reshapes on your whims");
await pause(4.5);
await caption("Point at a spot…");
await pickSpot(80, 20, 4);
await pause(1.2);
await caption("…and say what you want.");
let said = await whim("A waterfall that pours off this ridge into a pool below");
await caption("");
await pause(0.5);
await caption("“" + said + "”", "Qwen 27B on this PC looked around, previewed its plan, fixed it, then committed.");
await moveTo(...(await tile(90, 40)));
await pause(7);

await caption("Whims can be about behaviour, not just shape.");
await pickSpot(72, 34, 6);
said = await whim("Let glowing moss creep along the banks of this new stream");
await caption("“" + said + "”");
await setSpeed("4");
await pause(7);
await setSpeed("1");

await caption("Or about time.");
await pickSpot(50, 24, 6);
said = await whim("A wildfire that sweeps these hills for one minute, then burns out");
await caption("“" + said + "”");
await setSpeed("8");
await pause(9);

await caption("Every whim keeps running. They tangle: fire, moss and water all run on the same threads.");
await clickOn("#rain");
await pause(8);
await setSpeed("1");
mark("tangle-end");

await caption("Each whim is a skein: switch it off, erase it…");
const fireCard = page.locator("#skeins .card").first();
const fb = await fireCard.boundingBox();
await moveTo(fb.x + fb.width / 2, fb.y + 30);
await pause(2.5);
await clickOn("#skeins .card >> nth=0 >> text=Erase");
await pause(2.5);
await caption("…or rewind the whole world.");
const rr = await page.locator("#rewindRange").boundingBox();
await moveTo(rr.x + rr.width - 6, rr.y + rr.height / 2);
await page.mouse.down(); await page.mouse.move(rr.x + rr.width * 0.55, rr.y + rr.height / 2, { steps: 20 }); await page.mouse.up();
await page.locator("#rewindRange").evaluate((el) => el.dispatchEvent(new Event("input")));
await pause(1);
await clickOn("#rewind");
await pause(3.5);
await caption("Glomus · Upward, not northward", "Early prototype. Everything runs locally: the world in the browser, the model on your GPU.");
await moveTo(1250, 700);
await pause(5);
mark("end");
capturing = false;
await grabber;
console.log(`${frameNo} landscape frames`);

const video = page.video();
await context.close();
await browser.close();
const raw = path.join(OUT, "raw.webm");
fs.renameSync(await video.path(), raw);
fs.writeFileSync(path.join(OUT, "marks.json"), JSON.stringify(marks, null, 1));
console.log("Saved " + path.relative(ROOT, raw));
