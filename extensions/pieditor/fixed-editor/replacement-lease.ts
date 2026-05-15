export interface ReplacementSurface {
  render(width: number): string[];
}

export interface ReplacementLeaseCompositor {
  hideRenderable(target: ReplacementSurface): void;
  unhideRenderable?(target: ReplacementSurface): void;
  requestRepaint?(): void;
}

export interface ReplacementLeaseAcquireOptions {
  owner: string;
  id: string;
  target: ReplacementSurface;
}

export interface ReplacementLease {
  readonly owner: string;
  readonly id: string;
  release(): void;
}

export interface ReplacementLeaseDiagnostic {
  owner: string;
  id: string;
}

interface ActiveLease {
  owner: string;
  id: string;
  target: ReplacementSurface;
  released: boolean;
}

interface ReplacementLeaseState {
  activeCompositor: ReplacementLeaseCompositor | null;
  activeLeases: Set<ActiveLease>;
  targetLeaseCounts: Map<ReplacementSurface, number>;
}

const REPLACEMENT_LEASE_STATE_KEY = Symbol.for(
  "supa-pi:pieditor:replacement-lease-state"
);

const globalReplacementLeaseState = globalThis as typeof globalThis & {
  [REPLACEMENT_LEASE_STATE_KEY]?: ReplacementLeaseState;
};

if (!globalReplacementLeaseState[REPLACEMENT_LEASE_STATE_KEY]) {
  globalReplacementLeaseState[REPLACEMENT_LEASE_STATE_KEY] = {
    activeCompositor: null,
    activeLeases: new Set<ActiveLease>(),
    targetLeaseCounts: new Map<ReplacementSurface, number>(),
  };
}

const state = globalReplacementLeaseState[REPLACEMENT_LEASE_STATE_KEY];

function normalizeLabel(value: string, fallback: string): string {
  const label = value.trim();
  return label.length > 0 ? label : fallback;
}

function repaint(): void {
  state.activeCompositor?.requestRepaint?.();
}

function hideTarget(target: ReplacementSurface): void {
  const count = state.targetLeaseCounts.get(target) ?? 0;
  state.targetLeaseCounts.set(target, count + 1);

  if (count === 0) {
    state.activeCompositor?.hideRenderable(target);
  }
  repaint();
}

function unhideTarget(target: ReplacementSurface): void {
  const count = state.targetLeaseCounts.get(target) ?? 0;
  if (count <= 1) {
    state.targetLeaseCounts.delete(target);
    state.activeCompositor?.unhideRenderable?.(target);
  } else {
    state.targetLeaseCounts.set(target, count - 1);
  }
  repaint();
}

export function attachReplacementLeaseCompositor(
  compositor: ReplacementLeaseCompositor | null
): void {
  state.activeCompositor = compositor;

  if (!state.activeCompositor) {
    return;
  }

  for (const target of state.targetLeaseCounts.keys()) {
    state.activeCompositor.hideRenderable(target);
  }
  repaint();
}

export function acquireReplacementSurfaceLease(
  options: ReplacementLeaseAcquireOptions
): ReplacementLease {
  const lease: ActiveLease = {
    owner: normalizeLabel(options.owner, "unknown"),
    id: normalizeLabel(options.id, "unknown"),
    target: options.target,
    released: false,
  };

  state.activeLeases.add(lease);
  hideTarget(lease.target);

  return {
    owner: lease.owner,
    id: lease.id,
    release() {
      if (lease.released) {
        return;
      }

      lease.released = true;
      state.activeLeases.delete(lease);
      unhideTarget(lease.target);
    },
  };
}

export async function withReplacementSurfaceLease<T>(
  options: ReplacementLeaseAcquireOptions,
  run: () => Promise<T>
): Promise<T> {
  const lease = acquireReplacementSurfaceLease(options);
  try {
    return await run();
  } finally {
    lease.release();
  }
}

export function getActiveReplacementLeaseDiagnostics(): ReplacementLeaseDiagnostic[] {
  return [...state.activeLeases].map(({ owner, id }) => ({ owner, id }));
}

export function hasReplacementLeaseCompositor(): boolean {
  return state.activeCompositor !== null;
}

export function getActiveReplacementSurface(): ReplacementSurface | null {
  const leases = [...state.activeLeases];
  return leases.at(-1)?.target ?? null;
}

export function isReplacementSurfaceLeased(
  target: ReplacementSurface
): boolean {
  return state.targetLeaseCounts.has(target);
}

export function clearReplacementSurfaceLeases(): void {
  const leases = [...state.activeLeases];
  const targets = [...state.targetLeaseCounts.keys()];

  for (const lease of leases) {
    lease.released = true;
  }

  state.activeLeases.clear();
  state.targetLeaseCounts.clear();

  for (const target of targets) {
    state.activeCompositor?.unhideRenderable?.(target);
  }
  repaint();
}
