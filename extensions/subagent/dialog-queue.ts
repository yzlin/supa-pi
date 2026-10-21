// SupaPi addition: Pi 1.3.0 interactive dialogs share one slot; opening a second replaces the first and never settles it.
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

export type DialogUI = Pick<
  ExtensionUIContext,
  "confirm" | "select" | "input" | "editor" | "custom"
>;

const queued = new WeakSet<DialogUI>();

/**
 * Serialize dialogs on a shared UI object in place, FIFO. Idempotent per object.
 * Callers needing a queued dialog call `queueDialogs(ctx.ui)` (no-op if already wrapped), then `ctx.ui.*` as usual.
 */
export function queueDialogs(ui: DialogUI): void {
  if (queued.has(ui)) {
    return;
  }
  queued.add(ui);
  let tail: Promise<void> = Promise.resolve();
  const enqueue = <T>(
    run: () => Promise<T>,
    abortValue: T,
    signal?: AbortSignal,
  ): Promise<T> => {
    if (signal?.aborted) {
      return Promise.resolve(abortValue);
    }
    return new Promise<T>((resolve) => {
      // Pi resolves aborted dialogs with the deny value; a queued call does the same without opening.
      const onAbort = () => resolve(abortValue);
      signal?.addEventListener("abort", onAbort, { once: true });
      // The slot stays held until this dialog settles, even if a queued call aborts early.
      tail = tail.then(async () => {
        signal?.removeEventListener("abort", onAbort);
        if (signal?.aborted) {
          return;
        }
        const result = Promise.resolve().then(run);
        resolve(result);
        await result.catch(() => undefined);
      });
    });
  };
  const { confirm, select, input, editor, custom } = ui;
  ui.confirm = (title, message, opts) =>
    enqueue(() => confirm.call(ui, title, message, opts), false, opts?.signal);
  ui.select = (title, options, opts) =>
    enqueue(
      () => select.call(ui, title, options, opts),
      undefined,
      opts?.signal,
    );
  ui.input = (title, placeholder, opts) =>
    enqueue(
      () => input.call(ui, title, placeholder, opts),
      undefined,
      opts?.signal,
    );
  // editor and custom take no signal in Pi 1.3.0.
  ui.editor = (title, prefill) =>
    enqueue(() => editor.call(ui, title, prefill), undefined);
  // Overlays render above the dialog slot and are never displaced, so long-lived viewers must not hold the queue.
  ui.custom = (factory, options) =>
    options?.overlay
      ? custom.call(ui, factory, options)
      : enqueue(() => custom.call(ui, factory, options), undefined);
}
