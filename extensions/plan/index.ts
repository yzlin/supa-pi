import * as fs from "node:fs";
import * as path from "node:path";

import { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("plan", {
    description: "Start a planning session: /plan <what to build>",
    handler: async (args, ctx) => {
      const task = (args ?? "").trim();
      if (!task) {
        ctx.ui.notify("Usage: /plan <what to build>", "warning");
        return;
      }

      // Load the plan skill from the subagents extension directory
      const promptPath = path.join(
        path.dirname(new URL(import.meta.url).pathname),
        "prompt.md"
      );
      const prompt = fs.readFileSync(promptPath, "utf8").trim();
      pi.sendUserMessage(`${prompt}\n\nTask: ${task}`);
    },
  });
}
