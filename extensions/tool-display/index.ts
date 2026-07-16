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
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

import { registerToolDisplayCommands } from "./commands";
import { loadToolDisplayConfig } from "./config";
import { editTool, resolveToCwd, withFileMutationQueue } from "./edit-tool";
import {
  cleanupToolDisplayTimers,
  composeReasonedTool,
  type OwnedToolName,
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
  render: () => Component
): Component | undefined {
  return expanded ? toolResultBody(render(), true) : undefined;
}

export default function toolDisplayExtension(pi: ExtensionAPI): void {
  registerToolDisplayCommands(pi);
  let cwd = process.cwd();
  let config = loadToolDisplayConfig(cwd);
  let readTool = createReadTool(cwd);
  let grepTool = createGrepTool(cwd);
  let findTool = createFindTool(cwd);
  let lsTool = createLsTool(cwd);
  let writeTool = createWriteTool(cwd);
  let skillFilePaths = new Set<string>();

  function reloadSession(nextCwd: string): void {
    cleanupToolDisplayTimers("file");
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
  Reflect.apply(pi.on, pi, [
    "session_switch",
    (_event: { type: "session_switch" }, ctx: ExtensionContext) => {
      reloadSession(ctx.cwd);
    },
  ]);
  pi.on("session_shutdown", () => {
    cleanupToolDisplayTimers("file");
  });

  pi.on("before_agent_start", async (event) => {
    skillFilePaths = await normalizeSkillFilePaths(
      event.systemPromptOptions.skills ?? []
    );
  });

  if (config.tools.read.enabled) {
    const definition = composeReasonedTool(
      {
        ...readTool,
        renderShell: "self" as const,
        promptGuidelines: ["Use read to examine files instead of cat or sed"],
        async execute(toolCallId, params, signal, onUpdate, _ctx) {
          if (!config.tools.read.fullRead.enabled) {
            return readTool.execute(toolCallId, params, signal, onUpdate);
          }
          const fullReadMatch = await resolveFullReadPath(
            params.path,
            cwd,
            config.tools.read.fullRead.targets,
            skillFilePaths
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
                params
              ),
            };
          }
        },
        renderCall(args, theme, context) {
          return renderOwnedToolCall("read", args, theme, context);
        },
        renderResult(result, options, theme, context) {
          const expanded =
            options.expanded || config.output.read.mode === "expanded";
          return renderOwnedToolResult(
            "read",
            result,
            options,
            theme,
            context,
            expandedBody(expanded, () =>
              renderCompactReadResult(
                result,
                { ...options, expanded: true },
                theme,
                config.output.read
              )
            )
          );
        },
      },
      {
        reasoningDescription: REASONING_DESCRIPTION,
        promptGuidelines: [reasoningGuideline("read")],
      }
    );
    pi.registerTool(definition);
  }

  if (config.tools.search.enabled) {
    const registrations = [
      composeReasonedTool(
        {
          ...grepTool,
          renderShell: "self" as const,
          renderCall: (args, theme, context) =>
            renderOwnedToolCall("grep", args, theme, context),
          renderResult: (result, options, theme, context) =>
            renderOwnedToolResult(
              "grep",
              result,
              options,
              theme,
              context,
              expandedBody(
                options.expanded || config.output.search.mode === "expanded",
                () =>
                  renderCompactGrepResult(
                    result,
                    { ...options, expanded: true },
                    theme,
                    config.output.search
                  )
              )
            ),
        },
        {
          reasoningDescription: REASONING_DESCRIPTION,
          promptGuidelines: [reasoningGuideline("grep")],
        }
      ),
      composeReasonedTool(
        {
          ...findTool,
          renderShell: "self" as const,
          renderCall: (args, theme, context) =>
            renderOwnedToolCall("find", args, theme, context),
          renderResult: (result, options, theme, context) =>
            renderOwnedToolResult(
              "find",
              result,
              options,
              theme,
              context,
              expandedBody(
                options.expanded || config.output.search.mode === "expanded",
                () =>
                  renderCompactFindResult(
                    result,
                    { ...options, expanded: true },
                    theme,
                    config.output.search
                  )
              )
            ),
        },
        {
          reasoningDescription: REASONING_DESCRIPTION,
          promptGuidelines: [reasoningGuideline("find")],
        }
      ),
      composeReasonedTool(
        {
          ...lsTool,
          renderShell: "self" as const,
          renderCall: (args, theme, context) =>
            renderOwnedToolCall("ls", args, theme, context),
          renderResult: (result, options, theme, context) =>
            renderOwnedToolResult(
              "ls",
              result,
              options,
              theme,
              context,
              expandedBody(
                options.expanded || config.output.search.mode === "expanded",
                () =>
                  renderCompactLsResult(
                    result,
                    { ...options, expanded: true },
                    theme,
                    config.output.search
                  )
              )
            ),
        },
        {
          reasoningDescription: REASONING_DESCRIPTION,
          promptGuidelines: [reasoningGuideline("ls")],
        }
      ),
    ];
    for (const definition of registrations) {
      pi.registerTool(definition);
    }
  }

  function registerEditTool(): void {
    if (!config.tools.edit.enabled) {
      const builtInEditTool = createEditToolDefinition(cwd);
      pi.registerTool({
        ...builtInEditTool,
        renderShell: "self" as const,
        renderCall(args, theme, context) {
          return renderOwnedToolCall(
            "edit",
            args as never,
            theme,
            context as never
          );
        },
        renderResult(result, options, theme, context) {
          const expanded = options.expanded || config.diff.collapsed === false;
          return renderOwnedToolResult(
            "edit",
            result,
            options,
            theme,
            context as never,
            expandedBody(expanded, () =>
              renderFinalDiffResult(
                result,
                { ...options, expanded: true },
                theme,
                config.diff
              )
            )
          );
        },
      });
      return;
    }
    pi.registerTool({
      ...editTool,
      renderShell: "self" as const,
      async execute(
        toolCallId,
        params,
        signal,
        onUpdate,
        ctx: ExtensionContext
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
          }
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
      renderCall(args, theme, context) {
        return renderOwnedToolCall(
          "edit",
          args as never,
          theme,
          context as never
        );
      },
      renderResult(result, options, theme, context) {
        const expanded = options.expanded || config.diff.collapsed === false;
        return renderOwnedToolResult(
          "edit",
          result,
          options,
          theme,
          context as never,
          expandedBody(expanded, () =>
            renderFinalDiffResult(
              result,
              { ...options, expanded: true },
              theme,
              config.diff
            )
          )
        );
      },
    });
  }

  registerEditTool();

  if (config.tools.write.enabled) {
    pi.registerTool(
      composeReasonedTool(
        {
          ...writeTool,
          renderShell: "self" as const,
          execute(
            toolCallId,
            params: WriteToolInput,
            signal,
            onUpdate,
            ctx: ExtensionContext
          ) {
            const activeCwd = ctx.cwd ?? cwd;
            const targetPath = resolveToCwd(activeCwd, params.path);
            const activeWriteTool = createWriteTool(activeCwd);
            return withFileMutationQueue(
              [targetPath],
              async () => {
                const previous = await capturePreviousWriteContent(
                  activeCwd,
                  targetPath
                );
                const result = await activeWriteTool.execute(
                  toolCallId,
                  params,
                  signal,
                  onUpdate
                );
                if ((result as { isError?: boolean }).isError) {
                  return result;
                }
                return {
                  ...result,
                  details: createWriteDiffDetails(
                    params.path,
                    params.content,
                    previous
                  ),
                };
              },
              signal
            );
          },
          renderCall(args, theme, context) {
            return renderOwnedToolCall("write", args, theme, context);
          },
          renderResult(result, options, theme, context) {
            const expanded =
              options.expanded || config.diff.collapsed === false;
            return renderOwnedToolResult(
              "write",
              result,
              options,
              theme,
              context,
              expandedBody(expanded, () =>
                renderFinalDiffResult(
                  result,
                  { ...options, expanded: true },
                  theme,
                  config.diff
                )
              )
            );
          },
        },
        {
          reasoningDescription: REASONING_DESCRIPTION,
          promptGuidelines: [reasoningGuideline("write")],
        }
      )
    );
  }
}
