import { describe, expect, it, spyOn } from "bun:test";
import * as childProcess from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

import {
  copyInstallPlan,
  createSkillsManagerPaths,
  githubSkillFolderHash,
  parseSkillSource,
  planInstallSkill,
  readManagedManifest,
  writeManagedManifest,
} from "./core";
import skillsExtension, { skillOperationLabel } from "./index";

describe("skills panel removal", () => {
  it.each([true, false])(
    "confirmation %s returns a fresh inventory",
    async (confirmed) => {
      const home = mkdtempSync(join(tmpdir(), "skills-panel-remove-"));
      const previousHome = process.env.HOME;
      const paths = createSkillsManagerPaths(join(home, ".pi", "agent"));
      const source = join(home, "source", "panel-demo");
      mkdirSync(source, { recursive: true });
      writeFileSync(
        join(source, "SKILL.md"),
        "---\nname: panel-demo\ndescription: Panel test\n---\nOriginal",
      );
      const skill = copyInstallPlan(planInstallSkill(source, paths), paths);
      writeFileSync(join(skill.installPath, "SKILL.md"), "Local edits");
      const events: string[] = [];
      const trash = spyOn(childProcess, "spawnSync").mockImplementation(((
        command: string,
        args: readonly string[],
      ) => {
        expect(command).toBe("trash");
        expect(args).toEqual([skill.installPath]);
        events.push("trash");
        renameSync(skill.installPath, join(home, "trashed-skill"));
        return { status: 0 } as ReturnType<typeof childProcess.spawnSync>;
      }) as typeof childProcess.spawnSync);
      let handler:
        | ((args: string, ctx: ExtensionCommandContext) => Promise<void>)
        | undefined;
      skillsExtension({
        on: () => undefined,
        registerCommand(_name, command) {
          handler = command.handler;
        },
      } as Pick<ExtensionAPI, "on" | "registerCommand"> as ExtensionAPI);
      let panels = 0;
      const ctx = {
        hasUI: true,
        ui: {
          setWidget: () => undefined,
          setStatus: () => undefined,
          notify: () => undefined,
          confirm(title: string, message: string) {
            events.push("confirm");
            expect(title).toBe("Remove dirty skill");
            expect(message).toContain("panel-demo");
            expect(existsSync(skill.installPath)).toBe(true);
            return Promise.resolve(confirmed);
          },
          custom(
            factory: Parameters<ExtensionCommandContext["ui"]["custom"]>[0],
          ) {
            expect(this).toBe(ctx.ui);
            return new Promise((resolve) => {
              const component = factory(
                { mode: "regular" } as never,
                {} as never,
                {} as never,
                resolve,
              ) as unknown as {
                render(): string[];
                handleInput(data: string): void;
              };
              panels += 1;
              if (panels === 1) {
                events.push("selection");
                component.handleInput("d");
                component.handleInput("q");
              } else {
                events.push("refresh");
                expect(component.render().join("\n")).toContain(
                  `Managed (${confirmed ? 0 : 1})`,
                );
                component.handleInput("q");
              }
            });
          },
        },
      } as unknown as ExtensionCommandContext;
      try {
        process.env.HOME = home;
        await handler?.("list panel-demo", ctx);
        expect(panels).toBe(2);
        expect(events).toEqual(
          confirmed
            ? ["selection", "confirm", "trash", "refresh"]
            : ["selection", "confirm", "refresh"],
        );
        expect(readManagedManifest(paths.manifestPath).skills.length).toBe(
          confirmed ? 0 : 1,
        );
        expect(existsSync(skill.installPath)).toBe(!confirmed);
      } finally {
        process.env.HOME = previousHome;
        trash.mockRestore();
      }
    },
  );
});

describe("skills command activity labels", () => {
  it("preserves known /skill subcommand labels", () => {
    expect(skillOperationLabel("list")).toBe("Loading skills…");
    expect(skillOperationLabel("search")).toBe("Searching skills…");
    expect(skillOperationLabel("install")).toBe("Installing skill…");
    expect(skillOperationLabel("update")).toBe("Updating skills…");
    expect(skillOperationLabel("remove")).toBe("Removing skill…");
  });

  it("uses the entered token for unknown /skill subcommand labels", () => {
    expect(skillOperationLabel("unknown", "wat")).toBe("Running skill wat…");
  });
});

