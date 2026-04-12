import type {
  StatusBarSeparatorDef,
  StatusBarSeparatorStyle,
} from "./status-bar-types.js";

interface IconSet {
  pi: string;
  model: string;
  folder: string;
  branch: string;
  git: string;
  tokens: string;
  context: string;
  cost: string;
  time: string;
  cache: string;
  input: string;
  output: string;
  host: string;
  session: string;
}

interface SeparatorChars {
  powerlineLeft: string;
  powerlineRight: string;
  powerlineThinLeft: string;
  powerlineThinRight: string;
  slash: string;
  pipe: string;
  block: string;
  space: string;
  asciiLeft: string;
  asciiRight: string;
  dot: string;
}

export const SEP_DOT = " · ";

const THINKING_TEXT_UNICODE: Record<string, string> = {
  minimal: "[min]",
  low: "[low]",
  medium: "[med]",
  high: "[high]",
  xhigh: "[xhi]",
};

const THINKING_TEXT_NERD: Record<string, string> = {
  minimal: "\u{F0E7} min",
  low: "\u{F10C} low",
  medium: "\u{F192} med",
  high: "\u{F111} high",
  xhigh: "\u{F06D} xhi",
};

const NERD_ICONS: IconSet = {
  pi: "\uE22C",
  model: "\uF544",
  folder: "\uF07C",
  branch: "\uF126",
  git: "\uF1D3",
  tokens: "\uF02B",
  context: "\uF02D",
  cost: "\uF155",
  time: "\uF017",
  cache: "\uF021",
  input: "\uF063",
  output: "\uF062",
  host: "\uF108",
  session: "\uF550",
};

const ASCII_ICONS: IconSet = {
  pi: "π",
  model: "✦",
  folder: "▣",
  branch: "⎇",
  git: "⎇",
  tokens: "◎",
  context: "◫",
  cost: "$",
  time: "◷",
  cache: "⟳",
  input: "↙",
  output: "↗",
  host: "@",
  session: "◇",
};

const NERD_SEPARATORS: SeparatorChars = {
  powerlineLeft: "\uE0B0",
  powerlineRight: "\uE0B2",
  powerlineThinLeft: "\uE0B1",
  powerlineThinRight: "\uE0B3",
  slash: "/",
  pipe: "|",
  block: "█",
  space: " ",
  asciiLeft: ">",
  asciiRight: "<",
  dot: "·",
};

const ASCII_SEPARATORS: SeparatorChars = {
  powerlineLeft: ">",
  powerlineRight: "<",
  powerlineThinLeft: "|",
  powerlineThinRight: "|",
  slash: "/",
  pipe: "|",
  block: "#",
  space: " ",
  asciiLeft: ">",
  asciiRight: "<",
  dot: ".",
};

export function hasNerdFonts(): boolean {
  if (process.env.POWERLINE_NERD_FONTS === "0") return false;
  return true;
}

export function getIcons(): IconSet {
  return hasNerdFonts() ? NERD_ICONS : ASCII_ICONS;
}

function getSeparatorChars(): SeparatorChars {
  return hasNerdFonts() ? NERD_SEPARATORS : ASCII_SEPARATORS;
}

export function getThinkingText(level: string): string | undefined {
  return hasNerdFonts()
    ? THINKING_TEXT_NERD[level]
    : THINKING_TEXT_UNICODE[level];
}

export function getSeparator(
  style: StatusBarSeparatorStyle
): StatusBarSeparatorDef {
  const chars = getSeparatorChars();

  switch (style) {
    case "powerline":
      return { left: chars.powerlineLeft, right: chars.powerlineRight };
    case "powerline-thin":
      return { left: chars.powerlineThinLeft, right: chars.powerlineThinRight };
    case "slash":
      return { left: chars.slash, right: chars.slash };
    case "pipe":
      return { left: chars.pipe, right: chars.pipe };
    case "block":
      return { left: chars.block, right: chars.block };
    case "none":
      return { left: chars.space, right: chars.space };
    case "ascii":
      return { left: chars.asciiLeft, right: chars.asciiRight };
    case "dot":
      return { left: chars.dot, right: chars.dot };
    case "chevron":
      return { left: "›", right: "‹" };
    case "star":
      return { left: "✦", right: "✦" };
    default:
      return { left: chars.powerlineThinLeft, right: chars.powerlineThinRight };
  }
}
