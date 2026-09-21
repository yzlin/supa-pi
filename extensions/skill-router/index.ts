import { createHash } from "node:crypto";

import {
  type ExtensionAPI,
  type ExtensionContext,
  formatSkillsForPrompt,
  type Skill,
  stripFrontmatter,
} from "@earendil-works/pi-coding-agent";

import { writeRecoveryCatalog } from "./catalog";
import { RouterConfigStore } from "./config";
import {
  classifyRoute,
  loadSelectedSkills,
  MAX_TEXT_BYTES,
  prepareRoute,
} from "./core";
import {
  type CredentialStatus,
  CredentialStore,
  type ResolvedCredential,
  resolveAgentDir,
} from "./credentials";
import {
  JEV_MODEL,
  type JevBatchResult,
  type JevCandidate,
  JevClient,
  JevError,
  ROUTING_DEADLINE_MS,
} from "./jev";
import { EXPLICIT_ONLY_SKILLS } from "./policy";
import { identifyCanonicalMessages } from "./runtime-helpers";
import { hiddenRouterInput } from "./ui";

interface ConfigStore {
  load(): Promise<boolean>;
  save(enabled: boolean): Promise<void>;
}
interface Store {
  status(): Promise<CredentialStatus>;
  resolve(): Promise<ResolvedCredential>;
  save(value: string): Promise<void>;
  clear(): Promise<void>;
}
interface Client {
  judgeBatch(
    candidates: readonly JevCandidate[],
    context: { currentRequest: string; recentText: string },
    signal?: AbortSignal
  ): Promise<JevBatchResult>;
  verify(signal?: AbortSignal): Promise<void>;
}
export interface SkillRouterDependencies {
  configStore?: ConfigStore;
  credentialStore?: Store;
  createClient?: (apiKey: string) => Client;
  readSecret?: (ctx: ExtensionContext) => Promise<string | undefined>;
  env?: Record<string, string | undefined>;
  agentDir?: string;
  /** Test seam; production always uses the fixed two-second deadline. */
  deadlineMs?: number;
}

interface CapturedInput {
  text: string;
  source: "interactive" | "rpc" | "extension";
  hasImages: boolean;
}
interface SelectedSkillDetails {
  name: string;
  path: string;
  baseDir: string;
  bodyHash: string;
}
interface SelectedDetails {
  version: 1;
  catalogPath: string;
  skills: SelectedSkillDetails[];
}

const ACTIONS = ["status", "login", "logout", "enable", "disable"] as const;
const PRINTABLE_KEY = /^[!-~]+$/;
const WORD_SEPARATOR = /[^a-z0-9-]+/u;
const BODY_HASH = /^[a-f0-9]{64}$/u;
const MAX_REQUESTS = 100;
const SELECTED_MESSAGE_TYPE = "skill-router-selected";
const FALLBACK_MESSAGE_TYPE = "skill-router-native-fallback";
const OVERSIZED_INPUT = "x".repeat(MAX_TEXT_BYTES + 1);

