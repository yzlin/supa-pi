import type { ToolRenderers } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

// Pi draws the tool block background once per line. A full reset inside the
// line (for example from pi-tui truncateToWidth) clears it for the rest of the
// line, so swap full resets for one that resets everything except background.
// oxlint-disable-next-line no-control-regex -- SGR resets start with the terminal escape character.
const FULL_RESET = /\u001b\[0?m/g;
const RESET_EXCEPT_BACKGROUND = "\u001b[22;23;24;25;27;28;29;39m";

const wrappers = new WeakMap<Component, Component>();
const originals = new WeakMap<Component, Component>();

function keepBackground(component: Component): Component {
  const existing = wrappers.get(component);
  if (existing) {
    return existing;
  }
  const wrapper = new Proxy(component, {
    get(target, key) {
      if (key === "render") {
        return (width: number) =>
          target
            .render(width)
            .map((line) => line.replace(FULL_RESET, RESET_EXCEPT_BACKGROUND));
      }
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  wrappers.set(component, wrapper);
  originals.set(wrapper, component);
  return wrapper;
}

function withOriginalComponent<T extends { lastComponent?: Component }>(
  context: T,
): T {
  const original = context.lastComponent
    ? originals.get(context.lastComponent)
    : undefined;
  return original ? { ...context, lastComponent: original } : context;
}

export function keepRendererBackground(
  renderers: ToolRenderers,
): ToolRenderers {
  const { renderCall, renderResult } = renderers;
  return {
    ...renderers,
    renderCall:
      renderCall &&
      ((args, theme, context) =>
        keepBackground(
          renderCall(args, theme, withOriginalComponent(context)),
        )),
    renderResult:
      renderResult &&
      ((result, options, theme, context) =>
        keepBackground(
          renderResult(result, options, theme, withOriginalComponent(context)),
        )),
  };
}
