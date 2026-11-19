# Review of Powers and Honest Whims

Reviewer: Codex  
Date: November 17, 2026 (America/Denver)  
Reviewed: [POWERS.md](POWERS.md), the 332-line proposal marked “Nothing here is built yet,” against the current engine and the observed playtest.

This is design feedback for Jon and Claude. The findings below describe gaps in the proposed contract, not defects in an implemented powers feature. No gameplay code was changed.

## Overall opinion

The visible tool palette is a strong direction. It gives the player a discoverable way to reuse an invention, makes the active interaction visible, and handles multiple powers much better than accumulating hidden gesture bindings. Keeping a power's definition separate from each use is also the right foundation. Per-use timing, explicit alternatives, and descriptions derived from the plan all address real playtest findings.

I would proceed after tightening the honesty and undo contracts. Those are central to trust in this feature. The present proposal also introduces enough UI and lifecycle behavior that I would implement and test it in small slices.

## Findings

### R1 — [P1] Route alternatives using the request, not only the model's explanation

**Location:** POWERS.md lines 248–255.

The proposed gate examines `unsupported` supplied by the model and admissions in its `say`. It never checks the original request. For the exact double-click request, the model can return a click power with `say: "Pick Sink and click to lower the ground"`, omit `unsupported`, and commit. Every described check passes, but the promised proposal/approval step is bypassed. Telling the model it can “remove that sentence” makes this failure particularly easy.

**Requested change:** Separate outcome routing from prose. Carry the requested interaction and recognized unsupported requirements into validation, and require a proposal when the implementation changes them. At minimum, the explicit unsupported input mechanisms covered by this design need a request-side check. Do not treat the absence of an admission as evidence that the whole request is supported.

**Acceptance check:** Submit the exact double-click whim with a valid click-power plan whose explanation mentions only clicking and whose `unsupported` list is empty. It must still be proposed rather than committed. A normal request for a click power must remain eligible for direct commit.

### R2 — [P1] Match claims to the relevant action, units, and time semantics

**Location:** POWERS.md lines 262–278; evaluation definition at line 300.

Searching for a matching number or condition anywhere in the plan admits false claims:

- “Sinks to 6 m” can match `lower: 6`, although that is a rate and supplies no target height.
- “Rains for 30 seconds” can match `after: 30`, which starts the rain after the delay and gives it no end.
- “The rain stops” can pass because an unrelated sinking thread has a height condition, while the rain thread runs forever.

Skipping an entire sentence containing a denial also skips claims in sentences such as “I can't bind keys, but the rain stops after 30 seconds.” Finally, defining the eval's `honest` result with the same checker reproduces its blind spots; it is useful regression coverage but not independent evidence of honesty.

**Requested change:** Make the plan-derived explanation authoritative for mechanical claims. If free-form claims remain, validate supported claim types against the specific effect they describe, with distinct meanings for target height, delta, rate, duration, delay, and recurrence. Keep unrecognized prose outside the guarantee rather than labeling it verified. Check affirmative clauses even when another clause admits a limitation.

**Acceptance checks:** Add the examples above as independent negative fixtures. For durations, simulate past the alleged end and inspect the relevant action's activity. Cover a multi-thread plan where only the unrelated effect has a limit.

### R3 — [P1] Define what undo restores for lingering and overlapping uses

**Location:** POWERS.md lines 67–85, 177–184, and decision 5 at line 332.

The design promises Undo last use and Erase, but the described recording path captures immediate edits. The flagship Sink power changes terrain through threads. In the current engine, erasing such a thread stops it without restoring the terrain it already lowered. A per-use record needs an explicit rule for those subsequent mutations.

Overlap is a separate part of the same undo contract. Current erase restores before-values. Starting at height 10, apply A (+4), then B (+3), then erase A: the result is 10 while B's skein still exists. Reusing that mechanism for powers would erase later work in the same area. Capturing more before-values alone does not resolve this.

**Requested change:** Specify the semantics of canceling a use, undoing its direct edits, erasing a whole tool's history, and rewinding simulation consequences. Decide what happens to later overlapping uses and world evolution. A limited undo contract can be acceptable if the UI states it accurately; exact reversal of an arbitrary past use requires more than restoring its old cell values.

**Acceptance checks:** Use Sink, allow it to lower terrain, then undo. Use two tools on the same tile and erase the older tool. Repeat uses of one tool on a tile, undo the latest, then erase the remaining tool. Assert the chosen behavior and preserve it through save/load and rewind.

### R4 — [P2] Distinguish a brush's execution area from the reach of its effects

**Location:** POWERS.md lines 48–51 and the Fire starter example at line 148.

The claim that the model cannot place a power's effect outside the chosen brush is stronger than the existing engine supports. `spread` writes to neighboring cells outside its thread's area. The thread itself continues executing only on the original area. This matters for fire: boundary cells painted as fire can remain outside the area covered by an ash-conversion thread. Adding `within` stops actions; it does not remove the material they painted.

**Requested change:** Define the brush as the origin/execution footprint and disclose propagation, or explicitly constrain outgoing writes. If fire is advertised as spreading and burning out, specify how the entire affected region gets the cleanup behavior. Do not promise containment or complete burnout solely from the current area and time conditions.

