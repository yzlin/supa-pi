import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

import {
  createSkillOperationActivity,
  type SkillOperationActivity,
} from "./activity";
import {
  createSkillsManagerPaths,
  detectDirtySkills,
  discoverBundledSkillPaths,
  type ListedSkillSource,
  type ManagedSkillEntry,
  readManagedManifest,
} from "./core";
import {
  buildSkillInventoryModel,
  parseSkillCommandInitialState,
  type SkillInventoryModel,
} from "./model";
import {
  BUNDLED_SKILLS_DIR,
  findRemoteUpdates,
  formatList,
  installLocalSource,
  type Prompter,
  removeManaged,
  searchSkills,
  updateManaged,
} from "./ops";
import {
  createSkillsInstallPickerComponent,
  createSkillsManagerComponent,
  SKILLS_MANAGER_OVERLAY_OPTIONS,
  type SkillsManagerRemoval,
} from "./ui";

const STATUS_KEY = "skills";
const WHITESPACE_RE = /\s+/;

function withSkillOperationPromptsSuspended(
  ctx: ExtensionCommandContext,
  activity: SkillOperationActivity,
): ExtensionCommandContext {
  const resumeAfterPrompt = (): void => {
    activity.start();
  };
  const suspend = (): void => {
    activity.suspendBeforePrompt();
  };
  const ui = {
    ...ctx.ui,
    async select(...args: Parameters<typeof ctx.ui.select>) {
      suspend();
      const result = await ctx.ui.select(...args);
      resumeAfterPrompt();
      return result;
    },
    async confirm(...args: Parameters<typeof ctx.ui.confirm>) {
      suspend();
      const result = await ctx.ui.confirm(...args);
      resumeAfterPrompt();
      return result;
    },
    async input(...args: Parameters<typeof ctx.ui.input>) {
      suspend();
      const result = await ctx.ui.input(...args);
      resumeAfterPrompt();
      return result;
    },
    notify(...args: Parameters<typeof ctx.ui.notify>) {
      suspend();
      ctx.ui.notify(...args);
    },
  };
  if (typeof ctx.ui.custom === "function") {
    const custom = ctx.ui.custom.bind(ctx.ui);
    ui.custom = (async (...args: Parameters<typeof custom>) => {
      suspend();
      const result = await custom(...args);
      resumeAfterPrompt();
      return result;
    }) as typeof custom;
  }
  return { ...ctx, ui } as ExtensionCommandContext;
}

export function skillOperationLabel(
  subcommand: string,
  enteredSubcommand = subcommand,
): string {
  switch (subcommand) {
    case "search":
      return "Searching skills…";
    case "install":
      return "Installing skill…";
    case "update":
      return "Updating skills…";
    case "remove":
      return "Removing skill…";
    case "list":
      return "Loading skills…";
    default:
      return `Running skill ${enteredSubcommand}…`;
  }
}

const COMMANDS: AutocompleteItem[] = [
  {
    value: "list",
    label: "list",
    description: "List installed and bundled skills",
  },
  {
    value: "search",
    label: "search",
    description: "Search skills.sh cache or web",
  },
  {
    value: "install ",
    label: "install",
    description: "Install from a local skill directory",
  },
  {
    value: "update",
    label: "update",
    description: "Update remote managed skills",
  },
  { value: "remove ", label: "remove", description: "Remove a managed skill" },
];

function notifyError(ctx: ExtensionCommandContext, error: unknown): void {
  ctx.ui.notify(
    error instanceof Error ? error.message : String(error),
    "error",
  );
}

function createCommandPrompter(
  ctx: ExtensionCommandContext,
  activity?: SkillOperationActivity,
): Prompter {
  const prompter: Prompter = {
    select: (title, options) => ctx.ui.select(title, options),
    confirm: (title, message) => ctx.ui.confirm(title, message),
    input: (title, placeholder) => ctx.ui.input(title, placeholder),
    notify: (message, level) => ctx.ui.notify(message, level),
    setUpdateCount: (count) => refreshStatus(ctx, count),
  };
  if (activity) {
    prompter.progress = (label) => activity.setLabel(label);
  }
  if (ctx.hasUI && typeof ctx.ui.custom === "function") {
    prompter.pickSkills = (entries, manifest) =>
      ctx.ui.custom<string[] | undefined>(
        (_tui, theme, _kb, done) =>
          createSkillsInstallPickerComponent({
            inventory: installPickerInventory(
              entries,
              manifest.skills,
              new Set(detectDirtySkills(manifest).map((skill) => skill.id)),
            ),
            theme,
            done,
          }),
        {
          overlay: true,
          overlayOptions: {
            anchor: "center",
            width: "90%",
            minWidth: 64,
            maxHeight: "95%",
            margin: 1,
          },
        },
      );
  }
  return prompter;
}

