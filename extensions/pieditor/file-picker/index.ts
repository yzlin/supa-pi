/**
 * File Picker Extension
 *
 * Replaces the built-in @ file picker with an enhanced file browser.
 * Selected files are attached to the prompt as context.
 *
 * Based on codemap extension by @kcosr
 */

import type { ExtensionUIContext } from "@mariozechner/pi-coding-agent";

import { FileBrowserComponent } from "./browser.js";
import { highlightPreviewLine } from "./highlight.js";
import {
  type FilePickerRuntime,
  getSharedFilePickerRuntime,
} from "./runtime.js";
import { inferPreviewThemeMode, truncateVisibleText } from "./theme.js";
import type { FileBrowserAction } from "./types.js";

export { FileBrowserComponent, highlightPreviewLine, truncateVisibleText };

export async function openFilePicker(
  ui: ExtensionUIContext,
  runtime: FilePickerRuntime = getSharedFilePickerRuntime()
): Promise<string> {
  const result = await ui.custom<FileBrowserAction>(
    (_tui, theme, _kb, done) =>
      new FileBrowserComponent(
        done,
        runtime,
        inferPreviewThemeMode(theme),
        runtime.config.previewHighlightMode,
        (text) => theme.fg("border", text)
      ),
    {
      overlay: true,
      overlayOptions: {
        anchor: "center",
        width: "92%",
        minWidth: 80,
        maxHeight: "94%",
        margin: 1,
      },
    }
  );

  if (!result || result.action === "cancel") return "";
  const paths = result.paths ?? [];
  if (paths.length === 0) return "";

  const refs = paths
    .map((path) => `@${path.path}${path.isDirectory ? "/" : ""}`)
    .join(" ");
  ui.notify(`Added ${paths.length} file${paths.length > 1 ? "s" : ""}`, "info");
  return refs;
}
