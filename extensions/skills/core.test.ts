import { describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyRemovePlan,
  computeSkillFilesHash,
  copyInstallPlan,
  createSkillsManagerPaths,
  detectDirtySkills,
  detectLocalSkillUpdate,
  detectSkillUpdate,
  discoverBundledSkillPaths,
  fetchSkillsShSearchCache,
  findListedSkillSourceDir,
  hashSkillDirectory,
  installSelectedSkillsSequentially,
  listSkillsInSource,
  materializeResolvedSkillSource,
  parseSkillSource,
  planInstallSkill,
  planRemoveSkill,
  readManagedManifest,
  readSkillsSearchCache,
  searchCachedSkills,
  validateSkillDirectory,
  withSkillsWriteLock,
  writeManagedManifest,
  writeSkillsSearchCache,
} from "./core";
import skillsExtension from "./index";

function tempRoot(name: string) {
  const root = join(tmpdir(), `skills-${name}-${crypto.randomUUID()}`);
  mkdirSync(root, { recursive: true });
  return root;
}

function writeSkill(
  dir: string,
  name = "Demo Skill",
  description = "Does demo work."
) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "README.md"), "# note\n");
  writeFileSync(
    join(dir, "SKILL.md"),
    `# ${name}\n\ndescription: ${description}\n`
  );
}

interface SkillCommand {
  handler(args: string, context: never): Promise<void>;
}

function registerSkillsCommand(): Map<string, SkillCommand> {
  const commands = new Map<string, SkillCommand>();
  const pi = {
    on() {
      // Test stub.
    },
    registerCommand(name: string, registeredCommand: unknown) {
      commands.set(name, registeredCommand as SkillCommand);
    },
  };
  skillsExtension(pi as never);
  return commands;
}