export function createSkillRouterExtension(
  dependencies: SkillRouterDependencies = {}
) {
  return (pi: ExtensionAPI): void => {
    const env = dependencies.env ?? process.env;
    const agentDir =
      dependencies.agentDir ?? resolveAgentDir(env.PI_CODING_AGENT_DIR);
    const configStore =
      dependencies.configStore ?? new RouterConfigStore({ agentDir, env });
    const credentialStore =
      dependencies.credentialStore ?? new CredentialStore({ agentDir, env });
    const createClient =
      dependencies.createClient ??
      ((apiKey: string) => new JevClient({ apiKey }));
    const readSecret = dependencies.readSecret ?? hiddenRouterInput;
    const deadlineMs = dependencies.deadlineMs ?? ROUTING_DEADLINE_MS;

    let generation = 0;
    let requests = 0;
    let lastFallback = "none";
    interface ProviderCustomMessage {
      role: "custom";
      customType: string;
      content: string;
      display: false;
      timestamp: number;
      details?: SelectedDetails;
    }
    interface AnchoredProjection {
      anchor: string;
      placement: "before" | "after";
      message: ProviderCustomMessage;
    }
    interface FrozenSelection {
      provenance: string;
      message: ProviderCustomMessage;
    }
    let activeCatalog: Skill[] | undefined;
    let currentInput: CapturedInput | undefined;
    let pendingPreparedUsers = 0;
    let frozenSelections: FrozenSelection[] = [];
    const projections: AnchoredProjection[] = [];
    const knownUsers = new Set<string>();
    const safeRawInputs = new Set<string>();
    const controllers = new Set<AbortController>();

    const cancelInflight = (reason = "skill router state changed") => {
      generation++;
      for (const controller of controllers) {
        controller.abort(new Error(reason));
      }
      controllers.clear();
    };
    const resetBoundary = () => {
      cancelInflight();
      currentInput = undefined;
      activeCatalog = undefined;
      pendingPreparedUsers = 0;
      frozenSelections = [];
      projections.length = 0;
      knownUsers.clear();
      safeRawInputs.clear();
    };
    const resetSession = () => {
      resetBoundary();
      requests = 0;
      lastFallback = "none";
    };
    const report = (
      ctx: ExtensionContext,
      message: string,
      level: "info" | "error"
    ) => {
      if (ctx.hasUI) {
        ctx.ui.notify(message, level);
      } else {
        pi.sendMessage(
          {
            customType: "skill-router-status",
            content: message,
            display: true,
          },
          { triggerTurn: false }
        );
      }
    };

    pi.on("session_start", resetSession);
    pi.on("session_shutdown", resetBoundary);
    pi.on("session_before_switch", resetBoundary);
    pi.on("session_before_fork", resetBoundary);
    pi.on("session_before_tree", resetBoundary);
    pi.on("session_tree", resetBoundary);
    pi.on("session_compact", () => {
      cancelInflight("skill router context compacted");
      safeRawInputs.clear();
    });
    pi.on("agent_settled", () => {
      currentInput = undefined;
      activeCatalog = undefined;
      pendingPreparedUsers = 0;
    });

    pi.on("input", (event) => {
      // Queued input belongs to the already-running operation. It must not
      // replace the raw input waiting for that operation's before hook.
      if (event.streamingBehavior === undefined) {
        currentInput = {
          text:
            Buffer.byteLength(event.text, "utf8") <= MAX_TEXT_BYTES
              ? event.text
              : OVERSIZED_INPUT,
          source: event.source,
          hasImages: Boolean(event.images?.length),
        };
      }
      return { action: "continue" };
    });

    pi.on("before_agent_start", async (event, ctx) => {
      // Consume first: empty catalogs and earlier forced-prompt handlers must
      // not leave stale raw input for a later request.
      const current = currentInput;
      currentInput = undefined;
      activeCatalog = undefined;
      pendingPreparedUsers = 0;
      frozenSelections = [];
      const effectiveSkills = [...(event.systemPromptOptions.skills ?? [])];
      if (effectiveSkills.length === 0) {
        return;
      }
      if (event.systemPromptOptions.forceSystemPrompt !== undefined) {
        lastFallback = "forced prompt";
        return;
      }
      if (
        !current ||
        current.source === "extension" ||
        current.hasImages ||
        isExplicitInvocation(current.text) ||
        mentionsExcludedSkill(current.text)
      ) {
        lastFallback = current
          ? "explicit or unsupported input"
          : "uncaptured input";
        return;
      }
      const operationGeneration = generation;
      const sessionId = ctx.sessionManager.getSessionId();
      const controller = new AbortController();
      controllers.add(controller);
      const timeout = setTimeout(
        () => controller.abort(new Error("routing deadline exceeded")),
        deadlineMs
      );
      const valid = () =>
        !controller.signal.aborted &&
        generation === operationGeneration &&
        ctx.sessionManager.getSessionId() === sessionId &&
        sameCatalog(effectiveSkills, event.systemPromptOptions.skills ?? []);
      const route = async () => {
        if (!((await configStore.load()) && valid())) {
          lastFallback = "disabled";
          return;
        }
        const credential = await credentialStore.resolve();
        if (!valid()) {
          return;
        }
        const prepared = prepareRoute({
          skills: effectiveSkills,
          currentRequest: current.text,
          recentText: buildRecentText(ctx, safeRawInputs, current.text),
        });
        if (!prepared.ok) {
          lastFallback = "invalid routing input";
          return;
        }
        if (requests >= MAX_REQUESTS) {
          lastFallback = "session request limit";
          return;
        }
        // Reserve one classified request before network work so concurrent
        // starts cannot exceed the cap. Candidate batching is not this budget.
        requests++;
        safeRawInputs.add(current.text);
        trimRawInputSet(safeRawInputs);
        const client = createClient(credential.apiKey);
        const result = await classifyRoute(
          prepared,
          (batch, context, signal) => client.judgeBatch(batch, context, signal),
          controller.signal
        );
        if (!valid()) {
          return;
        }
        if (result.kind === "fallback") {
          lastFallback = result.reason;
          return;
        }
        const loaded = await loadSelectedSkills(
          effectiveSkills,
          result.skills.map((skill) => skill.name)
        );
        if (!(loaded.ok && valid())) {
          lastFallback =
            "reason" in loaded ? loaded.reason : "stale routing result";
          return;
        }
        const catalogPath = await writeRecoveryCatalog(
          agentDir,
          effectiveSkills
        );
        if (!(valid() && (await configStore.load()) && valid())) {
          lastFallback = "disabled or stale";
          return;
        }
        const visibleProvenance = visibleSelectedProvenance(
          ctx,
          projections.map((projection) => projection.message)
        );
        const details: SelectedDetails = {
          version: 1,
          catalogPath,
          skills: [],
        };
        const blocks: string[] = [];
        const frozen: FrozenSelection[] = [];
        const recovery = `If new requirements emerge, use the existing read tool on the recovery catalog at ${catalogPath}.`;
        for (const item of loaded.skills) {
          const body = stripFrontmatter(item.body).trim();
          const skillDetails: SelectedSkillDetails = {
            name: item.skill.name,
            path: item.skill.filePath,
            baseDir: item.skill.baseDir,
            bodyHash: createHash("sha256").update(body).digest("hex"),
          };
          const block = formatSelectedSkill(item.skill, body);
          const provenance = selectedProvenance(skillDetails);
          frozen.push({
            provenance,
            message: {
              role: "custom",
              customType: SELECTED_MESSAGE_TYPE,
              content: `Selected skill instructions:\n\n${block}\n\n${recovery}`,
              display: false,
              details: {
                version: 1,
                catalogPath,
                skills: [skillDetails],
              },
              timestamp: Date.now(),
            },
          });
          if (visibleProvenance.has(provenance)) {
            continue;
          }
          details.skills.push(skillDetails);
          blocks.push(block);
        }
        if (!valid()) {
          return;
        }
        const content =
          blocks.length > 0
            ? `Selected skill instructions:\n\n${blocks.join("\n\n")}\n\n${recovery}`
            : `No additional skill body was selected for this request. ${recovery}`;
        // This is the only mutation point; every failure path above preserves options.
        event.systemPromptOptions.skills = [];
        activeCatalog = effectiveSkills;
        frozenSelections = frozen;
        rememberContextUsers(ctx, knownUsers);
        pendingPreparedUsers = 1;
        lastFallback = "none";
        return {
          message: {
            customType: SELECTED_MESSAGE_TYPE,
            content,
            display: false,
            details,
          },
        };
      };
      try {
        return await Promise.race([
          route(),
          new Promise<undefined>((resolve) => {
            controller.signal.addEventListener(
              "abort",
              () => {
                lastFallback = "routing timed out or cancelled";
                resolve(undefined);
              },
              { once: true }
            );
          }),
        ]);
      } catch {
        lastFallback = "routing failed";
        return;
      } finally {
        clearTimeout(timeout);
        controllers.delete(controller);
      }
    });

    pi.on("context", (event) => {
      if (
        !activeCatalog &&
        frozenSelections.length === 0 &&
        projections.length === 0
      ) {
        knownUsers.clear();
        return;
      }

      const canonical = event.messages;
      const identified = identifyCanonicalMessages(canonical);
      const users = identified.filter((message) => message.role === "user");
      const visibleUsers = new Set(users.map((user) => user.identity));
      for (const identity of knownUsers) {
        if (!visibleUsers.has(identity)) {
          knownUsers.delete(identity);
        }
      }
      const visibleAnchors = new Set(
        identified.map((message) => message.identity)
      );
      for (let index = projections.length - 1; index >= 0; index--) {
        if (!visibleAnchors.has(projections[index]?.anchor ?? "")) {
          projections.splice(index, 1);
        }
      }

      for (const user of users) {
        if (knownUsers.has(user.identity)) {
          continue;
        }
        knownUsers.add(user.identity);
        if (pendingPreparedUsers > 0) {
          pendingPreparedUsers--;
          continue;
        }
        if (activeCatalog) {
          projections.push({
            anchor: user.identity,
            placement: "before",
            message: {
              role: "custom",
              customType: FALLBACK_MESSAGE_TYPE,
              content: formatSkillsForPrompt(activeCatalog),
              display: false,
              timestamp: Date.now(),
            },
          });
        }
      }

      const visibleProvenance = selectedProvenanceInMessages([
        ...canonical,
        ...projections.map((projection) => projection.message),
      ]);
      const missingFrozen = frozenSelections.filter(
        (selection) => !visibleProvenance.has(selection.provenance)
      );
      const insertion = canonical[0]?.role === "system" ? 1 : 0;
      const anchorAtInsertion = identified.find(
        (message) => message.index === insertion
      );
      const lastAnchor = identified.at(-1);
      const selectedAnchor = anchorAtInsertion ?? lastAnchor;
      const unanchoredSelections: ProviderCustomMessage[] = [];
      for (const selection of missingFrozen) {
        if (selectedAnchor) {
          projections.push({
            anchor: selectedAnchor.identity,
            placement: anchorAtInsertion ? "before" : "after",
            message: selection.message,
          });
        } else {
          unanchoredSelections.push(selection.message);
        }
      }

      const projectionsByAnchor = new Map<
        string,
        { before: ProviderCustomMessage[]; after: ProviderCustomMessage[] }
      >();
      for (const projection of projections) {
        let anchored = projectionsByAnchor.get(projection.anchor);
        if (!anchored) {
          anchored = { before: [], after: [] };
          projectionsByAnchor.set(projection.anchor, anchored);
        }
        anchored[projection.placement].push(projection.message);
      }
      let messages: typeof event.messages = [];
      let changed = false;
      const identityByIndex = new Map(
        identified.map((message) => [message.index, message.identity])
      );
      for (const [index, message] of canonical.entries()) {
        const anchored = projectionsByAnchor.get(
          identityByIndex.get(index) ?? ""
        );
        if (anchored && anchored.before.length > 0) {
          messages.push(...anchored.before);
          changed = true;
        }
        messages.push(message);
        if (anchored && anchored.after.length > 0) {
          messages.push(...anchored.after);
          changed = true;
        }
      }
      if (unanchoredSelections.length > 0) {
        messages = [
          ...messages.slice(0, insertion),
          ...unanchoredSelections,
          ...messages.slice(insertion),
        ];
        changed = true;
      }
      return changed ? { messages } : undefined;
    });

    pi.registerCommand("skill-router", {
      description: "Manage skill-router authentication, consent, and status",
      getArgumentCompletions(prefix) {
        return ACTIONS.filter((action) => action.startsWith(prefix)).map(
          (action) => ({ value: action, label: action })
        );
      },
      handler: async (raw, ctx) => {
        const action = raw.trim() || "status";
        if (!ACTIONS.includes(action as (typeof ACTIONS)[number])) {
          report(
            ctx,
            "Usage: /skill-router [status|login|logout|enable|disable]",
            "error"
          );
          return;
        }
        try {
          if (action === "status") {
            const [enabled, status] = await Promise.all([
              configStore.load(),
              credentialStore.status(),
            ]);
            const reason = "reason" in status ? ` (${status.reason})` : "";
            const usability = status.usable ? "usable" : `unusable${reason}`;
            report(
              ctx,
              `Skill router ${enabled ? "enabled" : "disabled"}; credential=${status.source}:${usability}; requests=${requests}/${MAX_REQUESTS}; lastFallback=${lastFallback}; model=${JEV_MODEL}. No input is sent by this status command.`,
              "info"
            );
            return;
          }
          if (action === "disable") {
            cancelInflight();
            await configStore.save(false);
            report(ctx, "Skill router disabled globally.", "info");
            return;
          }
          if (action === "logout") {
            cancelInflight();
            await configStore.save(false);
            await credentialStore.clear();
            report(
              ctx,
              `Stored skill-router credential cleared; routing disabled.${env.TYPESAFE_API_KEY === undefined ? "" : " TYPESAFE_API_KEY remains and takes precedence."}`,
              "info"
            );
            return;
          }
          if (action === "enable") {
            const status = await credentialStore.status();
            if (!status.usable) {
              report(
                ctx,
                "Skill router needs a usable TypeSafe credential. Run /skill-router login or set TYPESAFE_API_KEY.",
                "error"
              );
              return;
            }
            if (!interactive(ctx)) {
              report(
                ctx,
                "Persistent enablement requires an interactive TUI.",
                "error"
              );
              return;
            }
            const confirmed = await ctx.ui.confirm(
              "Enable experimental paid skill routing?",
              "Skill names/descriptions plus bounded current and recent user/assistant text will leave this machine for charged TypeSafe judgments. Conversation may contain sensitive text. Filtering is source-based, not secret-proof; routing is experimental and uncalibrated. Enable for future sessions?"
            );
            if (!confirmed) {
              report(ctx, "Skill router remains disabled.", "info");
              return;
            }
            await configStore.save(true);
            report(ctx, "Skill router enabled globally.", "info");
            return;
          }
          const current = await credentialStore.status();
          if (current.source === "environment") {
            report(
              ctx,
              "TYPESAFE_API_KEY takes precedence; stored authentication was not changed.",
              "info"
            );
            return;
          }
          if (!interactive(ctx) || typeof ctx.ui.custom !== "function") {
            report(
              ctx,
              "Secure login requires an interactive TUI; set TYPESAFE_API_KEY for headless use.",
              "error"
            );
            return;
          }
          const chargeConfirmed = await ctx.ui.confirm(
            "Verify a TypeSafe credential?",
            "Login sends one tiny synthetic verification judgment, which may incur a small charge. No workspace or conversation content is included. Continue?"
          );
          if (!chargeConfirmed) {
            report(ctx, "Skill-router login cancelled.", "info");
            return;
          }
          const key = await readSecret(ctx);
          if (key === undefined) {
            report(ctx, "Skill-router login cancelled.", "info");
            return;
          }
          const normalized = key.trim();
          if (
            normalized.length < 16 ||
            normalized.length > 512 ||
            !PRINTABLE_KEY.test(normalized)
          ) {
            report(
              ctx,
              "TypeSafe credential is invalid; authentication unchanged.",
              "error"
            );
            return;
          }
          const controller = new AbortController();
          controllers.add(controller);
          try {
            await createClient(normalized).verify(controller.signal);
            if (controller.signal.aborted) {
              throw new Error("cancelled");
            }
            await credentialStore.save(normalized);
            report(
              ctx,
              "TypeSafe credential verified and saved. Existing routing consent is unchanged.",
              "info"
            );
          } catch (error) {
            report(
              ctx,
              `TypeSafe credential verification failed (${safeFailure(error)}); authentication unchanged.`,
              "error"
            );
          } finally {
            controllers.delete(controller);
          }
        } catch {
          report(ctx, "Skill-router operation failed safely.", "error");
        }
      },
    });
  };
}

