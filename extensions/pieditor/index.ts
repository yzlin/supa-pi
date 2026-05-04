/**
 * pieditor
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

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { registerPieditorCommands } from "./commands.js";
import { createPieditorComposition } from "./composition.js";

export default function (pi: ExtensionAPI): void {
  const composition = createPieditorComposition(pi);
  registerPieditorCommands(pi, composition);

  pi.on("session_start", (_event, ctx) => {
    composition.attachEditor(ctx);
  });

  pi.on("session_shutdown", () => {
    composition.detachEditor();
  });

  pi.on("tool_result", (event) => {
    composition.handleToolResult(event);
  });

  pi.on("user_bash", (event) => {
    composition.handleUserBash(event.command);
  });

  pi.on("message_start", (event) => {
    composition.handleMessageStart(event);
  });

  pi.on("input", (event, ctx) => {
    composition.handleInput(event, ctx);
    return { action: "continue" };
  });

  // Provide alt+v raw clipboard paste (the only raw-paste feature you wanted)
  pi.registerShortcut("alt+v", {
    description:
      "Paste clipboard text raw into editor (bypasses [paste #..] markers)",
    handler: async (ctx) => {
      await composition.pasteClipboardRaw(ctx);
    },
  });
}
