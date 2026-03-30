import { executePlan } from "../extensions/execute/index.ts";

const DEFAULT_PLAN = [
  "inspect prompts/execute.md and summarize its role",
  "inspect .pi/agents/execute-step.md and summarize its role",
].join("\n");

const rawPlan = process.argv.slice(2).join(" ").trim() || DEFAULT_PLAN;
const sessionId = `execute-smoke-${Date.now()}`;
const messages: unknown[] = [];
const notifications: Array<{ message: string; level: string }> = [];
const statuses: Array<{ key: string; value: string }> = [];

// Force pi-lcm map-runner subprocesses to invoke the `pi` binary instead of
// recursively re-running this Bun script.
process.argv[1] = "";

await executePlan(
  {
    sendMessage(message: unknown) {
      messages.push(message);
    },
  } as never,
  rawPlan,
  {
    cwd: process.cwd(),
    sessionManager: {
      getSessionId: () => sessionId,
      getEntries: () => [],
      getBranch: () => [],
    },
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
      setStatus(key: string, value: string) {
        statuses.push({ key, value });
      },
    },
  } as never
);

console.log(
  JSON.stringify(
    {
      sessionId,
      plan: rawPlan,
      messages,
      notifications,
      statuses,
    },
    null,
    2
  )
);