async function runUpdateBatch(
  options: {
    failApply?: string;
    decline?: string;
    requestedId?: string;
    failCheck?: string;
    githubGroups?: boolean;
  } = {},
) {
  const home = mkdtempSync(join(tmpdir(), "skills-update-"));
  const previousHome = process.env.HOME;
  const paths = createSkillsManagerPaths(join(home, ".pi", "agent"));
  const names = ["alpha", "beta", "gamma"];
  const content = (name: string, body: string) =>
    `---\nname: ${name}\ndescription: Update test\n---\n${body}`;
  for (const name of names) {
    const source = join(home, "source", name);
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "SKILL.md"), content(name, "Original"));
    copyInstallPlan(planInstallSkill(source, paths), paths);
  }
  const manifest = readManagedManifest(paths.manifestPath);
  for (const skill of manifest.skills) {
    skill.source = parseSkillSource(
      `https://example.test/${skill.name}`,
    ).identity;
    if (options.githubGroups && skill.name !== "gamma") {
      // Two skills in one GitHub group count as one source check.
      skill.source = parseSkillSource(
        `owner/repo/tree/main/${skill.name}`,
      ).identity;
      skill.skillPath = skill.name;
      skill.skillFolderHash =
        githubSkillFolderHash(githubTree, skill.name) ?? undefined;
    }
    if (skill.name === options.decline) {
      writeFileSync(join(skill.installPath, "SKILL.md"), "Local edits");
    }
  }
  writeManagedManifest(paths.manifestPath, manifest);
  const requests = new Map<string, number>();
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((input) => {
    const url = String(input);
    if (url.startsWith("https://api.github.com/")) {
      return Promise.resolve(
        Response.json({ sha: "revision", tree: githubTree, truncated: false }),
      );
    }
    const name = names.find((candidate) => url.includes(`/${candidate}/`));
    if (!name) {
      throw new Error(`Unexpected URL: ${url}`);
    }
    const count = (requests.get(name) ?? 0) + 1;
    requests.set(name, count);
    if (
      (options.failApply === name && count === 2) ||
      options.failCheck === name
    ) {
      return Promise.resolve(new Response("unavailable", { status: 503 }));
    }
    return Promise.resolve(new Response(content(name, "Updated")));
  });
  const notifications: Array<{ message: string; level: string | undefined }> =
    [];
  const statuses: Array<{ key: string; text: string | undefined }> = [];
  const events: string[] = [];
  let handler:
    | ((args: string, ctx: ExtensionCommandContext) => Promise<void>)
    | undefined;
  skillsExtension({
    on: () => undefined,
    registerCommand(_name, command) {
      handler = command.handler;
    },
  } as Pick<ExtensionAPI, "on" | "registerCommand"> as ExtensionAPI);
  const ctx = {
    hasUI: true,
    ui: {
      setWidget(_key: string, value: unknown) {
        events.push(value ? "widget:start" : "widget:stop");
      },
      setStatus(key: string, text: string | undefined) {
        statuses.push({ key, text });
        if (key === "skills-activity" && text?.startsWith("Updating skills ")) {
          events.push(text);
        }
      },
      notify(message: string, level?: string) {
        notifications.push({ message, level });
        events.push("notify");
      },
      select: () => Promise.resolve("All updates"),
      confirm: () => Promise.resolve(false),
    },
  } as unknown as ExtensionCommandContext;
  try {
    process.env.HOME = home;
    await handler?.(`update ${options.requestedId ?? ""}`, ctx);
    return {
      notifications,
      statuses,
      events,
      installedContents: Object.fromEntries(
        readManagedManifest(paths.manifestPath).skills.map((skill) => [
          skill.name,
          readFileSync(join(skill.installPath, "SKILL.md"), "utf8"),
        ]),
      ),
      requests,
    };
  } finally {
    process.env.HOME = previousHome;
    fetchSpy.mockRestore();
    rmSync(home, { recursive: true, force: true });
  }
}

const githubTree = [
  { path: "alpha/SKILL.md", type: "blob" as const, sha: "alpha-sha" },
  { path: "beta/SKILL.md", type: "blob" as const, sha: "beta-sha" },
];

function progressLabels(result: Awaited<ReturnType<typeof runUpdateBatch>>) {
  return result.statuses
    .filter(({ key, text }) => key === "skills-activity" && text)
    .map(({ text }) => text);
}