async function showSkillsManager(
  ctx: ExtensionCommandContext,
  managed: ManagedSkillEntry[],
  initialQuery = "",
): Promise<void> {
  const dirty = detectDirtySkills({ version: 1, skills: managed });
  const dirtyIds = new Set(dirty.map((skill) => skill.id));
  const inventory = buildSkillInventoryModel({
    managed,
    bundledSkillPaths: discoverBundledSkillPaths(BUNDLED_SKILLS_DIR),
    dirtyIds,
  });
  const fallbackText = formatList(managed);
  if (!ctx.hasUI || typeof ctx.ui.custom !== "function") {
    ctx.ui.notify(fallbackText, "info");
    return;
  }
  const removal = await ctx.ui.custom<SkillsManagerRemoval | undefined>(
    (tui, theme, _kb, done) =>
      createSkillsManagerComponent({
        inventory,
        initialQuery,
        theme,
        done,
        hostTui: tui,
      }),
    {
      overlay: true,
      overlayOptions: SKILLS_MANAGER_OVERLAY_OPTIONS,
    },
  );
  if (!removal) {
    return;
  }
  try {
    await removeManaged(createCommandPrompter(ctx), {
      skillNames: removal.id ? [removal.id] : undefined,
    });
  } catch (error) {
    notifyError(ctx, error);
  }
  await showSkillsManager(
    ctx,
    readManagedManifest(createSkillsManagerPaths().manifestPath).skills,
    removal.query,
  );
}

function installPickerInventory(
  entries: ListedSkillSource[],
  managed: ManagedSkillEntry[],
  dirtyIds: ReadonlySet<string>,
): SkillInventoryModel {
  const managedById = new Map(managed.map((skill) => [skill.id, skill]));
  const items = entries.map((entry) => {
    const installed = managedById.get(entry.id);
    let dirtyStatus: "dirty" | "clean" | undefined;
    if (installed) {
      dirtyStatus = dirtyIds.has(installed.id) ? "dirty" : "clean";
    }
    return {
      id: entry.id,
      name: entry.name,
      description: entry.description,
      kind: installed ? ("managed" as const) : ("bundled" as const),
      path: entry.sourceDir,
      displayPath: entry.sourceDir,
      source: installed?.source,
      dirtyStatus,
    };
  });
  return {
    managed: items.filter((item) => item.kind === "managed"),
    bundled: items.filter((item) => item.kind === "bundled"),
    all: items,
  };
}

function updateStatusText(updateCount: number): string | undefined {
  if (updateCount === 0) {
    return;
  }
  const suffix = updateCount === 1 ? "" : "s";
  return `Skills: ${updateCount} update${suffix}`;
}

function refreshStatus(ctx: ExtensionCommandContext, updateCount = 0): void {
  ctx.ui.setStatus(STATUS_KEY, updateStatusText(updateCount));
}

async function checkRemoteUpdatesInBackground(
  ctx: ExtensionCommandContext,
  isActive: () => boolean,
): Promise<void> {
  let updateCount: number;
  try {
    const { updates } = await findRemoteUpdates({ suppressFailures: true });
    updateCount = updates.length;
  } catch {
    updateCount = 0;
  }
  // The session may have been replaced or reloaded while the check ran;
  // its ctx then throws on every access.
  if (!isActive()) {
    return;
  }
  refreshStatus(ctx, updateCount);
  if (updateCount > 0) {
    ctx.ui.notify(
      `${updateCount} managed skill update${updateCount === 1 ? "" : "s"} available. Run /skill update.`,
      "info",
    );
  }
}

export default function skillsExtension(pi: ExtensionAPI): void {
  pi.on("resources_discover", () => ({
    skillPaths: [
      ...discoverBundledSkillPaths(BUNDLED_SKILLS_DIR),
      ...readManagedManifest(
        createSkillsManagerPaths().manifestPath,
      ).skills.flatMap((skill) => discoverBundledSkillPaths(skill.installPath)),
    ],
  }));

  let sessionActive = false;
  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) {
      return;
    }
    sessionActive = true;
    queueMicrotask(() => {
      checkRemoteUpdatesInBackground(
        ctx as ExtensionCommandContext,
        () => sessionActive,
      ).catch(() => undefined);
    });
  });
  pi.on("session_shutdown", () => {
    sessionActive = false;
  });

  pi.registerCommand("skill", {
    description: "/skill list|search|install|update|remove",
    getArgumentCompletions(argumentPrefix) {
      const trimmed = argumentPrefix.trimStart();
      return COMMANDS.filter((item) => item.value.startsWith(trimmed));
    },
    async handler(args, ctx) {
      const parsed = parseSkillCommandInitialState(args ?? "");
      const subcommand = parsed.action;
      const operand = parsed.operand;
      const activity = createSkillOperationActivity(ctx);
      const label = skillOperationLabel(subcommand, parsed.enteredSubcommand);
      const activityCtx = withSkillOperationPromptsSuspended(ctx, activity);
      const prompter = createCommandPrompter(activityCtx, activity);
      activity.start(label);
      try {
        switch (subcommand) {
          case "list":
            await showSkillsManager(
              activityCtx,
              readManagedManifest(createSkillsManagerPaths().manifestPath)
                .skills,
              operand,
            );
            break;
          case "search":
            await searchSkills(prompter, operand);
            break;
          case "install":
            await installLocalSource(
              prompter,
              operand ||
                (await activityCtx.ui.input(
                  "Install skill",
                  "local skill directory",
                )) ||
                "",
            );
            break;
          case "update":
            await updateManaged(prompter, {
              skillNames: operand
                .split(WHITESPACE_RE)
                .filter(Boolean)
                .slice(0, 1),
            });
            break;
          case "remove":
            await removeManaged(prompter, {
              skillNames: operand ? [operand] : undefined,
            });
            break;
          case "unknown":
            activity.suspendBeforePrompt();
            ctx.ui.notify(
              "Usage: /skill list|search|install|update|remove",
              "warning",
            );
        }
        activity.finishSuccess();
      } catch (error) {
        activity.finishFailure();
        notifyError(ctx, error);
      }
    },
  });
}
