import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
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
  createGithubRepoTreeCacheSession,
  createSkillsManagerPaths,
  detectDirtySkills,
  detectLocalSkillUpdate,
  detectSkillUpdate,
  discoverBundledSkillPaths,
  fetchGithubRepoTreeSnapshot,
  fetchSkillsShSearchCache,
  findListedSkillSourceDir,
  GITHUB_TREE_CACHE_MAX_ENTRIES,
  githubSkillFolderHash,
  hashSkillDirectory,
  installSelectedSkillsSequentially,
  listSkillsInSource,
  materializeResolvedSkillSource,
  materializeSkillsShDownloadSnapshot,
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

function gitBlobSha(contents: string | Uint8Array): string {
  const bytes = Buffer.from(contents);
  return createHash("sha1")
    .update(`blob ${bytes.byteLength}\0`)
    .update(bytes)
    .digest("hex");
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
    expect(parseSkillSource("https://github.com/owner/repo/")).toMatchObject({
      identity: {
        type: "github",
        owner: "owner",
        repo: "repo",
        ref: "HEAD",
        subpath: "",
      },
      rawUrl: "https://raw.githubusercontent.com/owner/repo/HEAD/SKILL.md",
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

  it("materializes exact HEAD skills from canonical commit HTML links", async () => {
    const root = tempRoot("github-exact-head-canonical-links");
    const paths = createSkillsManagerPaths(join(root, ".pi", "agent"));
    const resolved = parseSkillSource("owner/repo/tree/HEAD/skills/demo");
    const commit = "0123456789abcdef0123456789abcdef01234567";
    const requestedUrls: string[] = [];
    const responses = new Map<string, Response>([
      [
        "https://api.github.com/repos/owner/repo/git/trees/HEAD?recursive=1",
        new Response("rate limited", { status: 403 }),
      ],
      [
        "https://github.com/owner/repo/tree/HEAD/skills/demo",
        new Response(
          `<a href="/owner/repo/blob/${commit}/skills/demo/SKILL.md">SKILL.md</a><a href="/owner/repo/tree/${commit}/skills/demo/references">references</a>`
        ),
      ],
      [
        "https://github.com/owner/repo/tree/HEAD/skills/demo/references",
        new Response(
          `<a href="/owner/repo/blob/${commit}/skills/demo/references/guide.md">guide.md</a>`
        ),
      ],
      [
        "https://raw.githubusercontent.com/owner/repo/HEAD/skills/demo/SKILL.md",
        new Response("# Demo Skill\n\ndescription: Exact source.\n"),
      ],
      [
        "https://raw.githubusercontent.com/owner/repo/HEAD/skills/demo/references/guide.md",
        new Response("# Guide\n"),
      ],
    ]);
    const fetcher = (url: string | URL | Request) => {
      const value = String(url);
      requestedUrls.push(value);
      return Promise.resolve(
        responses.get(value)?.clone() ??
          new Response("missing", { status: 404 })
      );
    };

    const sourceRoot = await materializeResolvedSkillSource(
      resolved,
      paths,
      fetcher as typeof fetch,
      { exactSubpath: true }
    );

    expect(
      readFileSync(join(sourceRoot, "references", "guide.md"), "utf8")
    ).toBe("# Guide\n");
    expect(requestedUrls).toContain(
      "https://github.com/owner/repo/tree/HEAD/skills/demo/references"
    );
    expect(requestedUrls).toContain(
      "https://raw.githubusercontent.com/owner/repo/HEAD/skills/demo/references/guide.md"
    );
  });

  it("retries GitHub tree fetches with GH_TOKEN when GITHUB_TOKEN is absent", async () => {
    const root = tempRoot("github-token-retry");
    const paths = createSkillsManagerPaths(join(root, ".pi", "agent"));
    const resolved = parseSkillSource("owner/repo/tree/main/skills/demo");
    const oldGithubToken = process.env.GITHUB_TOKEN;
    const oldGhToken = process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;
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
        delete process.env.GITHUB_TOKEN;
      } else {
        process.env.GITHUB_TOKEN = oldGithubToken;
      }
      if (oldGhToken === undefined) {
        delete process.env.GH_TOKEN;
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

  it("authenticates a captured skills.sh snapshot by its GitHub blob SHA", async () => {
    const root = tempRoot("skills-sh-captured-snapshot");
    const paths = createSkillsManagerPaths(join(root, ".pi", "agent"));
    const fixture = JSON.parse(
      readFileSync(
        join(
          import.meta.dir,
          "__fixtures__/skills-sh-vercel-web-design-guidelines.json"
        ),
        "utf8"
      )
    );
    const fixtureSkill = fixture.files[0].contents as string;

    const snapshot = await materializeSkillsShDownloadSnapshot(
      paths,
      "vercel-labs/agent-skills",
      "web-design-guidelines",
      () => Promise.resolve(Response.json(fixture))
    );
    const requestedUrls: string[] = [];
    const sourceRoot = await materializeResolvedSkillSource(
      parseSkillSource(
        "vercel-labs/agent-skills/tree/HEAD/skills/web-design-guidelines"
      ),
      paths,
      (url) => {
        const value = String(url);
        requestedUrls.push(value);
        if (value.includes("/git/trees/")) {
          return Promise.resolve(
            Response.json({
              sha: "0123456789abcdef0123456789abcdef01234567",
              tree: [
                {
                  path: "skills/web-design-guidelines/SKILL.md",
                  type: "blob",
                  sha: gitBlobSha(fixtureSkill),
                },
              ],
            })
          );
        }
        if (
          value ===
          "https://skills.sh/api/download/vercel-labs/agent-skills/web-design-guidelines"
        ) {
          return Promise.resolve(Response.json(fixture));
        }
        return Promise.resolve(new Response("unexpected", { status: 500 }));
      }
    );

    expect(snapshot?.hash).toBe(fixture.hash);
    expect(computeSkillFilesHash(snapshot?.files ?? [])).not.toBe(fixture.hash);
    expect(readFileSync(join(sourceRoot, "SKILL.md"), "utf8")).toBe(
      fixtureSkill
    );
    expect(
      requestedUrls.some((url) =>
        url.startsWith("https://raw.githubusercontent.com/")
      )
    ).toBe(false);
  });

  it("materializes GitHub skills from skills.sh snapshots before raw files", async () => {
    const root = tempRoot("github-tree-skills-sh-snapshot");
    const paths = createSkillsManagerPaths(join(root, ".pi", "agent"));
    const snapshotSeed = join(root, "snapshot-seed");
    writeSkill(snapshotSeed, "Demo Skill", "Snapshot demo.");
    const snapshotHash = computeSkillFilesHash(
      hashSkillDirectory(snapshotSeed)
    );
    const requestedUrls: string[] = [];

    const sourceRoot = await materializeResolvedSkillSource(
      parseSkillSource("owner/repo/tree/HEAD/skills"),
      paths,
      (url) => {
        const value = String(url);
        requestedUrls.push(value);
        if (value.includes("/git/trees/")) {
          return Promise.resolve(
            Response.json({
              tree: [
                {
                  path: "skills/demo/SKILL.md",
                  type: "blob",
                  sha: gitBlobSha(readFileSync(join(snapshotSeed, "SKILL.md"))),
                },
                {
                  path: "skills/demo/README.md",
                  type: "blob",
                  sha: gitBlobSha(
                    readFileSync(join(snapshotSeed, "README.md"))
                  ),
                },
              ],
            })
          );
        }
        if (value === "https://skills.sh/api/download/owner/repo/demo") {
          return Promise.resolve(
            Response.json({
              hash: snapshotHash,
              files: [
                {
                  path: "README.md",
                  contents: readFileSync(
                    join(snapshotSeed, "README.md"),
                    "utf8"
                  ),
                },
                {
                  path: "SKILL.md",
                  contents: readFileSync(
                    join(snapshotSeed, "SKILL.md"),
                    "utf8"
                  ),
                },
              ],
            })
          );
        }
        return Promise.resolve(new Response("rate limited", { status: 429 }));
      }
    );

    expect(listSkillsInSource(sourceRoot).map((skill) => skill.id)).toEqual([
      "demo-skill",
    ]);
    expect(readFileSync(join(sourceRoot, "demo/README.md"), "utf8")).toBe(
      "# note\n"
    );
    expect(
      requestedUrls.some((url) =>
        url.startsWith("https://raw.githubusercontent.com/")
      )
    ).toBe(false);
  });

  it("materializes exact GitHub skills from successful skills.sh snapshots", async () => {
    const root = tempRoot("github-exact-skills-sh-snapshot");
    const paths = createSkillsManagerPaths(join(root, ".pi", "agent"));
    const snapshotSeed = join(root, "snapshot-seed");
    writeSkill(snapshotSeed, "Demo Skill", "Exact snapshot.");
    const snapshotHash = computeSkillFilesHash(
      hashSkillDirectory(snapshotSeed)
    );

    const sourceRoot = await materializeResolvedSkillSource(
      parseSkillSource("owner/repo/tree/HEAD/skills/demo"),
      paths,
      (url) => {
        const value = String(url);
        if (value.includes("/git/trees/")) {
          return Promise.resolve(
            Response.json({
              tree: [
                {
                  path: "skills/demo/SKILL.md",
                  type: "blob",
                  sha: gitBlobSha(readFileSync(join(snapshotSeed, "SKILL.md"))),
                },
                {
                  path: "skills/demo/README.md",
                  type: "blob",
                  sha: gitBlobSha(
                    readFileSync(join(snapshotSeed, "README.md"))
                  ),
                },
              ],
            })
          );
        }
        if (value === "https://skills.sh/api/download/owner/repo/demo") {
          return Promise.resolve(
            Response.json({
              hash: snapshotHash,
              files: [
                {
                  path: "README.md",
                  contents: readFileSync(
                    join(snapshotSeed, "README.md"),
                    "utf8"
                  ),
                },
                {
                  path: "SKILL.md",
                  contents: readFileSync(
                    join(snapshotSeed, "SKILL.md"),
                    "utf8"
                  ),
                },
              ],
            })
          );
        }
        return Promise.resolve(new Response("unexpected", { status: 500 }));
      }
    );

    expect(readFileSync(join(sourceRoot, "SKILL.md"), "utf8")).toContain(
      "Exact snapshot."
    );
  });

  it("rejects skills.sh snapshot bytes that do not match GitHub blob SHAs", async () => {
    const root = tempRoot("github-mismatched-skills-sh-snapshot");
    const paths = createSkillsManagerPaths(join(root, ".pi", "agent"));
    const revision = "0123456789abcdef0123456789abcdef01234567";
    const githubSkill =
      "# Demo Skill\n\ndescription: Authenticated GitHub source.\n";
    const githubReadme = "# authenticated note\n";
    const requestedUrls: string[] = [];

    const sourceRoot = await materializeResolvedSkillSource(
      parseSkillSource("owner/repo/tree/HEAD/skills/demo"),
      paths,
      (url) => {
        const value = String(url);
        requestedUrls.push(value);
        if (value.includes("/git/trees/")) {
          return Promise.resolve(
            Response.json({
              sha: revision,
              tree: [
                {
                  path: "skills/demo/SKILL.md",
                  type: "blob",
                  sha: gitBlobSha(githubSkill),
                },
                {
                  path: "skills/demo/README.md",
                  type: "blob",
                  sha: gitBlobSha(githubReadme),
                },
              ],
            })
          );
        }
        if (value === "https://skills.sh/api/download/owner/repo/demo") {
          return Promise.resolve(
            Response.json({
              hash: "opaque-skills-sh-hash",
              files: [
                { path: "README.md", contents: "# malicious note\n" },
                {
                  path: "SKILL.md",
                  contents:
                    "# Demo Skill\n\ndescription: Substituted snapshot.\n",
                },
              ],
            })
          );
        }
        if (
          value ===
          `https://raw.githubusercontent.com/owner/repo/${revision}/skills/demo/SKILL.md`
        ) {
          return Promise.resolve(new Response(githubSkill));
        }
        if (
          value ===
          `https://raw.githubusercontent.com/owner/repo/${revision}/skills/demo/README.md`
        ) {
          return Promise.resolve(new Response(githubReadme));
        }
        return Promise.resolve(new Response("missing", { status: 404 }));
      }
    );

    expect(readFileSync(join(sourceRoot, "SKILL.md"), "utf8")).toBe(
      githubSkill
    );
    expect(
      requestedUrls.filter((url) =>
        url.startsWith("https://raw.githubusercontent.com/")
      )
    ).toHaveLength(2);
  });

  it("falls back to immutable GitHub files for partial or empty skills.sh snapshots", async () => {
    for (const snapshotFiles of [
      [
        {
          path: "SKILL.md",
          contents: "# Demo Skill\n\ndescription: Partial snapshot.\n",
        },
      ],
      [],
    ]) {
      const root = tempRoot("github-incomplete-skills-sh-snapshot");
      const paths = createSkillsManagerPaths(join(root, ".pi", "agent"));
      const revision = "0123456789abcdef0123456789abcdef01234567";
      const requestedUrls: string[] = [];

      const sourceRoot = await materializeResolvedSkillSource(
        parseSkillSource("owner/repo/tree/HEAD/skills/demo"),
        paths,
        (url) => {
          const value = String(url);
          requestedUrls.push(value);
          if (value.includes("/git/trees/")) {
            return Promise.resolve(
              Response.json({
                sha: revision,
                tree: [
                  { path: "skills/demo/SKILL.md", type: "blob" },
                  { path: "skills/demo/icon.png", type: "blob" },
                ],
              })
            );
          }
          if (value === "https://skills.sh/api/download/owner/repo/demo") {
            return Promise.resolve(Response.json({ files: snapshotFiles }));
          }
          if (
            value ===
            `https://raw.githubusercontent.com/owner/repo/${revision}/skills/demo/SKILL.md`
          ) {
            return Promise.resolve(
              new Response("# Demo Skill\n\ndescription: GitHub source.\n")
            );
          }
          if (
            value ===
            `https://raw.githubusercontent.com/owner/repo/${revision}/skills/demo/icon.png`
          ) {
            return Promise.resolve(new Response(new Uint8Array([0, 1, 2])));
          }
          return Promise.resolve(new Response("missing", { status: 404 }));
        }
      );

      expect(readFileSync(join(sourceRoot, "SKILL.md"), "utf8")).toContain(
        "GitHub source."
      );
      expect(readFileSync(join(sourceRoot, "icon.png"))).toEqual(
        Buffer.from([0, 1, 2])
      );
      expect(
        requestedUrls.filter((url) =>
          url.startsWith("https://raw.githubusercontent.com/")
        )
      ).toHaveLength(2);
    }
  });

  it("fetches pinned GitHub refs instead of unverifiable skills.sh snapshots", async () => {
    const root = tempRoot("github-pinned-ref-no-skills-sh-snapshot");
    const paths = createSkillsManagerPaths(join(root, ".pi", "agent"));
    const requestedUrls: string[] = [];
    const pinnedSkill = "# Demo Skill\n\ndescription: Pinned version.\n";

    const sourceRoot = await materializeResolvedSkillSource(
      parseSkillSource("owner/repo/tree/v1/skills/demo"),
      paths,
      (url) => {
        const value = String(url);
        requestedUrls.push(value);
        if (value.includes("/git/trees/")) {
          return Promise.resolve(
            Response.json({
              tree: [{ path: "skills/demo/SKILL.md", type: "blob" }],
            })
          );
        }
        if (value === "https://skills.sh/api/download/owner/repo/demo") {
          return Promise.resolve(
            Response.json({
              files: [
                {
                  path: "SKILL.md",
                  contents:
                    "# Demo Skill\n\ndescription: Default branch version.\n",
                },
              ],
            })
          );
        }
        if (
          value ===
          "https://raw.githubusercontent.com/owner/repo/v1/skills/demo/SKILL.md"
        ) {
          return Promise.resolve(new Response(pinnedSkill));
        }
        return Promise.resolve(new Response("missing", { status: 404 }));
      }
    );

    expect(readFileSync(join(sourceRoot, "SKILL.md"), "utf8")).toBe(
      pinnedSkill
    );
    expect(requestedUrls).not.toContain(
      "https://skills.sh/api/download/owner/repo/demo"
    );
  });

  it("preserves an uncached GitHub tree rate-limit failure when broad fallbacks miss", async () => {
    const root = tempRoot("github-tree-uncached-rate-limit");
    const paths = createSkillsManagerPaths(join(root, ".pi", "agent"));
    const fetcher = (url: string | URL | Request) => {
      if (String(url).includes("/git/trees/")) {
        return Promise.resolve(new Response("rate limited", { status: 403 }));
      }
      return Promise.resolve(new Response("missing", { status: 404 }));
    };

    await expect(
      materializeResolvedSkillSource(
        parseSkillSource("expo/skills"),
        paths,
        fetcher as typeof fetch,
        { requestedSkillName: "eas-app-stores" }
      )
    ).rejects.toThrow("GitHub tree fetch failed: 403");
  });

  it("reuses cached GitHub tree snapshots on ETag 304 responses", async () => {
    const root = tempRoot("github-tree-etag");
    const paths = createSkillsManagerPaths(join(root, ".pi", "agent"));
    const calls: RequestInit[] = [];
    const tree = [{ path: "skills/demo/SKILL.md", type: "blob", sha: "v1" }];
    const fetcher = (_url: string | URL | Request, init?: RequestInit) => {
      calls.push(init ?? {});
      if (calls.length === 1) {
        return Promise.resolve(
          Response.json({ tree }, { headers: { etag: 'W/"tree-v1"' } })
        );
      }
      return Promise.resolve(new Response(null, { status: 304 }));
    };

    const first = await fetchGithubRepoTreeSnapshot(
      paths,
      "owner",
      "repo",
      "main",
      fetcher as typeof fetch
    );
    const second = await fetchGithubRepoTreeSnapshot(
      paths,
      "owner",
      "repo",
      "main",
      fetcher as typeof fetch
    );

    expect(first).toMatchObject({ fromCache: false, etag: 'W/"tree-v1"' });
    expect(second).toMatchObject({
      fromCache: true,
      etag: 'W/"tree-v1"',
      stale: false,
      tree,
    });
    expect(calls[1]?.headers).toMatchObject({
      "If-None-Match": 'W/"tree-v1"',
    });
  });

  it("reuses cached GitHub tree snapshots when rate-limited", async () => {
    const root = tempRoot("github-tree-rate-limited");
    const paths = createSkillsManagerPaths(join(root, ".pi", "agent"));
    const tree = [{ path: "skills/demo/SKILL.md", type: "blob", sha: "v1" }];
    let callCount = 0;
    const fetcher = (_url: string | URL | Request) => {
      callCount += 1;
      if (callCount === 1) {
        return Promise.resolve(Response.json({ tree }));
      }
      return Promise.resolve(new Response("rate limited", { status: 403 }));
    };

    await fetchGithubRepoTreeSnapshot(
      paths,
      "owner",
      "repo",
      "main",
      fetcher as typeof fetch
    );
    const cached = await fetchGithubRepoTreeSnapshot(
      paths,
      "owner",
      "repo",
      "main",
      fetcher as typeof fetch
    );

    expect(cached).toMatchObject({ fromCache: true, stale: true, tree });
  });

  it("recovers from corrupt and deeply malformed GitHub tree caches", async () => {
    for (const cacheContents of [
      "{not-json",
      JSON.stringify({
        version: 2,
        entries: {
          "owner/repo#main": {
            fetchedAt: new Date().toISOString(),
            tree: [{ path: 42, type: "blob", sha: "bad" }],
          },
        },
      }),
    ]) {
      const root = tempRoot("github-tree-corrupt-cache");
      const paths = createSkillsManagerPaths(join(root, ".pi", "agent"));
      const cachePath = join(paths.cacheDir, "github-repo-trees.json");
      mkdirSync(paths.cacheDir, { recursive: true });
      writeFileSync(cachePath, cacheContents);
      const tree = [
        { path: "skills/demo/SKILL.md", type: "blob", sha: "fresh" },
      ];
      const calls: RequestInit[] = [];

      const snapshot = await fetchGithubRepoTreeSnapshot(
        paths,
        "owner",
        "repo",
        "main",
        (_url, init) => {
          calls.push(init ?? {});
          return Promise.resolve(Response.json({ tree }));
        }
      );

      expect(snapshot).toMatchObject({ fromCache: false, tree });
      expect(calls[0]?.headers).not.toHaveProperty("If-None-Match");
      expect(JSON.parse(readFileSync(cachePath, "utf8"))).toMatchObject({
        version: 2,
        entries: { "owner/repo#main": { tree } },
      });
      expect(
        readdirSync(paths.cacheDir).filter((name) => name.includes(".tmp"))
      ).toEqual([]);
    }
  });

  it("bounds GitHub tree cache entries and shares one in-memory cache session", async () => {
    const root = tempRoot("github-tree-bounded-shared-cache");
    const paths = createSkillsManagerPaths(join(root, ".pi", "agent"));
    const cachePath = join(paths.cacheDir, "github-repo-trees.json");
    mkdirSync(paths.cacheDir, { recursive: true });
    const fetchedAt = new Date().toISOString();
    writeFileSync(
      cachePath,
      JSON.stringify({
        version: 2,
        entries: Object.fromEntries(
          Array.from(
            { length: GITHUB_TREE_CACHE_MAX_ENTRIES + 10 },
            (_, index) => [
              `owner/repo-${index}#main`,
              {
                fetchedAt,
                tree: [
                  {
                    path: "skills/demo/SKILL.md",
                    type: "blob",
                    sha: `sha-${index}`,
                  },
                ],
              },
            ]
          )
        ),
      })
    );
    const session = createGithubRepoTreeCacheSession(paths);
    writeFileSync(cachePath, "{corrupt-after-session-load");
    const fetcher = () => Promise.resolve(Response.json({ tree: [] }));

    await fetchGithubRepoTreeSnapshot(
      paths,
      "new-owner",
      "repo-one",
      "main",
      fetcher,
      session
    );
    await fetchGithubRepoTreeSnapshot(
      paths,
      "new-owner",
      "repo-two",
      "main",
      fetcher,
      session
    );

    const persisted = JSON.parse(readFileSync(cachePath, "utf8"));
    expect(Object.keys(persisted.entries).length).toBeLessThanOrEqual(
      GITHUB_TREE_CACHE_MAX_ENTRIES
    );
    expect(Object.keys(session.cache.entries).length).toBeLessThanOrEqual(
      GITHUB_TREE_CACHE_MAX_ENTRIES
    );
  });

  it("materializes a root-level skill from current HTML when cached tree metadata is stale", async () => {
    const root = tempRoot("github-root-stale-tree");
    const paths = createSkillsManagerPaths(join(root, ".pi", "agent"));
    const tree = [{ path: "SKILL.md", type: "blob", sha: "v1" }];
    const seedFetcher = (_url: string | URL | Request) =>
      Promise.resolve(Response.json({ tree }));
    await fetchGithubRepoTreeSnapshot(
      paths,
      "owner",
      "repo",
      "main",
      seedFetcher as typeof fetch
    );
    const requestedUrls: string[] = [];
    const fetcher = (url: string | URL | Request) => {
      const value = String(url);
      requestedUrls.push(value);
      if (value.includes("/git/trees/")) {
        return Promise.resolve(new Response("rate limited", { status: 403 }));
      }
      if (value === "https://github.com/owner/repo/tree/main/") {
        return Promise.resolve(
          new Response('<a href="/owner/repo/blob/main/SKILL.md">SKILL.md</a>')
        );
      }
      if (
        value === "https://raw.githubusercontent.com/owner/repo/main/SKILL.md"
      ) {
        return Promise.resolve(
          new Response("---\nname: demo\ndescription: Demo.\n---\n")
        );
      }
      return Promise.resolve(new Response("missing", { status: 404 }));
    };

    const sourceRoot = await materializeResolvedSkillSource(
      parseSkillSource("owner/repo#main"),
      paths,
      fetcher as typeof fetch,
      { requestedSkillName: "demo", skipSkillsShSnapshots: true }
    );

    expect(readFileSync(join(sourceRoot, "SKILL.md"), "utf8")).toContain(
      "name: demo"
    );
    expect(requestedUrls).toContain("https://github.com/owner/repo/tree/main/");
  });

  it("rejects truncated GitHub tree snapshots without caching them", async () => {
    const root = tempRoot("github-tree-truncated");
    const paths = createSkillsManagerPaths(join(root, ".pi", "agent"));
    const completeTree = [
      { path: "skills/demo/SKILL.md", type: "blob", sha: "complete" },
    ];
    let callCount = 0;
    const fetcher = (_url: string | URL | Request) => {
      callCount += 1;
      if (callCount === 1) {
        return Promise.resolve(
          Response.json(
            { tree: completeTree },
            { headers: { etag: 'W/"complete-tree"' } }
          )
        );
      }
      if (callCount === 2) {
        return Promise.resolve(
          Response.json({
            truncated: true,
            tree: [
              { path: "skills/demo/SKILL.md", type: "blob", sha: "partial" },
            ],
          })
        );
      }
      return Promise.resolve(new Response(null, { status: 304 }));
    };

    await fetchGithubRepoTreeSnapshot(
      paths,
      "owner",
      "repo",
      "main",
      fetcher as typeof fetch
    );
    await expect(
      fetchGithubRepoTreeSnapshot(
        paths,
        "owner",
        "repo",
        "main",
        fetcher as typeof fetch
      )
    ).rejects.toThrow("GitHub tree fetch failed: truncated response");
    const cached = await fetchGithubRepoTreeSnapshot(
      paths,
      "owner",
      "repo",
      "main",
      fetcher as typeof fetch
    );

    expect(cached.tree).toEqual(completeTree);
  });

  it("rejects GitHub tree responses without a tree array without caching them", async () => {
    const root = tempRoot("github-tree-missing-tree");
    const paths = createSkillsManagerPaths(join(root, ".pi", "agent"));
    const completeTree = [
      { path: "skills/demo/SKILL.md", type: "blob", sha: "complete" },
    ];
    let callCount = 0;
    const fetcher = (_url: string | URL | Request) => {
      callCount += 1;
      if (callCount === 1) {
        return Promise.resolve(
          Response.json(
            { tree: completeTree },
            { headers: { etag: 'W/"complete-tree"' } }
          )
        );
      }
      if (callCount === 2) {
        return Promise.resolve(Response.json({ message: "unexpected" }));
      }
      return Promise.resolve(new Response(null, { status: 304 }));
    };

    await fetchGithubRepoTreeSnapshot(
      paths,
      "owner",
      "repo",
      "main",
      fetcher as typeof fetch
    );
    await expect(
      fetchGithubRepoTreeSnapshot(
        paths,
        "owner",
        "repo",
        "main",
        fetcher as typeof fetch
      )
    ).rejects.toThrow("GitHub tree fetch failed: invalid response");
    const cached = await fetchGithubRepoTreeSnapshot(
      paths,
      "owner",
      "repo",
      "main",
      fetcher as typeof fetch
    );

    expect(cached.tree).toEqual(completeTree);
  });

  it("does not use a cached GitHub tree after a failed revalidation", async () => {
    const root = tempRoot("github-tree-failed-revalidation");
    const paths = createSkillsManagerPaths(join(root, ".pi", "agent"));
    let callCount = 0;
    const fetcher = (_url: string | URL | Request) => {
      callCount += 1;
      if (callCount === 1) {
        return Promise.resolve(
          Response.json(
            {
              tree: [{ path: "skills/demo/SKILL.md", type: "blob", sha: "v1" }],
            },
            { headers: { etag: 'W/"tree-v1"' } }
          )
        );
      }
      return Promise.resolve(new Response("server error", { status: 500 }));
    };

    await fetchGithubRepoTreeSnapshot(
      paths,
      "owner",
      "repo",
      "main",
      fetcher as typeof fetch
    );

    await expect(
      fetchGithubRepoTreeSnapshot(
        paths,
        "owner",
        "repo",
        "main",
        fetcher as typeof fetch
      )
    ).rejects.toThrow("GitHub tree fetch failed: 500");
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

  it("persists the folder hash from the immutable GitHub revision that was installed", async () => {
    const home = tempRoot("command-immutable-github-install");
    const originalHome = process.env.HOME;
    const originalFetch = globalThis.fetch;
    process.env.HOME = home;
    const oldRevision = "0123456789abcdef0123456789abcdef01234567";
    const newRevision = "89abcdef0123456789abcdef0123456789abcdef";
    const oldTree = [
      { path: "skills/demo/SKILL.md", type: "blob", sha: "old-skill" },
    ];
    let treeRequests = 0;
    try {
      globalThis.fetch = ((url: string | URL | Request) => {
        const value = String(url);
        if (value.includes("/git/trees/")) {
          treeRequests += 1;
          return Promise.resolve(
            Response.json(
              treeRequests === 1
                ? { sha: oldRevision, tree: oldTree }
                : {
                    sha: newRevision,
                    tree: [
                      {
                        path: "skills/demo/SKILL.md",
                        type: "blob",
                        sha: "new-skill",
                      },
                    ],
                  }
            )
          );
        }
        if (value === "https://skills.sh/api/download/owner/repo/demo") {
          return Promise.resolve(new Response("missing", { status: 404 }));
        }
        if (
          value ===
          `https://raw.githubusercontent.com/owner/repo/${oldRevision}/skills/demo/SKILL.md`
        ) {
          return Promise.resolve(
            new Response("# Demo Skill\n\ndescription: Old revision.\n")
          );
        }
        if (value.includes(newRevision) || value.includes("/HEAD/")) {
          return Promise.resolve(
            new Response("# Demo Skill\n\ndescription: New revision.\n")
          );
        }
        return Promise.resolve(new Response("missing", { status: 404 }));
      }) as typeof fetch;
      const commands = registerSkillsCommand();
      const commandCtx = {
        hasUI: true,
        ui: {
          custom: () => Promise.resolve(["demo-skill"]),
          notify() {
            // Test stub.
          },
          setStatus() {
            // Test stub.
          },
        },
      };

      await commands
        .get("skill")
        ?.handler("install owner/repo", commandCtx as never);

      const installed = readManagedManifest(
        createSkillsManagerPaths().manifestPath
      ).skills[0];
      expect(treeRequests).toBe(1);
      expect(installed?.skillFolderHash).toBe(
        githubSkillFolderHash(oldTree, "skills/demo")
      );
      expect(
        readFileSync(join(installed?.installPath ?? "", "SKILL.md"), "utf8")
      ).toContain("Old revision.");
    } finally {
      globalThis.fetch = originalFetch;
      process.env.HOME = originalHome;
    }
  });

  it("uses the custom repo picker for single-skill GitHub repo roots", async () => {
    const originalHome = process.env.HOME;
    const originalFetch = globalThis.fetch;
    const sources = [
      "owner/repo",
      "https://github.com/owner/repo",
      "https://github.com/owner/repo/",
      "https://github.com/owner/repo.git",
      "owner/repo.git",
    ];
    try {
      for (const source of sources) {
        process.env.HOME = tempRoot(
          `command-single-repo-picker-${source.replaceAll(/[^a-z0-9]/gi, "-")}`
        );
        globalThis.fetch = ((url: string | URL | Request) => {
          const value = String(url);
          if (value.includes("/git/trees/")) {
            return Promise.resolve(
              Response.json({
                tree: [{ path: "skills/one/SKILL.md", type: "blob" }],
              })
            );
          }
          if (value.includes("/skills/one/SKILL.md")) {
            return Promise.resolve(
              new Response("# One Skill\n\ndescription: First.\n")
            );
          }
          return Promise.resolve(new Response("missing", { status: 404 }));
        }) as typeof fetch;
        let customCalls = 0;
        const commandCtx = {
          hasUI: true,
          ui: {
            custom: () => {
              customCalls += 1;
              return Promise.resolve(["one-skill"]);
            },
            notify() {
              // Test stub.
            },
            setStatus() {
              // Test stub.
            },
          },
        };
        const commands = registerSkillsCommand();

        await commands
          .get("skill")
          ?.handler(`install ${source}`, commandCtx as never);

        expect(customCalls).toBe(1);
        expect(
          readManagedManifest(
            createSkillsManagerPaths().manifestPath
          ).skills.map((skill) => skill.name)
        ).toEqual(["One Skill"]);
      }
    } finally {
      globalThis.fetch = originalFetch;
      process.env.HOME = originalHome;
    }
  });

  it("installs exact GitHub subpaths without opening the repo picker", async () => {
    const home = tempRoot("command-exact-subpath-no-picker");
    const originalHome = process.env.HOME;
    const originalFetch = globalThis.fetch;
    process.env.HOME = home;
    try {
      globalThis.fetch = ((url: string | URL | Request) => {
        const value = String(url);
        if (value.includes("/git/trees/")) {
          return Promise.resolve(
            Response.json({
              tree: [{ path: "skills/one/SKILL.md", type: "blob" }],
            })
          );
        }
        if (value.includes("/skills/one/SKILL.md")) {
          return Promise.resolve(
            new Response("# One Skill\n\ndescription: First.\n")
          );
        }
        return Promise.resolve(new Response("missing", { status: 404 }));
      }) as typeof fetch;
      const commandCtx = {
        hasUI: true,
        ui: {
          custom: () => {
            throw new Error("exact GitHub subpaths should bypass picker");
          },
          notify() {
            // Test stub.
          },
          setStatus() {
            // Test stub.
          },
        },
      };
      const commands = registerSkillsCommand();

      await commands
        .get("skill")
        ?.handler(
          "install https://github.com/owner/repo/tree/HEAD/skills/one",
          commandCtx as never
        );

      expect(
        readManagedManifest(createSkillsManagerPaths().manifestPath).skills.map(
          (skill) => skill.name
        )
      ).toEqual(["One Skill"]);
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
          custom: () => {
            throw new Error("requested skill names should bypass picker");
          },
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

  it("checks current GitHub skill files when cached tree revalidation is rate-limited", async () => {
    const home = tempRoot("command-update-stale-tree");
    const originalHome = process.env.HOME;
    const originalFetch = globalThis.fetch;
    process.env.HOME = home;
    try {
      const paths = createSkillsManagerPaths();
      const install = join(paths.managedDir, "demo");
      const oldSkill = "---\nname: demo\ndescription: Old.\n---\n";
      const updatedSkill = "---\nname: demo\ndescription: Updated.\n---\n";
      mkdirSync(join(install, "references"), { recursive: true });
      writeFileSync(join(install, "SKILL.md"), oldSkill);
      writeFileSync(join(install, "references", "removed.md"), "# Removed\n");
      const tree = [
        { path: "plugins/expo/skills/demo/SKILL.md", type: "blob", sha: "v1" },
        {
          path: "plugins/expo/skills/demo/references/removed.md",
          type: "blob",
          sha: "removed",
        },
      ];
      const treeFetcher = (_url: string | URL | Request) =>
        Promise.resolve(Response.json({ tree }));
      await fetchGithubRepoTreeSnapshot(
        paths,
        "expo",
        "skills",
        "feature/foo",
        treeFetcher as typeof fetch
      );
      writeManagedManifest(paths.manifestPath, {
        version: 1,
        skills: [
          {
            id: "demo",
            name: "demo",
            description: "Old.",
            source: parseSkillSource("expo/skills#feature/foo").identity,
            installPath: install,
            installedAt: "2026-05-21T00:00:00.000Z",
            files: hashSkillDirectory(install),
            skillPath: "plugins/expo/skills/demo",
            skillFolderHash: githubSkillFolderHash(
              tree,
              "plugins/expo/skills/demo"
            )!,
          },
        ],
      });
      const requestedUrls: string[] = [];
      globalThis.fetch = ((url: string | URL | Request) => {
        const value = String(url);
        requestedUrls.push(value);
        if (value.includes("/git/trees/")) {
          return Promise.resolve(new Response("rate limited", { status: 403 }));
        }
        if (
          value ===
          "https://github.com/expo/skills/tree/feature/foo/plugins/expo/skills/demo"
        ) {
          return Promise.resolve(
            new Response(
              '<a href="/expo/skills/blob/feature/foo/plugins/expo/skills/demo/SKILL.md">SKILL.md</a><a href="/expo/skills/tree/feature/foo/plugins/expo/skills/demo/references">references</a>'
            )
          );
        }
        if (
          value ===
          "https://github.com/expo/skills/tree/feature/foo/plugins/expo/skills/demo/references"
        ) {
          return Promise.resolve(
            new Response(
              '<a href="/expo/skills/blob/feature/foo/plugins/expo/skills/demo/references/new.md">new.md</a>'
            )
          );
        }
        if (
          value ===
          "https://raw.githubusercontent.com/expo/skills/feature/foo/plugins/expo/skills/demo/SKILL.md"
        ) {
          return Promise.resolve(new Response(updatedSkill));
        }
        if (
          value ===
          "https://raw.githubusercontent.com/expo/skills/feature/foo/plugins/expo/skills/demo/references/new.md"
        ) {
          return Promise.resolve(new Response("# New reference\n"));
        }
        return Promise.resolve(new Response("missing", { status: 404 }));
      }) as typeof fetch;
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
      const commands = registerSkillsCommand();

      await commands.get("skill")?.handler("update demo", commandCtx as never);

      expect(readFileSync(join(install, "SKILL.md"), "utf8")).toBe(
        updatedSkill
      );
      expect(requestedUrls).toContain(
        "https://raw.githubusercontent.com/expo/skills/feature/foo/plugins/expo/skills/demo/SKILL.md"
      );
      expect(readFileSync(join(install, "references", "new.md"), "utf8")).toBe(
        "# New reference\n"
      );
      expect(existsSync(join(install, "references", "removed.md"))).toBe(false);
      expect(requestedUrls).not.toContain(
        "https://raw.githubusercontent.com/expo/skills/feature/foo/plugins/expo/skills/demo/references/removed.md"
      );
      expect(notifications).not.toContain("No skill updates found.");
    } finally {
      globalThis.fetch = originalFetch;
      process.env.HOME = originalHome;
    }
  });

  it("installs and updates root-level GitHub skills with sibling skills", async () => {
    const home = tempRoot("command-install-update-root-github-skill");
    const originalHome = process.env.HOME;
    const originalFetch = globalThis.fetch;
    process.env.HOME = home;
    try {
      const paths = createSkillsManagerPaths();
      let rootVersion: "initial" | "updated" = "initial";
      let siblingVersion: "initial" | "updated" = "initial";
      globalThis.fetch = ((url: string | URL | Request) => {
        const value = String(url);
        if (value.includes("/git/trees/")) {
          return Promise.resolve(
            Response.json({
              tree: [
                {
                  path: "SKILL.md",
                  type: "blob",
                  sha: `root-${rootVersion}`,
                },
                {
                  path: "docs/guide.md",
                  type: "blob",
                  sha: "root-guide",
                },
                {
                  path: "skills/sibling/SKILL.md",
                  type: "blob",
                  sha: `sibling-${siblingVersion}`,
                },
              ],
            })
          );
        }
        if (value === "https://skills.sh/api/download/owner/repo/sibling") {
          return Promise.resolve(new Response("missing", { status: 404 }));
        }
        if (value.endsWith("/skills/sibling/SKILL.md")) {
          return Promise.resolve(
            new Response("# Sibling Skill\n\ndescription: Sibling.\n")
          );
        }
        if (value.endsWith("/docs/guide.md")) {
          return Promise.resolve(new Response("Root guide.\n"));
        }
        return Promise.resolve(
          new Response(
            `# Root Skill\n\ndescription: ${rootVersion === "initial" ? "Initial" : "Updated"}.\n`
          )
        );
      }) as typeof fetch;
      const commands = registerSkillsCommand();
      const notifications: { message: string; level?: string }[] = [];
      const commandCtx = {
        hasUI: true,
        ui: {
          custom: () => Promise.resolve(["root-skill"]),
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

      await commands
        .get("skill")
        ?.handler("install owner/repo", commandCtx as never);

      const [installed] = readManagedManifest(paths.manifestPath).skills;
      expect(installed?.skillPath).toBe("");
      expect(installed?.source.subpath).toBe("");
      expect(existsSync(join(installed!.installPath, "docs/guide.md"))).toBe(
        true
      );
      expect(
        existsSync(join(installed!.installPath, "skills/sibling/SKILL.md"))
      ).toBe(false);
      siblingVersion = "updated";
      notifications.length = 0;
      await commands
        .get("skill")
        ?.handler("update root-skill", commandCtx as never);
      expect(notifications).toContainEqual({
        message: "No skill updates found.",
        level: "info",
      });
      const rootFolderHash = readManagedManifest(paths.manifestPath).skills[0]
        ?.skillFolderHash;
      expect(rootFolderHash).toBeDefined();

      siblingVersion = "initial";
      notifications.length = 0;
      await commands
        .get("skill")
        ?.handler("update root-skill", commandCtx as never);
      expect(notifications).toContainEqual({
        message: "No skill updates found.",
        level: "info",
      });
      expect(
        readManagedManifest(paths.manifestPath).skills[0]?.skillFolderHash
      ).toBe(rootFolderHash);

      rootVersion = "updated";
      notifications.length = 0;
      await commands
        .get("skill")
        ?.handler("update root-skill", commandCtx as never);

      const [updated] = readManagedManifest(paths.manifestPath).skills;
      expect(
        readFileSync(join(updated!.installPath, "SKILL.md"), "utf8")
      ).toContain("description: Updated.");
      expect(updated?.skillPath).toBe("");
      expect(notifications).not.toContainEqual({
        message: "No skill updates found.",
        level: "info",
      });
    } finally {
      globalThis.fetch = originalFetch;
      process.env.HOME = originalHome;
    }
  });

  it("batches GitHub repo update checks without raw per-file fetches when hashes are current", async () => {
    const home = tempRoot("command-update-batched-github-clean");
    const originalHome = process.env.HOME;
    const originalFetch = globalThis.fetch;
    process.env.HOME = home;
    try {
      const paths = createSkillsManagerPaths();
      const oneInstall = join(paths.managedDir, "one");
      const twoInstall = join(paths.managedDir, "two");
      mkdirSync(oneInstall, { recursive: true });
      mkdirSync(twoInstall, { recursive: true });
      writeFileSync(
        join(oneInstall, "SKILL.md"),
        "# one\n\ndescription: One.\n"
      );
      writeFileSync(
        join(twoInstall, "SKILL.md"),
        "# two\n\ndescription: Two.\n"
      );
      const tree = [
        { path: "skills/one/SKILL.md", type: "blob", sha: "one-skill" },
        { path: "skills/one/README.md", type: "blob", sha: "one-readme" },
        { path: "skills/two/SKILL.md", type: "blob", sha: "two-skill" },
      ];
      const oneFolderHash = githubSkillFolderHash(tree, "skills/one");
      const twoFolderHash = githubSkillFolderHash(tree, "skills/two");
      expect(oneFolderHash).not.toBeNull();
      expect(twoFolderHash).not.toBeNull();
      writeManagedManifest(paths.manifestPath, {
        version: 1,
        skills: [
          {
            id: "one",
            name: "one",
            description: "One.",
            source: parseSkillSource("owner/repo/tree/main/skills/one")
              .identity,
            remoteSlug: "owner/repo",
            skillPath: "skills/one",
            skillFolderHash: oneFolderHash ?? "",
            installPath: oneInstall,
            installedAt: "2026-05-21T00:00:00.000Z",
            files: hashSkillDirectory(oneInstall),
          },
          {
            id: "two",
            name: "two",
            description: "Two.",
            source: parseSkillSource("owner/repo/tree/main/skills/two")
              .identity,
            remoteSlug: "owner/repo",
            skillPath: "skills/two",
            skillFolderHash: twoFolderHash ?? "",
            installPath: twoInstall,
            installedAt: "2026-05-21T00:00:00.000Z",
            files: hashSkillDirectory(twoInstall),
          },
        ],
      });
      const requestedUrls: string[] = [];
      globalThis.fetch = ((url: string | URL | Request) => {
        const value = String(url);
        requestedUrls.push(value);
        if (value.includes("/git/trees/")) {
          return Promise.resolve(Response.json({ tree }));
        }
        return Promise.resolve(new Response("unexpected", { status: 500 }));
      }) as typeof fetch;
      const commands = registerSkillsCommand();
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

      await commands.get("skill")?.handler("update", commandCtx as never);

      expect(
        requestedUrls.filter((url) => url.includes("/git/trees/main"))
      ).toHaveLength(1);
      expect(
        requestedUrls.some((url) =>
          url.startsWith("https://raw.githubusercontent.com/")
        )
      ).toBe(false);
      expect(
        requestedUrls.some((url) => url.startsWith("https://github.com/"))
      ).toBe(false);
      expect(notifications).toEqual([
        { message: "No skill updates found.", level: "info" },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
      process.env.HOME = originalHome;
    }
  });

  it("falls back to file checks when GitHub blob SHAs are missing", async () => {
    const home = tempRoot("command-update-missing-github-blob-shas");
    const originalHome = process.env.HOME;
    const originalFetch = globalThis.fetch;
    process.env.HOME = home;
    try {
      const paths = createSkillsManagerPaths();
      const install = join(paths.managedDir, "demo-skill");
      writeSkill(install, "Demo Skill", "Old.");
      const tree = [
        { path: "skills/demo/SKILL.md", type: "blob" },
        { path: "skills/demo/README.md", type: "blob" },
      ];
      expect(githubSkillFolderHash(tree, "skills/demo")).toBeNull();
      const unsafeFolderHash = createHash("sha256")
        .update("README.md\0\nSKILL.md\0")
        .digest("hex");
      writeManagedManifest(paths.manifestPath, {
        version: 1,
        skills: [
          {
            id: "demo-skill",
            name: "Demo Skill",
            description: "Old.",
            source: parseSkillSource("owner/repo/tree/main/skills/demo")
              .identity,
            remoteSlug: "owner/repo",
            skillPath: "skills/demo",
            skillFolderHash: unsafeFolderHash,
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
              sha: "0123456789abcdef0123456789abcdef01234567",
              tree,
            })
          );
        }
        if (value.endsWith("/skills/demo/SKILL.md")) {
          return Promise.resolve(
            new Response("# Demo Skill\n\ndescription: Updated.\n")
          );
        }
        if (value.endsWith("/skills/demo/README.md")) {
          return Promise.resolve(new Response("# note\n"));
        }
        return Promise.resolve(new Response("missing", { status: 404 }));
      }) as typeof fetch;
      const commands = registerSkillsCommand();
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

      await commands
        .get("skill")
        ?.handler("update demo-skill", commandCtx as never);

      expect(readFileSync(join(install, "SKILL.md"), "utf8")).toContain(
        "description: Updated."
      );
      expect(
        readManagedManifest(paths.manifestPath).skills[0]?.skillFolderHash
      ).toBeUndefined();
      expect(
        requestedUrls.some((url) =>
          url.startsWith("https://raw.githubusercontent.com/")
        )
      ).toBe(true);
      expect(notifications).not.toContain("No skill updates found.");
    } finally {
      globalThis.fetch = originalFetch;
      process.env.HOME = originalHome;
    }
  });

  it("updates exact legacy GitHub skills when skills.sh is stale", async () => {
    const home = tempRoot("command-update-exact-legacy-stale-snapshot");
    const originalHome = process.env.HOME;
    const originalFetch = globalThis.fetch;
    process.env.HOME = home;
    try {
      const paths = createSkillsManagerPaths();
      const install = join(paths.managedDir, "demo-skill");
      writeSkill(install, "Demo Skill", "Demo.");
      const githubSeed = join(home, "github-seed");
      writeSkill(githubSeed, "Demo Skill", "GitHub demo.");
      const tree = [
        { path: "skills/demo/SKILL.md", type: "blob", sha: "skill" },
        { path: "skills/demo/README.md", type: "blob", sha: "readme" },
      ];
      const revision = "0123456789abcdef0123456789abcdef01234567";
      const folderHash = githubSkillFolderHash(tree, "skills/demo");
      expect(folderHash).not.toBeNull();
      const snapshotHash = computeSkillFilesHash(hashSkillDirectory(install));
      writeManagedManifest(paths.manifestPath, {
        version: 1,
        skills: [
          {
            id: "demo-skill",
            name: "Demo Skill",
            description: "Demo.",
            source: parseSkillSource("owner/repo/tree/main/skills/demo")
              .identity,
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
          return Promise.resolve(Response.json({ sha: revision, tree }));
        }
        if (value === "https://skills.sh/api/download/owner/repo/demo-skill") {
          return Promise.resolve(
            Response.json({
              hash: snapshotHash,
              files: [
                {
                  path: "README.md",
                  contents: readFileSync(join(install, "README.md"), "utf8"),
                },
                {
                  path: "SKILL.md",
                  contents: readFileSync(join(install, "SKILL.md"), "utf8"),
                },
              ],
            })
          );
        }
        if (
          value ===
          `https://raw.githubusercontent.com/owner/repo/${revision}/skills/demo/SKILL.md`
        ) {
          return Promise.resolve(
            new Response(readFileSync(join(githubSeed, "SKILL.md"), "utf8"))
          );
        }
        if (
          value ===
          `https://raw.githubusercontent.com/owner/repo/${revision}/skills/demo/README.md`
        ) {
          return Promise.resolve(
            new Response(readFileSync(join(githubSeed, "README.md"), "utf8"))
          );
        }
        return Promise.resolve(new Response("missing", { status: 404 }));
      }) as typeof fetch;
      const commands = registerSkillsCommand();
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

      await commands
        .get("skill")
        ?.handler("update demo-skill", commandCtx as never);

      const [skill] = readManagedManifest(paths.manifestPath).skills;
      expect(skill).toMatchObject({
        remoteSlug: "owner/repo",
        skillPath: "skills/demo",
        skillFolderHash: folderHash,
      });
      expect(
        requestedUrls.some((url) =>
          url.startsWith("https://raw.githubusercontent.com/")
        )
      ).toBe(true);
      expect(readFileSync(join(install, "SKILL.md"), "utf8")).toBe(
        readFileSync(join(githubSeed, "SKILL.md"), "utf8")
      );
      expect(notifications).not.toContainEqual(
        expect.objectContaining({ level: "warning" })
      );
      expect(notifications).not.toContainEqual(
        expect.objectContaining({
          message: "Updated exact source metadata for 1 skill(s).",
        })
      );
    } finally {
      globalThis.fetch = originalFetch;
      process.env.HOME = originalHome;
    }
  });

  it("rejects a stale skills.sh snapshot during GitHub installation", async () => {
    const home = tempRoot("command-install-stale-snapshot-update");
    const originalHome = process.env.HOME;
    const originalFetch = globalThis.fetch;
    process.env.HOME = home;
    try {
      const paths = createSkillsManagerPaths();
      const snapshotSeed = join(home, "snapshot-seed");
      writeSkill(snapshotSeed, "Demo Skill", "Stale snapshot.");
      const snapshotHash = computeSkillFilesHash(
        hashSkillDirectory(snapshotSeed)
      );
      const currentSkill =
        "# Demo Skill\n\ndescription: Current GitHub version.\n";
      const tree = [
        { path: "skills/demo/SKILL.md", type: "blob", sha: "current-skill" },
        { path: "skills/demo/README.md", type: "blob", sha: "current-readme" },
      ];
      const revision = "89abcdef0123456789abcdef0123456789abcdef";
      const requestedUrls: string[] = [];
      globalThis.fetch = ((url: string | URL | Request) => {
        const value = String(url);
        requestedUrls.push(value);
        if (value.includes("/git/trees/")) {
          return Promise.resolve(Response.json({ sha: revision, tree }));
        }
        if (value === "https://skills.sh/api/download/owner/repo/demo") {
          return Promise.resolve(
            Response.json({
              hash: snapshotHash,
              files: [
                {
                  path: "README.md",
                  contents: readFileSync(
                    join(snapshotSeed, "README.md"),
                    "utf8"
                  ),
                },
                {
                  path: "SKILL.md",
                  contents: readFileSync(
                    join(snapshotSeed, "SKILL.md"),
                    "utf8"
                  ),
                },
              ],
            })
          );
        }
        if (
          value ===
          `https://raw.githubusercontent.com/owner/repo/${revision}/skills/demo/SKILL.md`
        ) {
          return Promise.resolve(new Response(currentSkill));
        }
        if (
          value ===
          `https://raw.githubusercontent.com/owner/repo/${revision}/skills/demo/README.md`
        ) {
          return Promise.resolve(new Response("# current note\n"));
        }
        return Promise.resolve(new Response("missing", { status: 404 }));
      }) as typeof fetch;
      const commands = registerSkillsCommand();
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

      await commands
        .get("skill")
        ?.handler("install owner/repo/tree/HEAD/skills", commandCtx as never);

      const [installed] = readManagedManifest(paths.manifestPath).skills;
      if (!installed) {
        throw new Error(`Install failed: ${notifications.join(" | ")}`);
      }
      expect(installed.skillFolderHash).toBe(
        githubSkillFolderHash(tree, "skills/demo") ?? undefined
      );
      expect(
        readFileSync(join(installed.installPath, "SKILL.md"), "utf8")
      ).toBe(currentSkill);

      await commands
        .get("skill")
        ?.handler("update demo-skill", commandCtx as never);

      const [updated] = readManagedManifest(paths.manifestPath).skills;
      expect(readFileSync(join(updated!.installPath, "SKILL.md"), "utf8")).toBe(
        currentSkill
      );
      expect(updated?.skillFolderHash).toBe(
        githubSkillFolderHash(tree, "skills/demo") ?? undefined
      );
      expect(
        requestedUrls.filter((url) =>
          url.startsWith("https://raw.githubusercontent.com/")
        ).length
      ).toBeGreaterThan(0);
      expect(notifications).toContain("No skill updates found.");
    } finally {
      globalThis.fetch = originalFetch;
      process.env.HOME = originalHome;
    }
  });

  it("stores an exact selected collection skill path and ignores sibling changes", async () => {
    const home = tempRoot("command-collection-selected-path");
    const originalHome = process.env.HOME;
    const originalFetch = globalThis.fetch;
    process.env.HOME = home;
    try {
      const paths = createSkillsManagerPaths();
      let siblingState: "initial" | "changed" | "deleted" = "initial";
      const requestedUrls: string[] = [];
      globalThis.fetch = ((url: string | URL | Request) => {
        const value = String(url);
        requestedUrls.push(value);
        if (value.includes("/git/trees/")) {
          return Promise.resolve(
            Response.json({
              sha:
                siblingState === "initial"
                  ? "1111111111111111111111111111111111111111"
                  : "2222222222222222222222222222222222222222",
              tree: [
                { path: "skills/one/SKILL.md", type: "blob", sha: "one-v1" },
                ...(siblingState === "deleted"
                  ? []
                  : [
                      {
                        path: "skills/two/SKILL.md",
                        type: "blob",
                        sha: siblingState === "changed" ? "two-v2" : "two-v1",
                      },
                    ]),
              ],
            })
          );
        }
        if (value.endsWith("/skills/one/SKILL.md")) {
          return Promise.resolve(
            new Response("# One Skill\n\ndescription: First.\n")
          );
        }
        if (value.endsWith("/skills/two/SKILL.md")) {
          return Promise.resolve(
            new Response("# Two Skill\n\ndescription: Second.\n")
          );
        }
        return Promise.resolve(new Response("missing", { status: 404 }));
      }) as typeof fetch;
      const commands = registerSkillsCommand();
      const notifications: string[] = [];
      const commandCtx = {
        hasUI: true,
        ui: {
          select: (_title: string, options: string[]) =>
            Promise.resolve(
              options.find((option) => option.startsWith("One Skill"))
            ),
          notify(message: string) {
            notifications.push(message);
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

      await commands
        .get("skill")
        ?.handler("install owner/repo/tree/main/skills", commandCtx as never);

      const [installed] = readManagedManifest(paths.manifestPath).skills;
      expect(installed?.source.subpath).toBe("skills/one");
      expect(installed?.skillPath).toBe("skills/one");

      requestedUrls.length = 0;
      notifications.length = 0;
      siblingState = "changed";
      await commands
        .get("skill")
        ?.handler("update one-skill", commandCtx as never);
      expect(notifications).toContain("No skill updates found.");
      expect(
        requestedUrls.some((url) => url.endsWith("/skills/one/SKILL.md"))
      ).toBe(false);

      requestedUrls.length = 0;
      notifications.length = 0;
      siblingState = "deleted";
      await commands
        .get("skill")
        ?.handler("update one-skill", commandCtx as never);
      expect(notifications).toContain("No skill updates found.");
      expect(
        requestedUrls.some((url) => url.endsWith("/skills/one/SKILL.md"))
      ).toBe(false);
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

  it("updates changed GitHub skills from GitHub when skills.sh is stale", async () => {
    const home = tempRoot("command-update-stale-skills-sh-snapshot");
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
      const snapshotSeed = join(home, "snapshot-seed");
      writeSkill(snapshotSeed, "demo", "Snapshot demo.");
      const snapshotHash = computeSkillFilesHash(
        hashSkillDirectory(snapshotSeed)
      );
      writeManagedManifest(paths.manifestPath, {
        version: 1,
        skills: [
          {
            id: "demo",
            name: "demo",
            description: "Demo.",
            source: parseSkillSource("owner/repo/tree/main/skills/demo")
              .identity,
            remoteSlug: "stored/remote",
            skillPath: "skills/demo",
            skillFolderHash: "old-folder-hash",
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
        if (value === "https://skills.sh/api/download/stored/remote/demo") {
          return Promise.resolve(
            Response.json({
              hash: snapshotHash,
              files: [
                {
                  path: "README.md",
                  contents: readFileSync(
                    join(snapshotSeed, "README.md"),
                    "utf8"
                  ),
                },
                {
                  path: "SKILL.md",
                  contents: readFileSync(
                    join(snapshotSeed, "SKILL.md"),
                    "utf8"
                  ),
                },
              ],
            })
          );
        }
        if (value.includes("/git/trees/")) {
          return Promise.resolve(
            Response.json({
              tree: [
                { path: "skills/demo/SKILL.md", type: "blob", sha: "new" },
              ],
            })
          );
        }
        if (
          value ===
          "https://raw.githubusercontent.com/owner/repo/main/skills/demo/SKILL.md"
        ) {
          return Promise.resolve(
            new Response("---\nname: demo\ndescription: GitHub demo.\n---\n")
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

      expect(requestedUrls).not.toContain(
        "https://skills.sh/api/download/stored/remote/demo"
      );
      expect(
        requestedUrls.some((url) =>
          url.startsWith("https://raw.githubusercontent.com/")
        )
      ).toBe(true);
      expect(readFileSync(join(install, "SKILL.md"), "utf8")).toBe(
        "---\nname: demo\ndescription: GitHub demo.\n---\n"
      );
    } finally {
      globalThis.fetch = originalFetch;
      process.env.HOME = originalHome;
    }
  });

  it("uses exact GitHub materialization without trusting skills.sh hashes", async () => {
    const home = tempRoot("command-update-skills-sh-mismatch");
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
            source: parseSkillSource("owner/repo/tree/main/skills/demo")
              .identity,
            remoteSlug: "owner/repo",
            skillPath: "skills/demo",
            skillFolderHash: "old-folder-hash",
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
        if (value === "https://skills.sh/api/download/owner/repo/demo") {
          return Promise.resolve(
            Response.json({
              hash: "not-the-deterministic-file-hash",
              files: [
                {
                  path: "SKILL.md",
                  contents: "# demo\n\ndescription: Stale snapshot.\n",
                },
              ],
            })
          );
        }
        if (value.includes("/git/trees/")) {
          return Promise.resolve(
            Response.json({
              tree: [
                { path: "skills/demo/SKILL.md", type: "blob", sha: "new" },
              ],
            })
          );
        }
        if (
          value ===
          "https://raw.githubusercontent.com/owner/repo/main/skills/demo/SKILL.md"
        ) {
          return Promise.resolve(
            new Response("---\nname: demo\ndescription: GitHub demo.\n---\n")
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

      expect(requestedUrls).not.toContain(
        "https://skills.sh/api/download/owner/repo/demo"
      );
      expect(requestedUrls).toContain(
        "https://raw.githubusercontent.com/owner/repo/main/skills/demo/SKILL.md"
      );
      expect(readFileSync(join(install, "SKILL.md"), "utf8")).toBe(
        "---\nname: demo\ndescription: GitHub demo.\n---\n"
      );
    } finally {
      globalThis.fetch = originalFetch;
      process.env.HOME = originalHome;
    }
  });

  it("uses exact GitHub materialization without requiring skills.sh", async () => {
    const home = tempRoot("command-update-skills-sh-miss");
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
            source: parseSkillSource("owner/repo/tree/main/skills/demo")
              .identity,
            remoteSlug: "owner/repo",
            skillPath: "skills/demo",
            skillFolderHash: "old-folder-hash",
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
        if (value === "https://skills.sh/api/download/owner/repo/demo") {
          return Promise.resolve(new Response("missing", { status: 404 }));
        }
        if (value.includes("/git/trees/")) {
          return Promise.resolve(
            Response.json({
              tree: [
                { path: "skills/demo/SKILL.md", type: "blob", sha: "new" },
              ],
            })
          );
        }
        if (
          value ===
          "https://raw.githubusercontent.com/owner/repo/main/skills/demo/SKILL.md"
        ) {
          return Promise.resolve(
            new Response("---\nname: demo\ndescription: GitHub demo.\n---\n")
          );
        }
        return Promise.resolve(new Response("missing", { status: 404 }));
      }) as typeof fetch;
      const commands = registerSkillsCommand();
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

      await commands.get("skill")?.handler("update demo", commandCtx as never);

      expect(requestedUrls).not.toContain(
        "https://skills.sh/api/download/owner/repo/demo"
      );
      expect(requestedUrls).toContain(
        "https://raw.githubusercontent.com/owner/repo/main/skills/demo/SKILL.md"
      );
      expect(readFileSync(join(install, "SKILL.md"), "utf8")).toBe(
        "---\nname: demo\ndescription: GitHub demo.\n---\n"
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

  it("fails an explicit update when a legacy broad GitHub source is deleted", async () => {
    const home = tempRoot("command-update-deleted-broad-github-source");
    const originalHome = process.env.HOME;
    const originalFetch = globalThis.fetch;
    process.env.HOME = home;
    try {
      const paths = createSkillsManagerPaths();
      const install = join(paths.managedDir, "demo-skill");
      mkdirSync(install, { recursive: true });
      writeFileSync(
        join(install, "SKILL.md"),
        "# Demo Skill\n\ndescription: Demo.\n"
      );
      writeManagedManifest(paths.manifestPath, {
        version: 1,
        skills: [
          {
            id: "demo-skill",
            name: "Demo Skill",
            description: "Demo.",
            source: parseSkillSource("owner/repo").identity,
            installPath: install,
            installedAt: "2026-05-21T00:00:00.000Z",
            files: hashSkillDirectory(install),
          },
        ],
      });
      globalThis.fetch = ((_url: string | URL | Request) =>
        Promise.resolve(Response.json({ tree: [] }))) as typeof fetch;
      const commands = registerSkillsCommand();
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
        },
      };

      await commands
        .get("skill")
        ?.handler("update demo-skill", commandCtx as never);

      expect(notifications).toEqual([
        {
          message:
            "Unable to check 1 skill update source: Demo Skill (owner/repo): Deleted GitHub skill source: owner/repo contains no skills.",
          level: "error",
        },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
      process.env.HOME = originalHome;
    }
  });

  it("skips ambiguous legacy GitHub sources during background update checks", async () => {
    const home = tempRoot("background-update-ambiguous-legacy-skip");
    const originalHome = process.env.HOME;
    const originalFetch = globalThis.fetch;
    process.env.HOME = home;
    try {
      const paths = createSkillsManagerPaths();
      const install = join(paths.managedDir, "demo-skill");
      mkdirSync(install, { recursive: true });
      writeFileSync(
        join(install, "SKILL.md"),
        "# Demo Skill\n\ndescription: Demo.\n"
      );
      const broadSource = parseSkillSource("owner/repo").identity;
      writeManagedManifest(paths.manifestPath, {
        version: 1,
        skills: [
          {
            id: "demo-skill",
            name: "Demo Skill",
            description: "Demo.",
            source: broadSource,
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
              tree: [
                { path: "skills/one/SKILL.md", type: "blob" },
                { path: "skills/two/SKILL.md", type: "blob" },
              ],
            })
          );
        }
        return Promise.resolve(
          new Response("# Other Skill\n\ndescription: Other.\n")
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
      for (let i = 0; i < 6; i += 1) {
        await Promise.resolve();
      }

      expect(requestedUrls.some((url) => url.includes("/git/trees/"))).toBe(
        true
      );
      expect(readManagedManifest(paths.manifestPath).skills[0]?.source).toEqual(
        broadSource
      );
      expect(notifications).toEqual([]);
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
        {
          message: "Updated exact source metadata for 1 skill(s).",
          level: "info",
        },
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

  it("warns and preserves local files when an upstream GitHub skill path is deleted", async () => {
    const home = tempRoot("command-update-deleted-github-path");
    const originalHome = process.env.HOME;
    const originalFetch = globalThis.fetch;
    process.env.HOME = home;
    try {
      const paths = createSkillsManagerPaths();
      const install = join(paths.managedDir, "demo");
      mkdirSync(install, { recursive: true });
      const installedSkill = "---\nname: Demo Skill\ndescription: Demo.\n---\n";
      writeFileSync(join(install, "SKILL.md"), installedSkill);
      writeManagedManifest(paths.manifestPath, {
        version: 1,
        skills: [
          {
            id: "demo-skill",
            name: "Demo Skill",
            description: "Demo.",
            source: parseSkillSource("owner/repo/tree/main/skills/demo")
              .identity,
            remoteSlug: "owner/repo",
            skillPath: "skills/demo",
            skillFolderHash: "old-folder-hash",
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
              tree: [
                { path: "skills/other/SKILL.md", type: "blob", sha: "new" },
              ],
            })
          );
        }
        return Promise.resolve(new Response("unexpected", { status: 500 }));
      }) as typeof fetch;
      const commands = registerSkillsCommand();
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

      await commands.get("skill")?.handler("update", commandCtx as never);

      expect(readFileSync(join(install, "SKILL.md"), "utf8")).toBe(
        installedSkill
      );
      expect(readManagedManifest(paths.manifestPath).skills).toHaveLength(1);
      expect(notifications).toContainEqual({
        message:
          "Unable to check 1 skill update source: Demo Skill (owner/repo/tree/main/skills/demo): Deleted GitHub skill path: skills/demo.",
        level: "warning",
      });
      expect(notifications).toContainEqual({
        message: "No skill updates found.",
        level: "info",
      });
    } finally {
      globalThis.fetch = originalFetch;
      process.env.HOME = originalHome;
    }
  });

  it("fails an explicit update when its source check fails", async () => {
    const home = tempRoot("command-update-explicit-source-failure");
    const originalHome = process.env.HOME;
    const originalFetch = globalThis.fetch;
    process.env.HOME = home;
    try {
      const paths = createSkillsManagerPaths();
      const install = join(paths.managedDir, "demo");
      mkdirSync(install, { recursive: true });
      writeFileSync(
        join(install, "SKILL.md"),
        "---\nname: Demo Skill\ndescription: Demo.\n---\n"
      );
      writeManagedManifest(paths.manifestPath, {
        version: 1,
        skills: [
          {
            id: "demo-skill",
            name: "Demo Skill",
            description: "Demo.",
            source: parseSkillSource("owner/repo/tree/main/skills/demo")
              .identity,
            remoteSlug: "owner/repo",
            skillPath: "skills/demo",
            skillFolderHash: "old-folder-hash",
            installPath: install,
            installedAt: "2026-05-21T00:00:00.000Z",
            files: hashSkillDirectory(install),
          },
        ],
      });
      globalThis.fetch = ((_url: string | URL | Request) =>
        Promise.resolve(
          Response.json({
            tree: [{ path: "skills/other/SKILL.md", type: "blob", sha: "new" }],
          })
        )) as typeof fetch;
      const commands = registerSkillsCommand();
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
        },
      };

      await commands
        .get("skill")
        ?.handler("update demo-skill", commandCtx as never);

      expect(notifications).toEqual([
        {
          message:
            "Unable to check 1 skill update source: Demo Skill (owner/repo/tree/main/skills/demo): Deleted GitHub skill path: skills/demo.",
          level: "error",
        },
      ]);
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