describe("skills core", () => {
  it("discovers bundled SKILL.md files recursively", () => {
    const root = tempRoot("discover");
    writeSkill(join(root, "one"));
    writeSkill(join(root, "nested", "two"), "Two Skill");

    expect(new Set(discoverBundledSkillPaths(root))).toEqual(
      new Set([
        join(root, "nested", "two", "SKILL.md"),
        join(root, "one", "SKILL.md"),
      ])
    );
  });

  it("validates skill structure", () => {
    const root = tempRoot("validate");
    writeSkill(root);

    expect(validateSkillDirectory(root)).toMatchObject({
      ok: true,
      name: "Demo Skill",
      description: "Does demo work.",
    });
    writeFileSync(
      join(root, "SKILL.md"),
      "---\nname: frontmatter-skill\ndescription: 'Frontmatter description.'\n---\n"
    );
    expect(validateSkillDirectory(root)).toMatchObject({
      ok: true,
      name: "frontmatter-skill",
      description: "Frontmatter description.",
    });
    writeFileSync(
      join(root, "SKILL.md"),
      [
        "---",
        "name: building-native-ui",
        "description: Build native UI with Expo.",
        "---",
        "",
        "# Expo UI Guidelines",
        "",
        "```bash",
        "# iOS (requires Xcode)",
        "npx expo run:ios",
        "```",
      ].join("\n")
    );
    expect(validateSkillDirectory(root)).toMatchObject({
      ok: true,
      name: "building-native-ui",
      description: "Build native UI with Expo.",
    });
    expect(validateSkillDirectory(join(root, "missing"))).toMatchObject({
      ok: false,
    });
  });

  it("uses global agent paths for managed skills, manifest, and cache", () => {
    const agentDir = join(tempRoot("paths"), ".pi", "agent");
    const paths = createSkillsManagerPaths(agentDir);

    expect(paths).toMatchObject({
      rootDir: agentDir,
      managedDir: join(agentDir, "skills"),
      cacheDir: join(agentDir, "skills-cache"),
      cachePath: join(agentDir, "skills-cache.json"),
      manifestPath: join(agentDir, "skills.json"),
      lockPath: join(agentDir, "skills.lock"),
    });
  });

  it("parses direct local, GitHub, and repo sources", () => {
    const root = tempRoot("source-parse");

    expect(parseSkillSource(root)).toMatchObject({
      localPath: root,
      identity: { type: "directory", path: root },
    });
    expect(
      parseSkillSource(
        "https://github.com/vercel-labs/react-view-transitions-skill/tree/main/skills/react-view-transitions"
      )
    ).toMatchObject({
      identity: {
        type: "github",
        owner: "vercel-labs",
        repo: "react-view-transitions-skill",
        ref: "main",
        subpath: "skills/react-view-transitions",
      },
      rawUrl:
        "https://raw.githubusercontent.com/vercel-labs/react-view-transitions-skill/main/skills/react-view-transitions/SKILL.md",
    });
    expect(parseSkillSource("https://example.com/skills/demo")).toMatchObject({
      identity: { type: "repo", url: "https://example.com/skills/demo" },
      rawUrl: "https://example.com/skills/demo/SKILL.md",
    });
    expect(() => parseSkillSource("http://example.com/skills/demo")).toThrow(
      "Remote skill sources must use HTTPS."
    );
  });

  it("lists multiple skills in a source with exact hashes", () => {
    const root = tempRoot("list-source");
    writeSkill(join(root, "one"), "One Skill");
    writeSkill(join(root, "nested", "two"), "Two Skill");

    const listed = listSkillsInSource(root);

    expect(listed.map((skill) => skill.id).sort()).toEqual([
      "one-skill",
      "two-skill",
    ]);
    expect(listed.every((skill) => skill.hash.length === 64)).toBe(true);
  });

  it("materializes all recursively discovered GitHub repo skills", async () => {
    const root = tempRoot("github-recursive");
    const paths = createSkillsManagerPaths(join(root, ".pi", "agent"));
    const resolved = parseSkillSource("owner/repo");
    const responses = new Map<string, Response>([
      [
        "https://api.github.com/repos/owner/repo/git/trees/HEAD?recursive=1",
        Response.json({
          tree: [
            { path: "skills/one/SKILL.md", type: "blob" },
            { path: "skills/one/README.md", type: "blob" },
            { path: "nested/two/SKILL.md", type: "blob" },
          ],
        }),
      ],
      [
        "https://raw.githubusercontent.com/owner/repo/HEAD/skills/one/SKILL.md",
        new Response("# One Skill\n\ndescription: First.\n"),
      ],
      [
        "https://raw.githubusercontent.com/owner/repo/HEAD/skills/one/README.md",
        new Response("# one\n"),
      ],
      [
        "https://raw.githubusercontent.com/owner/repo/HEAD/nested/two/SKILL.md",
        new Response("# Two Skill\n\ndescription: Second.\n"),
      ],
    ]);
    const fetcher = (url: string | URL | Request) => {
      const response = responses.get(String(url));
      if (!response) {
        return Promise.resolve(new Response("missing", { status: 404 }));
      }
      return Promise.resolve(response);
    };

    const sourceRoot = await materializeResolvedSkillSource(
      resolved,
      paths,
      fetcher as typeof fetch
    );
    const listed = listSkillsInSource(sourceRoot);

    expect(listed.map((skill) => skill.id).sort()).toEqual([
      "one-skill",
      "two-skill",
    ]);
    expect(
      readFileSync(join(sourceRoot, "skills", "one", "README.md"), "utf8")
    ).toBe("# one\n");
  });

  it("materializes exact GitHub subpaths without HTML child-folder guessing", async () => {
    const root = tempRoot("github-exact-subpath");
    const paths = createSkillsManagerPaths(join(root, ".pi", "agent"));
    const resolved = parseSkillSource("owner/repo/tree/main/skills/demo");
    const requestedUrls: string[] = [];
    const fetcher = (url: string | URL | Request) => {
      requestedUrls.push(String(url));
      if (String(url).includes("api.github.com")) {
        return Promise.resolve(new Response("rate limited", { status: 403 }));
      }
      if (
        String(url) === "https://github.com/owner/repo/tree/main/skills/demo"
      ) {
        return Promise.resolve(
          new Response(
            '<a href="/owner/repo/blob/main/skills/demo/SKILL.md">SKILL.md</a><a href="/owner/repo/tree/main/skills/demo/references">references</a>'
          )
        );
      }
      if (
        String(url) ===
        "https://raw.githubusercontent.com/owner/repo/main/skills/demo/SKILL.md"
      ) {
        return Promise.resolve(
          new Response("# Demo Skill\n\ndescription: Exact source.\n")
        );
      }
      return Promise.resolve(new Response("missing", { status: 404 }));
    };

    const sourceRoot = await materializeResolvedSkillSource(
      resolved,
      paths,
      fetcher as typeof fetch,
      { exactSubpath: true }
    );

    expect(listSkillsInSource(sourceRoot).map((skill) => skill.id)).toEqual([
      "demo-skill",
    ]);
    expect(requestedUrls).toContain(
      "https://github.com/owner/repo/tree/main/skills/demo"
    );
    expect(requestedUrls).not.toContain(
      "https://raw.githubusercontent.com/owner/repo/main/skills/demo/references/SKILL.md"
    );
  });

  it("retries GitHub tree fetches with GH_TOKEN when GITHUB_TOKEN is absent", async () => {
    const root = tempRoot("github-token-retry");
    const paths = createSkillsManagerPaths(join(root, ".pi", "agent"));
    const resolved = parseSkillSource("owner/repo/tree/main/skills/demo");
    const oldGithubToken = process.env.GITHUB_TOKEN;
    const oldGhToken = process.env.GH_TOKEN;
    process.env.GITHUB_TOKEN = undefined;
    process.env.GH_TOKEN = "token-123";
    const calls: RequestInit[] = [];
    const fetcher = (url: string | URL | Request, init?: RequestInit) => {
      calls.push(init ?? {});
      if (String(url).includes("api.github.com") && calls.length === 1) {
        return Promise.resolve(new Response("rate limited", { status: 403 }));
      }
      if (String(url).includes("api.github.com")) {
        return Promise.resolve(
          Response.json({
            tree: [{ path: "skills/demo/SKILL.md", type: "blob" }],
          })
        );
      }
      return Promise.resolve(
        new Response("# Demo Skill\n\ndescription: Token retry.\n")
      );
    };

    try {
      const sourceRoot = await materializeResolvedSkillSource(
        resolved,
        paths,
        fetcher as typeof fetch,
        { exactSubpath: true }
      );

      expect(listSkillsInSource(sourceRoot).map((skill) => skill.id)).toEqual([
        "demo-skill",
      ]);
      expect(calls[1]?.headers).toMatchObject({
        Authorization: "Bearer token-123",
      });
    } finally {
      if (oldGithubToken === undefined) {
        process.env.GITHUB_TOKEN = undefined;
      } else {
        process.env.GITHUB_TOKEN = oldGithubToken;
      }
      if (oldGhToken === undefined) {
        process.env.GH_TOKEN = undefined;
      } else {
        process.env.GH_TOKEN = oldGhToken;
      }
    }
  });

  it("uses the only listed skill when search metadata name differs from SKILL.md name", () => {
    const root = tempRoot("single-source-name-mismatch");
    const sourceDir = join(root, "building-native-ui");
    writeSkill(sourceDir, "Build Native UI", "Native components.");

    const listed = listSkillsInSource(root);

    expect(findListedSkillSourceDir(listed, "building-native-ui")).toBe(
      sourceDir
    );
  });

  it("installs selected skills sequentially and stops after the first failure", () => {
    const root = tempRoot("batch-install");
    const source = join(root, "source");
    const paths = createSkillsManagerPaths(join(root, ".pi", "agent"));
    writeSkill(join(source, "one"), "One Skill");
    writeSkill(join(source, "two"), "Two Skill");
    const entries = listSkillsInSource(source);
    rmSync(join(source, "two", "SKILL.md"));

    const result = installSelectedSkillsSequentially(
      entries,
      entries.map((entry) => entry.sourceDir),
      paths
    );
    const manifest = readManagedManifest(paths.manifestPath);

    expect(result.installed.map((entry) => entry.id)).toEqual(["one-skill"]);
    expect(result.failed?.sourceDir).toBe(join(source, "two"));
    expect(manifest.skills.map((entry) => entry.id)).toEqual(["one-skill"]);
  });

  it("plans and copies a managed skill with manifest state", () => {
    const root = tempRoot("install");
    const agentDir = join(root, ".pi", "agent");
    const source = join(root, "source");
    const paths = createSkillsManagerPaths(agentDir);
    writeSkill(source);

    const plan = planInstallSkill(source, paths);
    const entry = copyInstallPlan(plan, paths, "2026-01-01T00:00:00.000Z");
    const manifest = readManagedManifest(paths.manifestPath);

    expect(plan).toMatchObject({ id: "demo-skill", action: "install" });
    expect(plan.targetDir).toBe(join(agentDir, "skills", "demo-skill"));
    expect(entry.installPath).toBe(join(agentDir, "skills", "demo-skill"));
    expect(paths.manifestPath).toBe(join(agentDir, "skills.json"));
    expect(readFileSync(join(entry.installPath, "SKILL.md"), "utf8")).toContain(
      "Demo Skill"
    );
    expect(manifest.skills).toHaveLength(1);
    expect(manifest.skills[0]).toMatchObject({
      id: "demo-skill",
      name: "Demo Skill",
    });
    expect(
      manifest.skills[0]?.files.map((file) => file.relativePath).sort()
    ).toEqual(["README.md", "SKILL.md"]);
  });

  it("keeps generated install paths inside the managed skills directory", () => {
    const root = tempRoot("path-escape");
    const source = join(root, "source");
    const paths = createSkillsManagerPaths(join(root, ".pi", "agent"));
    writeSkill(source, "..");

    const plan = planInstallSkill(source, paths);
    const entry = copyInstallPlan(plan, paths);

    expect(plan.id).toBe("skill");
    expect(entry.installPath).toBe(join(paths.managedDir, "skill"));
    expect(existsSync(join(root, ".pi", "agent", "skills"))).toBe(true);
  });

  it("detects dirty installed skills including extra local files", () => {
    const root = tempRoot("dirty");
    const source = join(root, "source");
    const paths = createSkillsManagerPaths(join(root, ".pi", "agent"));
    writeSkill(source);
    const entry = copyInstallPlan(planInstallSkill(source, paths), paths);

    writeFileSync(join(entry.installPath, "SKILL.md"), "# changed\n");
    writeFileSync(join(entry.installPath, "local-note.md"), "keep me\n");

    expect(detectDirtySkills(readManagedManifest(paths.manifestPath))).toEqual([
      {
        id: "demo-skill",
        status: "dirty",
        changedFiles: ["SKILL.md", "local-note.md"],
      },
    ]);
  });

  it("marks expected files replaced by directories as dirty", () => {
    const root = tempRoot("dirty-directory");
    const source = join(root, "source");
    const paths = createSkillsManagerPaths(join(root, ".pi", "agent"));
    writeSkill(source);
    const entry = copyInstallPlan(planInstallSkill(source, paths), paths);

    rmSync(join(entry.installPath, "SKILL.md"));
    mkdirSync(join(entry.installPath, "SKILL.md"));

    expect(detectDirtySkills(readManagedManifest(paths.manifestPath))).toEqual([
      {
        id: "demo-skill",
        status: "dirty",
        changedFiles: ["SKILL.md"],
      },
    ]);
  });

  it("plans remove through the trash boundary and updates manifest", () => {
    const root = tempRoot("remove");
    const source = join(root, "source");
    const paths = createSkillsManagerPaths(join(root, ".pi", "agent"));
    writeSkill(source);
    copyInstallPlan(planInstallSkill(source, paths), paths);

    const plan = planRemoveSkill(
      "demo-skill",
      readManagedManifest(paths.manifestPath)
    );
    const trashed: string[] = [];
    const next = applyRemovePlan(plan, paths, (targetPath) =>
      trashed.push(targetPath)
    );

    expect(plan).toMatchObject({ trashBoundary: "trash-cli", exists: true });
    expect(trashed).toEqual([plan.installPath]);
    expect(next.skills).toEqual([]);
  });

  it("rejects remove plans outside the managed skills directory", () => {
    const root = tempRoot("remove-escape");
    const paths = createSkillsManagerPaths(join(root, ".pi", "agent"));
    writeManagedManifest(paths.manifestPath, {
      version: 1,
      skills: [],
    });
    const trashed: string[] = [];

    expect(() =>
      applyRemovePlan(
        {
          id: "demo-skill",
          installPath: join(root, "outside"),
          trashBoundary: "trash-cli",
          exists: true,
        },
        paths,
        (targetPath) => trashed.push(targetPath)
      )
    ).toThrow("Managed skill path escapes managed directory");
    expect(trashed).toEqual([]);
  });

  it("searches skills.sh cache and can refresh it without telemetry", async () => {
    const root = tempRoot("search-cache");
    const paths = createSkillsManagerPaths(join(root, ".pi", "agent"));
    const cache = await fetchSkillsShSearchCache("react", () =>
      Promise.resolve(
        Response.json({
          skills: [
            {
              skillId: "react-view-transitions",
              name: "React View Transitions",
              description: "Animate route changes.",
              source: "vercel-labs/react-view-transitions-skill",
              installs: 12_345,
            },
          ],
        })
      )
    );
    writeSkillsSearchCache(paths.cachePath, cache);

    const cached = readSkillsSearchCache(paths.cachePath);

    expect(searchCachedSkills(cached, "view route")).toHaveLength(1);
    expect(searchCachedSkills(cached, "python")).toHaveLength(0);
    expect(cached.skills[0]).toMatchObject({
      source: "vercel-labs/react-view-transitions-skill",
      skillName: "React View Transitions",
      installs: 12_345,
    });
  });

  it("ignores stale search cache versions so bad source mappings refresh", () => {
    const paths = createSkillsManagerPaths(
      join(tempRoot("stale-cache"), ".pi", "agent")
    );
    mkdirSync(join(paths.rootDir), { recursive: true });
    writeFileSync(
      paths.cachePath,
      JSON.stringify({
        version: 1,
        fetchedAt: "2026-01-01T00:00:00.000Z",
        skills: [
          {
            name: "find-skills",
            description: "vercel-labs/skills",
            source:
              "https://github.com/vercel-labs/skills/tree/HEAD/find-skills",
          },
        ],
      })
    );

    expect(readSkillsSearchCache(paths.cachePath)).toEqual({
      version: 5,
      fetchedAt: "",
      skills: [],
    });
  });

  it("parses skills.sh HTML leaderboard fallback", async () => {
    const requestedUrls: string[] = [];
    const cache = await fetchSkillsShSearchCache("react", (url) => {
      requestedUrls.push(String(url));
      return Promise.resolve(
        new Response(
          '<html><a href="/acme/demo-repo/demo-skill"><h3>Demo Skill</h3><p>acme/demo-repo</p></a></html>',
          { headers: { "content-type": "text/html" } }
        )
      );
    });

    expect(requestedUrls).toEqual(["https://skills.sh/api/search?q=react"]);
    expect(cache.skills).toEqual([
      {
        name: "Demo Skill acme/demo-repo",
        description: "acme/demo-repo",
        source: "https://github.com/acme/demo-repo/tree/HEAD/skills/demo-skill",
        skillName: "Demo Skill acme/demo-repo",
        url: "https://github.com/acme/demo-repo/tree/HEAD/skills/demo-skill",
        repository:
          "https://github.com/acme/demo-repo/tree/HEAD/skills/demo-skill",
      },
    ]);
  });

  it("resolves skills.sh JSON skill IDs by declared GitHub skill name", async () => {
    const requestedUrls: string[] = [];
    const cache = await fetchSkillsShSearchCache("ai-sdk", (url) => {
      requestedUrls.push(String(url));
      return Promise.resolve(
        Response.json({
          skills: [{ skillId: "ai-sdk", name: "ai-sdk", source: "vercel/ai" }],
        })
      );
    });
    const result = searchCachedSkills(cache, "ai-sdk")[0];
    const source = result?.source ?? "";
    expect(source).toBe("vercel/ai");
    expect(result?.skillName).toBe("ai-sdk");

    const root = tempRoot("skills-sh-github-name");
    const paths = createSkillsManagerPaths(join(root, ".pi", "agent"));
    const exactSources: Array<{
      path: string;
      ref?: string;
      subpath?: string;
    }> = [];
    const sourceRoot = await materializeResolvedSkillSource(
      parseSkillSource(source),
      paths,
      (url) => {
        const value = String(url);
        requestedUrls.push(value);
        if (value.includes("/git/trees/")) {
          return Promise.resolve(
            Response.json({
              tree: [
                { path: "skills/other/SKILL.md", type: "blob" },
                { path: "skills/use-ai-sdk/SKILL.md", type: "blob" },
                {
                  path: "skills/use-ai-sdk/references/common-errors.md",
                  type: "blob",
                },
              ],
            })
          );
        }
        if (value.endsWith("skills/other/SKILL.md")) {
          return Promise.resolve(
            new Response("---\nname: other\ndescription: Other skill.\n---\n")
          );
        }
        if (value.endsWith("skills/use-ai-sdk/SKILL.md")) {
          return Promise.resolve(
            new Response(
              "---\nname: ai-sdk\ndescription: Answer questions.\n---\n"
            )
          );
        }
        if (value.endsWith("skills/use-ai-sdk/references/common-errors.md")) {
          return Promise.resolve(new Response("# Common Errors\n"));
        }
        return Promise.resolve(new Response("missing", { status: 404 }));
      },
      {
        requestedSkillName: result?.skillName,
        onExactSourceResolved: (identity) =>
          exactSources.push({
            path: identity.path,
            ref: identity.ref,
            subpath: identity.subpath,
          }),
      }
    );

    expect(listSkillsInSource(sourceRoot)).toMatchObject([
      { id: "ai-sdk", name: "ai-sdk", description: "Answer questions." },
    ]);
    expect(
      requestedUrls.some((url) => url.endsWith("/skills/ai-sdk/SKILL.md"))
    ).toBe(false);
    expect(exactSources).toEqual([
      {
        path: "vercel/ai/skills/use-ai-sdk",
        ref: "HEAD",
        subpath: "skills/use-ai-sdk",
      },
    ]);
  });

  it("reuses GitHub root metadata across requested broad source resolutions", async () => {
    const root = tempRoot("github-root-metadata-cache");
    const paths = createSkillsManagerPaths(join(root, ".pi", "agent"));
    const githubSkillNameCache = new Map<string, string | null>();
    const rawRequests: string[] = [];

    const fetcher = (url: string | URL | Request) => {
      const value = String(url);
      if (value.includes("/git/trees/")) {
        return Promise.resolve(
          Response.json({
            tree: [
              { path: "skills/one/SKILL.md", type: "blob" },
              { path: "skills/two/SKILL.md", type: "blob" },
            ],
          })
        );
      }
      rawRequests.push(value);
      if (value.endsWith("/skills/one/SKILL.md")) {
        return Promise.resolve(new Response("# one\n\ndescription: One.\n"));
      }
      return Promise.resolve(new Response("# two\n\ndescription: Two.\n"));
    };

    await materializeResolvedSkillSource(
      parseSkillSource("acme/repo"),
      paths,
      fetcher as typeof fetch,
      { requestedSkillName: "one", githubSkillNameCache }
    );
    await materializeResolvedSkillSource(
      parseSkillSource("acme/repo"),
      paths,
      fetcher as typeof fetch,
      { requestedSkillName: "two", githubSkillNameCache }
    );

    expect(
      rawRequests.filter((url) => url.endsWith("/skills/one/SKILL.md"))
    ).toHaveLength(2);
    expect(
      rawRequests.filter((url) => url.endsWith("/skills/two/SKILL.md"))
    ).toHaveLength(2);
  });

  it("rejects ambiguous GitHub roots with duplicate requested folder names", async () => {
    const root = tempRoot("github-duplicate-folder-name");
    const paths = createSkillsManagerPaths(join(root, ".pi", "agent"));

    await expect(
      materializeResolvedSkillSource(
        parseSkillSource("acme/repo"),
        paths,
        (url) => {
          const value = String(url);
          if (value.includes("/git/trees/")) {
            return Promise.resolve(
              Response.json({
                tree: [
                  { path: "skills/demo/SKILL.md", type: "blob" },
                  { path: "packages/demo/SKILL.md", type: "blob" },
                ],
              })
            );
          }
          return Promise.resolve(
            new Response("# Demo Skill\n\ndescription: Demo.\n")
          );
        },
        { requestedSkillName: "demo" }
      )
    ).rejects.toThrow(
      "Ambiguous GitHub skill source for demo: packages/demo, skills/demo"
    );
  });

  it("rejects ambiguous GitHub roots with duplicate requested SKILL.md names", async () => {
    const root = tempRoot("github-duplicate-skill-name");
    const paths = createSkillsManagerPaths(join(root, ".pi", "agent"));

    await expect(
      materializeResolvedSkillSource(
        parseSkillSource("acme/repo"),
        paths,
        (url) => {
          const value = String(url);
          if (value.includes("/git/trees/")) {
            return Promise.resolve(
              Response.json({
                tree: [
                  { path: "skills/one/SKILL.md", type: "blob" },
                  { path: "skills/two/SKILL.md", type: "blob" },
                ],
              })
            );
          }
          if (value.endsWith("/skills/one/SKILL.md")) {
            return Promise.resolve(
              new Response(
                "---\nname: demo\ndescription: First duplicate.\n---\n"
              )
            );
          }
          return Promise.resolve(
            new Response(
              "---\nname: demo\ndescription: Second duplicate.\n---\n"
            )
          );
        },
        { requestedSkillName: "demo" }
      )
    ).rejects.toThrow(
      "Ambiguous GitHub skill source for demo: skills/one, skills/two"
    );
  });

  it("rejects ambiguous GitHub roots when folder and SKILL.md names both match", async () => {
    const root = tempRoot("github-folder-and-skill-name-duplicate");
    const paths = createSkillsManagerPaths(join(root, ".pi", "agent"));

    await expect(
      materializeResolvedSkillSource(
        parseSkillSource("acme/repo"),
        paths,
        (url) => {
          const value = String(url);
          if (value.includes("/git/trees/")) {
            return Promise.resolve(
              Response.json({
                tree: [
                  { path: "skills/demo/SKILL.md", type: "blob" },
                  { path: "skills/other/SKILL.md", type: "blob" },
                ],
              })
            );
          }
          if (value.endsWith("/skills/demo/SKILL.md")) {
            return Promise.resolve(
              new Response("---\nname: demo\ndescription: Folder match.\n---\n")
            );
          }
          return Promise.resolve(
            new Response("---\nname: demo\ndescription: Name match.\n---\n")
          );
        },
        { requestedSkillName: "demo" }
      )
    ).rejects.toThrow(
      "Ambiguous GitHub skill source for demo: skills/demo, skills/other"
    );
  });

  it("rejects ambiguous GitHub roots when a candidate metadata fetch fails", async () => {
    const root = tempRoot("github-ambiguous-metadata-fetch-fails");
    const paths = createSkillsManagerPaths(join(root, ".pi", "agent"));

    await expect(
      materializeResolvedSkillSource(
        parseSkillSource("acme/repo"),
        paths,
        (url) => {
          const value = String(url);
          if (value.includes("/git/trees/")) {
            return Promise.resolve(
              Response.json({
                tree: [
                  { path: "skills/demo/SKILL.md", type: "blob" },
                  { path: "skills/other/SKILL.md", type: "blob" },
                ],
              })
            );
          }
          if (value.endsWith("/skills/demo/SKILL.md")) {
            return Promise.resolve(
              new Response("---\nname: demo\ndescription: Folder match.\n---\n")
            );
          }
          return Promise.resolve(new Response("server error", { status: 500 }));
        },
        { requestedSkillName: "demo" }
      )
    ).rejects.toThrow("Fetch failed: 500");
  });

  it("rejects ambiguous HTML fallback roots before resolving exact source", async () => {
    const root = tempRoot("github-html-folder-and-skill-name-duplicate");
    const paths = createSkillsManagerPaths(join(root, ".pi", "agent"));

    await expect(
      materializeResolvedSkillSource(
        parseSkillSource("acme/repo"),
        paths,
        (url) => {
          const value = String(url);
          if (value.includes("/git/trees/")) {
            return Promise.resolve(
              new Response("rate limited", { status: 403 })
            );
          }
          if (value === "https://github.com/acme/repo/tree/HEAD/skills") {
            return Promise.resolve(
              new Response(
                '<a href="/acme/repo/tree/HEAD/skills/demo">demo</a><a href="/acme/repo/tree/HEAD/skills/other">other</a>'
              )
            );
          }
          if (value.endsWith("/skills/demo/SKILL.md")) {
            return Promise.resolve(
              new Response("---\nname: demo\ndescription: Folder match.\n---\n")
            );
          }
          return Promise.resolve(
            new Response("---\nname: demo\ndescription: Name match.\n---\n")
          );
        },
        { requestedSkillName: "demo" }
      )
    ).rejects.toThrow(
      "Ambiguous GitHub skill source for demo: skills/demo, skills/other"
    );
  });

  it("resolves the only HTML fallback root as exact when names differ", async () => {
    const root = tempRoot("github-html-single-root-name-differs");
    const paths = createSkillsManagerPaths(join(root, ".pi", "agent"));
    const exactSources: Array<{ path: string; subpath?: string }> = [];

    const sourceRoot = await materializeResolvedSkillSource(
      parseSkillSource("acme/repo"),
      paths,
      (url) => {
        const value = String(url);
        if (value.includes("/git/trees/")) {
          return Promise.resolve(new Response("rate limited", { status: 403 }));
        }
        if (value === "https://github.com/acme/repo/tree/HEAD/skills") {
          return Promise.resolve(
            new Response(
              '<a href="/acme/repo/tree/HEAD/skills/actual">actual</a>'
            )
          );
        }
        return Promise.resolve(
          new Response("---\nname: actual\ndescription: Actual skill.\n---\n")
        );
      },
      {
        requestedSkillName: "Display Skill",
        onExactSourceResolved: (identity) => {
          exactSources.push({ path: identity.path, subpath: identity.subpath });
        },
      }
    );

    expect(listSkillsInSource(sourceRoot)).toMatchObject([
      { id: "actual", name: "actual", description: "Actual skill." },
    ]);
    expect(exactSources).toEqual([
      { path: "acme/repo/skills/actual", subpath: "skills/actual" },
    ]);
  });

  it("materializes multiple GitHub skills through the tree API", async () => {
    const root = tempRoot("github-tree");
    const paths = createSkillsManagerPaths(join(root, ".pi", "agent"));
    const resolved = parseSkillSource("acme/repo/tree/main/skills");
    const sourceRoot = await materializeResolvedSkillSource(
      resolved,
      paths,
      (url) => {
        const value = String(url);
        if (value.includes("/git/trees/")) {
          return Promise.resolve(
            Response.json({
              tree: [
                { path: "skills/one/SKILL.md", type: "blob" },
                { path: "skills/one/README.md", type: "blob" },
                { path: "skills/two/SKILL.md", type: "blob" },
              ],
            })
          );
        }
        if (value.endsWith("README.md")) {
          return Promise.resolve(new Response("# readme\n"));
        }
        if (value.includes("/one/")) {
          return Promise.resolve(
            new Response("# One Skill\n\ndescription: one\n")
          );
        }
        return Promise.resolve(
          new Response("# Two Skill\n\ndescription: two\n")
        );
      }
    );

    expect(
      listSkillsInSource(sourceRoot)
        .map((skill) => skill.id)
        .sort()
    ).toEqual(["one-skill", "two-skill"]);
  });

  it("preserves binary files while materializing GitHub skills", async () => {
    const root = tempRoot("github-binary");
    const paths = createSkillsManagerPaths(join(root, ".pi", "agent"));
    const bytes = new Uint8Array([0xff, 0x00, 0x80, 0x61]);
    const sourceRoot = await materializeResolvedSkillSource(
      parseSkillSource("acme/repo/tree/main/skills/demo"),
      paths,
      (url) => {
        const value = String(url);
        if (value.includes("/git/trees/")) {
          return Promise.resolve(
            Response.json({
              tree: [
                { path: "skills/demo/SKILL.md", type: "blob" },
                { path: "skills/demo/assets/logo.bin", type: "blob" },
              ],
            })
          );
        }
        if (value.endsWith("logo.bin")) {
          return Promise.resolve(new Response(bytes));
        }
        return Promise.resolve(
          new Response("# Demo Skill\n\ndescription: Demo.\n")
        );
      },
      { exactSubpath: true }
    );

    expect(readFileSync(join(sourceRoot, "assets", "logo.bin"))).toEqual(
      Buffer.from(bytes)
    );
  });

  it("rejects GitHub tree paths that escape the materialized source", async () => {
    const root = tempRoot("github-path-escape");
    const paths = createSkillsManagerPaths(join(root, ".pi", "agent"));
    const sourceRoot = join(
      paths.cacheDir,
      "direct-source",
      parseSkillSource("acme/repo/tree/main/skills/demo").identity.id
    );

    await expect(
      materializeResolvedSkillSource(
        parseSkillSource("acme/repo/tree/main/skills/demo"),
        paths,
        (url) => {
          const value = String(url);
          if (value.includes("/git/trees/")) {
            return Promise.resolve(
              Response.json({
                tree: [
                  { path: "skills/demo/SKILL.md", type: "blob" },
                  { path: "skills/demo/../escape.txt", type: "blob" },
                ],
              })
            );
          }
          return Promise.resolve(
            new Response("# Demo Skill\n\ndescription: Demo.\n")
          );
        },
        { exactSubpath: true }
      )
    ).rejects.toThrow("Remote file path escapes source directory");
    expect(existsSync(join(sourceRoot, "..", "escape.txt"))).toBe(false);
  });

  it("computes installed and latest hashes for update detection", () => {
    const root = tempRoot("update");
    const source = join(root, "source");
    const paths = createSkillsManagerPaths(join(root, ".pi", "agent"));
    writeSkill(source);
    const entry = copyInstallPlan(planInstallSkill(source, paths), paths);
    const installedHash = computeSkillFilesHash(entry.files);

    expect(detectLocalSkillUpdate(entry)).toMatchObject({
      id: "demo-skill",
      installedHash,
      latestHash: installedHash,
      updateAvailable: false,
      remoteManaged: false,
    });

    writeFileSync(join(source, "extra.md"), "new file\n");
    const latestFiles = hashSkillDirectory(source);
    expect(detectSkillUpdate(entry, latestFiles)).toMatchObject({
      updateAvailable: true,
      remoteManaged: false,
    });
    expect(
      detectSkillUpdate(
        { ...entry, source: { ...entry.source, type: "github" } },
        latestFiles
      )
    ).toMatchObject({ remoteManaged: true, updateAvailable: true });
  });

  it("validates required name and description fields", () => {
    const root = tempRoot("validate-required");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "SKILL.md"), "description: no heading\n");

    expect(validateSkillDirectory(root)).toMatchObject({
      ok: false,
      name: null,
      description: "no heading",
      errors: ["SKILL.md must include an H1 skill name."],
    });

    writeFileSync(join(root, "SKILL.md"), "# Missing Description\n");

    expect(validateSkillDirectory(root)).toMatchObject({
      ok: false,
      name: "Missing Description",
      description: null,
      errors: ["SKILL.md must include a description."],
    });
  });

  it("keeps stable source identities and distinguishes pinned refs", () => {
    const root = tempRoot("source-identity");
    const local = parseSkillSource(root).identity;
    const sameLocal = parseSkillSource(root).identity;
    const main = parseSkillSource("owner/repo/tree/main/skills/demo").identity;
    const tag = parseSkillSource("owner/repo/tree/v1.0.0/skills/demo").identity;

    expect(local.id).toBe(sameLocal.id);
    expect(main).toMatchObject({
      type: "github",
      owner: "owner",
      repo: "repo",
      ref: "main",
      subpath: "skills/demo",
    });
    expect(main.id).not.toBe(tag.id);
  });

  it("hashes nested skill files with deterministic relative paths", () => {
    const root = tempRoot("hash-nested");
    writeSkill(root);
    mkdirSync(join(root, "assets"), { recursive: true });
    writeFileSync(join(root, "assets", "example.txt"), "asset\n");

    const files = hashSkillDirectory(root);

    expect(files.map((file) => file.relativePath)).toEqual([
      "README.md",
      "SKILL.md",
      "assets/example.txt",
    ]);
    expect(computeSkillFilesHash(files)).toHaveLength(64);
    expect(computeSkillFilesHash([...files].reverse())).toBe(
      computeSkillFilesHash(files)
    );
  });

  it("plans replacement and removes stale files while preserving one manifest entry", () => {
    const root = tempRoot("replace");
    const source = join(root, "source");
    const paths = createSkillsManagerPaths(join(root, ".pi", "agent"));
    writeSkill(source);
    const entry = copyInstallPlan(planInstallSkill(source, paths), paths);
    writeFileSync(join(entry.installPath, "stale.md"), "old\n");

    writeFileSync(join(source, "README.md"), "# changed\n");
    const plan = planInstallSkill(source, paths);
    const replaced = copyInstallPlan(plan, paths);

    expect(plan.action).toBe("replace");
    expect(existsSync(join(replaced.installPath, "stale.md"))).toBe(false);
    expect(readManagedManifest(paths.manifestPath).skills).toHaveLength(1);
  });

  it("replaces same-source skills when the skill name changes", () => {
    const root = tempRoot("rename");
    const source = join(root, "source");
    const paths = createSkillsManagerPaths(join(root, ".pi", "agent"));
    writeSkill(source, "Old Skill");
    const oldEntry = copyInstallPlan(planInstallSkill(source, paths), paths);

    writeSkill(source, "New Skill");
    const plan = planInstallSkill(source, paths);
    const newEntry = copyInstallPlan(plan, paths);
    const manifest = readManagedManifest(paths.manifestPath);

    expect(plan).toMatchObject({
      action: "replace",
      existingId: "old-skill",
      existingInstallPath: oldEntry.installPath,
    });
    expect(newEntry.id).toBe("new-skill");
    expect(existsSync(oldEntry.installPath)).toBe(false);
    expect(manifest.skills.map((skill) => skill.id)).toEqual(["new-skill"]);
  });

  it("detects missing installs and unavailable remote updates", () => {
    const root = tempRoot("missing-remote");
    const source = join(root, "source");
    const paths = createSkillsManagerPaths(join(root, ".pi", "agent"));
    writeSkill(source);
    const entry = copyInstallPlan(planInstallSkill(source, paths), paths);
    rmSync(entry.installPath, { recursive: true, force: true });

    expect(detectDirtySkills(readManagedManifest(paths.manifestPath))).toEqual([
      {
        id: "demo-skill",
        status: "missing",
        changedFiles: ["README.md", "SKILL.md"],
      },
    ]);
    expect(
      detectLocalSkillUpdate({
        ...entry,
        source: { ...entry.source, type: "github" },
      })
    ).toMatchObject({
      latestHash: null,
      updateAvailable: false,
      remoteManaged: true,
      reason: "latest-unavailable",
    });
  });

  it("plans remove when install path is already absent", () => {
    const root = tempRoot("remove-missing");
    const source = join(root, "source");
    const paths = createSkillsManagerPaths(join(root, ".pi", "agent"));
    writeSkill(source);
    const entry = copyInstallPlan(planInstallSkill(source, paths), paths);
    rmSync(entry.installPath, { recursive: true, force: true });

    const plan = planRemoveSkill(
      "demo-skill",
      readManagedManifest(paths.manifestPath)
    );
    const trashed: string[] = [];
    const next = applyRemovePlan(plan, paths, (targetPath) =>
      trashed.push(targetPath)
    );

    expect(plan).toMatchObject({ exists: false, trashBoundary: "trash-cli" });
    expect(trashed).toEqual([]);
    expect(next.skills).toEqual([]);
  });

  it("uses fail-fast write locking and clears locks after errors", () => {
    const paths = createSkillsManagerPaths(
      join(tempRoot("lock"), ".pi", "agent")
    );

    expect(() =>
      withSkillsWriteLock(paths, () =>
        withSkillsWriteLock(paths, () => undefined)
      )
    ).toThrow("Skills manager is locked by another writer.");
    expect(existsSync(paths.lockPath)).toBe(false);
    expect(() =>
      withSkillsWriteLock(paths, () => {
        throw new Error("boom");
      })
    ).toThrow("boom");
    expect(existsSync(paths.lockPath)).toBe(false);
    expect(withSkillsWriteLock(paths, () => "ok")).toBe("ok");
  });
});

