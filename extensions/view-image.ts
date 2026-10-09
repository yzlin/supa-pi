/*
 * Copied from `agent-stuff` by original author Armin Ronacher (mitsuhiko).
 * Source: https://github.com/mitsuhiko/agent-stuff/blob/main/extensions/view-image.ts
 * Original license: Apache License 2.0.
 * Local changes: added this attribution notice and repository formatting/lint
 * rules (bound `execute` wrapper).
 */

import { homedir } from "node:os";

import {
  createReadToolDefinition,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

function shortenPath(path: string): string {
  const home = homedir();
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

export default function (pi: ExtensionAPI) {
  // createReadTool() only exposes the runtime AgentTool and drops its TUI
  // renderers. Keep the definition so view_image can reuse the read result
  // renderer, which leaves image attachments to Pi's inline image viewer.
  const readTool = createReadToolDefinition(process.cwd());

  pi.registerTool({
    name: "view_image",
    label: "View Image",
    description:
      "Read an image file and return it as an image attachment for visual inspection. Intended for image files only; use the read tool for text files. Supports jpg, png, gif, webp, and bmp.",
    parameters: readTool.parameters,
    prepareArguments: readTool.prepareArguments,
    executionMode: readTool.executionMode,
    execute: (...args) => readTool.execute(...args),

    renderCall(args, theme, context) {
      const text =
        (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const path = typeof args?.path === "string" ? args.path : "";
      const pathDisplay = path
        ? theme.fg("accent", shortenPath(path))
        : theme.fg("toolOutput", "...");
      text.setText(
        `${theme.fg("toolTitle", theme.bold("view_image"))} ${pathDisplay}`,
      );
      return text;
    },

    renderResult: readTool.renderResult,
  });
}
