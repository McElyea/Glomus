# Powers and honest whims: design

Status (Nov 17, 2026): revised after Codex's review ([POWERS_REVIEW.md](POWERS_REVIEW.md)). Where a section
answers a review finding, it's tagged **(R1)** through **(R6)**, with a summary table at the end.

- **Slice 1 is built:** outcomes, request-side routing, typed claims, "What it does", proposal cards.
- **Slice 2 is built:** change records and delta undo for every skein, click tools with lifecycle and reach,
  and the palette with Spot, size and Undo use.
- **Slice 3 is built:** drag tools, `replaces`, Remove tool and Put back, and the 🛠 idea pills.
- **Still open:** gaps such as `fill`, `downhill`, button tools, pushing water along a stroke, and
  flatten-here. Those stay proposals.

Not committed.

Two linked changes:

1. **Powers.** A whim can give the player a named tool, a *power*, which they pick from a palette and use on
   the map. A use can change the ground once at that point, leave threads acting there, or both.
2. **Honesty.** "I can't do that" becomes a real outcome. Whether a whim is committed or proposed is decided
   from the **request** and the plan, not from the model's prose. The player-facing description of what a
   plan does is **generated from the plan** and is the authoritative one. The model's `say` is shown as its
   words, and only the claim types we can check are checked.

---

## 1. Powers in the plan format

A plan gets one more optional list, `powers` (at most 3 per plan):

```json
{
  "name": "Sinking touch",
  "say": "Pick Sink and click near water: the ground there sinks until water covers it.",
  "powers": [{
    "name": "Sink",
    "icon": "🕳️",
    "brush": {"circle": 4},
    "threads": [{"name": "Sink until wet", "when": [{"water": ["<", 0.2]}, {"height": [">", 1]}], "do": [{"lower": 0.25}]}]
  }]
}
```

A power holds its own `edits` (instant) and/or `threads` (lingering). It can also carry `replaces`, the id of
an existing power that it supersedes (see Lifecycle).

### The brush: where a use starts and runs (R4)

