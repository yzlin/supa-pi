import { afterEach, describe, expect, it } from "bun:test";

import {
  acquireReplacementSurfaceLease,
  attachReplacementLeaseCompositor,
  clearReplacementSurfaceLeases,
  getActiveReplacementLeaseDiagnostics,
  type ReplacementLeaseCompositor,
  type ReplacementSurface,
  withReplacementSurfaceLease,
} from "./replacement-lease.js";

class MockSurface implements ReplacementSurface {
  render(_width: number): string[] {
    return ["surface"];
  }
}

class MockCompositor implements ReplacementLeaseCompositor {
  readonly hidden: ReplacementSurface[] = [];
  readonly unhidden: ReplacementSurface[] = [];
  repaintCount = 0;

  hideRenderable(target: ReplacementSurface): void {
    this.hidden.push(target);
  }

  unhideRenderable(target: ReplacementSurface): void {
    this.unhidden.push(target);
  }

  requestRepaint(): void {
    this.repaintCount += 1;
  }
}

afterEach(() => {
  clearReplacementSurfaceLeases();
  attachReplacementLeaseCompositor(null);
});

describe("replacement surface leases", () => {
  it("acquires and releases a raw lease", () => {
    const compositor = new MockCompositor();
    const surface = new MockSurface();
    attachReplacementLeaseCompositor(compositor);

    const lease = acquireReplacementSurfaceLease({
      owner: "test-owner",
      id: "test-id",
      target: surface,
    });

    expect(compositor.hidden).toEqual([surface]);
    expect(getActiveReplacementLeaseDiagnostics()).toEqual([
      { owner: "test-owner", id: "test-id" },
    ]);

    lease.release();

    expect(compositor.unhidden).toEqual([surface]);
    expect(getActiveReplacementLeaseDiagnostics()).toEqual([]);
  });

  it("makes release idempotent", () => {
    const compositor = new MockCompositor();
    const surface = new MockSurface();
    attachReplacementLeaseCompositor(compositor);

    const lease = acquireReplacementSurfaceLease({
      owner: "owner",
      id: "id",
      target: surface,
    });

    lease.release();
    lease.release();

    expect(compositor.unhidden).toEqual([surface]);
  });

  it("keeps additive leases hidden until the last release", () => {
    const compositor = new MockCompositor();
    const surface = new MockSurface();
    attachReplacementLeaseCompositor(compositor);

    const first = acquireReplacementSurfaceLease({
      owner: "first",
      id: "1",
      target: surface,
    });
    const second = acquireReplacementSurfaceLease({
      owner: "second",
      id: "2",
      target: surface,
    });

    expect(compositor.hidden).toEqual([surface]);

    first.release();
    expect(compositor.unhidden).toEqual([]);

    second.release();
    expect(compositor.unhidden).toEqual([surface]);
  });

  it("keeps new leases active when a stale cleared handle releases", () => {
    const compositor = new MockCompositor();
    const surface = new MockSurface();
    attachReplacementLeaseCompositor(compositor);

    const staleLease = acquireReplacementSurfaceLease({
      owner: "stale",
      id: "old",
      target: surface,
    });

    clearReplacementSurfaceLeases();

    const currentLease = acquireReplacementSurfaceLease({
      owner: "current",
      id: "new",
      target: surface,
    });

    staleLease.release();

    expect(compositor.unhidden).toEqual([surface]);
    expect(getActiveReplacementLeaseDiagnostics()).toEqual([
      { owner: "current", id: "new" },
    ]);

    currentLease.release();

    expect(compositor.unhidden).toEqual([surface, surface]);
    expect(getActiveReplacementLeaseDiagnostics()).toEqual([]);
  });

  it("clears all leases and exposes active owner/id diagnostics", () => {
    const compositor = new MockCompositor();
    const firstSurface = new MockSurface();
    const secondSurface = new MockSurface();
    attachReplacementLeaseCompositor(compositor);

    acquireReplacementSurfaceLease({
      owner: "owner-a",
      id: "id-a",
      target: firstSurface,
    });
    acquireReplacementSurfaceLease({
      owner: "owner-b",
      id: "id-b",
      target: secondSurface,
    });

    expect(getActiveReplacementLeaseDiagnostics()).toEqual([
      { owner: "owner-a", id: "id-a" },
      { owner: "owner-b", id: "id-b" },
    ]);

    clearReplacementSurfaceLeases();

    expect(compositor.unhidden).toEqual([firstSurface, secondSurface]);
    expect(getActiveReplacementLeaseDiagnostics()).toEqual([]);
  });

  it("is a safe no-op when no compositor is attached", () => {
    const surface = new MockSurface();

    const lease = acquireReplacementSurfaceLease({
      owner: "owner",
      id: "id",
      target: surface,
    });

    expect(getActiveReplacementLeaseDiagnostics()).toEqual([
      { owner: "owner", id: "id" },
    ]);

    lease.release();
    clearReplacementSurfaceLeases();

    expect(getActiveReplacementLeaseDiagnostics()).toEqual([]);
  });

  it("releases scoped async leases after success and failure", async () => {
    const compositor = new MockCompositor();
    const surface = new MockSurface();
    attachReplacementLeaseCompositor(compositor);

    await expect(
      withReplacementSurfaceLease(
        { owner: "scope", id: "success", target: surface },
        async () => "ok"
      )
    ).resolves.toBe("ok");

    await expect(
      withReplacementSurfaceLease(
        { owner: "scope", id: "failure", target: surface },
        () => Promise.reject(new Error("boom"))
      )
    ).rejects.toThrow("boom");

    expect(getActiveReplacementLeaseDiagnostics()).toEqual([]);
    expect(compositor.unhidden).toEqual([surface, surface]);
  });
});