describe("skills extension", () => {
  it("shows search results directly after keyword input", async () => {
    const originalHome = process.env.HOME;
    const home = tempRoot("search-ui-home");
    process.env.HOME = home;
    try {
      const paths = createSkillsManagerPaths();
      const cache = await fetchSkillsShSearchCache("demo", () =>
        Promise.resolve(
          Response.json({
            skills: [
              {
                name: "Demo Skill",
                description: "Does demos.",
                source: "https://github.com/acme/demo/tree/HEAD/skills/demo",
                installs: 29_178,
              },
            ],
          })
        )
      );
      writeSkillsSearchCache(paths.cachePath, cache);

      const commands = new Map<
        string,
        { handler(args: string, context: never): Promise<void> }
      >();
      const pi = {
        on() {
          // no-op
        },
        registerCommand(name: string, registeredCommand: unknown) {
          commands.set(
            name,
            registeredCommand as {
              handler(args: string, context: never): Promise<void>;
            }
          );
        },
      };
      const selectCalls: string[][] = [];
      const commandCtx = {
        hasUI: true,
        ui: {
          input: () => Promise.resolve("demo"),
          select: (_title: string, options: string[]) => {
            selectCalls.push(options);
            return Promise.resolve("Cancel");
          },
          custom: () => {
            throw new Error(
              "search results should not require a blocking modal"
            );
          },
          notify() {
            // no-op
          },
          setStatus() {
            // no-op
          },
        },
      };

      skillsExtension(pi as never);
      await commands.get("skill")?.handler("search", commandCtx as never);

      expect(selectCalls).toEqual([
        [
          "Cancel",
          "Demo Skill — https://github.com/acme/demo/tree/HEAD/skills/demo — 29.2K installs",
        ],
      ]);
    } finally {
      process.env.HOME = originalHome;
    }
  });

  it("installs selected repo skills with one success notification", async () => {
    const home = tempRoot("command-repo-install");
    const originalHome = process.env.HOME;
    const originalFetch = globalThis.fetch;
    process.env.HOME = home;
    try {
      const responses = new Map<string, Response>([
        [
          "https://api.github.com/repos/owner/repo/git/trees/HEAD?recursive=1",
          Response.json({
            tree: [
              { path: "skills/one/SKILL.md", type: "blob" },
              { path: "skills/two/SKILL.md", type: "blob" },
            ],
          }),
        ],
        [
          "https://raw.githubusercontent.com/owner/repo/HEAD/skills/one/SKILL.md",
          new Response("# One Skill\n\ndescription: First.\n"),
        ],
        [
          "https://raw.githubusercontent.com/owner/repo/HEAD/skills/two/SKILL.md",
          new Response("# Two Skill\n\ndescription: Second.\n"),
        ],
      ]);
      globalThis.fetch = ((url: string | URL | Request) =>
        Promise.resolve(
          responses.get(String(url)) ?? new Response("missing", { status: 404 })
        )) as typeof fetch;
      const commands = new Map<
        string,
        { handler(args: string, context: never): Promise<void> }
      >();
      const pi = {
        on() {
          // Test stub.
        },
        registerCommand(name: string, registeredCommand: unknown) {
          commands.set(
            name,
            registeredCommand as {
              handler(args: string, context: never): Promise<void>;
            }
          );
        },
      };
      const notifications: string[] = [];
      const commandCtx = {
        hasUI: true,
        ui: {
          custom: () => Promise.resolve(["one-skill", "two-skill"]),
          notify(message: string) {
            notifications.push(message);
          },
          setStatus() {
            // Test stub.
          },
        },
      };

      skillsExtension(pi as never);
      await commands
        .get("skill")
        ?.handler("install owner/repo", commandCtx as never);

      const manifest = readManagedManifest(
        createSkillsManagerPaths().manifestPath
      );
      expect(manifest.skills.map((skill) => skill.name).sort()).toEqual([
        "One Skill",
        "Two Skill",
      ]);
      expect(notifications).toEqual([
        "Installed 2 skills: One Skill, Two Skill. Changes apply after /reload or next session.",
      ]);
    } finally {
      globalThis.fetch = originalFetch;
      process.env.HOME = originalHome;
    }
  });

  it("installs supabase agent skills when GitHub tree API is rate-limited", async () => {
    const home = tempRoot("command-supabase-rate-limit");
    const originalHome = process.env.HOME;
    const originalFetch = globalThis.fetch;
    process.env.HOME = home;
    try {
      const responses = new Map<string, Response>([
        [
          "https://api.github.com/repos/supabase/agent-skills/git/trees/HEAD?recursive=1",
          Response.json({ message: "rate limited" }, { status: 403 }),
        ],
        [
          "https://github.com/supabase/agent-skills/tree/HEAD/skills",
          new Response(
            '<a href="/supabase/agent-skills/tree/HEAD/skills/supabase">supabase</a>'
          ),
        ],
        [
          "https://raw.githubusercontent.com/supabase/agent-skills/HEAD/skills/supabase/SKILL.md",
          new Response(
            '---\nname: supabase\ndescription: "Use when doing Supabase work."\n---\n'
          ),
        ],
      ]);
      globalThis.fetch = ((url: string | URL | Request) =>
        Promise.resolve(
          responses.get(String(url)) ?? new Response("missing", { status: 404 })
        )) as typeof fetch;
      const commands = new Map<
        string,
        { handler(args: string, context: never): Promise<void> }
      >();
      const pi = {
        on() {
          // Test stub.
        },
        registerCommand(name: string, registeredCommand: unknown) {
          commands.set(
            name,
            registeredCommand as {
              handler(args: string, context: never): Promise<void>;
            }
          );
        },
      };
      const notifications: string[] = [];
      const commandCtx = {
        hasUI: true,
        ui: {
          custom: () => Promise.resolve(["supabase"]),
          notify(message: string) {
            notifications.push(message);
          },
          setStatus() {
            // Test stub.
          },
          setWidget() {
            // Test stub.
          },
        },
      };

      skillsExtension(pi as never);
      await commands
        .get("skill")
        ?.handler("install supabase/agent-skills", commandCtx as never);

      const manifest = readManagedManifest(
        createSkillsManagerPaths().manifestPath
      );
      expect(manifest.skills.map((skill) => skill.name)).toEqual(["supabase"]);
      expect(notifications).toEqual([
        "Installed 1 skill: supabase. Changes apply after /reload or next session.",
      ]);
    } finally {
      globalThis.fetch = originalFetch;
      process.env.HOME = originalHome;
    }
  });

  it("shows installed and dirty status in repo install picker", async () => {
    const home = tempRoot("command-repo-install-status");
    const originalHome = process.env.HOME;
    const originalFetch = globalThis.fetch;
    process.env.HOME = home;
    try {
      globalThis.fetch = ((url: string | URL | Request) => {
        if (String(url).includes("/git/trees/")) {
          return Promise.resolve(
            Response.json({
              tree: [
                { path: "skills/one/SKILL.md", type: "blob" },
                { path: "skills/two/SKILL.md", type: "blob" },
              ],
            })
          );
        }
        if (String(url).includes("/skills/one/SKILL.md")) {
          return Promise.resolve(
            new Response("# One Skill\n\ndescription: First.\n")
          );
        }
        if (String(url).includes("/skills/two/SKILL.md")) {
          return Promise.resolve(
            new Response("# Two Skill\n\ndescription: Second.\n")
          );
        }
        return Promise.resolve(new Response("missing", { status: 404 }));
      }) as typeof fetch;
      const paths = createSkillsManagerPaths();
      writeManagedManifest(paths.manifestPath, {
        version: 1,
        skills: [
          {
            id: "one-skill",
            name: "One Skill",
            description: "First.",
            source: parseSkillSource("owner/repo/tree/HEAD/skills/one")
              .identity,
            installPath: join(paths.managedDir, "one-skill"),
            installedAt: "2026-05-21T00:00:00.000Z",
            files: [{ relativePath: "SKILL.md", sha256: "missing", bytes: 1 }],
          },
        ],
      });
      const commands = new Map<
        string,
        { handler(args: string, context: never): Promise<void> }
      >();
      const pi = {
        on() {
          // Test stub.
        },
        registerCommand(name: string, registeredCommand: unknown) {
          commands.set(
            name,
            registeredCommand as {
              handler(args: string, context: never): Promise<void>;
            }
          );
        },
      };
      let pickerText = "";
      const commandCtx = {
        hasUI: true,
        ui: {
          custom(
            factory: (
              tui: unknown,
              theme: unknown,
              kb: unknown,
              done: unknown
            ) => { render(width?: number): string[] }
          ) {
            const component = factory(
              undefined,
              undefined,
              undefined,
              () => undefined
            );
            pickerText = component.render().join("\n");
            return Promise.resolve(["two-skill"]);
          },
          notify() {
            // Test stub.
          },
          setStatus() {
            // Test stub.
          },
        },
      };

      skillsExtension(pi as never);
      await commands
        .get("skill")
        ?.handler("install owner/repo", commandCtx as never);

      expect(pickerText).toContain("One Skill");
      expect(pickerText).toContain("installed dirty");
      expect(pickerText).toContain("[ ] Two Skill");
    } finally {
      globalThis.fetch = originalFetch;
      process.env.HOME = originalHome;
    }
  });

  it("warns instead of installing multi-skill repos without custom UI", async () => {
    const home = tempRoot("command-repo-install-no-custom");
    const originalHome = process.env.HOME;
    const originalFetch = globalThis.fetch;
    process.env.HOME = home;
    try {
      globalThis.fetch = ((url: string | URL | Request) => {
        if (String(url).includes("/git/trees/")) {
          return Promise.resolve(
            Response.json({
              tree: [
                { path: "skills/one/SKILL.md", type: "blob" },
                { path: "skills/two/SKILL.md", type: "blob" },
              ],
            })
          );
        }
        if (String(url).includes("/skills/one/SKILL.md")) {
          return Promise.resolve(
            new Response("# One Skill\n\ndescription: First.\n")
          );
        }
        if (String(url).includes("/skills/two/SKILL.md")) {
          return Promise.resolve(
            new Response("# Two Skill\n\ndescription: Second.\n")
          );
        }
        return Promise.resolve(new Response("missing", { status: 404 }));
      }) as typeof fetch;
      const commands = new Map<
        string,
        { handler(args: string, context: never): Promise<void> }
      >();
      const pi = {
        on() {
          // Test stub.
        },
        registerCommand(name: string, registeredCommand: unknown) {
          commands.set(
            name,
            registeredCommand as {
              handler(args: string, context: never): Promise<void>;
            }
          );
        },
      };
      const notifications: string[] = [];
      const commandCtx = {
        hasUI: true,
        ui: {
          notify(message: string) {
            notifications.push(message);
          },
          setStatus() {
            // Test stub.
          },
        },
      };

      skillsExtension(pi as never);
      await commands
        .get("skill")
        ?.handler("install owner/repo", commandCtx as never);

      expect(
        readManagedManifest(createSkillsManagerPaths().manifestPath).skills
      ).toEqual([]);
      expect(notifications).toEqual([
        "Multiple skills found. Run /skill install owner/repo/tree/HEAD/skills/one to install one skill.",
      ]);
    } finally {
      globalThis.fetch = originalFetch;
      process.env.HOME = originalHome;
    }
  });

  it("opens the skills manager for /skill when custom UI is available", async () => {
    const home = tempRoot("command-custom");
    const originalHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const commands = new Map<
        string,
        { handler(args: string, context: never): Promise<void> }
      >();
      const pi = {
        on() {
          // no-op
        },
        registerCommand(name: string, registeredCommand: unknown) {
          commands.set(
            name,
            registeredCommand as {
              handler(args: string, context: never): Promise<void>;
            }
          );
        },
      };
      const customCalls: unknown[] = [];
      const notifications: string[] = [];
      const commandCtx = {
        hasUI: true,
        ui: {
          custom: (_factory: unknown, options: unknown) => {
            customCalls.push(options);
            return Promise.resolve();
          },
          notify(message: string) {
            notifications.push(message);
          },
          setStatus() {
            // no-op
          },
        },
      };

      skillsExtension(pi as never);
      await commands.get("skill")?.handler("", commandCtx as never);

      expect(customCalls).toHaveLength(1);
      expect(customCalls[0]).toMatchObject({ overlay: true });
      expect(notifications).toEqual([]);
    } finally {
      process.env.HOME = originalHome;
    }
  });

  it("falls back to a simple list notification without custom UI", async () => {
    const home = tempRoot("command-fallback");
    const originalHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const commands = new Map<
        string,
        { handler(args: string, context: never): Promise<void> }
      >();
      const pi = {
        on() {
          // no-op
        },
        registerCommand(name: string, registeredCommand: unknown) {
          commands.set(
            name,
            registeredCommand as {
              handler(args: string, context: never): Promise<void>;
            }
          );
        },
      };
      const notifications: string[] = [];
      const commandCtx = {
        hasUI: true,
        ui: {
          notify(message: string) {
            notifications.push(message);
          },
          setStatus() {
            // no-op
          },
        },
      };

      skillsExtension(pi as never);
      await commands.get("skill")?.handler("list", commandCtx as never);

      expect(notifications).toHaveLength(1);
      expect(notifications[0]).toContain("Managed skills");
      expect(notifications[0]).toContain("Bundled/read-only skills");
    } finally {
      process.env.HOME = originalHome;
    }
  });

  it("drives command activity around /skill success and notification suspension", async () => {
    const home = tempRoot("command-activity-success");
    const originalHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const commands = new Map<
        string,
        { handler(args: string, context: never): Promise<void> }
      >();
      const pi = {
        on() {
          // Test stub.
        },
        registerCommand(name: string, registeredCommand: unknown) {
          commands.set(
            name,
            registeredCommand as {
              handler(args: string, context: never): Promise<void>;
            }
          );
        },
      };
      const activityCalls: string[] = [];
      const notifications: string[] = [];
      const commandCtx = {
        hasUI: true,
        ui: {
          notify(message: string) {
            notifications.push(message);
            activityCalls.push("notify");
          },
          setStatus(_key: string, text: string | undefined) {
            activityCalls.push(`status:${text ?? ""}`);
          },
          setWidget(_key: string, content: unknown) {
            activityCalls.push(
              `widget:${typeof content === "function" ? "factory" : ""}`
            );
          },
          setWorkingMessage() {
            // Should not touch global Working loader state.
          },
          setWorkingVisible() {
            activityCalls.push("working-visible");
          },
        },
      };

      skillsExtension(pi as never);
      await commands.get("skill")?.handler("list", commandCtx as never);

      expect(notifications).toHaveLength(1);
      expect(activityCalls).toEqual([
        "status:Loading skills…",
        "widget:factory",
        "status:",
        "widget:",
        "notify",
        "status:",
        "widget:",
      ]);
    } finally {
      process.env.HOME = originalHome;
    }
  });

  it("does not disable Pi's built-in Working indicator after /skill completes", async () => {
    const home = tempRoot("command-working-visible-state");
    const originalHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const commands = new Map<
        string,
        { handler(args: string, context: never): Promise<void> }
      >();
      const pi = {
        on() {
          // Test stub.
        },
        registerCommand(name: string, registeredCommand: unknown) {
          commands.set(
            name,
            registeredCommand as {
              handler(args: string, context: never): Promise<void>;
            }
          );
        },
      };
      let workingVisible = true;
      const commandCtx = {
        hasUI: true,
        ui: {
          notify() {
            // Test stub.
          },
          setStatus() {
            // Test stub.
          },
          setWidget() {
            // Test stub.
          },
          setWorkingMessage() {
            // Test stub.
          },
          setWorkingVisible(visible: boolean) {
            workingVisible = visible;
          },
        },
      };

      skillsExtension(pi as never);
      await commands.get("skill")?.handler("list", commandCtx as never);

      expect(workingVisible).toBe(true);
    } finally {
      process.env.HOME = originalHome;
    }
  });

  it("uses command-specific activity messages and suspends activity during prompts", async () => {
    const home = tempRoot("command-activity-prompts");
    const originalHome = process.env.HOME;
    const originalFetch = globalThis.fetch;
    process.env.HOME = home;
    try {
      globalThis.fetch = (() =>
        Promise.resolve(
          Response.json({ skills: [] })
        )) as unknown as typeof fetch;
      const commands = new Map<
        string,
        { handler(args: string, context: never): Promise<void> }
      >();
      const pi = {
        on() {
          // Test stub.
        },
        registerCommand(name: string, registeredCommand: unknown) {
          commands.set(
            name,
            registeredCommand as {
              handler(args: string, context: never): Promise<void>;
            }
          );
        },
      };
      const activityCalls: string[] = [];
      const commandCtx = {
        hasUI: true,
        ui: {
          input() {
            activityCalls.push("input");
            return Promise.resolve("missing");
          },
          notify() {
            activityCalls.push("notify");
          },
          setStatus(_key: string, text: string | undefined) {
            activityCalls.push(`status:${text ?? ""}`);
          },
          setWidget(_key: string, content: unknown) {
            activityCalls.push(
              `widget:${typeof content === "function" ? "factory" : ""}`
            );
          },
          setWorkingMessage() {
            // Should not touch global Working loader state.
          },
          setWorkingVisible() {
            activityCalls.push("working-visible");
          },
        },
      };

      skillsExtension(pi as never);
      await commands.get("skill")?.handler("search", commandCtx as never);

      expect(activityCalls.slice(0, 6)).toEqual([
        "status:Searching skills…",
        "widget:factory",
        "status:",
        "widget:",
        "input",
        "status:Searching skills…",
      ]);
      expect(activityCalls).not.toContain("working-visible");
      expect(activityCalls.at(-3)).toBe("notify");
      expect(activityCalls.at(-2)).toBe("status:");
      expect(activityCalls.at(-1)).toBe("widget:");
    } finally {
      globalThis.fetch = originalFetch;
      process.env.HOME = originalHome;
    }
  });

  it("sets a visible status while installing a remote repo before fetch resolves", async () => {
    const home = tempRoot("command-install-visible-status");
    const originalHome = process.env.HOME;
    const originalFetch = globalThis.fetch;
    process.env.HOME = home;
    try {
      let allowFetch = false;
      globalThis.fetch = (async () => {
        while (!allowFetch) {
          await Promise.resolve();
        }
        return new Response("missing", { status: 404 });
      }) as unknown as typeof fetch;
      const commands = new Map<
        string,
        { handler(args: string, context: never): Promise<void> }
      >();
      const pi = {
        on() {
          // Test stub.
        },
        registerCommand(name: string, registeredCommand: unknown) {
          commands.set(
            name,
            registeredCommand as {
              handler(args: string, context: never): Promise<void>;
            }
          );
        },
      };
      const statuses: Array<{ key: string; text: string | undefined }> = [];
      const widgets: Array<{ key: string; content: unknown }> = [];
      const commandCtx = {
        hasUI: true,
        ui: {
          notify() {
            // Test stub.
          },
          setStatus(key: string, text: string | undefined) {
            statuses.push({ key, text });
          },
          setWidget(key: string, content: unknown) {
            widgets.push({ key, content });
          },
          setWorkingMessage() {
            // Test stub.
          },
          setWorkingVisible() {
            // Test stub.
          },
        },
      };

      skillsExtension(pi as never);
      const pending = commands
        .get("skill")
        ?.handler("install supabase/agent-skills", commandCtx as never);
      await Promise.resolve();

      try {
        expect(statuses).toContainEqual({
          key: "skills-activity",
          text: "Installing skill…",
        });
        expect(widgets).toContainEqual({
          key: "skills-activity",
          content: expect.any(Function),
        });
      } finally {
        allowFetch = true;
        await pending;
      }
      expect(statuses).toContainEqual({
        key: "skills-activity",
        text: undefined,
      });
      expect(widgets).toContainEqual({
        key: "skills-activity",
        content: undefined,
      });
    } finally {
      globalThis.fetch = originalFetch;
      process.env.HOME = originalHome;
    }
  });

  it("persists exact GitHub source from a skills.sh broad repo install", async () => {
    const home = tempRoot("command-search-exact-source-install");
    const originalHome = process.env.HOME;
    const originalFetch = globalThis.fetch;
    process.env.HOME = home;
    try {
      globalThis.fetch = ((url: string | URL | Request) => {
        const value = String(url);
        if (value === "https://skills.sh/api/search?q=ai-sdk") {
          return Promise.resolve(
            Response.json({
              skills: [
                { skillId: "ai-sdk", name: "ai-sdk", source: "vercel/ai" },
              ],
            })
          );
        }
        if (value.includes("/git/trees/")) {
          return Promise.resolve(
            Response.json({
              tree: [
                { path: "skills/other/SKILL.md", type: "blob" },
                { path: "skills/use-ai-sdk/SKILL.md", type: "blob" },
              ],
            })
          );
        }
        if (value.endsWith("skills/other/SKILL.md")) {
          return Promise.resolve(
            new Response("---\nname: other\ndescription: Other skill.\n---\n")
          );
        }
        if (value.endsWith("skills/use-ai-sdk/SKILL.md")) {
          return Promise.resolve(
            new Response(
              "---\nname: ai-sdk\ndescription: Answer questions.\n---\n"
            )
          );
        }
        return Promise.resolve(new Response("missing", { status: 404 }));
      }) as typeof fetch;
      const commandCtx = {
        hasUI: true,
        ui: {
          select: () => Promise.resolve("ai-sdk — vercel/ai"),
          notify() {
            // Test stub.
          },
          setStatus() {
            // Test stub.
          },
          setWidget() {
            // Test stub.
          },
        },
      };
      const commands = registerSkillsCommand();

      await commands
        .get("skill")
        ?.handler("search ai-sdk", commandCtx as never);

      const [skill] = readManagedManifest(
        createSkillsManagerPaths().manifestPath
      ).skills;
      expect(skill?.source).toMatchObject({
        type: "github",
        owner: "vercel",
        repo: "ai",
        ref: "HEAD",
        subpath: "skills/use-ai-sdk",
        path: "vercel/ai/skills/use-ai-sdk",
      });
    } finally {
      globalThis.fetch = originalFetch;
      process.env.HOME = originalHome;
    }
  });

  it("installs the only skill in a broad GitHub source when search metadata differs", async () => {
    const home = tempRoot("command-search-single-skill-exact-source-install");
    const originalHome = process.env.HOME;
    const originalFetch = globalThis.fetch;
    process.env.HOME = home;
    try {
      globalThis.fetch = ((url: string | URL | Request) => {
        const value = String(url);
        if (value === "https://skills.sh/api/search?q=display") {
          return Promise.resolve(
            Response.json({
              skills: [
                {
                  skillId: "display-skill",
                  name: "Display Skill",
                  source: "owner/repo",
                },
              ],
            })
          );
        }
        if (value.includes("/git/trees/")) {
          return Promise.resolve(
            Response.json({
              tree: [{ path: "skills/actual/SKILL.md", type: "blob" }],
            })
          );
        }
        if (value.endsWith("skills/actual/SKILL.md")) {
          return Promise.resolve(
            new Response("---\nname: actual\ndescription: Actual skill.\n---\n")
          );
        }
        return Promise.resolve(new Response("missing", { status: 404 }));
      }) as typeof fetch;
      const commandCtx = {
        hasUI: true,
        ui: {
          select: () => Promise.resolve("Display Skill — owner/repo"),
          notify() {
            // Test stub.
          },
          setStatus() {
            // Test stub.
          },
          setWidget() {
            // Test stub.
          },
        },
      };
      const commands = registerSkillsCommand();

      await commands
        .get("skill")
        ?.handler("search display", commandCtx as never);

      const [skill] = readManagedManifest(
        createSkillsManagerPaths().manifestPath
      ).skills;
      expect(skill).toMatchObject({ id: "actual", name: "actual" });
      expect(skill?.source).toMatchObject({
        owner: "owner",
        repo: "repo",
        ref: "HEAD",
        subpath: "skills/actual",
        path: "owner/repo/skills/actual",
      });
    } finally {
      globalThis.fetch = originalFetch;
      process.env.HOME = originalHome;
    }
  });

  it("heals broad GitHub source metadata on explicit /skill update", async () => {
    const home = tempRoot("command-update-heal-source");
    const originalHome = process.env.HOME;
    const originalFetch = globalThis.fetch;
    process.env.HOME = home;
    try {
      const paths = createSkillsManagerPaths();
      const install = join(paths.managedDir, "ai-sdk");
      mkdirSync(install, { recursive: true });
      writeFileSync(
        join(install, "SKILL.md"),
        "---\nname: ai-sdk\ndescription: Answer questions.\n---\n"
      );
      writeManagedManifest(paths.manifestPath, {
        version: 1,
        skills: [
          {
            id: "ai-sdk",
            name: "ai-sdk",
            description: "Answer questions.",
            source: parseSkillSource("vercel/ai").identity,
            installPath: install,
            installedAt: "2026-05-21T00:00:00.000Z",
            files: hashSkillDirectory(install),
          },
        ],
      });
      globalThis.fetch = ((url: string | URL | Request) => {
        const value = String(url);
        if (value.includes("/git/trees/")) {
          return Promise.resolve(
            Response.json({
              tree: [{ path: "skills/use-ai-sdk/SKILL.md", type: "blob" }],
            })
          );
        }
        if (value.endsWith("skills/use-ai-sdk/SKILL.md")) {
          return Promise.resolve(
            new Response(
              "---\nname: ai-sdk\ndescription: Answer questions.\n---\n"
            )
          );
        }
        return Promise.resolve(new Response("missing", { status: 404 }));
      }) as typeof fetch;
      const commands = new Map<
        string,
        { handler(args: string, context: never): Promise<void> }
      >();
      const pi = {
        on() {
          // Test stub.
        },
        registerCommand(name: string, registeredCommand: unknown) {
          commands.set(
            name,
            registeredCommand as {
              handler(args: string, context: never): Promise<void>;
            }
          );
        },
      };
      const notifications: { message: string; level?: string }[] = [];
      const commandCtx = {
        hasUI: true,
        ui: {
          notify(message: string, level?: string) {
            notifications.push({ message, level });
          },
          setStatus() {
            // Test stub.
          },
          setWidget() {
            // Test stub.
          },
          setWorkingMessage() {
            // Test stub.
          },
          setWorkingVisible() {
            // Test stub.
          },
        },
      };

      skillsExtension(pi as never);
      await commands
        .get("skill")
        ?.handler("update ai-sdk", commandCtx as never);

      const [skill] = readManagedManifest(paths.manifestPath).skills;
      expect(skill?.source).toMatchObject({
        type: "github",
        owner: "vercel",
        repo: "ai",
        subpath: "skills/use-ai-sdk",
      });
      expect(skill?.files).toEqual(hashSkillDirectory(install));
      expect(notifications).toEqual([
        {
          message: "Updated exact source metadata for 1 skill(s).",
          level: "info",
        },
        { message: "No skill updates found.", level: "info" },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
      process.env.HOME = originalHome;
    }
  });

  it("updates root-level GitHub skills from broad sources", async () => {
    const home = tempRoot("command-update-root-github-skill");
    const originalHome = process.env.HOME;
    const originalFetch = globalThis.fetch;
    process.env.HOME = home;
    try {
      const paths = createSkillsManagerPaths();
      const install = join(paths.managedDir, "demo");
      mkdirSync(install, { recursive: true });
      writeFileSync(
        join(install, "SKILL.md"),
        "---\nname: demo\ndescription: Demo.\n---\n"
      );
      writeManagedManifest(paths.manifestPath, {
        version: 1,
        skills: [
          {
            id: "demo",
            name: "demo",
            description: "Demo.",
            source: parseSkillSource("owner/repo").identity,
            installPath: install,
            installedAt: "2026-05-21T00:00:00.000Z",
            files: hashSkillDirectory(install),
          },
        ],
      });
      globalThis.fetch = ((url: string | URL | Request) => {
        const value = String(url);
        if (value.includes("/git/trees/")) {
          return Promise.resolve(
            Response.json({ tree: [{ path: "SKILL.md", type: "blob" }] })
          );
        }
        if (value === "https://github.com/owner/repo/tree/HEAD/skills") {
          return Promise.resolve(new Response("missing", { status: 404 }));
        }
        return Promise.resolve(
          new Response("---\nname: demo\ndescription: Demo.\n---\n")
        );
      }) as typeof fetch;
      const commands = new Map<
        string,
        { handler(args: string, context: never): Promise<void> }
      >();
      const pi = {
        on() {
          // Test stub.
        },
        registerCommand(name: string, registeredCommand: unknown) {
          commands.set(
            name,
            registeredCommand as {
              handler(args: string, context: never): Promise<void>;
            }
          );
        },
      };
      const notifications: { message: string; level?: string }[] = [];
      const commandCtx = {
        hasUI: true,
        ui: {
          notify(message: string, level?: string) {
            notifications.push({ message, level });
          },
          setStatus() {
            // Test stub.
          },
          setWidget() {
            // Test stub.
          },
          setWorkingMessage() {
            // Test stub.
          },
          setWorkingVisible() {
            // Test stub.
          },
        },
      };

      skillsExtension(pi as never);
      await commands.get("skill")?.handler("update demo", commandCtx as never);

      expect(notifications).toEqual([
        { message: "No skill updates found.", level: "info" },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
      process.env.HOME = originalHome;
    }
  });

  it("recomputes persisted GitHub source ids before update materialization", async () => {
    const home = tempRoot("command-update-safe-source-id");
    const originalHome = process.env.HOME;
    const originalFetch = globalThis.fetch;
    process.env.HOME = home;
    try {
      const paths = createSkillsManagerPaths();
      const sentinelDir = join(paths.rootDir, "do-not-delete");
      mkdirSync(sentinelDir, { recursive: true });
      writeFileSync(join(sentinelDir, "sentinel.txt"), "keep\n");
      const install = join(paths.managedDir, "demo");
      mkdirSync(install, { recursive: true });
      writeFileSync(
        join(install, "SKILL.md"),
        "---\nname: demo\ndescription: Demo.\n---\n"
      );
      writeManagedManifest(paths.manifestPath, {
        version: 1,
        skills: [
          {
            id: "demo",
            name: "demo",
            description: "Demo.",
            source: {
              ...parseSkillSource("owner/repo").identity,
              id: "../../do-not-delete",
            },
            installPath: install,
            installedAt: "2026-05-21T00:00:00.000Z",
            files: hashSkillDirectory(install),
          },
        ],
      });
      globalThis.fetch = ((url: string | URL | Request) => {
        const value = String(url);
        if (value.includes("/git/trees/")) {
          return Promise.resolve(
            Response.json({
              tree: [{ path: "skills/demo/SKILL.md", type: "blob" }],
            })
          );
        }
        return Promise.resolve(
          new Response("---\nname: demo\ndescription: Demo.\n---\n")
        );
      }) as typeof fetch;
      const commands = new Map<
        string,
        { handler(args: string, context: never): Promise<void> }
      >();
      const pi = {
        on() {
          // Test stub.
        },
        registerCommand(name: string, registeredCommand: unknown) {
          commands.set(
            name,
            registeredCommand as {
              handler(args: string, context: never): Promise<void>;
            }
          );
        },
      };
      const commandCtx = {
        hasUI: true,
        ui: {
          notify() {
            // Test stub.
          },
          setStatus() {
            // Test stub.
          },
          setWidget() {
            // Test stub.
          },
          setWorkingMessage() {
            // Test stub.
          },
          setWorkingVisible() {
            // Test stub.
          },
        },
      };

      skillsExtension(pi as never);
      await commands.get("skill")?.handler("update demo", commandCtx as never);

      const [skill] = readManagedManifest(paths.manifestPath).skills;
      expect(existsSync(join(sentinelDir, "sentinel.txt"))).toBe(true);
      expect(skill?.source).toMatchObject({
        owner: "owner",
        repo: "repo",
        subpath: "skills/demo",
      });
      expect(skill?.source.id).not.toBe("../../do-not-delete");
    } finally {
      globalThis.fetch = originalFetch;
      process.env.HOME = originalHome;
    }
  });

  it("preserves broad GitHub source refs while healing metadata", async () => {
    const home = tempRoot("command-update-heal-source-ref");
    const originalHome = process.env.HOME;
    const originalFetch = globalThis.fetch;
    process.env.HOME = home;
    try {
      const paths = createSkillsManagerPaths();
      const install = join(paths.managedDir, "demo");
      mkdirSync(install, { recursive: true });
      writeFileSync(
        join(install, "SKILL.md"),
        "---\nname: demo\ndescription: Demo.\n---\n"
      );
      writeManagedManifest(paths.manifestPath, {
        version: 1,
        skills: [
          {
            id: "demo",
            name: "demo",
            description: "Demo.",
            source: parseSkillSource("owner/repo#dev").identity,
            installPath: install,
            installedAt: "2026-05-21T00:00:00.000Z",
            files: hashSkillDirectory(install),
          },
        ],
      });
      const requestedUrls: string[] = [];
      globalThis.fetch = ((url: string | URL | Request) => {
        const value = String(url);
        requestedUrls.push(value);
        if (value.includes("/git/trees/")) {
          return Promise.resolve(
            Response.json({
              tree: [{ path: "skills/demo/SKILL.md", type: "blob" }],
            })
          );
        }
        return Promise.resolve(
          new Response("---\nname: demo\ndescription: Demo.\n---\n")
        );
      }) as typeof fetch;
      const commands = new Map<
        string,
        { handler(args: string, context: never): Promise<void> }
      >();
      const pi = {
        on() {
          // Test stub.
        },
        registerCommand(name: string, registeredCommand: unknown) {
          commands.set(
            name,
            registeredCommand as {
              handler(args: string, context: never): Promise<void>;
            }
          );
        },
      };
      const commandCtx = {
        hasUI: true,
        ui: {
          notify() {
            // Test stub.
          },
          setStatus() {
            // Test stub.
          },
          setWidget() {
            // Test stub.
          },
          setWorkingMessage() {
            // Test stub.
          },
          setWorkingVisible() {
            // Test stub.
          },
        },
      };

      skillsExtension(pi as never);
      await commands.get("skill")?.handler("update demo", commandCtx as never);

      const [skill] = readManagedManifest(paths.manifestPath).skills;
      expect(skill?.source).toMatchObject({
        ref: "dev",
        subpath: "skills/demo",
        path: "owner/repo/skills/demo",
      });
      expect(requestedUrls).toContain(
        "https://api.github.com/repos/owner/repo/git/trees/dev?recursive=1"
      );
    } finally {
      globalThis.fetch = originalFetch;
      process.env.HOME = originalHome;
    }
  });

  it("installs exact GitHub source updates with slash-containing refs", async () => {
    const home = tempRoot("command-update-exact-source-slash-ref");
    const originalHome = process.env.HOME;
    const originalFetch = globalThis.fetch;
    process.env.HOME = home;
    try {
      const paths = createSkillsManagerPaths();
      const install = join(paths.managedDir, "demo");
      mkdirSync(install, { recursive: true });
      writeFileSync(
        join(install, "SKILL.md"),
        "---\nname: demo\ndescription: Old demo.\n---\n"
      );
      writeManagedManifest(paths.manifestPath, {
        version: 1,
        skills: [
          {
            id: "demo",
            name: "demo",
            description: "Demo.",
            source: {
              ...parseSkillSource("owner/repo#feature/foo").identity,
              path: "owner/repo/skills/demo",
              subpath: "skills/demo",
              id: "slash-ref-exact-source",
            },
            installPath: install,
            installedAt: "2026-05-21T00:00:00.000Z",
            files: hashSkillDirectory(install),
          },
        ],
      });
      const requestedUrls: string[] = [];
      globalThis.fetch = ((url: string | URL | Request) => {
        const value = String(url);
        requestedUrls.push(value);
        if (value.includes("/git/trees/")) {
          return Promise.resolve(
            Response.json({
              tree: [{ path: "skills/demo/SKILL.md", type: "blob" }],
            })
          );
        }
        return Promise.resolve(
          new Response("---\nname: demo\ndescription: New demo.\n---\n")
        );
      }) as typeof fetch;
      const commands = new Map<
        string,
        { handler(args: string, context: never): Promise<void> }
      >();
      const pi = {
        on() {
          // Test stub.
        },
        registerCommand(name: string, registeredCommand: unknown) {
          commands.set(
            name,
            registeredCommand as {
              handler(args: string, context: never): Promise<void>;
            }
          );
        },
      };
      const commandCtx = {
        hasUI: true,
        ui: {
          notify() {
            // Test stub.
          },
          setStatus() {
            // Test stub.
          },
          setWidget() {
            // Test stub.
          },
          setWorkingMessage() {
            // Test stub.
          },
          setWorkingVisible() {
            // Test stub.
          },
        },
      };

      skillsExtension(pi as never);
      await commands.get("skill")?.handler("update demo", commandCtx as never);

      expect(requestedUrls).toContain(
        "https://api.github.com/repos/owner/repo/git/trees/feature%2Ffoo?recursive=1"
      );
      expect(requestedUrls).not.toContain(
        "https://api.github.com/repos/owner/repo/git/trees/feature?recursive=1"
      );
      expect(readFileSync(join(install, "SKILL.md"), "utf8")).toBe(
        "---\nname: demo\ndescription: New demo.\n---\n"
      );
    } finally {
      globalThis.fetch = originalFetch;
      process.env.HOME = originalHome;
    }
  });

  it("does not heal broad GitHub source metadata when resolved root has another skill id", async () => {
    const home = tempRoot("command-update-heal-wrong-skill");
    const originalHome = process.env.HOME;
    const originalFetch = globalThis.fetch;
    process.env.HOME = home;
    try {
      const paths = createSkillsManagerPaths();
      const install = join(paths.managedDir, "ai-sdk");
      mkdirSync(install, { recursive: true });
      writeFileSync(
        join(install, "SKILL.md"),
        "---\nname: ai-sdk\ndescription: Answer questions.\n---\n"
      );
      const broadSource = parseSkillSource("vercel/ai").identity;
      writeManagedManifest(paths.manifestPath, {
        version: 1,
        skills: [
          {
            id: "ai-sdk",
            name: "ai-sdk",
            description: "Answer questions.",
            source: broadSource,
            installPath: install,
            installedAt: "2026-05-21T00:00:00.000Z",
            files: hashSkillDirectory(install),
          },
        ],
      });
      globalThis.fetch = ((url: string | URL | Request) => {
        const value = String(url);
        if (value.includes("/git/trees/")) {
          return Promise.resolve(
            Response.json({
              tree: [{ path: "skills/ai-sdk/SKILL.md", type: "blob" }],
            })
          );
        }
        return Promise.resolve(
          new Response("---\nname: other\ndescription: Other skill.\n---\n")
        );
      }) as typeof fetch;
      const commands = new Map<
        string,
        { handler(args: string, context: never): Promise<void> }
      >();
      const pi = {
        on() {
          // Test stub.
        },
        registerCommand(name: string, registeredCommand: unknown) {
          commands.set(
            name,
            registeredCommand as {
              handler(args: string, context: never): Promise<void>;
            }
          );
        },
      };
      const notifications: { message: string; level?: string }[] = [];
      const commandCtx = {
        hasUI: true,
        ui: {
          notify(message: string, level?: string) {
            notifications.push({ message, level });
          },
          setStatus() {
            // Test stub.
          },
          setWidget() {
            // Test stub.
          },
          setWorkingMessage() {
            // Test stub.
          },
          setWorkingVisible() {
            // Test stub.
          },
        },
      };

      skillsExtension(pi as never);
      await commands
        .get("skill")
        ?.handler("update ai-sdk", commandCtx as never);

      const [skill] = readManagedManifest(paths.manifestPath).skills;
      expect(skill?.source).toEqual(broadSource);
      expect(notifications).toEqual([
        { message: "No skill updates found.", level: "info" },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
      process.env.HOME = originalHome;
    }
  });

  it("heals source metadata without overwriting dirty installed files", async () => {
    const home = tempRoot("command-update-heal-dirty");
    const originalHome = process.env.HOME;
    const originalFetch = globalThis.fetch;
    process.env.HOME = home;
    try {
      const paths = createSkillsManagerPaths();
      const install = join(paths.managedDir, "ai-sdk");
      mkdirSync(install, { recursive: true });
      const cleanSkill =
        "---\nname: ai-sdk\ndescription: Answer questions.\n---\n";
      writeFileSync(join(install, "SKILL.md"), cleanSkill);
      const files = hashSkillDirectory(install);
      writeFileSync(join(install, "SKILL.md"), `${cleanSkill}\n# local note\n`);
      writeManagedManifest(paths.manifestPath, {
        version: 1,
        skills: [
          {
            id: "ai-sdk",
            name: "ai-sdk",
            description: "Answer questions.",
            source: parseSkillSource("vercel/ai").identity,
            installPath: install,
            installedAt: "2026-05-21T00:00:00.000Z",
            files,
          },
        ],
      });
      globalThis.fetch = ((url: string | URL | Request) => {
        const value = String(url);
        if (value.includes("/git/trees/")) {
          return Promise.resolve(
            Response.json({
              tree: [{ path: "skills/use-ai-sdk/SKILL.md", type: "blob" }],
            })
          );
        }
        return Promise.resolve(new Response(cleanSkill));
      }) as typeof fetch;
      const commands = new Map<
        string,
        { handler(args: string, context: never): Promise<void> }
      >();
      const pi = {
        on() {
          // Test stub.
        },
        registerCommand(name: string, registeredCommand: unknown) {
          commands.set(
            name,
            registeredCommand as {
              handler(args: string, context: never): Promise<void>;
            }
          );
        },
      };
      const notifications: { message: string; level?: string }[] = [];
      const commandCtx = {
        hasUI: true,
        ui: {
          notify(message: string, level?: string) {
            notifications.push({ message, level });
          },
          setStatus() {
            // Test stub.
          },
          setWidget() {
            // Test stub.
          },
          setWorkingMessage() {
            // Test stub.
          },
          setWorkingVisible() {
            // Test stub.
          },
        },
      };

      skillsExtension(pi as never);
      await commands
        .get("skill")
        ?.handler("update ai-sdk", commandCtx as never);

      const [skill] = readManagedManifest(paths.manifestPath).skills;
      expect(skill?.source).toMatchObject({ subpath: "skills/use-ai-sdk" });
      expect(readFileSync(join(install, "SKILL.md"), "utf8")).toBe(
        `${cleanSkill}\n# local note\n`
      );
      expect(skill?.files).toEqual(files);
      expect(notifications).toContainEqual({
        message: "Updated exact source metadata for 1 skill(s).",
        level: "info",
      });
    } finally {
      globalThis.fetch = originalFetch;
      process.env.HOME = originalHome;
    }
  });

  it("reports ambiguous broad GitHub source healing clearly", async () => {
    const home = tempRoot("command-update-heal-ambiguous");
    const originalHome = process.env.HOME;
    const originalFetch = globalThis.fetch;
    process.env.HOME = home;
    try {
      const paths = createSkillsManagerPaths();
      writeManagedManifest(paths.manifestPath, {
        version: 1,
        skills: [
          {
            id: "demo-skill",
            name: "Demo Skill",
            description: "Demo.",
            source: parseSkillSource("owner/repo").identity,
            installPath: join(paths.managedDir, "demo-skill"),
            installedAt: "2026-05-21T00:00:00.000Z",
            files: [{ relativePath: "SKILL.md", sha256: "old", bytes: 1 }],
          },
        ],
      });
      globalThis.fetch = ((url: string | URL | Request) => {
        const value = String(url);
        if (value.includes("/git/trees/")) {
          return Promise.resolve(
            Response.json({
              tree: [
                { path: "skills/one/SKILL.md", type: "blob" },
                { path: "skills/two/SKILL.md", type: "blob" },
              ],
            })
          );
        }
        return Promise.resolve(
          new Response("# Other Skill\n\ndescription: Demo.\n")
        );
      }) as typeof fetch;
      const commands = new Map<
        string,
        { handler(args: string, context: never): Promise<void> }
      >();
      const pi = {
        on() {
          // Test stub.
        },
        registerCommand(name: string, registeredCommand: unknown) {
          commands.set(
            name,
            registeredCommand as {
              handler(args: string, context: never): Promise<void>;
            }
          );
        },
      };
      const notifications: { message: string; level?: string }[] = [];
      const commandCtx = {
        hasUI: true,
        ui: {
          notify(message: string, level?: string) {
            notifications.push({ message, level });
          },
          setStatus() {
            // Test stub.
          },
          setWidget() {
            // Test stub.
          },
          setWorkingMessage() {
            // Test stub.
          },
          setWorkingVisible() {
            // Test stub.
          },
        },
      };

      skillsExtension(pi as never);
      await commands
        .get("skill")
        ?.handler("update demo-skill", commandCtx as never);

      expect(notifications).toContainEqual({
        message:
          "Unable to check 1 skill update source: Demo Skill (owner/repo): Unable to resolve demo-skill to one exact GitHub skill source.",
        level: "error",
      });
    } finally {
      globalThis.fetch = originalFetch;
      process.env.HOME = originalHome;
    }
  });

  it("keeps background update checks read-only when source metadata can be healed", async () => {
    const home = tempRoot("background-update-heal-read-only");
    const originalHome = process.env.HOME;
    const originalFetch = globalThis.fetch;
    process.env.HOME = home;
    try {
      const paths = createSkillsManagerPaths();
      const install = join(paths.managedDir, "ai-sdk");
      mkdirSync(install, { recursive: true });
      writeFileSync(
        join(install, "SKILL.md"),
        "---\nname: ai-sdk\ndescription: Answer questions.\n---\n"
      );
      const broadSource = parseSkillSource("vercel/ai").identity;
      writeManagedManifest(paths.manifestPath, {
        version: 1,
        skills: [
          {
            id: "ai-sdk",
            name: "ai-sdk",
            description: "Answer questions.",
            source: broadSource,
            installPath: install,
            installedAt: "2026-05-21T00:00:00.000Z",
            files: hashSkillDirectory(install),
          },
        ],
      });
      globalThis.fetch = ((url: string | URL | Request) => {
        const value = String(url);
        if (value.includes("/git/trees/")) {
          return Promise.resolve(
            Response.json({
              tree: [{ path: "skills/use-ai-sdk/SKILL.md", type: "blob" }],
            })
          );
        }
        return Promise.resolve(
          new Response(
            "---\nname: ai-sdk\ndescription: Answer questions.\n---\n"
          )
        );
      }) as typeof fetch;
      const handlers = new Map<string, (event: unknown, ctx: never) => void>();
      const pi = {
        on(name: string, handler: (event: unknown, ctx: never) => void) {
          handlers.set(name, handler);
        },
        registerCommand() {
          // Test stub.
        },
      };
      const notifications: { message: string; level?: string }[] = [];
      const ctx = {
        hasUI: true,
        ui: {
          notify(message: string, level?: string) {
            notifications.push({ message, level });
          },
          setStatus() {
            // Test stub.
          },
        },
      };

      skillsExtension(pi as never);
      handlers.get("session_start")?.({}, ctx as never);
      await Promise.resolve();
      await Promise.resolve();

      expect(readManagedManifest(paths.manifestPath).skills[0]?.source).toEqual(
        broadSource
      );
      expect(notifications).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
      process.env.HOME = originalHome;
    }
  });

  it("checks exact update subpaths with referenced files without false 404 warnings", async () => {
    const home = tempRoot("command-update-exact-subpath-clean");
    const originalHome = process.env.HOME;
    const originalFetch = globalThis.fetch;
    process.env.HOME = home;
    try {
      const paths = createSkillsManagerPaths();
      const install = join(paths.managedDir, "use-ai-sdk");
      mkdirSync(join(install, "references"), { recursive: true });
      mkdirSync(join(install, "scripts"), { recursive: true });
      writeFileSync(
        join(install, "SKILL.md"),
        "# Use AI SDK\n\ndescription: Build with AI SDK.\n"
      );
      writeFileSync(join(install, "references", "errors.md"), "# Errors\n");
      writeFileSync(join(install, "scripts", "setup.sh"), "echo setup\n");
      const files = hashSkillDirectory(install);
      writeManagedManifest(paths.manifestPath, {
        version: 1,
        skills: [
          {
            id: "use-ai-sdk",
            name: "Use AI SDK",
            description: "Build with AI SDK.",
            source: parseSkillSource("owner/repo/tree/HEAD/skills/use-ai-sdk")
              .identity,
            installPath: install,
            installedAt: "2026-05-21T00:00:00.000Z",
            files,
          },
        ],
      });
      const requestedUrls: string[] = [];
      const responses = new Map<string, Response>([
        [
          "https://api.github.com/repos/owner/repo/git/trees/HEAD?recursive=1",
          Response.json({
            tree: [
              { path: "skills/use-ai-sdk/SKILL.md", type: "blob" },
              {
                path: "skills/use-ai-sdk/references/errors.md",
                type: "blob",
              },
              { path: "skills/use-ai-sdk/scripts/setup.sh", type: "blob" },
            ],
          }),
        ],
        [
          "https://raw.githubusercontent.com/owner/repo/HEAD/skills/use-ai-sdk/SKILL.md",
          new Response("# Use AI SDK\n\ndescription: Build with AI SDK.\n"),
        ],
        [
          "https://raw.githubusercontent.com/owner/repo/HEAD/skills/use-ai-sdk/references/errors.md",
          new Response("# Errors\n"),
        ],
        [
          "https://raw.githubusercontent.com/owner/repo/HEAD/skills/use-ai-sdk/scripts/setup.sh",
          new Response("echo setup\n"),
        ],
      ]);
      globalThis.fetch = ((url: string | URL | Request) => {
        const value = String(url);
        requestedUrls.push(value);
        return Promise.resolve(
          responses.get(value) ?? new Response("missing", { status: 404 })
        );
      }) as typeof fetch;
      const commands = new Map<
        string,
        { handler(args: string, context: never): Promise<void> }
      >();
      const pi = {
        on() {
          // Test stub.
        },
        registerCommand(name: string, registeredCommand: unknown) {
          commands.set(
            name,
            registeredCommand as {
              handler(args: string, context: never): Promise<void>;
            }
          );
        },
      };
      const notifications: { message: string; level?: string }[] = [];
      const commandCtx = {
        hasUI: true,
        ui: {
          notify(message: string, level?: string) {
            notifications.push({ message, level });
          },
          setStatus() {
            // Test stub.
          },
          setWidget() {
            // Test stub.
          },
          setWorkingMessage() {
            // Test stub.
          },
          setWorkingVisible() {
            // Test stub.
          },
        },
      };

      skillsExtension(pi as never);
      await commands.get("skill")?.handler("update", commandCtx as never);

      expect(notifications).toEqual([
        { message: "No skill updates found.", level: "info" },
      ]);
      expect(requestedUrls).not.toContain(
        "https://github.com/owner/repo/tree/HEAD/skills/use-ai-sdk"
      );
      expect(requestedUrls).not.toContain(
        "https://raw.githubusercontent.com/owner/repo/HEAD/skills/use-ai-sdk"
      );
      expect(requestedUrls).toContain(
        "https://raw.githubusercontent.com/owner/repo/HEAD/skills/use-ai-sdk/references/errors.md"
      );
      expect(requestedUrls).toContain(
        "https://raw.githubusercontent.com/owner/repo/HEAD/skills/use-ai-sdk/scripts/setup.sh"
      );
    } finally {
      globalThis.fetch = originalFetch;
      process.env.HOME = originalHome;
    }
  });

  it("does not treat exact-source child directories as skills during /skill update HTML fallback", async () => {
    const home = tempRoot("command-update-exact-html-fallback");
    const originalHome = process.env.HOME;
    const originalFetch = globalThis.fetch;
    process.env.HOME = home;
    try {
      const paths = createSkillsManagerPaths();
      const install = join(paths.managedDir, "ai-sdk");
      mkdirSync(join(install, "references"), { recursive: true });
      writeFileSync(
        join(install, "SKILL.md"),
        "# AI SDK\n\ndescription: Build with AI SDK.\n"
      );
      writeFileSync(join(install, "references", "errors.md"), "# Errors\n");
      const files = hashSkillDirectory(install);
      writeManagedManifest(paths.manifestPath, {
        version: 1,
        skills: [
          {
            id: "ai-sdk",
            name: "ai-sdk",
            description: "Build with AI SDK.",
            source: parseSkillSource("vercel/ai/tree/HEAD/skills/use-ai-sdk")
              .identity,
            installPath: install,
            installedAt: "2026-05-21T00:00:00.000Z",
            files,
          },
        ],
      });
      const requestedUrls: string[] = [];
      const responses = new Map<string, Response>([
        [
          "https://api.github.com/repos/vercel/ai/git/trees/HEAD?recursive=1",
          Response.json({ message: "rate limited" }, { status: 403 }),
        ],
        [
          "https://github.com/vercel/ai/tree/HEAD/skills/use-ai-sdk",
          new Response(
            '<a href="/vercel/ai/blob/HEAD/skills/use-ai-sdk/SKILL.md">SKILL.md</a><a href="/vercel/ai/tree/HEAD/skills/use-ai-sdk/references">references</a>'
          ),
        ],
        [
          "https://github.com/vercel/ai/tree/HEAD/skills/use-ai-sdk/references",
          new Response(
            '<a href="/vercel/ai/blob/HEAD/skills/use-ai-sdk/references/errors.md">errors.md</a>'
          ),
        ],
        [
          "https://raw.githubusercontent.com/vercel/ai/HEAD/skills/use-ai-sdk/SKILL.md",
          new Response("# AI SDK\n\ndescription: Build with AI SDK.\n"),
        ],
        [
          "https://raw.githubusercontent.com/vercel/ai/HEAD/skills/use-ai-sdk/references/errors.md",
          new Response("# Errors\n"),
        ],
      ]);
      globalThis.fetch = ((url: string | URL | Request) => {
        const value = String(url);
        requestedUrls.push(value);
        return Promise.resolve(
          responses.get(value)?.clone() ??
            new Response("missing", { status: 404 })
        );
      }) as typeof fetch;
      const commands = new Map<
        string,
        { handler(args: string, context: never): Promise<void> }
      >();
      const pi = {
        on() {
          // Test stub.
        },
        registerCommand(name: string, registeredCommand: unknown) {
          commands.set(
            name,
            registeredCommand as {
              handler(args: string, context: never): Promise<void>;
            }
          );
        },
      };
      const notifications: { message: string; level?: string }[] = [];
      const commandCtx = {
        hasUI: true,
        ui: {
          notify(message: string, level?: string) {
            notifications.push({ message, level });
          },
          setStatus() {
            // Test stub.
          },
          setWidget() {
            // Test stub.
          },
          setWorkingMessage() {
            // Test stub.
          },
          setWorkingVisible() {
            // Test stub.
          },
        },
      };

      skillsExtension(pi as never);
      await commands
        .get("skill")
        ?.handler("update ai-sdk", commandCtx as never);

      expect(notifications).toEqual([
        { message: "No skill updates found.", level: "info" },
      ]);
      expect(requestedUrls).not.toContain(
        "https://raw.githubusercontent.com/vercel/ai/HEAD/skills/use-ai-sdk/references/SKILL.md"
      );
      expect(requestedUrls).toContain(
        "https://raw.githubusercontent.com/vercel/ai/HEAD/skills/use-ai-sdk/references/errors.md"
      );
    } finally {
      globalThis.fetch = originalFetch;
      process.env.HOME = originalHome;
    }
  });

  it("updates an exact-source skill via HTML fallback without treating child directories as skills", async () => {
    const home = tempRoot("command-update-exact-html-fallback-apply");
    const originalHome = process.env.HOME;
    const originalFetch = globalThis.fetch;
    process.env.HOME = home;
    try {
      const paths = createSkillsManagerPaths();
      const install = join(paths.managedDir, "ai-sdk");
      mkdirSync(join(install, "references"), { recursive: true });
      writeFileSync(
        join(install, "SKILL.md"),
        "# AI SDK\n\ndescription: Old AI SDK.\n"
      );
      writeFileSync(join(install, "references", "errors.md"), "# Errors\n");
      const files = hashSkillDirectory(install);
      writeManagedManifest(paths.manifestPath, {
        version: 1,
        skills: [
          {
            id: "ai-sdk",
            name: "ai-sdk",
            description: "Old AI SDK.",
            source: parseSkillSource("vercel/ai/tree/HEAD/skills/use-ai-sdk")
              .identity,
            installPath: install,
            installedAt: "2026-05-21T00:00:00.000Z",
            files,
          },
        ],
      });
      const requestedUrls: string[] = [];
      const responses = new Map<string, Response>([
        [
          "https://api.github.com/repos/vercel/ai/git/trees/HEAD?recursive=1",
          Response.json({ message: "rate limited" }, { status: 403 }),
        ],
        [
          "https://github.com/vercel/ai/tree/HEAD/skills/use-ai-sdk",
          new Response(
            '<a href="/vercel/ai/blob/HEAD/skills/use-ai-sdk/SKILL.md">SKILL.md</a><a href="/vercel/ai/tree/HEAD/skills/use-ai-sdk/references">references</a>'
          ),
        ],
        [
          "https://github.com/vercel/ai/tree/HEAD/skills/use-ai-sdk/references",
          new Response(
            '<a href="/vercel/ai/blob/HEAD/skills/use-ai-sdk/references/errors.md">errors.md</a>'
          ),
        ],
        [
          "https://raw.githubusercontent.com/vercel/ai/HEAD/skills/use-ai-sdk/SKILL.md",
          new Response("# AI SDK\n\ndescription: New AI SDK.\n"),
        ],
        [
          "https://raw.githubusercontent.com/vercel/ai/HEAD/skills/use-ai-sdk/references/errors.md",
          new Response("# Updated errors\n"),
        ],
      ]);
      globalThis.fetch = ((url: string | URL | Request) => {
        const value = String(url);
        requestedUrls.push(value);
        return Promise.resolve(
          responses.get(value)?.clone() ??
            new Response("missing", { status: 404 })
        );
      }) as typeof fetch;
      const commands = new Map<
        string,
        { handler(args: string, context: never): Promise<void> }
      >();
      const pi = {
        on() {
          // Test stub.
        },
        registerCommand(name: string, registeredCommand: unknown) {
          commands.set(
            name,
            registeredCommand as {
              handler(args: string, context: never): Promise<void>;
            }
          );
        },
      };
      const notifications: { message: string; level?: string }[] = [];
      const commandCtx = {
        hasUI: true,
        ui: {
          notify(message: string, level?: string) {
            notifications.push({ message, level });
          },
          select() {
            return "All updates";
          },
          setStatus() {
            // Test stub.
          },
          setWidget() {
            // Test stub.
          },
          setWorkingMessage() {
            // Test stub.
          },
          setWorkingVisible() {
            // Test stub.
          },
        },
      };

      skillsExtension(pi as never);
      await commands.get("skill")?.handler("update", commandCtx as never);

      expect(notifications.some((item) => item.level === "error")).toBe(false);
      expect(notifications).toContainEqual({
        message:
          "Updated 1 skill(s). Changes apply after /reload or next session.",
        level: "info",
      });
      expect(requestedUrls).not.toContain(
        "https://raw.githubusercontent.com/vercel/ai/HEAD/skills/use-ai-sdk/references/SKILL.md"
      );
      expect(
        readFileSync(join(install, "references", "errors.md"), "utf8")
      ).toBe("# Updated errors\n");
    } finally {
      globalThis.fetch = originalFetch;
      process.env.HOME = originalHome;
    }
  });

  it("continues /skill update when one remote source 404s", async () => {
    const home = tempRoot("command-update-partial-404");
    const originalHome = process.env.HOME;
    const originalFetch = globalThis.fetch;
    process.env.HOME = home;
    try {
      const paths = createSkillsManagerPaths();
      const goodInstall = join(paths.managedDir, "good-skill");
      mkdirSync(goodInstall, { recursive: true });
      writeFileSync(
        join(goodInstall, "SKILL.md"),
        "# Good Skill\n\ndescription: Still exists.\n"
      );
      const goodFiles = hashSkillDirectory(goodInstall);
      writeManagedManifest(paths.manifestPath, {
        version: 1,
        skills: [
          {
            id: "bad-skill",
            name: "Bad Skill",
            description: "Gone.",
            source: parseSkillSource("missing/repo/tree/HEAD/skills/bad")
              .identity,
            installPath: join(paths.managedDir, "bad-skill"),
            installedAt: "2026-05-21T00:00:00.000Z",
            files: [{ relativePath: "SKILL.md", sha256: "missing", bytes: 1 }],
          },
          {
            id: "good-skill",
            name: "Good Skill",
            description: "Still exists.",
            source: parseSkillSource("owner/repo/tree/HEAD/skills/good")
              .identity,
            installPath: goodInstall,
            installedAt: "2026-05-21T00:00:00.000Z",
            files: goodFiles,
          },
        ],
      });
      const responses = new Map<string, Response>([
        [
          "https://api.github.com/repos/owner/repo/git/trees/HEAD?recursive=1",
          Response.json({
            tree: [{ path: "skills/good/SKILL.md", type: "blob" }],
          }),
        ],
        [
          "https://raw.githubusercontent.com/owner/repo/HEAD/skills/good/SKILL.md",
          new Response("# Good Skill\n\ndescription: Still exists.\n"),
        ],
      ]);
      globalThis.fetch = ((url: string | URL | Request) =>
        Promise.resolve(
          responses.get(String(url)) ?? new Response("missing", { status: 404 })
        )) as typeof fetch;
      const commands = new Map<
        string,
        { handler(args: string, context: never): Promise<void> }
      >();
      const pi = {
        on() {
          // Test stub.
        },
        registerCommand(name: string, registeredCommand: unknown) {
          commands.set(
            name,
            registeredCommand as {
              handler(args: string, context: never): Promise<void>;
            }
          );
        },
      };
      const notifications: { message: string; level?: string }[] = [];
      const commandCtx = {
        hasUI: true,
        ui: {
          notify(message: string, level?: string) {
            notifications.push({ message, level });
          },
          setStatus() {
            // Test stub.
          },
          setWidget() {
            // Test stub.
          },
          setWorkingMessage() {
            // Test stub.
          },
          setWorkingVisible() {
            // Test stub.
          },
        },
      };

      skillsExtension(pi as never);
      await commands.get("skill")?.handler("update", commandCtx as never);

      expect(notifications.some((item) => item.level === "error")).toBe(false);
      expect(notifications).toContainEqual({
        message: "No skill updates found.",
        level: "info",
      });
      expect(notifications).toContainEqual({
        message:
          "Unable to check 1 skill update source: Bad Skill (missing/repo/tree/HEAD/skills/bad): Fetch failed: 404",
        level: "warning",
      });
    } finally {
      globalThis.fetch = originalFetch;
      process.env.HOME = originalHome;
    }
  });

  it("stops activity before showing a short actionable /skill failure", async () => {
    const home = tempRoot("command-activity-failure");
    const originalHome = process.env.HOME;
    const originalFetch = globalThis.fetch;
    process.env.HOME = home;
    try {
      globalThis.fetch = (() =>
        Promise.resolve(
          new Response("missing", { status: 404 })
        )) as unknown as typeof fetch;
      const commands = new Map<
        string,
        { handler(args: string, context: never): Promise<void> }
      >();
      const pi = {
        on() {
          // Test stub.
        },
        registerCommand(name: string, registeredCommand: unknown) {
          commands.set(
            name,
            registeredCommand as {
              handler(args: string, context: never): Promise<void>;
            }
          );
        },
      };
      const activityCalls: string[] = [];
      const notifications: { message: string; level?: string }[] = [];
      const commandCtx = {
        hasUI: true,
        ui: {
          notify(message: string, level?: string) {
            notifications.push({ message, level });
            activityCalls.push("notify");
          },
          setStatus(_key: string, text: string | undefined) {
            activityCalls.push(`status:${text ?? ""}`);
          },
          setWidget(_key: string, content: unknown) {
            activityCalls.push(
              `widget:${typeof content === "function" ? "factory" : ""}`
            );
          },
          setWorkingMessage() {
            // Should not touch global Working loader state.
          },
          setWorkingVisible() {
            activityCalls.push("working-visible");
          },
        },
      };

      skillsExtension(pi as never);
      await commands
        .get("skill")
        ?.handler("install owner/repo", commandCtx as never);

      expect(notifications).toHaveLength(1);
      expect(notifications[0]?.level).toBe("error");
      expect(notifications[0]?.message).not.toContain("\n");
      expect(notifications[0]?.message).toContain("Fetch failed: 404");
      expect(activityCalls.slice(-3)).toEqual(["status:", "widget:", "notify"]);
      expect(activityCalls).not.toContain("working-visible");
    } finally {
      globalThis.fetch = originalFetch;
      process.env.HOME = originalHome;
    }
  });

  it("shows search result counts and a clear no-result message", async () => {
    const home = tempRoot("command-search-counts");
    const originalHome = process.env.HOME;
    const originalFetch = globalThis.fetch;
    process.env.HOME = home;
    try {
      globalThis.fetch = ((url: string | URL | Request) => {
        const query = String(url).includes("missing")
          ? []
          : [
              {
                name: "Demo Skill",
                description: "Does demos.",
                source: "https://github.com/acme/demo/tree/HEAD/skills/demo",
              },
              {
                name: "Other Demo Skill",
                description: "Does other demo work.",
                source: "https://github.com/acme/other/tree/HEAD/skills/other",
              },
            ];
        return Promise.resolve(Response.json({ skills: query }));
      }) as typeof fetch;
      const commands = new Map<
        string,
        { handler(args: string, context: never): Promise<void> }
      >();
      const pi = {
        on() {
          // Test stub.
        },
        registerCommand(name: string, registeredCommand: unknown) {
          commands.set(
            name,
            registeredCommand as {
              handler(args: string, context: never): Promise<void>;
            }
          );
        },
      };
      const selectTitles: string[] = [];
      const notifications: string[] = [];
      const commandCtx = {
        hasUI: true,
        ui: {
          select(title: string) {
            selectTitles.push(title);
            return Promise.resolve("Cancel");
          },
          notify(message: string) {
            notifications.push(message);
          },
          setStatus() {
            // Test stub.
          },
        },
      };

      skillsExtension(pi as never);
      await commands.get("skill")?.handler("search demo", commandCtx as never);
      await commands
        .get("skill")
        ?.handler("search missing", commandCtx as never);

      expect(selectTitles).toEqual(["Install skill (2 found)"]);
      expect(notifications).toEqual(["No skills found."]);
    } finally {
      globalThis.fetch = originalFetch;
      process.env.HOME = originalHome;
    }
  });

  it("installs a searched skill after registering its remote source", async () => {
    const home = tempRoot("command-search-install-registration");
    const originalHome = process.env.HOME;
    const originalFetch = globalThis.fetch;
    process.env.HOME = home;
    try {
      globalThis.fetch = ((url: string | URL | Request) => {
        const value = String(url);
        if (value.startsWith("https://skills.sh/api/search")) {
          return Promise.resolve(
            Response.json({
              skills: [
                {
                  name: "Demo Skill",
                  skillName: "Demo Skill",
                  description: "Does demos.",
                  source: "https://github.com/acme/demo/tree/HEAD/skills/demo",
                },
              ],
            })
          );
        }
        if (value.includes("/git/trees/HEAD")) {
          return Promise.resolve(
            Response.json({
              tree: [{ path: "skills/demo/SKILL.md", type: "blob" }],
            })
          );
        }
        if (value.includes("/skills/demo/SKILL.md")) {
          return Promise.resolve(
            new Response("# Demo Skill\n\ndescription: Does demos.\n")
          );
        }
        return Promise.resolve(new Response("missing", { status: 404 }));
      }) as typeof fetch;
      const commands = new Map<
        string,
        { handler(args: string, context: never): Promise<void> }
      >();
      const pi = {
        on() {
          // Test stub.
        },
        registerCommand(name: string, registeredCommand: unknown) {
          commands.set(
            name,
            registeredCommand as {
              handler(args: string, context: never): Promise<void>;
            }
          );
        },
      };
      const notifications: string[] = [];
      const commandCtx = {
        hasUI: true,
        ui: {
          select(_title: string, options: string[]) {
            return Promise.resolve(options[1]);
          },
          notify(message: string) {
            notifications.push(message);
          },
          setStatus() {
            // Test stub.
          },
        },
      };

      skillsExtension(pi as never);
      await commands.get("skill")?.handler("search demo", commandCtx as never);

      const manifest = readManagedManifest(
        createSkillsManagerPaths().manifestPath
      );
      expect(manifest.skills).toHaveLength(1);
      expect(manifest.skills[0]?.source).toMatchObject({
        type: "github",
        owner: "acme",
        repo: "demo",
        subpath: "skills/demo",
      });
      expect(notifications).toEqual([
        "Installed 1 skill: Demo Skill. Changes apply after /reload or next session.",
      ]);
    } finally {
      globalThis.fetch = originalFetch;
      process.env.HOME = originalHome;
    }
  });

  it("registers the /skill command with stable subcommand completions", () => {
    const commands = new Map<string, unknown>();
    const handlers = new Map<string, unknown[]>();
    const pi = {
      on(event: string, handler: unknown) {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      },
      registerCommand(name: string, registeredCommand: unknown) {
        commands.set(name, registeredCommand);
      },
    };

    skillsExtension(pi as never);

    const command = commands.get("skill") as {
      description: string;
      getArgumentCompletions(argumentPrefix: string): { value: string }[];
    };
    expect(command.description).toBe(
      "/skill list|search|install|update|remove"
    );
    expect(
      command.getArgumentCompletions("i").map((item) => item.value)
    ).toEqual(["install "]);
    expect(
      command.getArgumentCompletions("").map((item) => item.value)
    ).toEqual(["list", "search", "install ", "update", "remove "]);
    expect(handlers.has("resources_discover")).toBe(true);
    expect(handlers.has("session_start")).toBe(true);
  });
});
