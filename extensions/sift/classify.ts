import { loadWorkspaceFile } from "./files";
import type { JevJudgment } from "./jev";

export class SessionBudget {
  attempted = 0;
  readonly limit: number;
  constructor(limit = 100) {
    if (!Number.isInteger(limit) || limit < 0) {
      throw new Error("Invalid budget");
    }
    this.limit = limit;
  }
  canFit(count: number): boolean {
    return this.attempted + count <= this.limit;
  }
  recordAttempt(): void {
    if (!this.canFit(1)) {
      throw new Error("Session judgment budget exceeded");
    }
    this.attempted++;
  }
}

export interface ClassificationResult {
  path: string;
  probability?: number;
  model?: string;
  truncated?: boolean;
  error?: string;
}

export interface ClassifyOptions {
  cwd: string;
  query: string;
  paths: string[];
  budget: SessionBudget;
  signal?: AbortSignal;
  judge: (
    query: string,
    path: string,
    content: string,
    signal?: AbortSignal,
  ) => Promise<JevJudgment>;
}

export async function classifyFiles(
  options: ClassifyOptions,
): Promise<ClassificationResult[]> {
  const query = options.query.trim();
  if (!query || query.length > 2000) {
    throw new Error("query must be between 1 and 2000 characters");
  }
  if (options.paths.length < 1 || options.paths.length > 20) {
    throw new Error("Between 1 and 20 paths are required");
  }
  if (options.paths.some((path) => !path || path.length > 1000)) {
    throw new Error("Paths must be between 1 and 1000 characters");
  }
  if (new Set(options.paths).size !== options.paths.length) {
    throw new Error("Paths must be unique");
  }
  if (!options.budget.canFit(options.paths.length)) {
    throw new Error("Session judgment budget exceeded");
  }

  const results: ClassificationResult[] = options.paths.map((path) => ({
    path,
  }));
  let next = 0;
  const worker = async () => {
    while (next < options.paths.length) {
      if (options.signal?.aborted) {
        return;
      }
      const index = next++;
      const path = options.paths[index];
      try {
        const file = await loadWorkspaceFile(options.cwd, path);
        if (options.signal?.aborted) {
          return;
        }
        options.budget.recordAttempt();
        const judgment = await options.judge(
          query,
          file.externalPath,
          file.content,
          options.signal,
        );
        results[index] = {
          path,
          probability: judgment.probability,
          model: judgment.model,
          truncated: file.truncated,
        };
      } catch (error) {
        results[index] = { path, error: safeError(error) };
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(4, options.paths.length) }, worker),
  );
  if (options.signal?.aborted) {
    for (let index = 0; index < results.length; index++) {
      if (
        results[index].probability === undefined &&
        results[index].error === undefined
      ) {
        results[index] = { path: options.paths[index], error: "cancelled" };
      }
    }
  }
  return results;
}

function safeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return "File judgment failed";
}
