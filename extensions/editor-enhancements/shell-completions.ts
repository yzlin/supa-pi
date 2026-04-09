/**
 * Shell completion logic extracted from @extensions/shell-completions
 *
 * This file intentionally does NOT register an extension.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { CompletionResult, ShellInfo, ShellType } from "./shell/types.js";
import { getFishCompletions } from "./shell/fish.js";
import { getBashCompletions } from "./shell/bash.js";
import { getZshCompletions } from "./shell/zsh.js";

export type { CompletionResult, ShellInfo, ShellType } from "./shell/types.js";

function detectShellType(shellPath: string): ShellType {
    const name = path.basename(shellPath);
    if (name === "fish" || name.startsWith("fish")) return "fish";
    if (name === "zsh" || name.startsWith("zsh")) return "zsh";
    return "bash";
}

function findBashPath(): string | undefined {
    const bashPaths = [
        "/bin/bash",
        "/usr/bin/bash",
        "/usr/local/bin/bash",
        "/opt/homebrew/bin/bash",
    ];

    for (const bashPath of bashPaths) {
        if (fs.existsSync(bashPath)) {
            return bashPath;
        }
    }

    return undefined;
}

export function findCompletionShell(): ShellInfo {
    // First, try user's $SHELL - they've configured their completions there
    const userShell = process.env.SHELL;
    if (userShell && fs.existsSync(userShell)) {
        const shellType = detectShellType(userShell);
        // Only use it if it's a shell we support (fish/zsh/bash)
        if (shellType === "fish" || shellType === "zsh" || shellType === "bash") {
            return { path: userShell, type: shellType };
        }
    }

    // If user's shell isn't suitable, prefer fish for best completions
    const fishPaths = [
        "/opt/homebrew/bin/fish",
        "/usr/local/bin/fish",
        "/usr/bin/fish",
        "/bin/fish",
    ];
    for (const fishPath of fishPaths) {
        if (fs.existsSync(fishPath)) {
            return { path: fishPath, type: "fish" };
        }
    }

    // Then zsh
    const zshPaths = [
        "/bin/zsh",
        "/usr/bin/zsh",
        "/usr/local/bin/zsh",
        "/opt/homebrew/bin/zsh",
    ];
    for (const zshPath of zshPaths) {
        if (fs.existsSync(zshPath)) {
            return { path: zshPath, type: "zsh" };
        }
    }

    // Bash fallback
    const bashPaths = [
        "/bin/bash",
        "/usr/bin/bash",
        "/usr/local/bin/bash",
        "/opt/homebrew/bin/bash",
    ];
    for (const bashPath of bashPaths) {
        if (fs.existsSync(bashPath)) {
            return { path: bashPath, type: "bash" };
        }
    }

    return { path: "/bin/bash", type: "bash" };
}

function extractCompletionContext(text: string): {
    commandLine: string;
    prefix: string;
} {
    // Remove ! or !! prefix
    let commandLine = text.trimStart();
    if (commandLine.startsWith("!!")) {
        commandLine = commandLine.slice(2);
    } else if (commandLine.startsWith("!")) {
        commandLine = commandLine.slice(1);
    }

    const trimmed = commandLine.trimStart();

    // If ends with space, completing a new word
    if (trimmed.endsWith(" ")) {
        return { commandLine: trimmed, prefix: "" };
    }

    // Last word is the prefix
    const words = trimmed.split(/\s+/);
    const prefix = words[words.length - 1] || "";

    return { commandLine: trimmed, prefix };
}

/**
 * Get shell completions for a command line.
 * Returns null if the user hasn't configured completions for their shell.
 */
export function getShellCompletions(text: string, cwd: string, shell: ShellInfo): CompletionResult | null {
    const { commandLine } = extractCompletionContext(text);

    if (!commandLine.trim()) {
        return null;
    }

    switch (shell.type) {
        case "fish":
            // Fish always has completions (it's a core feature)
            return getFishCompletions(commandLine, cwd, shell.path);
        case "bash":
            // Bash: only works if bash-completion is available
            return getBashCompletions(commandLine, cwd, shell.path);
        case "zsh": {
            // Try bash-completion first as a best-effort fallback for zsh users
            const fallbackBashPath = findBashPath();
            if (fallbackBashPath) {
                const bashResult = getBashCompletions(commandLine, cwd, fallbackBashPath);
                if (bashResult) return bashResult;
            }
            return getZshCompletions(commandLine, cwd, shell.path);
        }
        default:
            return null;
    }
}
