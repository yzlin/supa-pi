// SupaPi additions: parent dialog FIFO coverage against Pi's displace-and-orphan dialog slot.
import { expect, test } from "bun:test";

import type { ExtensionUIDialogOptions } from "@earendil-works/pi-coding-agent";

import { queueDialogs } from "./dialog-queue";

// Mimics Pi 1.3.0 InteractiveMode: one dialog slot; opening another replaces the visible one and never settles it.
function displacingUI() {
  const opened: string[] = [];
  let active: { title: string; settle: (value: unknown) => void } | undefined;
  function open<T>(
    title: string,
    abortValue: T,
    opts?: ExtensionUIDialogOptions,
  ): Promise<T> {
    return new Promise<T>((resolve) => {
      if (opts?.signal?.aborted) {
        resolve(abortValue);
        return;
      }
      opened.push(title);
      const entry = {
        title,
        settle: (value: unknown) => resolve(value as T),
      };
      active = entry;
      opts?.signal?.addEventListener(
        "abort",
        () => {
          if (active === entry) {
            active = undefined;
          }
          resolve(abortValue);
        },
        { once: true },
      );
    });
  }
  const ui = {
    confirm: (
      title: string,
      _message: string,
      opts?: ExtensionUIDialogOptions,
    ) =>
      open<string | undefined>(title, undefined, opts).then(
        (value) => value === "Yes",
      ),
    select: (
      title: string,
      _options: string[],
      opts?: ExtensionUIDialogOptions,
    ) => open<string | undefined>(title, undefined, opts),
    input: (
      title: string,
      _placeholder?: string,
      opts?: ExtensionUIDialogOptions,
    ) => open<string | undefined>(title, undefined, opts),
    editor: (title: string, _prefill?: string) =>
      open<string | undefined>(title, undefined),
    custom: <T>(_factory: unknown, _options?: unknown) =>
      open<T | undefined>("custom", undefined) as Promise<T>,
  };
  return {
    ui,
    opened,
    get active() {
      return active?.title;
    },
    answer(value: unknown) {
      const current = active;
      if (!current) {
        throw new Error("No visible dialog");
      }
      active = undefined;
      current.settle(value);
    },
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("fake reproduces the orphaned displaced dialog without the queue", async () => {
  const fake = displacingUI();
  let firstSettled = false;
  void fake.ui.confirm("first", "m").then(() => {
    firstSettled = true;
  });
  const second = fake.ui.confirm("second", "m");
  fake.answer("Yes");
  expect(await second).toBe(true);
  await tick();
  expect(firstSettled).toBe(false);
});

test("concurrent confirms open one at a time and both resolve in order", async () => {
  const fake = displacingUI();
  queueDialogs(fake.ui);
  const order: string[] = [];
  const first = fake.ui.confirm("first", "m").then((value) => {
    order.push("first");
    return value;
  });
  const second = fake.ui.confirm("second", "m").then((value) => {
    order.push("second");
    return value;
  });
  await tick();
  expect(fake.opened).toEqual(["first"]);
  fake.answer("Yes");
  expect(await first).toBe(true);
  await tick();
  expect(fake.opened).toEqual(["first", "second"]);
  expect(fake.active).toBe("second");
  fake.answer("No");
  expect(await second).toBe(false);
  expect(order).toEqual(["first", "second"]);
});

test("mixed dialog kinds share one FIFO and keep return values", async () => {
  const fake = displacingUI();
  queueDialogs(fake.ui);
  const select = fake.ui.select("select", ["a", "b"]);
  const input = fake.ui.input("input", "hint");
  const editor = fake.ui.editor("editor", "prefill");
  const custom = fake.ui.custom<number>(() => {
    throw new Error("factory is owned by Pi");
  });
  const answers: unknown[] = ["b", "typed", undefined, 42];
  for (const answer of answers) {
    await tick();
    fake.answer(answer);
  }
  expect(await select).toBe("b");
  expect(await input).toBe("typed");
  expect(await editor).toBeUndefined();
  expect(await custom).toBe(42);
  expect(fake.opened).toEqual(["select", "input", "editor", "custom"]);
});

test("aborted queued calls resolve like Pi's abort without opening", async () => {
  const fake = displacingUI();
  queueDialogs(fake.ui);
  const confirmAbort = new AbortController();
  const selectAbort = new AbortController();
  const inputAbort = new AbortController();
  const first = fake.ui.confirm("first", "m");
  const confirm = fake.ui.confirm("confirm", "m", {
    signal: confirmAbort.signal,
  });
  const select = fake.ui.select("select", ["a"], {
    signal: selectAbort.signal,
  });
  const input = fake.ui.input("input", undefined, {
    signal: inputAbort.signal,
  });
  const last = fake.ui.input("last");
  confirmAbort.abort();
  selectAbort.abort();
  inputAbort.abort();
  expect(await confirm).toBe(false);
  expect(await select).toBeUndefined();
  expect(await input).toBeUndefined();
  await tick();
  // Abort of a queued call must not release the slot while the first dialog is still visible.
  expect(fake.opened).toEqual(["first"]);
  fake.answer("Yes");
  expect(await first).toBe(true);
  await tick();
  expect(fake.opened).toEqual(["first", "last"]);
  fake.answer("done");
  expect(await last).toBe("done");
});

test("already-aborted calls resolve immediately and visible abort releases the slot", async () => {
  const fake = displacingUI();
  queueDialogs(fake.ui);
  const aborted = AbortSignal.abort();
  expect(await fake.ui.confirm("pre", "m", { signal: aborted })).toBe(false);
  const controller = new AbortController();
  const visible = fake.ui.select("visible", ["a"], {
    signal: controller.signal,
  });
  const next = fake.ui.confirm("next", "m");
  await tick();
  expect(fake.active).toBe("visible");
  controller.abort();
  expect(await visible).toBeUndefined();
  await tick();
  expect(fake.active).toBe("next");
  fake.answer("Yes");
  expect(await next).toBe(true);
  expect(fake.opened).toEqual(["visible", "next"]);
});

test("a rejected dialog does not block later dialogs", async () => {
  const fake = displacingUI();
  const original = fake.ui.input;
  fake.ui.input = (title, placeholder, opts) =>
    title === "boom"
      ? Promise.reject(new Error("boom"))
      : original(title, placeholder, opts);
  queueDialogs(fake.ui);
  const failed = fake.ui.input("boom");
  const next = fake.ui.input("next");
  const error = await failed.catch((reason: unknown) => reason);
  expect(error).toBeInstanceOf(Error);
  expect(error).toHaveProperty("message", "boom");
  await tick();
  fake.answer("ok");
  expect(await next).toBe("ok");
});

test("wrapping is idempotent per object and applies to new objects", async () => {
  const fake = displacingUI();
  queueDialogs(fake.ui);
  const wrappedConfirm = fake.ui.confirm;
  queueDialogs(fake.ui);
  expect(fake.ui.confirm).toBe(wrappedConfirm);
  const first = fake.ui.confirm("first", "m");
  const second = fake.ui.confirm("second", "m");
  await tick();
  expect(fake.opened).toEqual(["first"]);
  fake.answer("Yes");
  await first;
  await tick();
  fake.answer("Yes");
  await second;

  const replacement = displacingUI();
  queueDialogs(replacement.ui);
  void replacement.ui.confirm("a", "m");
  void replacement.ui.confirm("b", "m");
  await tick();
  expect(replacement.opened).toEqual(["a"]);
});

test("overlay custom dialogs bypass the queue; inline custom stays queued", async () => {
  const fake = displacingUI();
  const overlays: unknown[] = [];
  const slotCustom = fake.ui.custom;
  // Pi shows overlays above the editor slot; they never displace or get displaced by slot dialogs.
  fake.ui.custom = (<T>(factory: unknown, options?: { overlay?: boolean }) => {
    if (options?.overlay) {
      overlays.push(factory);
      return new Promise<T>(() => undefined);
    }
    return slotCustom<T>(factory, options);
  }) as typeof fake.ui.custom;
  queueDialogs(fake.ui);
  void fake.ui.custom("viewer", { overlay: true });
  const confirm = fake.ui.confirm("after overlay", "?");
  await tick();
  expect(overlays).toEqual(["viewer"]);
  expect(fake.active).toBe("after overlay");
  fake.answer("Yes");
  expect(await confirm).toBe(true);

  const inline = fake.ui.custom("inline");
  const queued = fake.ui.confirm("after inline", "?");
  await tick();
  expect(fake.active).toBe("custom");
  fake.answer("done");
  expect(await inline).toBe("done");
  await tick();
  expect(fake.active).toBe("after inline");
  fake.answer("No");
  expect(await queued).toBe(false);
});
