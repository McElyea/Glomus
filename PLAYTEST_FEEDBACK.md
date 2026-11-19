# Glomus: Concept and Playtest Feedback Handoff

Date: November 17, 2026 (America/Denver)

## Purpose and scope

This document captures concept feedback and findings from a short play session in which Jon controlled Glomus and Codex observed periodic window snapshots and inspected the saved whim logs. It is intended for discussion and prioritization before further implementation.

The session covered three requests on one world. These observations are not a continuous recording or a general usability study. Timing comes from the server's recorded request durations; reactions, satisfaction, and reasons for individual actions were not independently established. No gameplay code was changed during the session.

## Overall assessment

The most compelling part of Glomus is giving a landscape new habits and watching those habits interact. A request such as “make these stones sweat water” can create consequences that inspire another request.

The central creative loop is:

> Make a wish → notice a consequence → get curious → make another wish.

Having nature and player additions use the same thread language is a strong foundation. The spring, meadows, and invented behaviors belong to the same system, so they can meaningfully interact. The playful vocabulary of whims, threads, and skeins also gives the project a coherent identity.

The open-ended premise—nothing has to be useful—is worth preserving. The immediate priority is making the world's response understandable and ensuring the model describes only behavior it actually implemented.

## Observed requests and outcomes

### 1. “Expand the water to the right”

- **Recorded duration:** 18.066 seconds; six tool calls.
- **Selection:** No spot selected.
- **Committed behavior:** Level a 30 × 12 tile rectangle east of the existing water to 15.5 metres, then add 1.2 metres of water across it.
- **Visible result:** A conspicuous rectangular body of water appeared. Water subsequently redistributed into surrounding terrain, and the region's appearance continued changing.
- **Interpretation:** The request produced a visible expansion, but the initial geometry looked mechanically imposed on the landscape. A preview that checks water quantities can still accept an awkward-looking result.

This suggests evaluating the shape and persistence of a change alongside its immediate mechanical effect. An ordinary request to expand a lake should generally preserve a plausible shoreline, unless the player asks for a geometric or artificial feature.

### 2. “lower the land so the area I have selected can be filled with water”

- **Recorded duration:** 9.181 seconds; three tool calls.
- **Selection:** Centre (48, 30), radius 16.
- **Committed behavior:** Apply a circular edit with a target level of 1.5 metres and add 0.6 metres of water. Terrain edits have spatial weighting, so this does not uniformly flatten every selected tile to the target height.
- **Visible result:** A pond developed and settled into a more organic shape as the simulation continued.
- **Additional observation:** Jon opened “Show its plan,” exposing the JSON. The reason for opening it was not established.

The evolving pond demonstrated the appeal of a world that continues responding after a request completes. It also raises a usability question: can players understand the affected area, expected water coverage, and ongoing changes directly from the map and explanation?

### 3. “Make it so when I left double-click, water replaces the land, by lowering the land or whatever mechanism for that area that works”

- **Recorded duration:** 11.067 seconds; three tool calls.
- **Selection:** Centre (35, 36), radius 4.
- **Model's explanation:** “When you left double-click here, the ground slowly sinks to about 6 m — below the lake's surface — and the water rushes in to cover it.”
- **Actual committed behavior:** A continuously active rule lowers the originally selected circle by 0.25 metres per second.

The relevant rule was:

```json
{
  "name": "Sink the clicked ground",
  "area": { "circle": [35, 36, 4] },
  "when": [],
  "do": [{ "lower": 0.25 }]
}
```

There are two concrete mismatches:

1. **No double-click trigger was created.** The rule starts acting on the fixed circle immediately. The current thread language does not provide a mouse-event trigger, and the map's existing pointer handlers manage selection.
2. **No stopping condition at 6 metres was created.** The empty condition list leaves the lowering rule active, subject to the engine's terrain bounds or the player switching it off.

The plan committed successfully, but it did not implement the interaction described to the player. This is the highest-priority finding because it can make the interface appear broken and undermine confidence in subsequent explanations.

## Suggested priorities

### First: Ground explanations in supported, committed behavior

Unsupported requests should receive a clear explanation of the limitation. A request for a new mouse interaction should not silently become a fixed terrain edit with an explanation claiming that the interaction exists.

Suggested acceptance criteria:

- A request to bind an unsupported mouse action does not commit an unrelated substitute while claiming success.
- Any claimed stopping depth, duration, trigger, or future event is represented in the committed behavior.
- A supported alternative is described explicitly, including how it differs from the request, before it is applied.
- Add this exact double-click request as a regression case. Check both the plan and the explanation; successful commit alone is insufficient.

Review the capability guidance, commit handling, and explanation generation in [server/shaper.js](server/shaper.js), with the rule vocabulary in [game/world.js](game/world.js).

### Next: Make consequences and spatial scope easier to read

Potential improvements include highlighting the actual affected area, distinguishing immediate edits from ongoing rules, and providing a plain-language “why is this happening here?” inspector.

A useful explanation might connect a spreading material to water from an earlier floodgate. The important outcome is that players can discover causal relationships without needing to interpret JSON.

For terrain shaping, review whether the model has suitable primitives and feedback for making organic contours. Test results after water has had time to settle, not only immediately after commit.

### Explore: Whims that create reusable tools or powers

Within three requests, Jon moved from changing terrain to asking for a reusable mouse interaction. That is evidence of interest in changing how the player acts on the world, as well as changing the world itself.

This suggests an exploratory direction: named brushes or powers created through whims, with visible activation controls and clear scope. It is a product hypothesis from one session, not yet a validated requirement. Supporting it would require explicit input-event and interaction design beyond the current thread language.

## Responsiveness

The three recorded requests completed in approximately 9–18 seconds. This is a useful baseline on the current machine and model configuration. The session does not establish whether that delay is acceptable across users or more complex requests.

Future playtests should distinguish time spent watching interesting world behavior from time spent waiting for a response. The world remaining active during generation could help, provided players can tell what is still being planned and what has already taken effect.

## Follow-up playtest

Run a short, unassisted session and look for whether a later whim arises from a consequence of an earlier one. For example, a flood changes a meadow and the player invents something that thrives after flooding.

Also observe whether players can explain what each new rule does, identify where it acts, and stop it without opening its JSON. Record moments when they repeat or rephrase requests, and ask afterward what result they expected.

Existing single-request evaluations are useful. A complementary sequence-based evaluation should check whether several whims remain understandable and interact as intended over time.

## Local evidence for reproduction

The saved cases include the starting world, request, selected spot, committed plan, tool events, and transcript. These files are local workspace artifacts and may not accompany a repository checkout:

- `workspace/whims/2026-11-18T03-48-18-768Z-dfba7e70.json` — expand water right.
- `workspace/whims/2026-11-18T03-49-20-791Z-407ee5a4.json` — lower and fill the selected area.
- `workspace/whims/2026-11-18T03-50-51-813Z-d3ae4fe7.json` — requested double-click behavior.

The filenames use UTC timestamps; the local session date was November 17. See also [evals/cases.json](evals/cases.json) for the existing mechanical evaluations and [game/index.html](game/index.html) for selection, rendering, and skein controls.
