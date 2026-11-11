/**
 * Live check of the `tier` tool on the session that looped (01a1ca94).
 *
 * Usage: bun evals/tier-tool/live.ts <session.jsonl> [> log]
 *
 * Resumes the session after its 7th refused Spec write (line 214) on the
 * settings default model, with the workspace tier guard in place of the live
 * copy. Each tier-guard refusal already in the history is rewritten to what
 * the workspace guard says at that point, as if the session had run on it.
 * A sandbox hook after the guard skips every edit, write, or subagent
 * call the guard allows and blocks bash, so nothing is written. Stops after
 * the first allowed work call or 4 assistant messages. Costs one to four
 * model calls on a ~250k-token context.
 */

import { readFileSync } from "node:fs";

import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  getAgentDir,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

import tierGuard, {
  flatten,
  TIER_TOOL,
  tierRefusal,
} from "../../extensions/tier-guard";

const CUT = 214;
const CWD = "/Users/yzlin/dev/golfsavers/golfsavers-subsite";
const MAX_ASSISTANTS = 4;
const WORK = new Set(["edit", "write", "subagent"]);

const file = process.argv[2];
if (!file) {
  throw new Error("usage: bun evals/tier-tool/live.ts <session.jsonl>");
}
const entries = readFileSync(file, "utf8")
  .trim()
  .split("\n")
  .slice(0, CUT)
  .map((line) => JSON.parse(line) as Record<string, unknown>);

interface Message {
  role?: string;
  toolCallId?: string;
  content?: Record<string, unknown>[];
}
for (const [index, entry] of entries.entries()) {
  const message = entry.message as Message | undefined;
  if (
    message?.role !== "toolResult" ||
    !JSON.stringify(message.content).includes("Refused by the tier guard")
  ) {
    continue;
  }
  const before = entries.slice(0, index);
  const call = before
    .flatMap((e) => (e.message as Message | undefined)?.content ?? [])
    .find((part) => part.id === message.toolCallId);
  const reason = call
    ? tierRefusal(
        flatten(before),
        message.toolCallId ?? "",
        String(call.name),
        (call.arguments as Record<string, unknown>) ?? {},
        CWD,
      )
    : null;
  if (reason) {
    message.content = [{ type: "text", text: reason }];
  }
}
const resumeAt = flatten(entries).length;

let allowed = "";
const sandbox = (pi: ExtensionAPI) => {
  pi.on("tool_call", (event) => {
    if (WORK.has(event.toolName)) {
      const path = (event.input as { path?: unknown }).path;
      allowed ||= `${event.toolName} ${typeof path === "string" ? path : ""}`;
      return {
        block: true,
        reason: "Replay harness: the tier guard allowed this call; skipped.",
      };
    }
    if (event.toolName === "bash") {
      return { block: true, reason: "Replay harness: bash is disabled." };
    }
  });
};

const loader = new DefaultResourceLoader({
  cwd: CWD,
  agentDir: getAgentDir(),
  // Order matters: the guard's tool_call handler runs before the sandbox.
  extensionFactories: [tierGuard, sandbox],
  extensionsOverride: (base) => ({
    ...base,
    extensions: base.extensions.filter(
      (e) => !e.resolvedPath.endsWith("extensions/tier-guard.ts"),
    ),
  }),
});
await loader.reload();

const { session } = await createAgentSession({
  cwd: CWD,
  resourceLoader: loader,
  sessionManager: SessionManager.inMemory(CWD, undefined, entries as never),
});
// The SDK picks a model before extension providers register; apply the
// settings default now that they exist.
const settings = SettingsManager.create(CWD, getAgentDir());
const provider = settings.getDefaultProvider();
const modelId = settings.getDefaultModel();
const model =
  provider && modelId
    ? session.modelRuntime.getModel(provider, modelId)
    : undefined;
if (!model) {
  throw new Error(`settings default ${provider}/${modelId} is not registered`);
}
await session.setModel(model);
const registered = session.getAllTools().some((t) => t.name === TIER_TOOL);
console.log(`model: ${session.model?.provider}/${session.model?.id}`);
console.log(`tier tool registered: ${registered}`);
console.log(`resume after flattened item ${resumeAt}`);

let assistants = 0;
let cost = 0;
session.subscribe((event) => {
  if (event.type !== "message_end") {
    return;
  }
  const message = event.message as unknown as Record<string, unknown>;
  if (message.role === "assistant") {
    assistants++;
    cost += (message.usage as { cost?: { total?: number } })?.cost?.total ?? 0;
    for (const part of message.content as Record<string, unknown>[]) {
      if (part.type === "text") {
        console.log(`text: ${JSON.stringify(part.text)}`);
      } else if (part.type === "toolCall") {
        console.log(
          `call:${String(part.name)} ${JSON.stringify(part.arguments).slice(0, 160)}`,
        );
      } else {
        console.log(part.type);
      }
    }
    if (typeof message.errorMessage === "string") {
      console.log(`error: ${message.errorMessage.slice(0, 300)}`);
    }
  } else if (message.role === "toolResult") {
    const text = JSON.stringify(message.content);
    let mark = message.isError ? "ERR" : "ok";
    if (text.includes("Refused by the tier guard")) {
      mark = "GUARD-REFUSED";
    }
    console.log(
      `  result:${String(message.toolName)} ${mark} ${text.slice(0, 200)}`,
    );
  }
  if (allowed || assistants >= MAX_ASSISTANTS) {
    void session.abort();
  }
});

try {
  await session.agent.continue();
} catch (error) {
  console.log(`continue threw: ${String(error)}`);
}
session.dispose();
console.log(`cost: $${cost.toFixed(2)}`);
console.log(`RESULT guardAllowed=${JSON.stringify(allowed)}`);
process.exit(0);
