import { AsyncLocalStorage } from "node:async_hooks";

import type { ImageContent } from "@earendil-works/pi-ai";
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
    prefix: "Research the following topic in strict evidence mode:\n\n",
    suffix:
      "\n\nRequirements:\n- Do not guess.\n- Cite every factual claim.\n- Prefer primary or official sources.\n- Quote relevant passages before analyzing documents.\n- Separate verified facts from inferences.\n- If evidence is missing or conflicting, say so clearly.\n\nOutput:\n1. Short answer\n2. Evidence\n3. Open uncertainties\n4. Sources",
  },
  "show-me": {
    prefix:
      "Use the `showing-me` skill as canonical for this explicit command.\n\nTopic:\n",
    suffix: "",
  },
} as const;

type PromptCommandName = keyof typeof COMMANDS;
type PromptMethod = (text: string, options?: PromptOptions) => Promise<void>;
type QueueMethod = (text: string, images?: ImageContent[]) => Promise<void>;
type Transformer = (text: string) => string;
type QueueOwner = symbol;

const whitespaceDelimiter = /\s/u;
const identityTransformer: Transformer = (text) => text;

interface QueuePatchRegistry {
  originalPrompt: PromptMethod;
  originalSteer: QueueMethod;
  originalFollowUp: QueueMethod;
  prompt: PromptMethod;
  steer: QueueMethod;
  followUp: QueueMethod;
  promptExpansion: AsyncLocalStorage<boolean>;
  owners: Map<QueueOwner, Transformer>;
}

const queuePatch = Symbol.for("supa-pi.prompt-pipeline-commands.queue-patch");
type QueuePatchRegistries = Map<QueuePrototype, QueuePatchRegistry>;
type GlobalWithQueuePatch = typeof globalThis & {
  [queuePatch]?: QueuePatchRegistries;
};
type QueuePrototype = AgentSession & {
  prompt: PromptMethod;
  steer: QueueMethod;
  followUp: QueueMethod;
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

function currentTransformer(registry: QueuePatchRegistry): Transformer {
  const transformers = [...registry.owners.values()];
  return transformers.at(-1) ?? identityTransformer;
}

function addQueueOwner(owner: QueueOwner, transform: Transformer): void {
  const globals = globalThis as GlobalWithQueuePatch;
  const prototype = AgentSession.prototype as QueuePrototype;
  const registries = globals[queuePatch] ?? new Map();
  const existing = registries.get(prototype);
  if (existing) {
    existing.owners.set(owner, transform);
    if (prototype.prompt === existing.originalPrompt) {
      prototype.prompt = existing.prompt;
    }
    if (prototype.steer === existing.originalSteer) {
      prototype.steer = existing.steer;
    }
    if (prototype.followUp === existing.originalFollowUp) {
      prototype.followUp = existing.followUp;
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
  const steer: QueueMethod = function steer(text, images) {
    return registry.originalSteer.call(
      this,
      currentTransformer(registry)(text),
      images
    );
  };
  const followUp: QueueMethod = function followUp(text, images) {
    return registry.originalFollowUp.call(
      this,
      currentTransformer(registry)(text),
      images
    );
  };
  registry = {
    originalPrompt: prototype.prompt,
    originalSteer: prototype.steer,
    originalFollowUp: prototype.followUp,
    prompt,
    steer,
    followUp,
    promptExpansion: new AsyncLocalStorage<boolean>(),
    owners: new Map([[owner, transform]]),
  };

  try {
    prototype.prompt = prompt;
    prototype.steer = steer;
    prototype.followUp = followUp;
    registries.set(prototype, registry);
    globals[queuePatch] = registries;
  } catch (error) {
    prototype.prompt = registry.originalPrompt;
    prototype.steer = registry.originalSteer;
    prototype.followUp = registry.originalFollowUp;
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
    if (prototype.steer === registry.steer) {
      prototype.steer = registry.originalSteer;
    }
    if (prototype.followUp === registry.followUp) {
      prototype.followUp = registry.originalFollowUp;
    }
    if (
      prototype.prompt !== registry.originalPrompt ||
      prototype.steer !== registry.originalSteer ||
      prototype.followUp !== registry.originalFollowUp
    ) {
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
    addQueueOwner(owner, transform);

    pi.on("session_start", () => {
      if (active) {
        return;
      }
      addQueueOwner(owner, transform);
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
