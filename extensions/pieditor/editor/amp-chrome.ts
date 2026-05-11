import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export interface AmpChromeLabels {
  topLeftContent: string;
  topRightContent: string;
  bottomContent: string;
}

export interface RenderAmpEditorChromeOptions {
  width: number;
  editorLines: string[];
  labels: AmpChromeLabels;
  minBodyHeight?: number;
  borderColor?: (value: string) => string;
}

const DEFAULT_MIN_BODY_HEIGHT = 3;
export const MIN_AMP_WIDTH = 12;
export const AMP_BODY_HORIZONTAL_CHROME_WIDTH = 4;
const ANSI_ESCAPE_PATTERN = new RegExp(
  `${String.fromCharCode(27)}\\[[0-9;]*m`,
  "g"
);
const HORIZONTAL_BORDER_PATTERN = /^─+$/u;
const SCROLL_BORDER_PATTERN = /^─── [↑↓] \d+ more /u;
const TOP_SCROLL_BORDER_PATTERN = /^─── ↑ \d+ more /u;
const BOTTOM_SCROLL_BORDER_PATTERN = /^─── ↓ \d+ more /u;
const TRAILING_BORDER_PATTERN = /─+$/u;

function hasAnsi(value: string): boolean {
  return value.includes(String.fromCharCode(27));
}

function stripAnsi(value: string): string {
  return value.replace(ANSI_ESCAPE_PATTERN, "");
}

function isBorderLine(value: string): boolean {
  const plain = stripAnsi(value);
  return (
    HORIZONTAL_BORDER_PATTERN.test(plain) || SCROLL_BORDER_PATTERN.test(plain)
  );
}

function truncateVisible(value: string, width: number): string {
  const truncated = truncateToWidth(value, width, "");
  return hasAnsi(value)
    ? truncated
    : truncated.replace(ANSI_ESCAPE_PATTERN, "");
}

function fitVisible(value: string, width: number): string {
  if (width <= 0) {
    return "";
  }

  const actualWidth = visibleWidth(value);
  if (actualWidth > width) {
    return truncateVisible(value, width);
  }

  return value + " ".repeat(width - actualWidth);
}

function renderTopBorder(options: {
  width: number;
  leftContent: string;
  rightContent: string;
  borderColor: (value: string) => string;
  colorLeftContent?: boolean;
  colorRightContent?: boolean;
}): string {
  const {
    width,
    leftContent,
    rightContent,
    borderColor,
    colorLeftContent = false,
    colorRightContent = false,
  } = options;
  const innerWidth = width - 2;
  if (!(leftContent || rightContent)) {
    return `${borderColor("╭")}${borderColor("─".repeat(innerWidth))}${borderColor("╮")}`;
  }

  let left = truncateVisible(leftContent, innerWidth);
  const remainingForRight = Math.max(0, innerWidth - visibleWidth(left));
  let right = truncateVisible(rightContent, remainingForRight);

  if (visibleWidth(left) + visibleWidth(right) > innerWidth) {
    right = truncateVisible(
      right,
      Math.max(0, innerWidth - visibleWidth(left))
    );
  }
  if (visibleWidth(left) + visibleWidth(right) > innerWidth) {
    left = truncateVisible(left, Math.max(0, innerWidth - visibleWidth(right)));
  }

  const fillWidth = Math.max(
    0,
    innerWidth - visibleWidth(left) - visibleWidth(right)
  );
  const renderedLeft = colorLeftContent ? borderColor(left) : left;
  const renderedRight = colorRightContent ? borderColor(right) : right;
  return `${borderColor("╭")}${renderedLeft}${borderColor("─".repeat(fillWidth))}${renderedRight}${borderColor("╮")}`;
}

function renderBottomBorder(
  width: number,
  content: string,
  borderColor: (value: string) => string,
  colorContent = false
): string {
  const innerWidth = width - 2;
  if (!content) {
    return `${borderColor("╰")}${borderColor("─".repeat(innerWidth))}${borderColor("╯")}`;
  }

  const label = truncateVisible(content, innerWidth);
  const labelWidth = visibleWidth(label);
  const border = "─".repeat(Math.max(0, innerWidth - labelWidth));
  return `${borderColor("╰")}${borderColor(border)}${
    colorContent ? borderColor(label) : label
  }${borderColor("╯")}`;
}

function renderBodyLine(
  line: string,
  width: number,
  borderColor: (value: string) => string
): string {
  const contentWidth = width - 4;
  return `${borderColor("│")} ${fitVisible(line, contentWidth)} ${borderColor("│")}`;
}

export function renderAmpEditorChrome({
  width,
  editorLines,
  labels,
  minBodyHeight = DEFAULT_MIN_BODY_HEIGHT,
  borderColor = (value) => value,
}: RenderAmpEditorChromeOptions): string[] {
  if (width < MIN_AMP_WIDTH || editorLines.length < 2) {
    return editorLines;
  }

  const topNativeBorder = stripAnsi(editorLines[0] ?? "");
  const bottomIndex = editorLines.findIndex(
    (line, index) => index > 0 && isBorderLine(line)
  );

  if (bottomIndex < 0) {
    return editorLines;
  }

  const bottomNativeBorder = stripAnsi(editorLines[bottomIndex] ?? "");
  const hasTopScrollIndicator = TOP_SCROLL_BORDER_PATTERN.test(topNativeBorder);
  const hasBottomScrollIndicator =
    BOTTOM_SCROLL_BORDER_PATTERN.test(bottomNativeBorder);
  const topLeftContent = hasTopScrollIndicator
    ? topNativeBorder.replace(TRAILING_BORDER_PATTERN, "")
    : labels.topLeftContent;
  const topRightContent = hasTopScrollIndicator ? "" : labels.topRightContent;
  const bottomContent = hasBottomScrollIndicator
    ? bottomNativeBorder.replace(TRAILING_BORDER_PATTERN, "")
    : labels.bottomContent;

  const body = editorLines.slice(1, bottomIndex);
  const popup = editorLines.slice(bottomIndex + 1);
  const paddedBody = [...body];
  while (paddedBody.length < minBodyHeight) {
    paddedBody.push("");
  }

  return [
    renderTopBorder({
      width,
      leftContent: topLeftContent,
      rightContent: topRightContent,
      borderColor,
      colorLeftContent: hasTopScrollIndicator,
    }),
    ...paddedBody.map((line) => renderBodyLine(line, width, borderColor)),
    renderBottomBorder(
      width,
      bottomContent,
      borderColor,
      hasBottomScrollIndicator
    ),
    ...popup,
  ];
}