describe("skills update batch", () => {
  it("reports one aggregate notification and counted check/apply progress", async () => {
    const result = await runUpdateBatch();
    expect(result.notifications).toEqual([
      {
        message:
          "Updated 3/3 skills: alpha, beta, gamma. Changes apply after /reload or next session.",
        level: "info",
      },
    ]);
    expect(progressLabels(result)).toEqual([
      "Updating skills…",
      "Checking sources 1/3 (https://example.test/alpha)",
      "Checking sources 2/3 (https://example.test/beta)",
      "Checking sources 3/3 (https://example.test/gamma)",
      // The picker resumes with the latest label, not the initial label.
      "Checking sources 3/3 (https://example.test/gamma)",
      "Updating skills 1/3: alpha",
      "Updating skills 2/3: beta",
      "Updating skills 3/3: gamma",
    ]);
    expect(
      result.events.slice(result.events.indexOf("Updating skills 1/3: alpha")),
    ).toEqual([
      "Updating skills 1/3: alpha",
      "widget:start",
      "Updating skills 2/3: beta",
      "widget:start",
      "Updating skills 3/3: gamma",
      "widget:start",
      "widget:stop",
      "notify",
      "widget:stop",
    ]);
    for (const name of ["alpha", "beta", "gamma"]) {
      expect(result.installedContents[name]).toContain("Updated");
    }
    expect(result.statuses).toContainEqual({ key: "skills", text: undefined });
  });

  it("counts GitHub groups and other candidates as check sources", async () => {
    const result = await runUpdateBatch({ githubGroups: true });
    expect(progressLabels(result)).toContain(
      "Checking sources 1/2 (owner/repo#main)",
    );
    expect(progressLabels(result)).toContain(
      "Checking sources 2/2 (https://example.test/gamma)",
    );
    expect(result.notifications[0]?.message).toContain(
      "Updated 1/1 skills: gamma.",
    );
  });

  it("continues after a mid-batch failure and leaves it pending", async () => {
    const result = await runUpdateBatch({ failApply: "beta" });
    expect(result.notifications).toEqual([
      {
        message:
          "Updated 2/3 skills: alpha, gamma. Failed: beta (Fetch failed: 503). Changes apply after /reload or next session.",
        level: "warning",
      },
    ]);
    expect(result.requests.get("gamma")).toBe(2);
    expect(result.installedContents.alpha).toContain("Updated");
    expect(result.installedContents.beta).toContain("Original");
    expect(result.installedContents.gamma).toContain("Updated");
    expect(result.statuses).toContainEqual({
      key: "skills",
      text: "Skills: 1 update",
    });
    expect(progressLabels(result)).toContain("Updating skills 3/3: gamma");
  });

  it("reports declined dirty overwrites as skipped and resumes the latest label", async () => {
    const result = await runUpdateBatch({ decline: "beta" });
    expect(result.notifications).toEqual([
      {
        message:
          "Updated 2/3 skills: alpha, gamma. Skipped: beta. Changes apply after /reload or next session.",
        level: "info",
      },
    ]);
    expect(result.requests.get("beta")).toBe(1);
    expect(result.installedContents.beta).toBe("Local edits");
    expect(result.installedContents.gamma).toContain("Updated");
    expect(
      progressLabels(result).filter(
        (label) => label === "Updating skills 2/3: beta",
      ),
    ).toHaveLength(2);
    expect(result.statuses).toContainEqual({
      key: "skills",
      text: "Skills: 1 update",
    });
  });

  it("keeps single-id updates counted as 1/1", async () => {
    const result = await runUpdateBatch({ requestedId: "beta" });
    expect(result.notifications[0]?.message).toContain(
      "Updated 1/1 skills: beta.",
    );
    expect(progressLabels(result)).toContain("Updating skills 1/1: beta");
    expect(result.requests.get("alpha")).toBe(1);
    expect(result.statuses).toContainEqual({
      key: "skills",
      text: "Skills: 2 updates",
    });
  });

  it("preserves requested-id check failures", async () => {
    const result = await runUpdateBatch({
      requestedId: "beta",
      failCheck: "beta",
    });
    expect(result.notifications).toHaveLength(1);
    expect(result.notifications[0]?.level).toBe("error");
    expect(result.notifications[0]?.message).toContain(
      "Unable to check 1 skill update source: beta",
    );
    expect(result.requests.get("gamma")).toBe(1);
  });
});
