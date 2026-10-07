import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rmdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Apache-2.0 adaptation of mitsuhiko/agent-stuff, d265b8e. Modified for SupaPi: reusable bounded runner, trusted roles and validated evidence.
import {
  getAgentDir,
  getPackageDir,
  truncateHead,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { isRecord, loadAgent, resolveAgentResources, within } from "./agents";
import type { Thinking } from "./agents";
import {
  atomicJson,
  schemaHash,
  validateResult,
  validateSchema,
  type ChildConfig,
  type ChildResult,
} from "./protocol";
import type { JsonValue } from "./protocol";
import { checkAbort, withSessionSlot } from "./scheduler";
import { selectSettings } from "./settings";
export interface SubagentParams {
  task: string;
  agent?: string;
  cwd?: string;
  provider?: string;
  model?: string;
  thinking?: Thinking;
  schema?: Record<string, unknown>;
}
export interface SubagentResult {
  runId: string;
  agent?: string;
  provider: string;
  model: string;
  thinking: Thinking;
  output: string;
  structuredOutput?: JsonValue;
  resultPath: string;
  sessionFile?: string;
}
export interface SubagentUpdate {
  runId: string;
  status: "queued" | "running";
  text: string;
  attachCommand?: string;
}
export interface RunOptions {
  signal?: AbortSignal;
  onUpdate?: (update: SubagentUpdate) => void;
}
export type RunnerAPI = Pick<ExtensionAPI, "exec" | "getThinkingLevel">;
export type RunnerContext = Pick<
  ExtensionContext,
  "cwd" | "model" | "isProjectTrusted" | "scopedModels"
> & {
  signal?: AbortSignal;
  sessionManager: Pick<ExtensionContext["sessionManager"], "getSessionId">;
  modelRegistry: Pick<
    ExtensionContext["modelRegistry"],
    "find" | "hasConfiguredAuth"
  >;
};
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
const bootstrap = fileURLToPath(new URL("./child.ts", import.meta.url));
async function ownerDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await lstat(directory)).isSymbolicLink()) {
    throw new Error("Subagent evidence directory must not be a symlink");
  }
  await chmod(directory, 0o700);
}
async function removeSocket(socket: string, directory: string): Promise<void> {
  try {
    await unlink(socket);
  } catch (error) {
    if (!isRecord(error) || error.code !== "ENOENT") {
      throw error;
    }
  }
  await rmdir(directory);
}
async function delay(signal: AbortSignal): Promise<void> {
  checkAbort(signal);
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new Error("Subagent aborted."));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, 500);
    signal.addEventListener("abort", abort, { once: true });
  });
}
async function privateEvidence(file: string): Promise<void> {
  const info = await lstat(file);
  if (
    !info.isFile() ||
    info.mode % 512 !== 0o600 ||
    (process.getuid && info.uid !== process.getuid())
  ) {
    throw new Error(
      `Child evidence must be an owner-only regular file: ${file}`,
    );
  }
  if (info.size > 16 * 1024 * 1024) {
    throw new Error("Child evidence exceeds 16 MiB limit");
  }
}
async function validateSession(
  file: string,
  directory: string,
  config: ChildConfig,
): Promise<void> {
  await privateEvidence(file);
  if (!within(await realpath(directory), await realpath(file))) {
    throw new Error("Child session path escaped evidence directory");
  }
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const first = buffer.toString("utf8", 0, bytesRead).split("\n", 1)[0];
    const header: unknown = JSON.parse(first);
    if (
      !isRecord(header) ||
      header.type !== "session" ||
      header.id !== config.runId ||
      header.cwd !== config.cwd
    ) {
      throw new Error("Mismatched child session header");
    }
  } finally {
    await handle.close();
  }
}
async function readResult(
  file: string,
  config: ChildConfig,
): Promise<ReturnType<typeof validateResult> | undefined> {
  let text: string;
  try {
    await privateEvidence(file);
    text = await readFile(file, "utf8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  return validateResult(JSON.parse(text), config);
}
function resourceArgs(config: ChildConfig): string[] {
  const args: string[] = [];
  if (
    config.agent?.extensions === false ||
    Array.isArray(config.agent?.extensions)
  ) {
    args.push("--no-extensions");
  }
  if (Array.isArray(config.agent?.extensions)) {
    for (const resource of config.agent.extensions) {
      args.push(
        "--extension",
        path.resolve(path.dirname(config.agent.file), resource),
      );
    }
  }
  if (config.agent?.skills === false || Array.isArray(config.agent?.skills)) {
    args.push("--no-skills");
  }
  if (Array.isArray(config.agent?.skills)) {
    for (const resource of config.agent.skills) {
      args.push(
        "--skill",
        path.resolve(path.dirname(config.agent.file), resource),
      );
    }
  }
  return args;
}
export async function runSubagent(
  pi: RunnerAPI,
  ctx: RunnerContext,
  params: SubagentParams,
  options: RunOptions = {},
): Promise<SubagentResult> {
  if (typeof params.task !== "string" || !params.task.trim()) {
    throw new Error("Subagent task must not be empty.");
  }
  if (params.schema !== undefined) {
    validateSchema(params.schema);
  }
  const runId = randomUUID();
  const parentSessionId = ctx.sessionManager.getSessionId();
  return withSessionSlot(
    parentSessionId,
    options.signal && ctx.signal
      ? AbortSignal.any([options.signal, ctx.signal])
      : (options.signal ?? ctx.signal),
    () =>
      options.onUpdate?.({
        runId,
        status: "queued",
        text: "Waiting for a parent subagent slot (maximum four).",
      }),
    async (signal) => {
      const agent =
        params.agent === undefined
          ? undefined
          : await resolveAgentResources(
              await loadAgent(
                params.agent,
                ctx.cwd,
                path.join(getAgentDir(), "agents"),
                ctx.isProjectTrusted(),
              ),
              ctx.cwd,
            );
      const selection = selectSettings(pi, ctx, params, agent);
      const cwd = await realpath(path.resolve(ctx.cwd, params.cwd ?? "."));
      if (!(await stat(cwd)).isDirectory()) {
        throw new Error("Subagent cwd is not a directory");
      }
      const trusted =
        ctx.isProjectTrusted() && within(await realpath(ctx.cwd), cwd);
      const config: ChildConfig = {
        version: 1,
        runId,
        parentSessionId,
        cwd,
        ...selection,
        trusted,
        agent,
        schema: params.schema,
        schemaHash: schemaHash(params.schema),
      };
      const root = path.join(getAgentDir(), "subagents");
      await ownerDirectory(root);
      const parentDirectory = path.join(
        root,
        createHash("sha256").update(parentSessionId).digest("hex").slice(0, 24),
      );
      await ownerDirectory(parentDirectory);
      const runDirectory = path.join(parentDirectory, runId);
      await ownerDirectory(runDirectory);
      const sessionDirectory = path.join(runDirectory, "session");
      await ownerDirectory(sessionDirectory);
      const resultPath = path.join(runDirectory, "result.json");
      const configPath = path.join(runDirectory, "config.json");
      const taskPath = path.join(runDirectory, "task.md");
      await atomicJson(configPath, config);
      await writeFile(taskPath, params.task, { mode: 0o600 });
      const socketDirectory = await mkdtemp(path.join(tmpdir(), "pi-sa-"));
      await chmod(socketDirectory, 0o700);
      const socket = path.join(socketDirectory, "s");
      const session = `pi-subagent-${runId}`;
      const target = `${session}:0.0`;
      const tmux = async (...args: string[]) =>
        pi.exec("tmux", ["-f", "/dev/null", "-S", socket, ...args], {
          timeout: 5000,
        });
      const requireTmux = async (...args: string[]) => {
        const result = await tmux(...args);
        if (result.code !== 0) {
          throw new Error(
            result.stderr.trim() ||
              result.stdout.trim() ||
              "tmux command failed",
          );
        }
        return result;
      };
      const attachCommand = `pi --attach-subagent ${runId}`;
      const invocation =
        config.agent?.skills === false || Array.isArray(config.agent?.skills)
          ? [
              "bun",
              fileURLToPath(new URL("./host-entry.ts", import.meta.url)),
              getPackageDir(),
            ]
          : [
              process.execPath,
              path.join(getPackageDir(), "dist", "bundle", "cli.js"),
              "--provider",
              selection.provider,
              "--model",
              selection.model,
              "--thinking",
              selection.thinking,
              "--session-dir",
              sessionDirectory,
              "--session-id",
              runId,
              "--name",
              session,
              trusted ? "--approve" : "--no-approve",
              ...resourceArgs(config),
              "--extension",
              bootstrap,
              `@${taskPath}`,
            ];
      const launchScript = `umask 077; exec env SUPA_PI_SUBAGENT_CONFIG=${shellQuote(configPath)} ${invocation.map(shellQuote).join(" ")}`;
      const launchPath = path.join(runDirectory, "launch.sh");
      await writeFile(launchPath, `${launchScript}\n`, { mode: 0o600 });
      const command = `exec /bin/sh ${shellQuote(launchPath)}`;
      let created = false;
      let pane = "";
      const startedAt = Date.now();
      let reported: ChildResult | undefined;
      const kill = async () => {
        if (created) {
          await tmux("kill-session", "-t", session);
        }
      };
      const abort = () => {
        void kill();
      };
      signal.addEventListener("abort", abort, { once: true });
      try {
        checkAbort(signal);
        await requireTmux(
          "new-session",
          "-d",
          "-s",
          session,
          "-n",
          "pi",
          "-c",
          cwd,
          "/bin/sh",
          "-i",
        );
        created = true;
        checkAbort(signal);
        await requireTmux(
          "set-window-option",
          "-t",
          `${session}:0`,
          "remain-on-exit",
          "on",
        );
        await atomicJson(path.join(runDirectory, "attach.json"), {
          version: 1,
          runId,
          socket,
          session,
        });
        await requireTmux("send-keys", "-t", target, "-l", "--", command);
        await requireTmux("send-keys", "-t", target, "Enter");
        let ready = false;
        while (true) {
          checkAbort(signal);
          try {
            const startupError: unknown = JSON.parse(
              await readFile(
                path.join(runDirectory, "startup-error.json"),
                "utf8",
              ),
            );
            if (
              !isRecord(startupError) ||
              typeof startupError.error !== "string"
            ) {
              throw new Error("Malformed child startup error");
            }
            throw new Error(startupError.error);
          } catch (error) {
            if (!isRecord(error) || error.code !== "ENOENT") {
              throw error;
            }
          }
          const result = await readResult(resultPath, config);
          if (result) {
            reported = result;
            if (result.sessionFile) {
              await validateSession(
                result.sessionFile,
                sessionDirectory,
                config,
              );
            }
            if (result.status === "completed" && !result.sessionFile) {
              throw new Error("Missing saved child session");
            }
            if (result.status !== "completed") {
              throw new Error(result.error ?? "Subagent failed");
            }
            const text = truncateHead(result.output);
            return {
              runId,
              ...selection,
              agent: agent?.name,
              output:
                text.content +
                (text.truncated
                  ? `\n[Output capped. Complete evidence: ${resultPath}]`
                  : ""),
              structuredOutput: result.structuredOutput,
              resultPath,
              sessionFile: result.sessionFile,
            };
          }
          const capture = await requireTmux(
            "capture-pane",
            "-p",
            "-J",
            "-t",
            target,
          );
          pane = capture.stdout
            .replace(/\r/g, "")
            .split("\n")
            .slice(-18)
            .join("\n")
            .trim();
          options.onUpdate?.({
            runId,
            status: "running",
            text: pane,
            attachCommand,
          });
          checkAbort(signal);
          const dead = await requireTmux(
            "display-message",
            "-p",
            "-t",
            target,
            "#{pane_dead}",
          );
          if (dead.stdout.trim() === "1") {
            // A report is atomically renamed before shutdown; re-read after the pane observation to close the race.
            const final = await readResult(resultPath, config);
            if (!final) {
              throw new Error(`Child exited without reporting. ${pane}`);
            }
            continue;
          }
          if (!ready) {
            try {
              const raw: unknown = JSON.parse(
                await readFile(path.join(runDirectory, "ready.json"), "utf8"),
              );
              if (!isRecord(raw) || raw.runId !== runId) {
                throw new Error("Mismatched child readiness");
              }
              ready = true;
            } catch (error) {
              if (!isRecord(error) || error.code !== "ENOENT") {
                throw error;
              }
            }
            if (!ready && Date.now() - startedAt > 30_000) {
              throw new Error("Child startup timed out");
            }
          }
          await delay(signal);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await atomicJson(path.join(runDirectory, "failure.json"), {
          runId,
          parentSessionId,
          error: message,
          pane,
          reported,
          aborted: signal.aborted,
        });
        throw new Error(`${message}\nEvidence: ${runDirectory}`, {
          cause: error,
        });
      } finally {
        signal.removeEventListener("abort", abort);
        await kill();
        if (created) {
          await tmux("kill-server");
        }
        await removeSocket(socket, socketDirectory);
      }
    },
  );
}
export { cancelSessionSubagents } from "./scheduler";
