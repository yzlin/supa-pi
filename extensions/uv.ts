/**
 * UV Extension - Redirects Python tooling to uv equivalents
 *
 * Blocks agent bash tool calls that use Python tooling uv replaces, returning
 * the equivalent uv commands as the block reason. Uses `tool_call` instead of
 * registering `bash` so it composes with the rtk bash override.
 *
 * Blocked commands (including explicit paths like `.venv/bin/python`):
 * - pip/pip3: suggest `uv add` or `uv run --with`
 * - poetry: suggest uv init, uv add, uv sync, uv run
 * - python -m pip, python -m venv, python -m py_compile
 *
 * Adapted from https://github.com/mitsuhiko/agent-stuff
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

export function getBlockedCommandMessage(command: string): string | null {
  // Match commands at the start of a shell segment (start/newline/; /&& /|| /|)
  const pipCommandPattern = /(?:^|\n|[;|&]{1,2})\s*(?:\S+\/)?pip\s*(?:$|\s)/m;
  const pip3CommandPattern = /(?:^|\n|[;|&]{1,2})\s*(?:\S+\/)?pip3\s*(?:$|\s)/m;
  const poetryCommandPattern =
    /(?:^|\n|[;|&]{1,2})\s*(?:\S+\/)?poetry\s*(?:$|\s)/m;

  // Match python invocations including explicit paths like .venv/bin/python
  // and .venv/bin/python3.12.
  const pythonPipPattern =
    /(?:^|\n|[;|&]{1,2})\s*(?:\S+\/)?python(?:3(?:\.\d+)?)?\b[^\n;|&]*(?:\s-m\s*pip\b|\s-mpip\b)/m;
  const pythonVenvPattern =
    /(?:^|\n|[;|&]{1,2})\s*(?:\S+\/)?python(?:3(?:\.\d+)?)?\b[^\n;|&]*(?:\s-m\s*venv\b|\s-mvenv\b)/m;
  const pythonPyCompilePattern =
    /(?:^|\n|[;|&]{1,2})\s*(?:\S+\/)?python(?:3(?:\.\d+)?)?\b[^\n;|&]*(?:\s-m\s*py_compile\b|\s-mpy_compile\b)/m;

  if (pipCommandPattern.test(command)) {
    return [
      "Error: pip is disabled. Use uv instead:",
      "",
      "  To install a package for a script: uv run --with PACKAGE python script.py",
      "  To add a dependency to the project: uv add PACKAGE",
      "",
    ].join("\n");
  }

  if (pip3CommandPattern.test(command)) {
    return [
      "Error: pip3 is disabled. Use uv instead:",
      "",
      "  To install a package for a script: uv run --with PACKAGE python script.py",
      "  To add a dependency to the project: uv add PACKAGE",
      "",
    ].join("\n");
  }

  if (poetryCommandPattern.test(command)) {
    return [
      "Error: poetry is disabled. Use uv instead:",
      "",
      "  To initialize a project: uv init",
      "  To add a dependency: uv add PACKAGE",
      "  To sync dependencies: uv sync",
      "  To run commands: uv run COMMAND",
      "",
    ].join("\n");
  }

  if (pythonPipPattern.test(command)) {
    return [
      "Error: 'python -m pip' is disabled. Use uv instead:",
      "",
      "  To install a package for a script: uv run --with PACKAGE python script.py",
      "  To add a dependency to the project: uv add PACKAGE",
      "",
    ].join("\n");
  }

  if (pythonVenvPattern.test(command)) {
    return [
      "Error: 'python -m venv' is disabled. Use uv instead:",
      "",
      "  To create a virtual environment: uv venv",
      "",
    ].join("\n");
  }

  if (pythonPyCompilePattern.test(command)) {
    return [
      "Error: 'python -m py_compile' is disabled because it writes .pyc files to __pycache__.",
      "",
      "  To verify syntax without bytecode output: uv run python -m ast path/to/file.py >/dev/null",
      "",
    ].join("\n");
  }

  return null;
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", (event) => {
    if (!isToolCallEventType("bash", event)) {
      return;
    }
    const blockedMessage = getBlockedCommandMessage(event.input.command);
    if (blockedMessage) {
      return { block: true, reason: blockedMessage };
    }
  });
}
