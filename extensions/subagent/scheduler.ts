// Apache-2.0 adaptation of mitsuhiko/agent-stuff, d265b8e. Modified for SupaPi: four shared parent slots and owned cancellation.
interface Waiter {
  start: () => void;
}
interface Job {
  controller: AbortController;
  done: Promise<void>;
}
interface Parent {
  active: number;
  queue: Waiter[];
  jobs: Set<Job>;
  closed: boolean;
}
const parents = new Map<string, Parent>();
function parentFor(id: string): Parent {
  let parent = parents.get(id);
  if (!parent) {
    parent = { active: 0, queue: [], jobs: new Set(), closed: false };
    parents.set(id, parent);
  }
  return parent;
}
export function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error("Subagent aborted.");
  }
}
function acquire(
  parent: Parent,
  signal: AbortSignal,
  queued: () => void,
): Promise<void> {
  checkAbort(signal);
  if (parent.active < 4) {
    parent.active++;
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const waiter: Waiter = {
      start: () => {
        signal.removeEventListener("abort", abort);
        parent.active++;
        resolve();
      },
    };
    const abort = () => {
      parent.queue = parent.queue.filter((item) => item !== waiter);
      reject(new Error("Subagent aborted while queued."));
    };
    signal.addEventListener("abort", abort, { once: true });
    parent.queue.push(waiter);
    queued();
  });
}
export async function withSessionSlot<T>(
  id: string,
  external: AbortSignal | undefined,
  queued: () => void,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const parent = parentFor(id);
  if (parent.closed) {
    throw new Error("Parent subagents are shut down.");
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  external?.addEventListener("abort", abort, { once: true });
  if (external?.aborted) {
    abort();
  }
  let finished!: () => void;
  const job: Job = {
    controller,
    done: new Promise((resolve) => {
      finished = resolve;
    }),
  };
  parent.jobs.add(job);
  let acquired = false;
  try {
    await acquire(parent, controller.signal, queued);
    acquired = true;
    checkAbort(controller.signal);
    return await work(controller.signal);
  } finally {
    external?.removeEventListener("abort", abort);
    parent.jobs.delete(job);
    finished();
    if (acquired) {
      parent.active--;
      parent.queue.shift()?.start();
    }
    if (!parent.closed && !parent.jobs.size) {
      parents.delete(id);
    }
  }
}
export async function cancelSessionSubagents(id: string): Promise<void> {
  const parent = parentFor(id);
  parent.closed = true;
  const jobs = [...parent.jobs];
  for (const job of jobs) {
    job.controller.abort();
  }
  await Promise.all(jobs.map((job) => job.done));
  if (parents.get(id) === parent) {
    parents.delete(id);
  }
}
