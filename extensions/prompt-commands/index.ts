import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AgentSession,
  type ExtensionAPI,
  type PromptOptions,
  stripFrontmatter,
} from "@earendil-works/pi-coding-agent";

const PROMPTS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "prompts",
);
const ARGS_PLACEHOLDER = "$@";

function loadTemplate(name: string): { prefix: string; suffix: string } {
  const body = stripFrontmatter(
    readFileSync(join(PROMPTS_DIR, `${name}.md`), "utf8"),
  );
  const index = body.indexOf(ARGS_PLACEHOLDER);
  if (index === -1 || body.includes(ARGS_PLACEHOLDER, index + 1)) {
    throw new Error(`prompts/${name}.md must contain exactly one $@`);
  }
  return {
    prefix: body.slice(0, index),
    suffix: body.slice(index + ARGS_PLACEHOLDER.length),
  };
}

const COMMANDS = {
  "grill-me": loadTemplate("grill-me"),
  "show-me": loadTemplate("show-me"),
} as const;

type PromptCommandName = keyof typeof COMMANDS;
type PromptMethod = (text: string, options?: PromptOptions) => Promise<void>;
type Transformer = (text: string) => string;
type QueueOwner = symbol;

const whitespaceDelimiter = /\s/u;

interface QueuePatchRegistry {
  originalPrompt: PromptMethod;
  prompt: PromptMethod;
  promptExpansion: AsyncLocalStorage<boolean>;
  owners: Set<QueueOwner>;
}

const queuePatch = Symbol.for("supa-pi.prompt-pipeline-commands.queue-patch");
type QueuePatchRegistries = Map<QueuePrototype, QueuePatchRegistry>;
type GlobalWithQueuePatch = typeof globalThis & {
  [queuePatch]?: QueuePatchRegistries;
};
type QueuePrototype = AgentSession & {
  prompt: PromptMethod;
};

export function buildPromptCommandMessage(
  name: PromptCommandName,
  args: string,
): string {
  const command = COMMANDS[name];
  return `${command.prefix}${args}${command.suffix}`;
}

function expandRawPromptCommand(text: string): string {
  for (const name of Object.keys(COMMANDS) as PromptCommandName[]) {
    const prefix = `/${name}`;
    if (text === prefix) {
      return buildPromptCommandMessage(name, "");
    }
    if (
      text.startsWith(prefix) &&
      whitespaceDelimiter.test(text[prefix.length] ?? "")
    ) {
      return buildPromptCommandMessage(name, text.slice(prefix.length + 1));
    }
  }
  return text;
}

function addQueueOwner(owner: QueueOwner): void {
  const globals = globalThis as GlobalWithQueuePatch;
  const prototype = AgentSession.prototype as QueuePrototype;
  const registries = globals[queuePatch] ?? new Map();
  const existing = registries.get(prototype);
  if (existing) {
    existing.owners.add(owner);
    if (prototype.prompt === existing.originalPrompt) {
      prototype.prompt = existing.prompt;
    }
    return;
  }

  const prompt: PromptMethod = function prompt(text, options) {
    return registry.promptExpansion.run(
      options?.expandPromptTemplates ?? true,
      () => registry.originalPrompt.call(this, text, options),
    );
  };
  const registry: QueuePatchRegistry = {
    originalPrompt: prototype.prompt,
    prompt,
    promptExpansion: new AsyncLocalStorage<boolean>(),
    owners: new Set([owner]),
  };

  try {
    prototype.prompt = prompt;
    registries.set(prototype, registry);
    globals[queuePatch] = registries;
  } catch (error) {
    prototype.prompt = registry.originalPrompt;
    registries.delete(prototype);
    if (registries.size === 0) {
      delete globals[queuePatch];
    }
    throw error;
  }
}

function removeQueueOwner(owner: QueueOwner): void {
  const globals = globalThis as GlobalWithQueuePatch;
  const registries = globals[queuePatch];
  const prototype = AgentSession.prototype as QueuePrototype;
  const registry = registries?.get(prototype);
  if (!registry) {
    return;
  }

  registry.owners.delete(owner);
  if (registry.owners.size > 0) {
    return;
  }

  const cleanup = () => {
    if (registry.owners.size > 0) {
      return;
    }
    if (prototype.prompt === registry.prompt) {
      prototype.prompt = registry.originalPrompt;
    }
    if (prototype.prompt !== registry.originalPrompt) {
      return;
    }
    registries.delete(prototype);
    if (registries.size === 0) {
      delete globals[queuePatch];
    }
  };
  cleanup();
  if (registries.get(prototype) === registry) {
    setTimeout(cleanup, 0);
  }
}

function promptExpansionEnabled(): boolean {
  const globals = globalThis as GlobalWithQueuePatch;
  const prototype = AgentSession.prototype as QueuePrototype;
  return (
    globals[queuePatch]?.get(prototype)?.promptExpansion.getStore() ?? true
  );
}

export function createPromptCommandsExtension(
  transform: Transformer = expandRawPromptCommand,
): (pi: ExtensionAPI) => void {
  return (pi) => {
    const owner = Symbol("prompt-commands-owner");
    let active = true;
    addQueueOwner(owner);

    pi.on("session_start", () => {
      if (active) {
        return;
      }
      addQueueOwner(owner);
      active = true;
    });
    pi.on("session_shutdown", () => {
      if (!active) {
        return;
      }
      removeQueueOwner(owner);
      active = false;
    });
    pi.on("input", (event) => {
      if (!promptExpansionEnabled()) {
        return { action: "continue" };
      }
      const text = transform(event.text);
      if (text === event.text) {
        return { action: "continue" };
      }
      return { action: "transform", text };
    });
  };
}

export default createPromptCommandsExtension();
