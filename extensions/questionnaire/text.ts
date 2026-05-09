import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

const ESC = 0x1b;
const BEL = 0x07;
const DELETE = 0x7f;

function isTextControl(code: number): boolean {
  return code < 0x20 && code !== 0x09 && code !== 0x0a;
}

function skipOscSequence(text: string, index: number): number {
  let cursor = index + 2;
  while (cursor < text.length) {
    const code = text.charCodeAt(cursor);
    if (code === BEL) {
      return cursor;
    }
    if (code === ESC && text[cursor + 1] === "\\") {
      return cursor + 1;
    }
    cursor++;
  }
  return text.length - 1;
}

function skipCsiSequence(text: string, index: number): number {
  let cursor = index + 2;
  while (cursor < text.length) {
    const code = text.charCodeAt(cursor);
    if (code >= 0x40 && code <= 0x7e) {
      return cursor;
    }
    cursor++;
  }
  return text.length - 1;
}

function skipEscapeSequence(text: string, index: number): number {
  const next = text[index + 1];
  if (next === "]") {
    return skipOscSequence(text, index);
  }
  if (next === "[") {
    return skipCsiSequence(text, index);
  }
  return index + 1 < text.length ? index + 1 : index;
}

function stripTerminalControls(text: string): string {
  let out = "";
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code === ESC) {
      index = skipEscapeSequence(text, index);
      continue;
    }
    if (code === DELETE || isTextControl(code)) {
      continue;
    }
    out += text[index];
  }
  return out;
}

export function wrapQuestionnaireText(text: string, width: number): string[] {
  const clampedWidth = Math.max(1, width);
  const normalized = stripTerminalControls(text).replace(/\t/g, "    ");

  if (!normalized) {
    return [""];
  }

  return normalized.split("\n").flatMap((line) => {
    if (!line) {
      return [""];
    }

    return wrapTextWithAnsi(line, clampedWidth).map((segment) =>
      truncateToWidth(segment, clampedWidth)
    );
  });
}
