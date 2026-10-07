// Apache-2.0 adaptation of mitsuhiko/agent-stuff, d265b8e. Modified for SupaPi: public-SDK host for strict skill catalog controls.
import path from "node:path";

import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  getAgentDir,
  type AgentSessionRuntime,
  type InlineExtension,
  type Skill,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

import { within } from "./agents";
import { registerChildBootstrap } from "./child";
import type { ChildConfig } from "./protocol";

export async function createChildHost(
  config: ChildConfig,
  directory: string,
): Promise<AgentSessionRuntime> {
  const agentDir = getAgentDir();
  const role = config.agent;
  const resources = (paths: string[] | boolean | undefined) =>
    Array.isArray(paths)
      ? paths.map((item) =>
          path.resolve(path.dirname(role?.file ?? directory), item),
        )
      : [];
  const extensionFactories: InlineExtension[] =
    role?.extensions === false
      ? []
      : [
          {
            name: "codemode",
            factory: createCodemodeExtension(),
            builtin: true,
            replaceable: true,
          },
          {
            name: "mcp",
            factory: createMcpExtension(),
            builtin: true,
            replaceable: true,
          },
          {
            name: "tool-search",
            factory: createToolSearchExtension(),
            builtin: true,
            replaceable: true,
          },
        ];
  const sessionManager = SessionManager.create(
    config.cwd,
    path.join(directory, "session"),
    { id: config.runId },
  );
  let created = false;
  return createAgentSessionRuntime(
    async () => {
      if (created) {
        throw new Error(
          "Child conversation resume/replacement is not supported",
        );
      }
      created = true;
      const settingsManager = SettingsManager.create(config.cwd, agentDir, {
        projectTrusted: config.trusted,
      });
      const modelRuntime = await ModelRuntime.create({
        authPath: path.join(agentDir, "auth.json"),
        modelsPath: path.join(agentDir, "models.json"),
        allowModelNetwork: false,
      });
      const approvedSkills = new Set(resources(role?.skills));
      const filterSkills = (skills: Skill[]): Skill[] => {
        if (role?.skills === false) {
          return [];
        }
        if (!Array.isArray(role?.skills)) {
          return skills;
        }
        return skills.filter((skill) =>
          [...approvedSkills].some((root) => within(root, skill.filePath)),
        );
      };
      const services = await createAgentSessionServices({
        cwd: config.cwd,
        agentDir,
        settingsManager,
        modelRuntime,
        resourceLoaderOptions: {
          noExtensions:
            role?.extensions === false || Array.isArray(role?.extensions),
          additionalExtensionPaths: resources(role?.extensions),
          noSkills: role?.skills === false || Array.isArray(role?.skills),
          additionalSkillPaths: [...approvedSkills],
          skillsOverride: (base) => ({
            ...base,
            skills: filterSkills(base.skills),
          }),
          extensionFactories: [
            ...extensionFactories,
            (pi) =>
              registerChildBootstrap(
                pi,
                config,
                path.join(directory, "result.json"),
              ),
          ],
        },
      });
      const errors = [
        ...services.diagnostics
          .filter((item) => item.type === "error")
          .map((item) => item.message),
        ...services.resourceLoader
          .getExtensions()
          .errors.map((item) => item.error),
      ];
      if (errors.length) {
        throw new Error(`Child resource startup failed: ${errors.join("; ")}`);
      }
      // Native provider registration starts an asynchronous availability refresh. Await the selected
      // provider's public refresh before reading its synchronous auth snapshot.
      await services.modelRuntime.refresh({
        providers: [config.provider],
        allowNetwork: false,
        signal: AbortSignal.timeout(15_000),
      });
      const model = services.modelRuntime.getModel(
        config.provider,
        config.model,
      );
      if (!model || !services.modelRuntime.hasConfiguredAuth(model.provider)) {
        throw new Error(
          `Child model unavailable or unauthenticated: ${config.provider}/${config.model}`,
        );
      }
      const session = await createAgentSessionFromServices({
        services,
        sessionManager,
        model,
        thinkingLevel: config.thinking,
      });
      return { ...session, services, diagnostics: services.diagnostics };
    },
    { cwd: config.cwd, agentDir, sessionManager },
  );
}
