import {
  createEditToolDefinition,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  type ExtensionAPI,
  type ExtensionContext,
  type WriteToolInput,
  type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

import { keepRendererBackground } from "./background";
import { registerToolDisplayCommands } from "./commands";
import { companionGroup } from "./companion";
import { loadToolDisplayConfig } from "./config";
import { editTool, resolveToCwd, withFileMutationQueue } from "./edit-tool";
import {
  cleanupToolDisplayTimers,
  composeReasonedTool,
  type OwnedToolName,
  renderBashToolCall,
  renderCompanionToolCall,
  renderCompanionToolResult,
  renderBashToolResult,
  renderGenericToolCall,
  renderGenericToolResult,
  renderOwnedToolCall,
  renderOwnedToolResult,
  toolResultBody,
} from "./presentation";
import {
  createToolDisplayReadDetails,
  getToolDisplayReadErrorMessage,
  normalizeSkillFilePaths,
  readFullReadText,
  resolveFullReadPath,
} from "./read";
import {
  capturePreviousWriteContent,
  createWriteDiffDetails,
  renderCompactBashResult,
  renderCompactFindResult,
  renderCompactGrepResult,
  renderCompactLsResult,
  renderCompactReadResult,
  renderFinalDiffResult,
} from "./renderers";

const REASONING_DESCRIPTION =
  "State short present-tense intent, maximum 12 words, without restating target";

function reasoningGuideline(name: OwnedToolName): string {
  return `Give ${name} a short present-tense reasoning goal without repeating its target`;
}

function expandedBody(
  expanded: boolean,
  render: () => Component,
): Component | undefined {
  return expanded ? toolResultBody(render(), true) : undefined;
}

export default function toolDisplayExtension(pi: ExtensionAPI): void {
  let cwd = process.cwd();
  let config = loadToolDisplayConfig(cwd);
  registerToolDisplayCommands(pi, {
    onConfigWritten: () => {
      config = loadToolDisplayConfig(cwd);
    },
  });
  let readTool = createReadTool(cwd);
  let grepTool = createGrepTool(cwd);
  let findTool = createFindTool(cwd);
  let lsTool = createLsTool(cwd);
  let writeTool = createWriteTool(cwd);
  let skillFilePaths = new Set<string>();
  let editOverridden = false;

  pi.registerToolRenderer((toolName, next) => {
    const drawing = config;
    const fileNames: OwnedToolName[] = [
      "read",
      "grep",
      "find",
      "ls",
      "edit",
      "write",
    ];
    const name = fileNames.find((candidate) => candidate === toolName);
    if (name) {
      const gates: Record<OwnedToolName, boolean> = {
        read: drawing.output.read.enabled,
        grep: drawing.output.search.enabled,
        find: drawing.output.search.enabled,
        ls: drawing.output.search.enabled,
        edit: drawing.diff.enabled,
        write: drawing.diff.enabled,
      };
      if (!gates[name]) {
        return next();
      }
      return {
        renderShell: "self",
        renderCall: (args, theme, context) =>
          renderOwnedToolCall(name, args, theme, context),
        renderResult(result, options, theme, context) {
          const current = config;
          const expandedOptions = { ...options, expanded: true };
          let body: Component | undefined;
          if (name === "edit" || name === "write") {
            body = expandedBody(
              options.expanded || !current.diff.collapsed,
              () =>
                renderFinalDiffResult(
                  result,
                  expandedOptions,
                  theme,
                  current.diff,
                ),
            );
          } else {
            const output =
              name === "read" ? current.output.read : current.output.search;
            const render = {
              read: renderCompactReadResult,
              grep: renderCompactGrepResult,
              find: renderCompactFindResult,
              ls: renderCompactLsResult,
            }[name];
            body = expandedBody(
              options.expanded || output.mode === "expanded",
              () => render(result, expandedOptions, theme, output),
            );
          }
          return renderOwnedToolResult(
            name,
            result,
            options,
            theme,
            context,
            body,
          );
        },
      } satisfies ToolRenderers;
    }
    if (toolName === "bash") {
      if (!drawing.output.bash.enabled) {
        return next();
      }
      return {
        renderShell: "self",
        renderCall: renderBashToolCall,
        renderResult(result, options, theme, context) {
          const output = config.output.bash;
          return renderBashToolResult(
            result,
            options,
            theme,
            context,
            expandedBody(options.expanded || output.mode === "expanded", () =>
              renderCompactBashResult(
                result,
                { ...options, expanded: true },
                theme,
                output,
              ),
            ),
          );
        },
      } satisfies ToolRenderers;
    }
    const group = companionGroup(toolName);
    if (group) {
      if (!drawing.output[group].enabled) {
        return next();
      }
      return {
        renderShell: "self",
        renderCall: (args, theme, context) =>
          renderCompanionToolCall(
            toolName,
            args,
            theme,
            context,
            config.output.codemode,
          ),
        renderResult: (result, options, theme, context) =>
          renderCompanionToolResult(
            toolName,
            result,
            options,
            theme,
            context,
            config.output[group],
          ),
      } satisfies ToolRenderers;
    }
    const resolved = next();
    if (!drawing.output.fallback.enabled) {
      return resolved;
    }
    if (resolved?.renderCall && resolved.renderResult) {
      return keepRendererBackground(resolved);
    }
    const bothGeneric = !resolved?.renderCall && !resolved?.renderResult;
    const kept = resolved && keepRendererBackground(resolved);
    return {
      ...kept,
      renderShell: bothGeneric ? "self" : resolved?.renderShell,
      renderCall:
        kept?.renderCall ??
        ((args, theme, context) =>
          renderGenericToolCall(toolName, args, theme, context)),
      renderResult:
        kept?.renderResult ??
        ((result, options, theme, context) =>
          renderGenericToolResult(
            toolName,
            result,
            options,
            theme,
            context,
            config.output.fallback,
          )),
    } satisfies ToolRenderers;
  });

  function reloadSession(nextCwd: string): void {
    cleanupToolDisplayTimers();
    cwd = nextCwd;
    config = loadToolDisplayConfig(cwd);
    readTool = createReadTool(cwd);
    grepTool = createGrepTool(cwd);
    findTool = createFindTool(cwd);
    lsTool = createLsTool(cwd);
    writeTool = createWriteTool(cwd);
    registerEditTool();
  }

  pi.on("session_start", (_event, ctx) => {
    reloadSession(ctx.cwd);
  });
  // oxlint-disable-next-line typescript/unbound-method -- Reflect.apply explicitly supplies pi as the method's receiver.
  Reflect.apply(pi.on, pi, [
    "session_switch",
    (_event: { type: "session_switch" }, ctx: ExtensionContext) => {
      reloadSession(ctx.cwd);
    },
  ]);
  pi.on("session_shutdown", () => {
    cleanupToolDisplayTimers();
  });

  pi.on("before_agent_start", async (event) => {
    skillFilePaths = await normalizeSkillFilePaths(
      event.systemPromptOptions.skills ?? [],
    );
  });

  if (config.tools.read.enabled) {
    const definition = composeReasonedTool(
      {
        ...readTool,
        promptGuidelines: ["Use read to examine files instead of cat or sed"],
        async execute(toolCallId, params, signal, onUpdate, _ctx) {
          if (!config.tools.read.fullRead.enabled) {
            return readTool.execute(toolCallId, params, signal, onUpdate);
          }
          const fullReadMatch = await resolveFullReadPath(
            params.path,
            cwd,
            config.tools.read.fullRead.targets,
            skillFilePaths,
          );
          if (!fullReadMatch) {
            return readTool.execute(toolCallId, params, signal, onUpdate);
          }
          try {
            const result = await readFullReadText(fullReadMatch, params);
            return {
              content: [{ type: "text" as const, text: result.content }],
              details: result.details,
            };
          } catch (error) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: getToolDisplayReadErrorMessage(error),
                },
              ],
              isError: true,
              details: createToolDisplayReadDetails(
                fullReadMatch.path,
                fullReadMatch.target.name,
                0,
                params,
              ),
            };
          }
        },
      },
      {
        reasoningDescription: REASONING_DESCRIPTION,
        promptGuidelines: [reasoningGuideline("read")],
      },
    );
    pi.registerTool(definition);
  }

  if (config.tools.search.enabled) {
    for (const tool of [grepTool, findTool, lsTool]) {
      pi.registerTool(
        composeReasonedTool(tool, {
          reasoningDescription: REASONING_DESCRIPTION,
          promptGuidelines: [reasoningGuideline(tool.name as OwnedToolName)],
        }),
      );
    }
  }

  function registerEditTool(): void {
    if (!config.tools.edit.enabled) {
      // Pi retains registered tools across sessions and has no unregister API.
      // Once overridden, refresh the native definition for each session's cwd.
      if (editOverridden) {
        const {
          renderCall: _renderCall,
          renderResult: _renderResult,
          renderShell: _renderShell,
          ...nativeEdit
        } = createEditToolDefinition(cwd);
        pi.registerTool(nativeEdit);
      }
      return;
    }
    pi.registerTool({
      ...editTool,
      async execute(
        toolCallId,
        params,
        signal,
        onUpdate,
        ctx: ExtensionContext,
      ) {
        const startedAt = Date.now();
        const activeCwd = ctx.cwd ?? cwd;
        const result = await editTool.execute(
          toolCallId,
          params,
          signal,
          onUpdate,
          {
            ...ctx,
            cwd: activeCwd,
            toolDisplayAllowPatchAdd: config.tools.write.enabled === true,
            toolDisplayAllowPermanentDelete:
              config.tools.edit.allowPermanentDelete === true,
          },
        );
        return {
          ...result,
          details: {
            ...(result.details ?? {}),
            toolDisplay: {
              ...((result.details as { toolDisplay?: object } | undefined)
                ?.toolDisplay ?? {}),
              durationMs: Date.now() - startedAt,
            },
          },
        };
      },
    });
    editOverridden = true;
  }

  registerEditTool();

  if (config.tools.write.enabled) {
    pi.registerTool(
      composeReasonedTool(
        {
          ...writeTool,
          execute(
            toolCallId,
            params: WriteToolInput,
            signal,
            onUpdate,
            ctx: ExtensionContext,
          ) {
            const activeCwd = ctx.cwd ?? cwd;
            const targetPath = resolveToCwd(activeCwd, params.path);
            const activeWriteTool = createWriteTool(activeCwd);
            return withFileMutationQueue(
              [targetPath],
              async () => {
                const previous = await capturePreviousWriteContent(
                  activeCwd,
                  targetPath,
                );
                const result = await activeWriteTool.execute(
                  toolCallId,
                  params,
                  signal,
                  onUpdate,
                );
                if ((result as { isError?: boolean }).isError) {
                  return result;
                }
                return {
                  ...result,
                  details: createWriteDiffDetails(
                    params.path,
                    params.content,
                    previous,
                  ),
                };
              },
              signal,
            );
          },
        },
        {
          reasoningDescription: REASONING_DESCRIPTION,
          promptGuidelines: [reasoningGuideline("write")],
        },
      ),
    );
  }
}
