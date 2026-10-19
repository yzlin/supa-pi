import {
  type ExtensionAPI,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";

import {
  contextDirectories,
  contextFilesDisabled,
  discoverLocalContextFiles,
  type LocalContextFile,
  mergeLocalContextFiles,
} from "./discover";

interface LocalContextCache {
  files: LocalContextFile[];
  dirOrder: string[];
}

export default function agentsLocalExtension(pi: ExtensionAPI): void {
  let cache: LocalContextCache | undefined;

  pi.on("session_start", (_event, ctx) => {
    cache = undefined;
    if (contextFilesDisabled(process.argv)) {
      return;
    }
    const options = { cwd: ctx.cwd, agentDir: getAgentDir() };
    cache = {
      files: discoverLocalContextFiles(options),
      dirOrder: contextDirectories(options),
    };
  });

  // Edit contextFiles, not sections or systemPrompt: entries render inside the
  // native <project_context>, and claude-bridge reads this same options object.
  pi.on("before_agent_start", (event) => {
    if (!cache || cache.files.length === 0) {
      return;
    }
    const { contextFiles } = event.systemPromptOptions;
    contextFiles.splice(
      0,
      contextFiles.length,
      ...mergeLocalContextFiles(contextFiles, cache.files, cache.dirOrder),
    );
  });
}