**Acceptance check:** Use fire next to the brush boundary, run beyond its burn duration, and inspect all cells it reached, including neighbors outside the initial footprint. Separately verify any explicit containment guarantee.

### R5 — [P2] Represent delayed, dormant, and expired uses separately

**Location:** POWERS.md lines 71–85, 118–121, and the two-second feedback rule at line 179.

A supported `after: 10` power legitimately does nothing for its first two seconds. A rain-dependent or probabilistic rule may also be temporarily inactive. The proposed “nothing happened here” message would describe these valid uses as failures unless it accounts for their schedule and conditions.

Likewise, `height > 6` is a continuing condition, not a permanent completion marker. Once a sinking thread becomes inactive at 6 m, another power can raise that ground and reactivate it. This affects the meaning of “stopped,” the active-use count, map markers, and pruning.

**Requested change:** Specify lifecycle states such as pending, eligible but currently inactive, acting, expired, and canceled. Only prune when future activity is impossible under the chosen semantics. Use messages such as “starts in 8 seconds” or “waiting for rain” when those are the reason for inactivity. If reaching a target should complete a use permanently, introduce that behavior explicitly.

**Acceptance checks:** Observe an `after: 10` use at two seconds and after ten seconds. Let Sink settle, raise the same ground, and verify the documented reactivation/completion behavior. Check time-based uses across Switch off/on as well: does their clock continue or pause?

### R6 — [P2] A fixed height is not a reusable “sink to water” operation

**Location:** POWERS.md lines 25–31 and the “Sink to water” example at line 144.

Lowering to an absolute 6 m does not guarantee that water reaches a new click location. A nearby lake can have a lower surface or be separated by terrain. A successful preview at one shoreline demonstrates that use, not the behavior everywhere the player later uses the tool. The example currently promises that the lake floods in.

**Requested change:** Name and describe this version as “Lower toward 6 m,” with water arrival conditional on the surrounding terrain and water. If the intended tool is genuinely “sink until water arrives,” specify use-time sensing and stopping behavior, or propose that as a capability beyond this round. Keep those two promises distinct.

**Acceptance check:** Use the same tool near water surfaces above and below 6 m, and behind a separating ridge. Either satisfy the stronger water-arrival behavior or explain the narrower fixed-height behavior accurately.

## Evidence gathered

Four small probes ran directly against the current `game/world.js`, on isolated in-memory worlds with nature disabled. They did not use the local language model, touch the running game, or save world changes:

| Probe | Observed result |
|---|---|
| Overlapping edits: 10 → +4 → +3, erase the earlier edit | Height went from 17 back to 10; the later skein remained present. |
| Sink from 10 with `height > 6`, then erase | Height reached approximately 5.975 and stayed there after erase. |
| Spread fire from a radius-1 circle for one second; inspect after three seconds | The execution footprint contained 5 tiles; 13 additional tiles outside it were fire. Expiration did not remove the material. |
| Let a height-limited Sink settle, then raise that area | Activity went from 0 tiles back to 5 tiles. |

Relevant implementation: `applyEdits` and `eraseSkein` in [world.js](../game/world.js), `compileAction` for spread/lowering, and `compileCond` for height and time conditions. These probes establish current behavior; they do not imply that powers have already been implemented.

## Suggested implementation sequence

1. Add explicit outcomes, authoritative plan explanations, and the original double-click regression. Keep ordinary supported requests direct and reserve proposals for actual substitutions.
2. Build a small playable palette with a hill tool, a timed rain tool, and a precisely described sinking tool. Include the chosen undo contract and per-use timing from the start.
3. Add stroke tools and exercise overlap, persistence, and delayed-use cases before expanding replacement/removal behavior.

Resolve the data model before adding more controls: stable power/use identities, how replacements preserve old uses, and how undo history is retained separately from active-use pruning. Bound undo history explicitly; a cap on lingering uses does not bound instant-edit history or the size of saved snapshots and whim requests.

The key product test remains whether making a power leads to satisfying repeated play and interactions with earlier whims. A polished palette alone will not establish that; the next playtest should exercise the new tools together in one evolving world.

## Follow-up on the revised proposal

November 17, 2026. Bounded pass requested by Jon while Claude starts slice 1; this is not a new review of the entire design.

The revised request-side routing, authoritative plan descriptions, typed claims, and independent behavioral checks address the main direction of R1 and R2. I see no reason to delay starting slice 1 for another broad design round. This is a design assessment, not verification of the forthcoming implementation.

**One slice-1 parsing trap to cover:** in POWERS.md's typed-claims table, the delay example is “after 10 seconds,” but the existing fixture also contains “the rain stops after 30 seconds.” The latter refers to an ending, not a delayed start. A correct rain thread with `within: 30` and no `after` must pass that claim. Requiring `after: 30` as well would reject the correct plan and can encourage a thread whose start and end coincide.

Add the positive counterpart explicitly: “I can't bind keys, but the rain stops after 30 seconds” + rain with `within: 30` passes; rain with only `after: 30` fails. Route the admission to a proposal independently. This belongs in the existing claim fixtures and does not require a wider redesign.

Further review should target the completed slice and observed failures, rather than expanding the proposal now.
