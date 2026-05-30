import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { formatDocsList, listDocs } from "./core";

export default function docsListExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "docs_list",
    label: "Docs List",
    description:
      "List project markdown docs with summary and read_when metadata. Defaults to cwd/docs; accepts an optional safe relative path.",
    promptSnippet:
      "Discover project markdown docs with summary and read_when metadata before coding",
    promptGuidelines: [
      "Use docs_list when the user asks for docs discovery or relevant project guidance says to discover docs before coding.",
      "Keep usage narrow: do not call docs_list for unrelated code search or implementation work.",
    ],
    parameters: Type.Object({
      path: Type.Optional(
        Type.String({
          description:
            "Optional relative docs directory path. Leading @ is ignored. Absolute paths and paths escaping cwd are rejected.",
        })
      ),
    }),
    execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const result = listDocs({ cwd: ctx.cwd, path: params.path });
        return Promise.resolve({
          content: [{ type: "text" as const, text: formatDocsList(result) }],
          details: result,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return Promise.resolve({
          content: [{ type: "text" as const, text: `Error: ${message}` }],
          details: {
            ok: false,
            error: true,
            message,
            warnings: [{ message }],
            warningCount: 1,
          },
          isError: true,
        });
      }
    },
  });
}
