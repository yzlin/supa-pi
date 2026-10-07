# Subagent

Repo-owned, blocking delegation through a fresh interactive Pi process in tmux.
Adapted from [mitsuhiko/agent-stuff's subagent extension](https://github.com/mitsuhiko/agent-stuff/blob/d265b8ef32f896d3ef3bc6a45bd7b8e0d02150e0/extensions/subagent.ts)
at `d265b8ef32f896d3ef3bc6a45bd7b8e0d02150e0` (Armin Ronacher).
The full Apache-2.0 license and attribution/modification notice are retained in
[`LICENSE.upstream`](LICENSE.upstream)
and [`NOTICE`](NOTICE). This adapted runtime
and its SupaPi additions do not change the repository's root MIT license.

## Tool

```json
{"task":"Inspect the assigned changes and report evidence.","agent":"explorer"}
```

`subagent({task, agent?, cwd?, provider?, model?, thinking?, schema?})` waits for one
child. `agent` is optional; omission selects generic delegation, not a fallback
for an invalid named role. Calls share **four active slots per native parent
session across all consumers**. Further calls queue. The native tool declares
`executionMode: "parallel"`; tools and programmatic consumers use the same pool.

A schema-bound call supplies an inline JSON Schema object. `StructuredOutput` is
available only for that call, including roles with `tools: none`. Native Pi
argument validation returns feedback for invalid submissions. If the child
finishes normally without a valid report, one final correction requests the
report. A second omission fails. Errors, abortion, and unavailable role tools
never trigger this correction. Capturing shape does not establish task success
or authorize semantic repair.

The tool has `outputSchema` and returns native `structuredContent`:

```ts
{
  runId, agent?, provider, model, thinking,
  output, structuredOutput?, resultPath, sessionFile
}
```

Text is capped using Pi's 50 KB / 2,000-line limits. The complete text and report
remain in `resultPath`; `sessionFile` holds the full fresh native child session.
Failed calls throw an error with an evidence-directory path. Live updates show
pane text and a copyable `pi --attach-subagent <run-id>` command. Finished,
failed, and aborted tmux sessions/private sockets are closed, not resumable.

## Human attachment

While a child runs, copy its printed command into another terminal:

```sh
pi --attach-subagent <run-id>
```

`--attach-subagent=<run-id>` also works. The installed Pi must load this Extension
and use the same `PI_CODING_AGENT_DIR` as the parent (default `~/.pi/agent`). The
wrapper searches exact run IDs across parent-hash evidence directories, reads
private `attach.json`, and verifies the owned socket and live tmux pane. It
inherits stdin/stdout/stderr and exits with tmux's exit code, without opening a
parent Pi session/TUI. Within the same tmux server it switches clients; otherwise
it attaches with `TMUX`/`TMUX_PANE` unset to avoid nested-server interference.
Detach normally with tmux's `Ctrl+B`, then `D`; this leaves the child running.

Missing/invalid values, ambiguous/unsafe metadata, and finished or stale children
fail clearly. `--` ends flag parsing. This is human CLI only: no new agent tool,
resume API, shared server, global registry, or legacy attachment ID is provided.

## Extension-local runner

The runner, role discovery, settings, protocol, and scheduler live beside this
extension. They are implementation details, not a shared cross-extension API.
Within this extension:

```ts
import { runSubagent, cancelSessionSubagents } from "./runner";
const result = await runSubagent(pi, ctx, params, {signal, onUpdate});
```

`onUpdate` receives `{runId, status: "queued" | "running", text, attachCommand?}`.
`signal` is combined with the native context's current signal. A tool abort stops
that owned job, including its queued launch; parent shutdown cancels all jobs
owned by that parent session and awaits their cleanup. Direct API users must wire
`cancelSessionSubagents(sessionId)` into their own shutdown owner. Completed
cancellation permits fresh calls after a parent reload.

Other extensions use `ctx.executeTool("subagent", params, {signal, onUpdate})`,
not runner imports. This crosses native `tool_call` / `tool_result` hooks
(including profile refresh). Its return
is an `AgentToolCallOutcome`: check `isError`, then read
`outcome.result.structuredContent`. Direct helper calls do not fabricate native
tool events. Cancellation groups such as review should use their own signal;
whole-session cancellation is for the parent owner.

## Discovery and settings

- Trusted **parent** workspace `.pi/agents/*.md` takes precedence over
  `getAgentDir()/agents/*.md`, by frontmatter `name` or basename when omitted.
  A child `cwd` override does not change this discovery root.
- Unknown, ambiguous, malformed, unreadable, escaped, or untrusted named roles
  fail closed; no global/generic fallback replaces a blocked project role.
  Unindexable role files block discovery because their shadow names cannot be
  established safely. Project role files must stay inside the real project
  `.pi/agents` directory. Global setup-style repo symlinks are allowed.
- Strict controls: `model: provider/model`, supported `thinking`, `tools` as
  `none`, `*` (quoted or bare), comma-separated names, or a YAML list;
  `disallowed_tools` as a comma list or YAML list; `extensions` and `skills` as
  booleans or lists of **local paths relative to the real role file**; boolean
  `caveman`; string `name`/`description`. Project resource paths/symlinks must
  stay inside the trusted parent workspace. Global repo symlinks remain valid.
- Explicit call choices override the definition, then parent defaults. The
  selected model must exist, have configured auth, and be within parent model
  scope. Parent-only provider registrations are not serialized: permitted
  child resources must independently supply the selected provider/model.
- The role body is system instruction text. Only the task is fresh user input;
  no parent conversation or saved child conversation is imported. Normal
  workspace guidance remains. Only descendants of a trusted parent inherit
  its workspace approval; other child workspaces receive no new approval.
- Allowed/denied tools are enforced through `tool_call`, including native nested
  calls, not only the declared active set. Delegation and legacy Task* tools are
  never permitted in children. Internal reporting remains available even when
  extensions are disabled. These controls are **not an OS/filesystem sandbox**.

## Process/resource boundary

Requires tmux, Pi 1.0.1+, and the complete repo checkout. Generic/ordinary children
use the parent runtime's Pi CLI, located through Pi's public `getPackageDir()`
API, not the checkout's independently pinned development dependency. Updating
the parent Pi installation therefore updates ordinary CLI children too. Roles
that explicitly disable or select skills use an interactive public-SDK Pi host
from the checkout's Pi dependency, requiring `bun` on PATH: its resource-loader
`skillsOverride` keeps the catalog disabled/selected even if extensions try to
add resource paths. This host supplies public codemode/MCP/tool-search built-ins
when permitted; it does not activate native llama.cpp management. Explicit
extension lists disable implicit extension discovery. `extensions: false`
loads only the internal reporter/policy. Missing resources or providers fail,
never widen resources or change model to compensate.

Each run owns a clean-config tmux server on a short socket path in a freshly
created mode-0700 temporary directory. The launcher uses shell quoting, a short
launcher-file command, and `umask 077`. The launcher replaces the pane shell with
`exec`, so a child exit without a report fails instead of leaving a live shell.
Task/config/result/session evidence lives
under `getAgentDir()/subagents/<parent-id-hash>/<run-id>/`, with directories 0700
and files 0600. Parent checks run/parent/schema/agent/model/thinking metadata,
report schema, result permissions, and native session header/path. Evidence
files over 16 MiB fail closed. Startup without readiness times out after 30 s;
normal tasks have no runner-imposed execution deadline. There is no background
API, workflow DSL, old-tool alias, task dashboard, conversation resume, or old
state import.

## Intermediate data and retention

Storage uses the configured Pi agent directory, not the checkout or the newest
temporary directory:

```text
getAgentDir()/subagents/
  <sha256(parent-session-id).hex.slice(0,24)>/
    <run-id>/                    # UUID; private retained evidence
      task.md                   # self-contained child task
      config.json               # role/resources, settings, report binding
      launch.sh                 # quoted child invocation
      attach.json               # run ID, private socket, tmux session
      session/                  # full native child session JSONL
      ready.json                # startup readiness, when reached
      result.json               # complete output/report, when reported
      startup-error.json        # startup failure, when emitted
      failure.json              # parent-observed failure/abort, when present
$TMPDIR/pi-sa-<random>/s          # one private live tmux socket per run
```

Evidence directories are 0700 and files are 0600. Attachment checks ownership,
permissions, regular files, symlink boundaries, and the exact run/session binding;
lookup does not use recency. `attach.json` stays as evidence after completion,
but cannot reopen a finished child. The server and temporary socket directory are
removed on completion, failure, or abort; retained evidence has no automatic
pruning. You may remove old run directories once their evidence is no longer
needed. Tests can add fixture-only evidence such as `child-pid.json`.

Task, config, output, and sessions can contain private workspace data. They are
intermediate local evidence, not a public journal, and are not imported for
automatic child recovery. Unexpected parent-process death can leave stale socket
metadata; attachment rejects targets that are no longer live.

Children share the checkout. Parallel writes require disjoint scopes and
verified prerequisites. Cancellation does not undo writes or guarantee stopping
processes independently detached by a child. Evidence can contain task/workspace
content: keep it private and do not publish raw sessions as verification.

## Validation

```sh
bun test extensions/subagent
bun test extensions/subagent/smoke.test.ts
bun run format extensions/subagent
bun run check
```

The smoke uses temporary `PI_CODING_AGENT_DIR`, `PI_OFFLINE=1`, and a native faux
provider, with no auth/network calls. It crosses actual tmux/Pi CLI and public-SDK
child boundaries, proves fresh task/role separation and final correction,
checks ordinary children use the parent Pi package/version, checks private
evidence/finished cleanup, detects a ready child exiting without a report, and
kills an actually started child on abort. It invokes the native attachment
CLI against launched children through a tmux wrapper that forwards live-target
checks but replaces interactive attachment, proving CLI dispatch without a TTY
block. Separate native CLI fixtures cover parsing, unsafe/malformed/ambiguous
metadata, stale/dead targets, inherited streams, tmux environment, and exit codes.
It does not activate live setup/settings, test paid models, or establish semantic
correctness of worker reports.