function interactive(ctx: ExtensionContext): boolean {
  return ctx.hasUI && ctx.mode === "tui";
}
function sameCatalog(left: readonly Skill[], right: readonly Skill[]): boolean {
  return (
    left.length === right.length &&
    left.every(
      (skill, index) =>
        skill === right[index] ||
        (skill.name === right[index]?.name &&
          skill.filePath === right[index]?.filePath &&
          skill.disableModelInvocation === right[index]?.disableModelInvocation)
    )
  );
}
function isExplicitInvocation(text: string): boolean {
  return text.trimStart().startsWith("/");
}
function mentionsExcludedSkill(text: string): boolean {
  const words = new Set(
    text.toLowerCase().split(WORD_SEPARATOR).filter(Boolean)
  );
  for (const name of EXPLICIT_ONLY_SKILLS) {
    if (words.has(name.toLowerCase())) {
      return true;
    }
  }
  return false;
}
function trimRawInputSet(inputs: Set<string>): void {
  while (inputs.size > 64) {
    const oldest = inputs.values().next().value;
    if (oldest === undefined) {
      return;
    }
    inputs.delete(oldest);
  }
}
function buildRecentText(
  ctx: ExtensionContext,
  safeRawInputs: ReadonlySet<string>,
  current: string
): string {
  const lines: string[] = [];
  const entries = ctx.sessionManager.buildContextEntries();
  let currentIndex = -1;
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (
      entry?.type === "message" &&
      entry.message.role === "user" &&
      plainText(entry.message.content) === current
    ) {
      currentIndex = index;
      break;
    }
  }
  for (const [index, entry] of entries.entries()) {
    if (entry.type !== "message") {
      continue;
    }
    const message = entry.message;
    if (message.role === "user") {
      const text = plainText(message.content);
      if (!(text && safeRawInputs.has(text)) || index === currentIndex) {
        continue;
      }
      lines.push(`user: ${text}`);
      continue;
    }
    if (message.role === "assistant") {
      const text = plainText(message.content);
      if (text) {
        lines.push(`assistant: ${text}`);
      }
    }
  }
  return lines.slice(-20).join("\n");
}
function plainText(content: unknown): string | undefined {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return;
  }
  const text = content
    .filter(
      (item): item is { type: "text"; text: string } =>
        typeof item === "object" &&
        item !== null &&
        Reflect.get(item, "type") === "text" &&
        typeof Reflect.get(item, "text") === "string"
    )
    .map((item) => item.text)
    .join("\n");
  return text || undefined;
}
function visibleSelectedProvenance(
  ctx: ExtensionContext,
  retained: readonly unknown[]
): Set<string> {
  return selectedProvenanceInMessages([
    ...ctx.sessionManager
      .buildContextEntries()
      .filter((entry) => entry.type === "custom_message")
      .map((entry) => ({
        role: "custom",
        customType: entry.customType,
        content: entry.content,
        details: entry.details,
      })),
    ...retained,
  ]);
}
function selectedProvenanceInMessages(
  messages: readonly unknown[]
): Set<string> {
  const visible = new Set<string>();
  for (const message of messages) {
    if (
      typeof message !== "object" ||
      message === null ||
      Reflect.get(message, "role") !== "custom" ||
      Reflect.get(message, "customType") !== SELECTED_MESSAGE_TYPE
    ) {
      continue;
    }
    const content = Reflect.get(message, "content");
    const details = Reflect.get(message, "details");
    const skills =
      typeof details === "object" && details !== null
        ? Reflect.get(details, "skills")
        : undefined;
    if (typeof content !== "string" || !Array.isArray(skills)) {
      continue;
    }
    for (const value of skills) {
      const skill = selectedSkillDetails(value);
      if (!skill) {
        continue;
      }
      const opening = `<skill name="${xml(skill.name)}" location="${xml(skill.path)}">`;
      const relative = `References are relative to ${skill.baseDir}.`;
      if (content.includes(opening) && content.includes(relative)) {
        visible.add(selectedProvenance(skill));
      }
    }
  }
  return visible;
}
function selectedSkillDetails(
  value: unknown
): SelectedSkillDetails | undefined {
  if (typeof value !== "object" || value === null) {
    return;
  }
  const name = Reflect.get(value, "name");
  const path = Reflect.get(value, "path");
  const baseDir = Reflect.get(value, "baseDir");
  const bodyHash = Reflect.get(value, "bodyHash");
  if (
    typeof name !== "string" ||
    typeof path !== "string" ||
    typeof baseDir !== "string" ||
    typeof bodyHash !== "string" ||
    !BODY_HASH.test(bodyHash)
  ) {
    return;
  }
  return { name, path, baseDir, bodyHash };
}
function selectedProvenance(skill: SelectedSkillDetails): string {
  return JSON.stringify([
    skill.name,
    skill.path,
    skill.baseDir,
    skill.bodyHash,
  ]);
}
function formatSelectedSkill(skill: Skill, body: string): string {
  return `<skill name="${xml(skill.name)}" location="${xml(skill.filePath)}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
}
function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
function rememberContextUsers(
  ctx: ExtensionContext,
  knownUsers: Set<string>
): void {
  const messages = ctx.sessionManager
    .buildContextEntries()
    .filter((entry) => entry.type === "message")
    .map((entry) => entry.message);
  for (const message of identifyCanonicalMessages(messages)) {
    if (message.role === "user") {
      knownUsers.add(message.identity);
    }
  }
}
function safeFailure(error: unknown): string {
  return error instanceof JevError ? error.category : "connection";
}

export default createSkillRouterExtension();
