import {
  copyToClipboard,
  type ExtensionAPI,
  type ExtensionContext,
  type InputEvent,
  type KeybindingsManager,
  type ReadonlyFooterDataProvider,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";

import { type FixedEditorRuntimeConfig, loadConfig } from "./config.js";
import { EnhancedEditor } from "./enhanced-editor.js";
import { warmPreviewHighlighter } from "./file-picker-highlight.js";
import { renderFixedEditorCluster } from "./fixed-editor/cluster.js";
import { TerminalSplitCompositor } from "./fixed-editor/terminal-split.js";
import { invalidateGitBranch, invalidateGitStatus } from "./status-bar-git.js";

type FixedEditorConfigListener = (config: FixedEditorRuntimeConfig) => void;

type CopySelection = (text: string) => Promise<void> | void;

interface PieditorCompositionOptions {
  copySelection?: CopySelection;
}

interface PieditorRuntime {
  activeContext: ExtensionContext | null;
  activeEditor: EnhancedEditor | null;
  activeEditorTui: TUI | null;
  activeFooterData: ReadonlyFooterDataProvider | null;
  activeFooterTui: TUI | null;
  fixedEditorCompositor: TerminalSplitCompositor | null;
  fixedEditorConfig: FixedEditorRuntimeConfig;
  fixedEditorConfigListeners: Set<FixedEditorConfigListener>;
  fixedEditorInstallFailed: boolean;
}

const GIT_BRANCH_PATTERNS = [
  /\bgit\s+(checkout|switch|branch\s+-[dDmM]|merge|rebase|pull|reset|worktree)/,
  /\bgit\s+stash\s+(pop|apply)/,
];

function getDoubleEscapeCommandState(
  pi: ExtensionAPI,
  doubleEscapeCommand: string | null
): { command: string | null; isVisible: boolean } {
  if (!doubleEscapeCommand) {
    return { command: null, isVisible: false };
  }

  return {
    command: doubleEscapeCommand,
    isVisible: pi
      .getCommands()
      .some((command) => command.name === doubleEscapeCommand),
  };
}

function mightChangeGitBranch(command: string): boolean {
  return GIT_BRANCH_PATTERNS.some((pattern) => pattern.test(command));
}

function invalidateGitState(): void {
  invalidateGitStatus();
  invalidateGitBranch();
}

export function createPieditorComposition(
  pi: ExtensionAPI,
  options: PieditorCompositionOptions = {}
) {
  const initialConfig = loadConfig();
  const runtime: PieditorRuntime = {
    activeContext: null,
    activeEditor: null,
    activeEditorTui: null,
    activeFooterData: null,
    activeFooterTui: null,
    fixedEditorCompositor: null,
    fixedEditorConfig: initialConfig.fixedEditor,
    fixedEditorConfigListeners: new Set(),
    fixedEditorInstallFailed: false,
  };

  function emitFixedEditorConfigChanged(): void {
    const config = runtime.fixedEditorConfig;
    for (const listener of runtime.fixedEditorConfigListeners) {
      listener(config);
    }
  }

  function notifyFixedEditorInstallFailed(): void {
    runtime.activeContext?.ui.notify(
      "pieditor fixed-editor could not attach; using the normal editor",
      "warning"
    );
  }

  function disposeFixedEditorCompositor(): void {
    runtime.fixedEditorCompositor?.dispose({
      resetExtendedKeyboardModes: true,
    });
    runtime.fixedEditorCompositor = null;
  }

  function getShowHardwareCursor(): boolean {
    return runtime.activeEditorTui?.getShowHardwareCursor() ?? false;
  }

  function copyFixedEditorSelection(text: string): void {
    const copy = options.copySelection ?? copyToClipboard;
    const copyPromise = Promise.resolve(copy(text));
    copyPromise.catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      runtime.activeContext?.ui.notify(
        `pieditor fixed-editor copy failed: ${message}`,
        "warning"
      );
    });
  }

  function installFixedEditorCompositor(): void {
    if (!runtime.fixedEditorConfig.enabled) {
      disposeFixedEditorCompositor();
      runtime.fixedEditorInstallFailed = false;
      return;
    }

    if (runtime.fixedEditorCompositor || runtime.fixedEditorInstallFailed) {
      return;
    }

    const editor = runtime.activeEditor;
    const tui = runtime.activeEditorTui;
    const footerTui = runtime.activeFooterTui;
    const terminal = tui?.terminal;
    if (!(editor && tui && footerTui && terminal)) {
      return;
    }

    let compositor: TerminalSplitCompositor | null = null;
    try {
      compositor = new TerminalSplitCompositor({
        tui,
        terminal,
        mouseScroll: runtime.fixedEditorConfig.mouseScroll,
        scrollUpShortcuts: runtime.fixedEditorConfig.scrollUpShortcuts,
        scrollDownShortcuts: runtime.fixedEditorConfig.scrollDownShortcuts,
        onCopySelection: copyFixedEditorSelection,
        getShowHardwareCursor,
        renderCluster: (width, terminalRows) => {
          const parts = editor.renderFixedEditorParts(width);
          return renderFixedEditorCluster({
            width,
            terminalRows,
            ...parts,
          });
        },
      });

      if (!compositor.install()) {
        runtime.fixedEditorInstallFailed = true;
        notifyFixedEditorInstallFailed();
        return;
      }

      compositor.hideRenderable(editor);
      runtime.fixedEditorCompositor = compositor;
      tui.requestRender();
    } catch {
      compositor?.dispose({ resetExtendedKeyboardModes: true });
      runtime.fixedEditorInstallFailed = true;
      notifyFixedEditorInstallFailed();
    }
  }

  function hasFixedEditorRefs(): boolean {
    return Boolean(
      runtime.activeEditor &&
        runtime.activeEditorTui &&
        runtime.activeFooterTui &&
        runtime.activeEditorTui.terminal
    );
  }

  function reconcileFixedEditorCompositor(): void {
    if (!(runtime.fixedEditorConfig.enabled && hasFixedEditorRefs())) {
      disposeFixedEditorCompositor();
      runtime.activeEditorTui?.requestRender();
      runtime.fixedEditorInstallFailed = false;
      return;
    }

    installFixedEditorCompositor();
  }

  return {
    attachEditor(ctx: ExtensionContext): void {
      if (!ctx.hasUI) {
        return;
      }

      runtime.activeContext = ctx;
      const config = loadConfig();
      runtime.fixedEditorConfig = config.fixedEditor;
      runtime.fixedEditorInstallFailed = false;
      emitFixedEditorConfigChanged();
      let warnedMissingDoubleEscapeCommand = false;

      const getDoubleEscapeCommand = () => {
        const commandState = getDoubleEscapeCommandState(
          pi,
          config.doubleEscapeCommand
        );

        if (
          commandState.command &&
          !commandState.isVisible &&
          !warnedMissingDoubleEscapeCommand
        ) {
          ctx.ui.notify(
            `pieditor: '/${commandState.command}' is not currently visible in slash commands; submitting it anyway`,
            "warning"
          );
        }

        warnedMissingDoubleEscapeCommand = Boolean(
          commandState.command && !commandState.isVisible
        );

        return commandState.command;
      };

      const factory = (
        tui: TUI,
        theme: EditorTheme,
        keybindings: KeybindingsManager
      ) => {
        runtime.activeEditorTui = tui;
        runtime.activeEditor = new EnhancedEditor(
          tui,
          theme,
          keybindings,
          ctx.ui,
          {
            getDoubleEscapeCommand,
            canTriggerDoubleEscapeCommand: () => {
              if (!runtime.activeContext) {
                return false;
              }
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
        reconcileFixedEditorCompositor();
        return runtime.activeEditor;
      };

      ctx.ui.setEditorComponent(factory);
      ctx.ui.setFooter(
        (tui: TUI, _theme: Theme, footerData: ReadonlyFooterDataProvider) => {
          runtime.activeFooterTui = tui;
          runtime.activeFooterData = footerData;
          reconcileFixedEditorCompositor();
          const unsub = footerData.onBranchChange(() => tui.requestRender());

          return {
            dispose() {
              unsub();
              if (runtime.activeFooterData === footerData) {
                runtime.activeFooterData = null;
              }
              if (runtime.activeFooterTui === tui) {
                runtime.activeFooterTui = null;
              }
              reconcileFixedEditorCompositor();
            },
            invalidate() {
              // Footer data is pulled during EnhancedEditor.render().
            },
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

    detachEditor(): void {
      disposeFixedEditorCompositor();
      runtime.activeContext = null;
      runtime.activeEditor = null;
      runtime.activeEditorTui = null;
      runtime.activeFooterData = null;
      runtime.activeFooterTui = null;
      runtime.fixedEditorInstallFailed = false;
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

    handleMessageStart(event: { message?: { role?: unknown } }): void {
      if (event.message?.role === "user") {
        runtime.fixedEditorCompositor?.jumpToRootBottom();
      }
    },

    handleInput(
      event: Pick<InputEvent, "source">,
      ctx: ExtensionContext
    ): void {
      if (event.source === "interactive" && !ctx.isIdle()) {
        runtime.fixedEditorCompositor?.jumpToRootBottom();
      }
    },

    getFixedEditorConfig(): FixedEditorRuntimeConfig {
      return runtime.fixedEditorConfig;
    },

    setFixedEditorEnabled(enabled: boolean): void {
      runtime.fixedEditorConfig = {
        ...runtime.fixedEditorConfig,
        enabled,
      };
      runtime.fixedEditorInstallFailed = false;
      reconcileFixedEditorCompositor();
      emitFixedEditorConfigChanged();
    },

    onFixedEditorConfigChange(listener: FixedEditorConfigListener): () => void {
      runtime.fixedEditorConfigListeners.add(listener);
      return () => {
        runtime.fixedEditorConfigListeners.delete(listener);
      };
    },

    async pasteClipboardRaw(ctx: ExtensionContext): Promise<void> {
      if (!ctx.hasUI) {
        return;
      }
      if (!runtime.activeEditor) {
        ctx.ui.notify("Editor not ready", "warning");
        return;
      }
      await runtime.activeEditor.pasteClipboardRawAtCursor();
    },
  };
}
