# Glomus

*Upward, not northward.*

A living landscape, seen from above, that a local model reshapes and reprograms on your whims.

Point at a spot and say what you want: *carve a stream from here into the lake*, *make the stones here
sweat water*, *a floodgate that bursts every 30 seconds*, *let glowing moss creep along the banks*. A model
running on your own machine works on a copy of the world: it looks closely at the ground, previews its plan
in a short simulation, fixes what the preview shows is wrong, and commits. What it commits is a **skein**:
new materials, edits to the ground, and **threads**, small rules that keep running in the world. The world's
own nature (the spring, meadows, snow on the peaks) is written in threads too, so a whim can extend it,
compete with it or switch it off.

Nothing has to be useful. Skeins pile up and tangle: moss follows the floodgate's water, a channel fills with
silt, rain turns the peaks white and the meltwater finds the new streams.

*Glomus* is Latin for a ball of thread; it is also a genus of fungi whose hidden networks feed the plants
above them.

## Play

Double-click **Play Glomus.vbs**, or run `npm start`. It serves the game at http://127.0.0.1:8840/ and starts
the local model if nothing answers at the configured address.

- **Click** the map to choose a spot; **drag** to size it. The model calls it "here".
- **Ask the world** (Ctrl+Enter) queues a whim. While the model works, its spot shows a moving dashed ring
  and its card lists each step: what it looked at, what its preview showed, when it committed.
- **Skeins** lists every whim with what the model said and how many tiles each thread is acting on.
  *Switch off* pauses its threads; *Erase* also restores the ground its edits changed.
- **Rewind** goes back up to three minutes. **Rain**, **Pause** (Space) and **speed** are in the header.
- *Write a plan by hand* applies a plan in the same JSON the model writes.

## The model

`config/model.json` names the model server. By default it starts llama.cpp's `llama-server` with Qwen3.8
27B (Q4_K_L) on port 8080, with the model's own chat template (`--jinja`) so tool calling works. Any
OpenAI-compatible server with tool calling (Ollama, LM Studio, vLLM) works if its `baseUrl` and `alias`
match; remove the `launch` section to use one that is already running.

## How it's built

- `game/world.js`: the world as an ES module with no DOM: terrain, water, erosion, weather, the thread
  language, plan validation (`checkPlan`), skeins, saves and the report the model reads. Runs in the page
  and in Node.
- `game/index.html`: the map, the whim queue with live steps, the skeins panel.
- `server/shaper.js`: the harness. A [Pi](https://www.npmjs.com/package/@mariozechner/pi-agent-core) agent
  with four tools (`look`, `read_skein`, `try_plan`, `commit`), at most 8 tool calls per whim. Its `LANGUAGE`
  prompt is the thread language's reference.
- `server/server.js`: the local server. Every whim is saved as a replayable case in `workspace/whims/`: the
  world it started from, the full transcript, each tool call and the result.
- `server/model.js`: finds or starts the model server.

A plan is data, not code: it can only name areas, materials, conditions and actions the game knows, with
bounded amounts, so nothing a model writes reaches beyond the map. Every skein can be switched off, erased
or rewound.

## Tests and evals

```powershell
npm test                                    # the world and the thread language (17 checks)
npm run eval                                # every eval case through the real model
npm run eval -- --only floodgate --repeat 3
```

`evals/cases.json` holds whims on a fixed seed with mechanical checks (did water arrive, did a thread act,
did the new moss spread). Each case is simulated next to an untouched copy of the world and compared.
Runs are saved to `workspace/evals/` with every plan and transcript, ready for a reviewer, or Claude, to
judge whether each result actually matches its whim.

## Demo videos

With the server and the model running:

```powershell
npm run record-demo         # a narrated session with captions → demo/out/glomus-demo.mp4
npm run record-timelapse    # ten whims at 4× speed → demo/out/glomus-miniature.mp4 (stop-motion, tilt-shift)
```

Both drive the installed Microsoft Edge through Playwright with a seeded world (`?seed=7`, which never
touches your own saved world). The narrated cut speeds up the stretches where the model is working.

`npm run voice-over` narrates both videos with Kokoro's Sky voice (`af_sky`), locally on the CPU, from the
lines and timings in `demo/voiceover.json`, and writes `demo/out/*-voiced.mp4`. The Kokoro model was copied
from forward-one's cache; on a fresh checkout `kokoro-js` downloads it (about 90 MB) on first use.

## License

Copyright (c) 2026 Jonathan McElyea. [Business Source License 1.1](LICENSE); see
[commercial licensing](COMMERCIAL_LICENSE.md).
