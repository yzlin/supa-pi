/*
 * Copied from `agent-stuff` by original author Armin Ronacher (mitsuhiko).
 * Source: https://github.com/mitsuhiko/agent-stuff/blob/main/extensions/trust-github-repos.ts
 * Original license: Apache License 2.0.
 * Local changes: attribution and repository formatting/lint rules, user-managed
 * owners config, /trust-github-repos command, and trust without remember.
 */

/**
 * Automatically trust checked-out repositories owned by trusted GitHub owners.
 *
 * This handles pi's project_trust event before project-local resources are
 * loaded. Trust is granted without remembering when every origin URL points at
 * a GitHub owner in the user's config. Missing or invalid config grants no trust.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type {
  ExtensionAPI,
  ProjectTrustEventResult,
} from "@earendil-works/pi-coding-agent";

const OWNER_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38})$/;
const WHITESPACE_PATTERN = /\s+/;
const REMOVE_PREFIX_PATTERN = /^remove\s+(.*)$/i;
const GIT_TIMEOUT_MS = 5000;
const USAGE = "Usage: /trust-github-repos [list|add <owner>|remove <owner>]";
const NEXT_START = "Changes apply on next Pi start.";

interface OwnersConfig {
  owners: string[];
  extra: Record<string, unknown>;
}

function getGlobalOwnersConfigPath(): string {
  return join(homedir(), ".pi", "agent", "trust-github-repos.json");
}

function normalizeOwner(owner: string): string {
  const normalized = owner.toLowerCase();
  if (!OWNER_PATTERN.test(normalized)) {
    throw new Error(`Invalid GitHub owner: ${owner}`);
  }
  return normalized;
}

function readOwnersConfig(configPath: string): OwnersConfig {
  if (!existsSync(configPath)) {
    return { owners: [], extra: {} };
  }

  try {
    const data: unknown = JSON.parse(readFileSync(configPath, "utf8"));
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new Error("Expected an object with an owners array");
    }
    const { owners, ...extra } = data as Record<string, unknown>;
    if (!Array.isArray(owners)) {
      throw new Error("Expected an owners array");
    }
    const normalized = owners.map((owner: unknown) => {
      if (typeof owner !== "string") {
        throw new Error("Owners must be strings");
      }
      return normalizeOwner(owner);
    });
    return { owners: [...new Set(normalized)].sort(), extra };
  } catch (error) {
    throw new Error(
      `Invalid trust-github-repos config ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function writeOwnersConfig(configPath: string, config: OwnersConfig): void {
  const nextConfig = {
    ...config.extra,
    owners: config.owners.toSorted(),
  };
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`);
}

interface GitHubRepo {
  owner: string;
  repo: string;
}

function trimGitSuffix(repo: string): string {
  return repo.replace(/\.git$/i, "");
}

function parseGitHubRemoteUrl(remoteUrl: string): GitHubRepo | null {
  const value = remoteUrl.trim();
  if (!value) {
    return null;
  }

  // SCP-like SSH syntax: git@github.com:owner/repo.git
  const scpMatch = value.match(
    /^(?:[^@/:\s]+@)?github\.com:([^/:\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i,
  );
  if (scpMatch) {
    return {
      owner: scpMatch[1],
      repo: trimGitSuffix(scpMatch[2]),
    };
  }

  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== "https:" && parsed.protocol !== "ssh:") ||
      parsed.hostname.toLowerCase() !== "github.com"
    ) {
      return null;
    }

    const parts = parsed.pathname
      .replace(/^\/+|\/+$/g, "")
      .split("/")
      .filter(Boolean);

    if (parts.length !== 2) {
      return null;
    }

    return {
      owner: decodeURIComponent(parts[0]),
      repo: trimGitSuffix(decodeURIComponent(parts[1])),
    };
  } catch {
    return null;
  }
}

async function getOriginRemoteUrls(
  pi: ExtensionAPI,
  cwd: string,
): Promise<string[]> {
  try {
    const result = await pi.exec(
      "git",
      ["remote", "get-url", "--all", "origin"],
      {
        cwd,
        timeout: GIT_TIMEOUT_MS,
      },
    );

    if (result.code !== 0) {
      return [];
    }

    return result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

export default function trustGitHubReposExtension(pi: ExtensionAPI): void {
  pi.on(
    "project_trust",
    async (event, ctx): Promise<ProjectTrustEventResult> => {
      let owners: Set<string>;
      try {
        owners = new Set(readOwnersConfig(getGlobalOwnersConfigPath()).owners);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (ctx.hasUI) {
          ctx.ui.notify(message, "error");
        } else {
          console.error(message);
        }
        return { trusted: "undecided" };
      }
      if (owners.size === 0) {
        return { trusted: "undecided" };
      }

      const originUrls = await getOriginRemoteUrls(pi, event.cwd);
      if (
        originUrls.length > 0 &&
        originUrls.every((url) => {
          const repo = parseGitHubRemoteUrl(url);
          return !!repo && owners.has(repo.owner.toLowerCase());
        })
      ) {
        return { trusted: "yes" };
      }

      return { trusted: "undecided" };
    },
  );

  pi.registerCommand("trust-github-repos", {
    description:
      "Manage trusted GitHub owners: /trust-github-repos [list|add <owner>|remove <owner>]",
    getArgumentCompletions(argumentPrefix) {
      const prefix = argumentPrefix.trimStart().toLowerCase();
      const removeMatch = prefix.match(REMOVE_PREFIX_PATTERN);
      if (removeMatch) {
        try {
          return readOwnersConfig(getGlobalOwnersConfigPath())
            .owners.filter((owner) => owner.startsWith(removeMatch[1]))
            .map((owner) => ({ value: `remove ${owner}`, label: owner }));
        } catch {
          return [];
        }
      }
      return ["list", "add", "remove"]
        .filter((value) => value.startsWith(prefix))
        .map((value) => ({ value, label: value }));
    },
    handler(args, ctx) {
      const parts = args.trim().split(WHITESPACE_PATTERN);
      const command = parts[0].toLowerCase() || "list";
      if (
        !["list", "add", "remove"].includes(command) ||
        parts.length !== (command === "list" ? 1 : 2)
      ) {
        ctx.ui.notify(USAGE, "error");
        return Promise.resolve();
      }

      const configPath = getGlobalOwnersConfigPath();
      try {
        const config = readOwnersConfig(configPath);
        if (command === "list") {
          const message =
            config.owners.length > 0
              ? `Trusted GitHub owners: ${config.owners.join(", ")}`
              : "No trusted owners.";
          ctx.ui.notify(`${message}\nConfig: ${configPath}`, "info");
          return Promise.resolve();
        }

        const owner = normalizeOwner(parts[1]);
        const present = config.owners.includes(owner);
        if (command === "add" && present) {
          ctx.ui.notify(`${owner} is already trusted. ${NEXT_START}`, "info");
          return Promise.resolve();
        }
        if (command === "remove" && !present) {
          ctx.ui.notify(`${owner} is not present. ${NEXT_START}`, "info");
          return Promise.resolve();
        }
        config.owners =
          command === "add"
            ? [...config.owners, owner]
            : config.owners.filter((saved) => saved !== owner);
        writeOwnersConfig(configPath, config);
        ctx.ui.notify(
          `${command === "add" ? "Added" : "Removed"} ${owner}. ${NEXT_START}`,
          "info",
        );
      } catch (error) {
        ctx.ui.notify(
          error instanceof Error ? error.message : String(error),
          "error",
        );
      }
      return Promise.resolve();
    },
  });
}
