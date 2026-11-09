---
name: verify-subagent-dialog-relay
description: "Model-check the subagent dialog relay and parent dialog FIFO with TLA+. Use before finishing any change to extensions/subagent/dialog-relay.ts, dialog-queue.ts, the relay lines in runner.ts, or the queueDialogs/relayDialogs wiring in index.ts and child.ts, or when a relayed child dialog hangs, stays on the parent screen, or blocks later parent dialogs."
---

# Verify: subagent dialog relay

## The promise

A child dialog that is no longer needed always leaves the parent screen, and a child never waits on a dialog that nobody can answer.

Harm if broken: the parent shows dialogs one at a time (FIFO), so one stuck relayed dialog blocks every later parent dialog, including the parent's own `ask` and permission prompts. A child that waits on an unanswerable dialog hangs its run until the tool aborts.

## Run

```sh
.agents/skills/verify-subagent-dialog-relay/check.sh
```

About 30 s. It uses mise to install Java (temurin 25) and TLC 1.7.4 (checksum-pinned) on first run, which needs network. Exit 0 means all three stages passed.

1. **Code anchors.** `model/anchors.tsv` maps each model action to code text that must appear exactly once (whitespace-insensitive). A miss prints `ANCHOR <action>: found N times in <file>`.
2. **Model.** TLC checks `model/DialogRelay.tla` with `model/DialogRelay.cfg`.
3. **Mutants.** Each broken variant must break its property. A `MISS` means the model can no longer fail, so a pass in stage 2 proves nothing.

## Properties (model/DialogRelay.tla)

| Property | Plain sentence |
| --- | --- |
| `OneParentDialog` | The parent shows at most one relayed or own dialog at a time. |
| `NoCopyAfterClose` | After the parent sees a relay socket close, that request's dialog is neither shown nor queued. |
| `ParentCopyGoesAway` | Once the child settles a request (or dies), its parent copy leaves the screen and queue for good, without the user answering it. |
| `NeverWaitsOnUnanswerable` | If the parent has no UI or is aborting while a child waits, the child settles (denies) or exits. |

Mutants and the code each one stands for:

| Flag | Code it removes | Must break |
| --- | --- | --- |
| `BugNoAbortOnClose` | `controller.abort()` in the parent `socket.on("close")` handler, `startDialogRelay` | `NoCopyAfterClose`, `ParentCopyGoesAway` |
| `BugFifoNoHold` | `await result` in `queueDialogs` `enqueue` (next dialog opens before the previous settles) | `OneParentDialog` |
| `BugChildIgnoresClose` | `finish(deny, ...)` in the child `socket.on("close")` handler, `relayDialogs` `ask` | `NeverWaitsOnUnanswerable` |

## Coverage

Sync commit: `1103ff13465ed16374df262d3d34c0514431c06c` (last commit at which this model was confirmed to describe the code).

| Code | Model |
| --- | --- |
| `extensions/subagent/dialog-relay.ts` `startDialogRelay`: connection handler, `lineReader` callback, `show().then`, socket `close`, `close()` | `Accept`, `Refuse`, `ParentReads`, `ParentUserAnswers`, `ParentSocketCloses`, `ToolAborts`, `RelayCloses` |
| `extensions/subagent/dialog-relay.ts` `relayDialogs` `ask`, `finish` | `ChildAsks`, `Finish`, `ChildUserAnswers`, `ChildCallerAborts`, `ChildReads`, `ChildSocketCloses` |
| `extensions/subagent/dialog-queue.ts` `queueDialogs` `enqueue` | `Enqueue`, `Advance`, `AbortDialogs` |
| `extensions/subagent/runner.ts` `startDialogRelay(...)` call, `await relay?.close()` | `ui`, `ToolAborts`, `RelayCloses` |
| `extensions/subagent/index.ts` `queueDialogs(ctx.ui)`; `extensions/subagent/child.ts` `relayDialogs(ctx.ui, ...)` | wiring assumed by every action |
| Pi `showExtensionSelector`/`showExtensionInput` (pi-coding-agent 1.5.0): abort closes the dialog | `AbortDialogs` |

To see if covered code moved since the sync commit:

```sh
git diff --stat 1103ff13465ed16374df262d3d34c0514431c06c..HEAD -- extensions/subagent/dialog-relay.ts extensions/subagent/dialog-queue.ts extensions/subagent/runner.ts extensions/subagent/index.ts extensions/subagent/child.ts
```

## Bounds and assumptions

- Two relayed requests, each on its own socket (the code opens one connection per dialog), plus one parent-own dialog. One child process. Checked: 235,744 distinct states, depth 26.
- One model step is one Node macrotask plus all its microtasks. This is why `RelayCloses` sends no deny: `close()` destroys every socket before the `show().then` microtasks run.
- Socket streams are ordered; `allowHalfOpen` is false (Node default), so reading the peer's end also ends our side.
- Fairness covers only sockets and Node handlers. Users may never answer, aborts and crashes may never happen.
- Not covered: message validation and length limits (`parseChildMessage`, `parseAnswer`, `lineReader` over-long lines; tested in `dialog-relay.test.ts`); which answer value is returned; `select`/`input`/`confirm` differences; `editor` and `custom` (never relayed; `overlay: true` bypasses the FIFO); a dialog opened from inside an inline `custom` (README says it waits forever by design); the scheduler and tmux lifecycle; more than two requests.

## When it fails

Read every TLC result with the `/statechart` skill: it turns a violation into its shortest path in plain words, and a pass into a chart of the states. Copy the model into a scratch folder first.

- **ANCHOR miss.** The code an action models changed. Open the file at the anchor. If the change is a rename or reformat with the same behavior, update the anchor text. If the behavior changed, update the matching action in `DialogRelay.tla`, then the anchor. If you cannot tell, set the closest mutant flag to `TRUE` in a scratch copy of the cfg: if it reproduces the new behavior and breaks a property, the change is a real bug.
- **Stage 2 violation.** Get the path with `/statechart`, then replay it against the code, action by action, using the Coverage table. If every step matches code that can run in that order, it is a real bug: report the path in code terms (which socket event, which handler) and do not change the property. If a step cannot happen in the code (for example the model lets two handlers interleave inside one microtask chain), it is a modeling error: fix the action, and say so in the change.
- **MISS.** A model edit made a property unable to fail. Undo it or move the guard it hid.

## After an intended change

1. Change the matching action in `DialogRelay.tla` so it still says what the code does. Keep one action per Node callback.
2. Update `model/anchors.tsv` and the Coverage table.
3. If you add a guard, add a mutant flag that removes it, and a row in `check.sh` and the mutant table.
4. Run `check.sh` to exit 0.
5. Move the sync commit (here and in the `git diff` command) to the new commit only after you have read each covered function at that commit and confirmed the model describes it.

For drift found later (merges, rebases, refactors made without this skill), use `/maintain-formal-verification-skill`.