| brush | how the player uses it | the use's footprint |
|---|---|---|
| `{"circle": r}` (r 1–12) | click on the map | a circle around the click; r is its starting size (the palette's size control changes it) |
| `{"stroke": w}` (w 1–8) | drag along the map | a path of width w along the drag, downsampled to 40 points with both ends kept |

Edits and threads inside a power have no `area` of their own. An area the model writes anyway is dropped,
with a problem note.

**The brush is where a use starts, not a containment boundary.** Effects travel:

- Water added by a use flows downhill like any other water.
- `spread` paints neighbouring tiles, which can be outside the footprint.

To keep a use's own rules in charge of what it caused, its lingering threads run on its **reach**: the
footprint plus every tile this use has painted a material onto. Fire's "burn to ash" thread then follows the
fire to every tile it spread to, so a use can burn out completely. The reach is the same tile set the use's
undo record already keeps (see Undo), so it adds no new bookkeeping. Nothing here promises containment.

- `explainPlan` says so where it applies: *"can spread beyond where you click; its later rules follow it,"*
  and *"the water flows away downhill."*
- Spreading tools keep spreading from every tile they've reached, until a `within` stops them.
- Ordinary whim skeins keep their fixed areas, as now. Their fire can still leave stragglers outside the area,
  and that stays a known limitation.

### Instant and lingering effects

- **Instant:** the power's `edits` run once on the footprint, at the moment of use.
- **Lingering:** the power's `threads` are attached to that use. Each use gets its own copy, so three clicks
  make three independent sinks.
- **Times count from each use:**
  - `{"within": 30}` means "for 30 s after each use".
  - `{"after": 10}` means "starting 10 s after".
  - The clock keeps running while the skein is switched off, the same as skeins today. Turning a Rain cloud
    back on after its 10 s have passed doesn't restart the rain. The card says so: *"times count from each
    use, even while switched off."*
- **Height and water conditions keep holding.** They don't mark a use as finished (R5). `{"height": [">", 6]}`
  means "keeps the ground here at or below 6 m". If something raises that ground later, the use lowers it again.

### "Sink to water" names what it really does (R6)

Lowering to a fixed height doesn't guarantee that water arrives. Nearby water may stand lower than that
height, or a ridge may cut it off. A preview at one shoreline only proves that shoreline. So the design
keeps two different promises apart:

- **Lower toward 6 m:** `lower` while `height > 6`. Its description says *"keeps the ground here at or below
  6 m. Water fills it only where nearby water stands higher than that."*
- **Sink until water covers it:** this sensing happens at use time and is already in the language.
  `lower` while `water < 0.2` and `height > 1`. Each tile stops sinking once it's wet. The floor stops a
  pit from digging to 0 where no water can reach. Its description says *"sinks until water covers it, down
  to at most 1 m. With no water nearby, it leaves a dry pit."*

The prompt tells the model to use the second form when the whim says the water should arrive. The eval uses
the tool at three points: one where water reaches, one where nearby water is lower, and one behind a ridge.

### Identities, lifecycle and limits (R5)

**Identities**

- Every power has a stable `id` (`"<skeinId>.<k>"`), and every use has a world-unique `id` from
  `world.nextUse`.
- A power with `replaces: id` retires the old power: it leaves the palette, and its live uses keep acting
  until erased.

**States of a use**, computed each UI tick and shown on the map and the card:

| state | meaning | shown as |
|---|---|---|
| pending | before an `after` start | "starts in 8 s" |
| acting | at least one tile acted this tick | dotted ring on the map |
| waiting | its time window is open, but a world-wide condition is false | "waiting for rain", "between pulses" |
| holding | its window is open, but none of its tiles match right now (for example, at its height limit) | "holding at 6 m"; can wake again |
| expired | every thread has a `within` that has passed, so it can never act again | not shown; pruned from the live list |
| undone | canceled by Undo or Erase | gone |

**Rules that follow from the states**

- **Pruning:** only expired and undone uses leave the live list. Holding uses stay live because they can wake.
- **Making a permanent "done":** that would be a new flag (for example `"once": true` on a height condition).
  It's out of this round; "holding" is the documented behaviour.
- **Feedback after a use** is read from the state, so a valid delayed or rain-dependent use is never called a
  failure:
  - pending: "starts in 8 s"
  - waiting: "waiting for rain"
  - instant edits that changed no tile: "nothing changed here"
  - a lingering use whose window is open and global conditions hold, but which hasn't acted for 2 s:
    "nothing here matches: it only acts where there's water". The phrase comes from its local conditions.
- **Cap:** 24 live uses per power. At the cap, a new use is **refused**: *"Spring is acting in 24 places. Undo
  or erase some first."* No silent pruning.

### Undo, Erase and Rewind (R3)

Today a skein's undo stores before-values, and two of the review's probes reproduce on the current engine:

- **Overlapping raises:** a tile at 10 m gets A (+4), then B (+3), reaching 17 m. Erasing A puts the tile back
  to 10 m even though B still exists.
- **Sinking:** a sink thread lowers a tile from 10 m to 6 m. Erasing it leaves the tile at 6 m.

Powers would make both of these happen all the time, so the contract changes for **all** skeins, not only
powers.

**What gets recorded.** Each use, and each ordinary skein, keeps a change record:

- **height:** a per-tile delta covering everything it did to the ground. That includes its edits *and* the
  amounts its `raise`/`lower` threads actually applied, after clamping at 0 and 30 m.
- **material:** for each tile it painted, the material before its first write and the material it last wrote.

**What Undo and Erase do.**

- They subtract the height delta, clamped to 0–30 m.
- They restore a tile's material only where the tile still holds what this record last wrote. If something
  else repainted it since, that later change is left alone.
- Water and silt are not undone. Water moves on, as today.

Results for the review's acceptance cases:

| case | result |
|---|---|
| 10 → A +4 → B +3, erase A | 13: B's +3 is kept |
| Sink lowers 10 → 6, then undo | back to 10, apart from any erosion since |
| Three uses of a tool on one tile, undo the latest, then erase the tool | only the latest use's delta is removed; Erase then removes the remaining ones |
| Each of the above after save/load, and after a rewind to before and after the undo | identical results |

**What this doesn't do.** Undo removes what a use itself did to the ground. It does not replay the world as if
the use never happened: erosion it caused, water it moved, and other rules that reacted to it all stay. The
UI says this plainly:

- the Undo tooltip: *"puts back what this use did to the ground. Use Rewind to go back in time exactly."*
- the Erase tooltip: *"stops its rules and takes back what they did to the ground."*

**The controls.**

| control | what it does |
|---|---|
| Undo last use (button, Ctrl+Z) | pops the most recent use that still exists, world-wide; repeatable |
| Erase (whole skein) | undoes every use and every edit of the skein, removes its powers, and stops its threads |
| Remove tool | takes the power off the palette, keeps everything it made, and leaves its live uses acting |
| Switch off | pauses its threads and its uses, and greys out its tools |
| Rewind | exact, as now: snapshots carry all the records |

**Bounds** (the review asked for these to be explicit):

- **Per-use history:** individual records are kept for the **last 50 uses world-wide**, which is what Undo last
  use can reach. Older use records fold into their power's aggregate record: deltas are summed, and for
  materials the earliest "before" and the latest "written" are kept. Erase still works on those.
- **Size:** each record covers at most every tile on the map once (6,144). On top of that, a world-wide budget
  of **200,000 recorded tiles** applies. Past it, the oldest aggregate records are dropped, and their card
  says *"can no longer take back its ground changes; Rewind still can."*
- **Model requests:** records are **stripped from the world sent to the model server**, since the shaper
  doesn't need them. Requests stay at their current size, and saves and snapshots carry the records within
  the budget above.
- **Old saves:** saves with the old before-value records keep the old erase behaviour for those skeins.

### Icons

- **Format:** `icon` must be one emoji grapheme (`\p{Extended_Pictographic}`, at most one ZWJ sequence).
  Flags are excluded, because Windows doesn't render them.
- **Fallback:** a power with no valid icon gets a badge with its initials on a colour derived from its name.
- **Names:** capped at 24 characters and rendered with `textContent` only.
- **Generated icons:** not in this round. The local model reads and writes text only, and an image model
  would compete with it for the one GPU. An 8×8 pixel icon drawn as text, in a second call that doesn't
  block the whim, is a possible follow-up.

### In the world (`game/world.js`)

- `checkPlan` validates `powers`: name, icon, brush, up to 4 edits and 3 threads, `replaces`, and that each
  power has at least one edit or thread.
- `usePower(world, powerId, where)`:
  - refuses at the cap
  - builds the footprint
  - applies the edits into a new use record
  - registers the use
  - clears the skein's compiled cache
- `undoUse(world, useId)` and the delta-based `eraseSkein`.
- `useState(world, use)` returns the lifecycle state.
- `compiled()` adds a copy of the power's threads per live use, running on its reach, with `within` and
  `after` timed from the use.
- Thread actions write height deltas and material writes into the record of the skein or use they belong to.
- `explainPlan(clean)` and `describe()` list powers, their ids and how many live uses each has, so later
  whims can refer to them and replace them.

### What the model sees (`server/shaper.js`)

- **Prompt:** a POWERS section in `LANGUAGE`, plus:
  - the World tools the page already has (Spot)
  - that the model can't use tools itself: for "use the rain tool on the lake", make the change directly or
    explain how to use the tool
  - how to turn an existing skein into a tool (`read_skein`, then copy its threads)
  - the "sink until wet" pattern
- **Preview:** `try_plan` takes an optional `use_at`. The preview uses each power once there (by default at the
  spot, or the map centre if there's none). It reports what that use did *and* that it proves only that one
  place:
  > Used Sink once at (35,36): ground 7.8 → 6.1 m in 20 s, wet tiles 0 → 41; it is holding now. One use at
  > one place: other places may differ.

### In the page (`game/index.html`)

A **tool palette** directly above the map, in two groups:

```
 World │ 📍 Spot   Size ◀ 4 ▶   ↶ Undo use        Your tools │ 1 🕳️ Sink   2 🌧️ Rain cloud   3 〰️ Dig channel
```

- **World tools** are always there: 📍 **Spot** picks "here" for the next whim. The "why is this happening
  here?" inspector can go here later.
- **Your tools** are the powers whims have made: icon, name and number key, with "drag" marked on strokes.
  With none yet, this group shows a hint: *"Ask for a tool: 'give me a tool that raises a hill where I
  click.'"* A new tool glows briefly. The palette wraps, and tools past the 9th have no key.
- **Size** applies to whichever circle tool is active, Spot included: ◀ ▶ or the [ and ] keys. Each tool
  remembers its own size.
- **Clicking places; it never sizes.** Dragging only means something for stroke tools.
- **Picking a tool** (click it, or press 1–9) changes what a click does. The cursor shows the brush, and the
  hover line reads *"Sink: click to use · Esc for Spot"*. A use flashes its outline. Then the state feedback
  above appears next to it.
- **Escape** goes back to Spot. While Spot is already active, Escape clears the spot, as it does now.
- **On the map,** acting uses get a faint dotted ring, and holding or waiting ones a fainter one.
- **On the skein card:** "What it does", its tools, its live uses by state, and **Switch off / Remove tool /
  Erase**.

### Powers are tools you pick, not gestures

Every power is a visible tool in the palette. There are no gesture bindings. A whim that names a gesture the
game doesn't have ("when I double-click…") gets a **proposal**, which is enforced from the request (R1):

> I can't bind double-click. Instead you get a Sink tool in your palette: pick it and click. Apply?

That card is also where a player first learns that whims can make tools.

### Tools players will ask for

| tool | brush | how it's built | fits? |
|---|---|---|---|
| 🌧️ Rain cloud | circle | thread `add_water 0.4` with `within 10` | yes |
| ⛰️ Raise a hill | circle | edit `raise 4` | yes |
| 🕳️ Sink until wet (Jon's) | circle | `lower 0.25` while `water < 0.2` and `height > 1` | yes; water arrives only where it can reach (R6) |
| 〰️ Dig a channel | stroke | edit `lower 2` | yes |
| 🧱 Wall / dam | stroke | edit `raise 3`, material stone | yes |
| 🌱 Seed meadow / forest | circle | edit `material`, plus a `spread` thread with `within 60` | yes; spreads beyond the click (R4) |
| 🔥 Fire starter | circle | set fire; spread with `within 20`; fire → ash | yes; burn-out follows the reach (R4) |
| ⛲ Spring | circle (small) | thread `add_water 2`, forever | yes; counts toward the cap |
| 🧽 Sponge | circle | thread `drain_water 1` with `within 20` | yes |
| 🖌️ Paint sand, stone… | circle or stroke | edit `material` | yes |
| ⚡ Lightning | circle (small) | edits: `lower 1`, material scorch | yes |
| ❄️ Freeze | circle | drains water and sets ice, then an `after 30` thread melts it back | roughly |
| 🌋 Volcano | circle | raises, then lava spreads as a material | roughly (only water moves) |
| 🌊 Current | stroke | `push_water` along the drag | **gap**: push needs "along the stroke" |
| 🏞️ River pen | stroke | a channel that slopes down the way you drag | **gap** |
| ▭ Flatten here | circle | level to the height where you clicked | **gap**: `level` is absolute only |
| 🫧 Smooth / erode | circle | soften bumps | **gap**: no smoothing action |
| ↩️ Restore / un-whim here | circle | undo whatever whims did here | built-in World tool later |
| 🔍 Inspect | n/a | what's acting on this tile | built-in World tool, priority 2 |
| ✋ Hold to pour, 🦌 creatures, 🔊 sounds, 🎥 camera | n/a | n/a | no; propose or decline |
| 🔁 Charges, cooldowns ("3 uses") | n/a | limit on uses | not yet |

The gaps, along with `fill` (a connected region), `downhill` (a traced path) and button tools (no map
target), stay proposals until a playtest asks for them.

### Edge cases: the 5% at each end

**New, confused or just playing**

| case | handling |
|---|---|
| Forgets a tool is active and raises a hill by accident | **Undo use** / Ctrl+Z, repeatable, delta-based |
| Spam-clicks a raise tool | Undo repeatedly; Erase removes every use's delta |
| Freeze on dry land | "nothing here matches: it only acts where there's water" (from the lifecycle, R5) |
| A delayed or rain-only tool seems dead | "starts in 8 s" / "waiting for rain", never "nothing happened" |
| "Make a tool" with nothing else | the model asks what it should do (an answer, no plan) |
| "Give me a hammer" | the model picks a reading and commits; "What it does" shows the reading |
| "A tool to select an area" | the model answers "Spot already does that" |
| "Use the rain tool on the lake" | the model makes the change directly, or explains how to use the tool |
| Erase, expecting only the tool to go | the tooltip says it takes back the ground changes too; **Remove tool** keeps them |
| A twelfth tool; a touch screen | the palette wraps; ◀ ▶ buttons; tap = click, drag = stroke |

**Power users, testers and system builders**

| case | handling |
|---|---|
| "Make my rain tool stronger" | `replaces`: the old tool retires and its uses keep acting |
| "Turn my stream into a tool" | `read_skein`, then copy its threads; prompt hint |
| 25 forever-springs | the 25th is refused with a message; no silent pruning |
| The same tile clicked 10 times | effects stack; Undo removes only the latest delta |
| Raise a held Sink area with another tool | Sink wakes and lowers it again: documented "holding" behaviour (R5) |
| Strength levels, hold-to-pour | proposal: three tools, or size as strength |
| Tools that erase skeins, make tools, count uses, or move land | unsupported: propose or decline |
| Hostile names and icons | textContent only, 24 chars, a single emoji, flags excluded |
| Proposal applied after the world changed | Apply re-runs `checkPlan` and works once |
| A claim with no rule ("gets stronger each time") | unchecked; "What it does" is the authoritative description (R2) |

### Idea pills

The example chips gain three tool ideas, marked 🛠. The map-only chips drop to four.

- 🛠 *A rain cloud tool: click to make it rain there for 10 seconds*
- 🛠 *A tool that raises a hill where I click*
- 🛠 *A tool that digs a channel where I drag*

---

## 2. "Can't do that" as a real outcome

### Three ways to finish

| tool | when | what the player sees |
|---|---|---|
| `commit(plan)` | the whole whim is done as asked | the skein lands |
| `propose(plan, unsupported)` | part can't be done, and the plan does the closest thing | **Can't do:** … **Instead:** "What it does" plus the model's words. **[Apply] [No thanks]** |
| `decline(say)` | nothing reasonable fits | an answer card, no plan |

### Routing decided from the request, not the prose (R1)

Whether a whim may be committed is decided by `routeOutcome(whim, plan, requested)`, without trusting the
model's prose.

1. **Request-side detection.** `requestNeeds(whim)` scans the player's words, clause by clause, for things the
   game doesn't have:

   | detected in the whim | unsupported entry |
   |---|---|
   | double-click, right-click, middle-click | "double-click (you pick the tool and click instead)" |
   | press, hold or tap a key; keyboard; shift, ctrl, alt; spacebar | that key binding |
   | hold the mouse, scroll, mouse wheel, hover | that input |
   | days, hours, weeks, real time | "days (the plan uses N s of game time)" |
   | sounds, creatures that move, camera, 3D | that thing |

   A clause like "without double-clicking" is negated and skipped.

2. **If anything is detected, the outcome can't be `committed`.** A `commit` call becomes a proposal, with the
   detected entries merged into `unsupported`. It doesn't matter what `say` admits or leaves out.
3. **A non-empty `unsupported`** from the model also makes it a proposal.
4. **A `say` that admits a missing ability** ("I can't…", "instead of…") makes it a proposal. There's no
   "remove that sentence" escape any more: the old advice is gone.
5. **Otherwise, commit.** A normal "a tool that raises a hill where I click" detects nothing, so it is
   committed directly.

The model is told the same rules, so it usually calls `propose` itself. The harness rules are the guarantee.

> **Note:** days and hours now go through a proposal. Jon's wildfire whim ("for 2 days") becomes "can't do
> days; burns for 3 minutes instead. Apply?" That's consistent with "alternatives are approved before they
> apply", at the cost of one click. The `wildfire` eval case changes from `committed` to `proposed`.

**Fixtures (no model, in `game/tools/claims_test.js`):**

| whim | plan | say | `unsupported` | expected |
|---|---|---|---|---|
| Jon's exact double-click whim | a valid click power | mentions only clicking | `[]` | **proposed** |
| "a tool that raises a hill where I click" | the same shape of plan | — | — | **committed** |
| "when I press R, rain here" | a rain power | — | — | **proposed** |

### "What it does" is authoritative; claims are typed (R2)

**The card.** It leads with **What it does**, generated by `explainPlan` from the clean plan. Below that, in
quotes and labelled "The world says", is the model's `say`. Nothing is marked "verified". Prose the checker
doesn't recognise is simply not covered.

**`checkClaims(say, clean)`**, used at commit and propose:

- **Clause-level reading.** `say` is split into sentences, then into clauses at `;`, `but`, `, and`, `, so`,
  `while`. A denial ("can't", "isn't possible") exempts **only its own clause**. In *"I can't bind keys, but
  the rain stops after 30 seconds"*, the second clause is still checked.
- **Matched to the effect.** A clause's verbs map to the actions it talks about. Its claims must hold for
  **every** lingering thread doing that action, or for the specific edits. If no verb matches, the claim
  applies to all of the plan's threads.

  | words | action |
  |---|---|
  | rain, pour, flood, spring, fill with water | `add_water` |
  | sink, dig, lower, carve | `lower` / `level` |
  | raise, build, grow a hill | `raise` / `level` |
  | burn, fire, spread, grow, creep, paint, turn into | `set_material` / `spread` |
  | dry, drain, soak up | `drain_water` |
  | push, pump, current | `push_water` |

- **Typed claims, each with one meaning:**

  | claim type | example in say | what the matched effect must have |
  |---|---|---|
  | target height | "sinks to 6 m", "until it's 6 m", "holds at 6 m" | `lower` with `height` `>`/`>=` N, or `raise` with `<`/`<=` N, or a `level` edit to N (±0.5) |
  | delta | "2 m deep", "raises it 4 m" | an edit `lower`/`raise` of N (±20%) |
  | rate | "0.25 m per second" | that action's amount N (±20%) |
  | water depth | "half a metre of water" | an edit `water` of N |
  | duration | "for 30 seconds", "for a minute" | `within` N (±15% or 2 s) on every matched thread |
  | delay | "after 10 seconds", "in 10 s", "starts later" | `after` N on the matched thread |
  | recurrence | "every 30 seconds" | `cycle` N |
  | ending | "stops", "ends", "burns out", "fades" | every matched lingering thread has `within`, or, for `lower`/`raise`, a height bound in the right direction. A water cap doesn't count as an ending. |
  | future event | "regrows", "comes back", "after a while" | an `after` or `cycle` on the matched thread |
  | input | "click", "tap" / "drag" | a power / a stroke power |
  | unsupported input or time unit in an affirmative clause | "double-click it", "for 2 days" | rejected; routed to propose |

- **Rejections** name the clause, the claim type and the thread it was matched to. They offer two fixes: change
  the plan, or change the claim.

**Negative fixtures** (`claims_test.js`), each with a passing counterpart:

| say | plan | why it must fail |
|---|---|---|
| "sinks to 6 m" | `lower: 6`, no height condition | 6 is a rate, not a target height |
| "rains for 30 seconds" | `add_water` with `after: 30` | a delay, not a duration: it starts at 30 s and never ends |
| "the rain stops" | rain forever + a separate sink thread with a height bound | the limit is on the unrelated effect |
| "I can't bind keys, but the rain stops after 30 seconds" | rain forever | the affirmative clause is still checked |

### "What it does" lines

`explainPlan(clean)` lives in `world.js`, so the page and the server share it. Examples:

- *Once, now: lowers the ground 2 m along a path (40,10)→(60,30).*
- *Keeps going in a circle at (35,36) r 4: lowers the ground 0.25 m/s. Never stops on its own.*
- *Tool "Sink" (click, radius 4 to start): each use lowers the ground 0.25 m/s on each tile until water covers
  it, down to at most 1 m.*
- *Tool "Fire" (click, radius 2): each use sets fire, which spreads for 20 s beyond where you click; its later
  rules follow it.*
- *For the first 120 s after it lands, everywhere on soil, 10% chance per second: turns to fire.*

The same text goes back to the model in the `try_plan` and `commit` results.

---

## 3. Evals

**The claim checker isn't its own evidence (R2).** The old `honest` check is renamed `claims_check`. It's
regression coverage for the checker and doesn't count as proof that a message is true. Independent evidence
comes from **behaviour**: simulating and measuring the effect the case expects. Where a case needs a number
from `say`, `eval.js` extracts it with its own small regex, not with `checkClaims`.

New check types:

- `outcome_in: [...]`: committed, proposed, declined or answered
- `has_power`, optionally with a brush kind
- `quiet_until_used`: before any use, the use points haven't changed after 30 s (the old plan fails this)
- `power_use {at: [...points], expect}`: uses the power at each point and simulates 60 s. A control point must
  be unchanged. `expect` is set per point:

  | expect | passes when |
  |---|---|
  | `sinks` | the ground dropped at least `min_drop` |
  | `wet` | the area became wet |
  | `floor` | the ground stayed at or above the plan's height bound (or the height stated in `say`) − 0.75 m |

- `effect_ends {action}`: simulates past the claimed or planned end + 5 s, and checks that every thread doing
  that action shows zero activity in every use.
- `stays_burnt_out`: for fire-like tools. After the burn window, no tile anywhere in the use's reach still has
  the burning material, and tiles never reached are unchanged (R4).

Cases:

| case | whim | expected outcome | checks |
|---|---|---|---|
| **`double-click-sink`** | Jon's exact whim, at spot (35,36) r 4 | `proposed`, with double-click in `unsupported` | `has_power`, `quiet_until_used`, `power_use` at three seed-7 points: a shoreline where water reaches (`sinks`, `wet`), one beside water lower than the plan's height bound (`sinks`), one behind a ridge (`sinks`, `floor`). The points get picked from the map during the build. |
| **`key-binding`** | "When I press the R key, make it rain on the spot under my mouse." | proposed or declined, never committed | a proposal gets full credit if its plan has a power whose use adds water |
| **`rain-cloud-tool`** | "a rain cloud tool: click to make it rain there for 10 seconds" | committed | `has_power`, `quiet_until_used`, a use adds water, `effect_ends add_water` |
| `wildfire` (changed) | as before | **proposed** (days) | its existing plan checks, run on the proposed plan |

Plus `claims_check` on the new cases, as regression coverage.

**Engine tests, no model (`world_test.js` / `claims_test.js`):**

- **Undo (R3):** overlap (10 → +4 → +3, erase A → 13), sink-then-undo, repeat-then-undo-then-erase. Each is
  checked again through save/load and rewind.
- **Fire reach (R4):** fire next to the brush edge, run past its window: burnt out everywhere it reached.
- **Lifecycle (R5):**
  - an `after: 10` use is pending at 2 s and acting at 12 s
  - Sink holding at its bound, then raised: it acts again
  - a `within` use across Switch off/on: its clock keeps running
  - the 25th live use is refused
- **Routing (R1)** and the **claims fixtures (R2)** from section 2.

Run the full eval suite before (baseline done: 9/10, 24/27, 25.8 s per whim) and after.

---

## Build order (adopting the review's sequence)

1. **Outcomes and truth:**
   - `commit` / `propose` / `decline`, and request-side routing
   - `explainPlan` as the authoritative "What it does" on cards
   - typed `checkClaims` with its fixtures
   - the `double-click-sink` and `key-binding` cases. In this slice, a proposal for double-click is judged on
     its outcome and its claims only; its power checks switch on in slice 2.
2. **Engine contract, then a small palette:**
   - delta-based change records for all skeins, with the undo tests
   - powers (circle brush only), use ids, lifecycle, reach and per-use timing
   - the palette with Spot, size and Undo use
   - try out a hill tool, a timed rain tool and Sink until wet
   - the `rain-cloud-tool` case
3. **Strokes and lifecycle edges:**
   - stroke brushes; overlap, delayed and persistence tests
   - `replaces`, Remove tool, the visible cap, palette overflow, sanitizing, idea pills
4. **Full eval suite, then a browser playtest on `?seed=7`** with several tools together in one evolving world.
   Fix what it turns up.

## Decisions

1. No gesture bindings: powers are tools picked from the palette.
2. Size is a palette control shared by every circle tool. A click only places, and dragging is only for strokes.
3. The palette has two groups: built-in World tools, and tools that whims made.
4. Icons are a single emoji chosen by the model, with initials as the fallback.
5. Undo and Erase are delta-based for all skeins and don't replay the world. Rewind remains the exact one.
6. A use's lingering threads run on its reach (footprint plus tiles it painted). No containment is promised.
7. Height and water limits mean "holding", not "done". Only expired and undone uses are pruned.
8. Whether a whim is committed or proposed is decided from the request and the plan, never from the prose
   alone. Days and hours go through a proposal.

## Review findings and where they're answered

| finding | answer |
|---|---|
| R1 route from the request | `requestNeeds` + `routeOutcome`. The double-click fixture is proposed even with a clean click plan and no admission. A plain click-tool request still commits. |
| R2 claims matched to effect | `explainPlan` is the authoritative description. Typed claims (target height, delta, rate, duration, delay, recurrence, ending) are matched to the threads doing that action. Denials exempt only their own clause. The four negative fixtures are listed. `claims_check` is regression coverage only, with behavioural checks as the evidence. |
| R3 undo semantics | Delta-based records for height and material, for every skein and use, covering thread-driven changes. A compare-before-restore rule for materials. "Doesn't replay the world" is stated in the UI. History and size bounds are explicit, and records are stripped from model requests. |
| R4 brush vs reach | The brush is the origin. Lingering threads run on the reach (footprint plus painted tiles), so burn-out follows the fire. Travel is disclosed, and no containment is promised. The `stays_burnt_out` check. |
| R5 lifecycle | Pending, acting, waiting, holding, expired and undone. Pruning only when no future activity is possible. Feedback is read from the state. Clocks keep running while switched off. The cap refuses instead of pruning. |
| R6 fixed height vs water arrival | "Lower toward 6 m" and "Sink until wet" are kept distinct, each with an accurate description. The eval uses the tool at three points, including a ridge. |
