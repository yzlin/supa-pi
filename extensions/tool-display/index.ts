import {
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import { registerToolDisplayCommands } from "./commands";
import { loadToolDisplayConfig } from "./config";
import {
  createToolDisplayReadDetails,
  getToolDisplayReadErrorMessage,
  isToolDisplayReadDetails,
  normalizeSkillFilePaths,
  readFullSkillText,
  resolveFullSkillReadPath,
} from "./read";
import {
  capturePreviousWriteContent,
  createWriteDiffDetails,
  renderCompactFindCall,
  renderCompactFindResult,
  renderCompactGrepCall,
  renderCompactGrepResult,
  renderCompactLsCall,
  renderCompactLsResult,
  renderCompactReadCall,
  renderCompactReadResult,
  renderEditCall,
  renderFinalDiffResult,
  renderWriteCall,
} from "./renderers";

const SESSION_EVENTS = ["session_start", "session_switch"] as const;

export default function toolDisplayExtension(pi: ExtensionAPI): void {
  registerToolDisplayCommands(pi);
  let cwd = process.cwd();
  let config = loadToolDisplayConfig(cwd);
  let readTool = createReadTool(cwd);
  let grepTool = createGrepTool(cwd);
  let findTool = createFindTool(cwd);
  let lsTool = createLsTool(cwd);
  let editTool = createEditTool(cwd);
  let writeTool = createWriteTool(cwd);
  let skillFilePaths = new Set<string>();

  function reloadSession(nextCwd: string): void {
    cwd = nextCwd;
    config = loadToolDisplayConfig(cwd);
    readTool = createReadTool(cwd);
    grepTool = createGrepTool(cwd);
    findTool = createFindTool(cwd);
    lsTool = createLsTool(cwd);
    editTool = createEditTool(cwd);
    writeTool = createWriteTool(cwd);
  }

  for (const eventName of SESSION_EVENTS) {
    pi.on(eventName, (_event, ctx) => {
      reloadSession(ctx.cwd);
    });
  }

  pi.on("before_agent_start", async (event) => {
    skillFilePaths = await normalizeSkillFilePaths(
      event.systemPromptOptions.skills
    );
  });

  if (config.tools.read.enabled) {
    pi.registerTool({
      ...readTool,
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        if (!config.tools.read.fullSkillRead) {
          return readTool.execute(toolCallId, params, signal, onUpdate, ctx);
        }

        const patchedPath = await resolveFullSkillReadPath(
          params.path,
          cwd,
          skillFilePaths
        );

        if (!patchedPath) {
          return readTool.execute(toolCallId, params, signal, onUpdate, ctx);
        }

        try {
          const result = await readFullSkillText(patchedPath, params);
          return {
            content: [{ type: "text", text: result.content }],
            details: result.details,
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: getToolDisplayReadErrorMessage(error),
              },
            ],
            isError: true,
            details: createToolDisplayReadDetails(patchedPath, 0, params),
          };
        }
      },

      renderCall(args, theme) {
        return renderCompactReadCall(args, theme);
      },

      renderResult(result, renderContext, theme, _context) {
        if (isToolDisplayReadDetails(result.details)) {
          const details = result.details.toolDisplay;
          const ignored: string[] = [];

          if (details.ignoredOffset !== undefined) {
            ignored.push(`offset=${details.ignoredOffset}`);
          }

          if (details.ignoredLimit !== undefined) {
            ignored.push(`limit=${details.ignoredLimit}`);
          }

          const suffix = ignored.length
            ? `; ignored ${ignored.join(", ")}`
            : "";
          const status = result.isError ? "error" : "success";
          return new Text(
            theme.fg(
              status,
              `skill read full (${details.bytes} bytes${suffix})`
            ),
            0,
            0
          );
        }

        return renderCompactReadResult(
          result,
          renderContext,
          theme,
          config.output.read
        );
      },
    });
  }

  if (config.tools.search.enabled) {
    pi.registerTool({
      ...grepTool,
      execute(toolCallId, params, signal, onUpdate, ctx) {
        return grepTool.execute(toolCallId, params, signal, onUpdate, ctx);
      },
      renderCall(args, theme) {
        return renderCompactGrepCall(args, theme);
      },
      renderResult(result, renderContext, theme) {
        return renderCompactGrepResult(
          result,
          renderContext,
          theme,
          config.output.search
        );
      },
    });

    pi.registerTool({
      ...findTool,
      execute(toolCallId, params, signal, onUpdate, ctx) {
        return findTool.execute(toolCallId, params, signal, onUpdate, ctx);
      },
      renderCall(args, theme) {
        return renderCompactFindCall(args, theme);
      },
      renderResult(result, renderContext, theme) {
        return renderCompactFindResult(
          result,
          renderContext,
          theme,
          config.output.search
        );
      },
    });

    pi.registerTool({
      ...lsTool,
      execute(toolCallId, params, signal, onUpdate, ctx) {
        return lsTool.execute(toolCallId, params, signal, onUpdate, ctx);
      },
      renderCall(args, theme) {
        return renderCompactLsCall(args, theme);
      },
      renderResult(result, renderContext, theme) {
        return renderCompactLsResult(
          result,
          renderContext,
          theme,
          config.output.search
        );
      },
    });
  }

  if (config.tools.edit.enabled) {
    pi.registerTool({
      ...editTool,
      renderShell: "default",
      execute(toolCallId, params, signal, onUpdate, ctx) {
        return editTool.execute(toolCallId, params, signal, onUpdate, ctx);
      },
      renderCall(args, theme) {
        return renderEditCall(args, theme);
      },
      renderResult(result, renderContext, theme) {
        return renderFinalDiffResult(result, renderContext, theme, config.diff);
      },
    });
  }

  if (config.tools.write.enabled) {
    pi.registerTool({
      ...writeTool,
      renderShell: "default",
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        const previous = capturePreviousWriteContent(cwd, params.path);
        const result = await writeTool.execute(
          toolCallId,
          params,
          signal,
          onUpdate,
          ctx
        );

        if (result.isError) {
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
      renderCall(args, theme) {
        return renderWriteCall(args, theme);
      },
      renderResult(result, renderContext, theme) {
        return renderFinalDiffResult(result, renderContext, theme, config.diff);
      },
    });
  }
}
