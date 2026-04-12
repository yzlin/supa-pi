import type {
  ExtensionAPI,
  ExtensionContext,
  ReadonlyFooterDataProvider,
} from "@mariozechner/pi-coding-agent";

import { loadConfig } from "./config.js";
import { EnhancedEditor } from "./enhanced-editor.js";
import { warmPreviewHighlighter } from "./file-picker-highlight.js";
import { invalidateGitBranch, invalidateGitStatus } from "./status-bar-git.js";

type PieditorRuntime = {
  activeContext: ExtensionContext | null;
  activeEditor: EnhancedEditor | null;
  activeFooterData: ReadonlyFooterDataProvider | null;
};

const GIT_BRANCH_PATTERNS = [
  /\bgit\s+(checkout|switch|branch\s+-[dDmM]|merge|rebase|pull|reset|worktree)/,
  /\bgit\s+stash\s+(pop|apply)/,
];

function resolveDoubleEscapeCommand(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  doubleEscapeCommand: string | null,
  options: { warnIfMissing?: boolean } = {}
): string | null {
  if (!doubleEscapeCommand) return null;

  const hasMatchingCommand = pi
    .getCommands()
    .some((command) => command.name === doubleEscapeCommand);

  if (!hasMatchingCommand && options.warnIfMissing !== false) {
    ctx.ui.notify(
      `pieditor: '/${doubleEscapeCommand}' is not currently visible in slash commands; submitting it anyway`,
      "warning"
    );
  }

  return doubleEscapeCommand;
}

function mightChangeGitBranch(command: string): boolean {
  return GIT_BRANCH_PATTERNS.some((pattern) => pattern.test(command));
}

function invalidateGitState(): void {
  invalidateGitStatus();
  invalidateGitBranch();
}

export function createPieditorComposition(pi: ExtensionAPI) {
  const runtime: PieditorRuntime = {
    activeContext: null,
    activeEditor: null,
    activeFooterData: null,
  };

  return {
    attachEditor(ctx: ExtensionContext): void {
      if (!ctx.hasUI) return;

      runtime.activeContext = ctx;
      const config = loadConfig();
      let warnedMissingDoubleEscapeCommand = false;

      const getDoubleEscapeCommand = () => {
        const resolved = resolveDoubleEscapeCommand(
          pi,
          ctx,
          config.doubleEscapeCommand,
          { warnIfMissing: !warnedMissingDoubleEscapeCommand }
        );

        const hasMatchingCommand = config.doubleEscapeCommand
          ? pi
              .getCommands()
              .some((command) => command.name === config.doubleEscapeCommand)
          : false;
        warnedMissingDoubleEscapeCommand = Boolean(
          config.doubleEscapeCommand && !hasMatchingCommand
        );

        return resolved;
      };

      const factory = (tui: any, theme: any, keybindings: any) => {
        runtime.activeEditor = new EnhancedEditor(
          tui,
          theme,
          keybindings,
          ctx.ui,
          {
            getDoubleEscapeCommand,
            canTriggerDoubleEscapeCommand: () => {
              if (!runtime.activeContext) return false;
              return (
                runtime.activeContext.isIdle() &&
                !runtime.activeContext.hasPendingMessages()
              );
            },
            commandRemap: config.commandRemap,
            statusBar: {
              config: config.statusBar,
              getContext: () => runtime.activeContext,
              getFooterData: () => runtime.activeFooterData,
            },
          }
        );
        return runtime.activeEditor;
      };

      ctx.ui.setEditorComponent(factory);
      ctx.ui.setFooter(
        (tui: any, _theme: any, footerData: ReadonlyFooterDataProvider) => {
          runtime.activeFooterData = footerData;
          const unsub = footerData.onBranchChange(() => tui.requestRender());

          return {
            dispose() {
              unsub();
              if (runtime.activeFooterData === footerData) {
                runtime.activeFooterData = null;
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
    },

    handleToolResult(event: {
      toolName: string;
      input?: { command?: unknown };
    }): void {
      if (event.toolName === "write" || event.toolName === "edit") {
        invalidateGitStatus();
      }

      if (event.toolName === "bash" && event.input?.command) {
        const command = String(event.input.command);
        if (mightChangeGitBranch(command)) {
          invalidateGitState();
        }
      }
    },

    handleUserBash(command: string): void {
      if (mightChangeGitBranch(command)) {
        invalidateGitState();
      }
    },

    async pasteClipboardRaw(ctx: ExtensionContext): Promise<void> {
      if (!ctx.hasUI) return;
      if (!runtime.activeEditor) {
        ctx.ui.notify("Editor not ready", "warning");
        return;
      }
      await runtime.activeEditor.pasteClipboardRawAtCursor();
    },
  };
}
