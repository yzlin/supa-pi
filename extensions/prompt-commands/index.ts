import { AsyncLocalStorage } from "node:async_hooks";

import {
  AgentSession,
  type ExtensionAPI,
  type PromptOptions,
} from "@earendil-works/pi-coding-agent";

const COMMANDS = {
  "grill-me": {
    prefix:
      "Use the `grill-me` wrapper skill as canonical for this explicit command.\n\nPlan:\n",
    suffix: "",
  },
  "research-brief": {
    prefix:
      "This requests one research brief only. It does not start persistent research mode; apply the requirements to this request and do not carry them into later turns unless the user separately asks for persistent research mode.\n\nResearch the following topic in strict evidence mode:\n\n",
    suffix:
      "\n\nRequirements:\n- Do not guess.\n- Cite every factual claim.\n- Prefer primary or official sources.\n- Quote relevant passages before analyzing documents.\n- Separate verified facts from inferences.\n- If evidence is missing or conflicting, say so clearly.\n\nOutput:\n1. Short answer\n2. Evidence\n3. Open uncertainties\n4. Sources",
  },
  "show-me": {
    prefix:
      "Use the `showing-me` skill as canonical for this explicit command.\n\nTopic:\n",
    suffix: "",
  },
  wayfinder: {
    prefix:
      "Use the `wayfinder` skill as canonical for this explicit command.\n\nRequest:\n",
    suffix: "",
  },
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
  args: string
): string {
  const command = COMMANDS[name];
  return `${command.prefix}${args}${command.suffix}`;
}

export function expandRawPromptCommand(text: string): string {
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

  let registry: QueuePatchRegistry;
  const prompt: PromptMethod = function prompt(text, options) {
    return registry.promptExpansion.run(
      options?.expandPromptTemplates ?? true,
      () => registry.originalPrompt.call(this, text, options)
    );
  };
  registry = {
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
  transform: Transformer = expandRawPromptCommand
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
