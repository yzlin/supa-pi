/**
 * editor-enhancements
 *
 * Local rewritten and independently evolving variant of the upstream
 * editor-enhancements extension from w-winter/dot314:
 * https://github.com/w-winter/dot314/tree/main/extensions/editor-enhancements
 *
 * Keep attribution to the original upstream author even as this local version
 * continues to diverge.
 *
 * Composite custom editor that combines:
 * - shell-completions (autocomplete wrapping for !/!! mode)
 * - file-picker (@ opens overlay file browser)
 * - raw-paste alt+v (paste clipboard text "raw" into editor, bypassing large-paste markers)
 *
 * NOTE: This extension intentionally owns ctx.ui.setEditorComponent().
 * Disable other extensions that also call setEditorComponent (shell-completions/, file-picker.ts, raw-paste.ts)
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  ReadonlyFooterDataProvider,
} from "@mariozechner/pi-coding-agent";

import { loadConfig } from "./config.js";
import { EnhancedEditor } from "./enhanced-editor.js";
import { warmPreviewHighlighter } from "./file-picker-highlight.js";
import { invalidateGitBranch, invalidateGitStatus } from "./status-bar-git.js";

function resolveDoubleEscapeCommand(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  doubleEscapeCommand: string | null
): string | null {
  if (!doubleEscapeCommand) return null;

  const hasMatchingExtensionCommand = pi
    .getCommands()
    .some(
      (command) =>
        command.source === "extension" && command.name === doubleEscapeCommand
    );

  if (hasMatchingExtensionCommand) {
    return doubleEscapeCommand;
  }

  ctx.ui.notify(
    `editor-enhancements: configured doubleEscapeCommand '/${doubleEscapeCommand}' is not a registered extension command`,
    "warning"
  );
  return null;
}

const GIT_BRANCH_PATTERNS = [
  /\bgit\s+(checkout|switch|branch\s+-[dDmM]|merge|rebase|pull|reset|worktree)/,
  /\bgit\s+stash\s+(pop|apply)/,
];

function mightChangeGitBranch(command: string): boolean {
  return GIT_BRANCH_PATTERNS.some((pattern) => pattern.test(command));
}

function invalidateGitState(): void {
  invalidateGitStatus();
  invalidateGitBranch();
}

export default function (pi: ExtensionAPI) {
  let activeContext: ExtensionContext | null = null;
  let activeEditor: EnhancedEditor | null = null;
  let activeFooterData: ReadonlyFooterDataProvider | null = null;

  const attachEditor = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;

    activeContext = ctx;
    const config = loadConfig();
    const doubleEscapeCommand = resolveDoubleEscapeCommand(
      pi,
      ctx,
      config.doubleEscapeCommand
    );

    const factory = (tui: any, theme: any, keybindings: any) => {
      activeEditor = new EnhancedEditor(tui, theme, keybindings, ctx.ui, {
        doubleEscapeCommand,
        canTriggerDoubleEscapeCommand: () => {
          if (!activeContext) return false;
          return activeContext.isIdle() && !activeContext.hasPendingMessages();
        },
        commandRemap: config.commandRemap,
        statusBar: {
          config: config.statusBar,
          getContext: () => activeContext,
          getFooterData: () => activeFooterData,
        },
      });
      return activeEditor;
    };

    ctx.ui.setEditorComponent(factory);
    ctx.ui.setFooter(
      (tui: any, _theme: any, footerData: ReadonlyFooterDataProvider) => {
        activeFooterData = footerData;
        const unsub = footerData.onBranchChange(() => tui.requestRender());

        return {
          dispose() {
            unsub();
            if (activeFooterData === footerData) {
              activeFooterData = null;
            }
          },
          invalidate() {},
          render(): string[] {
            return [];
          },
        };
      }
    );
    setTimeout(() => {
      warmPreviewHighlighter(config.filePicker.previewHighlightMode);
    }, 0);
  };

  pi.on("session_start", (_event, ctx) => {
    attachEditor(ctx);
  });

  pi.on("tool_result", (event) => {
    if (event.toolName === "write" || event.toolName === "edit") {
      invalidateGitStatus();
    }

    if (event.toolName === "bash" && event.input?.command) {
      const command = String(event.input.command);
      if (mightChangeGitBranch(command)) {
        invalidateGitState();
      }
    }
  });

  pi.on("user_bash", (event) => {
    if (mightChangeGitBranch(event.command)) {
      invalidateGitState();
    }
  });

  // Provide alt+v raw clipboard paste (the only raw-paste feature you wanted)
  pi.registerShortcut("alt+v", {
    description:
      "Paste clipboard text raw into editor (bypasses [paste #..] markers)",
    handler: async (ctx) => {
      if (!ctx.hasUI) return;
      if (!activeEditor) {
        ctx.ui.notify("Editor not ready", "warning");
        return;
      }
      await activeEditor.pasteClipboardRawAtCursor();
    },
  });
}
