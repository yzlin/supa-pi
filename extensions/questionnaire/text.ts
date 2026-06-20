import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

const ESC = 0x1b;
const BEL = 0x07;
const DELETE = 0x7f;

function isTextControl(code: number): boolean {
  return code < 0x20 && code !== 0x09 && code !== 0x0a;
}

function skipOscSequence(
  text: string,
  index: number,
  limit = text.length
): number {
  let cursor = index + 2;
  while (cursor < limit) {
    const code = text.charCodeAt(cursor);
    if (code === BEL) {
      return cursor;
    }
    if (code === ESC && cursor + 1 < limit && text[cursor + 1] === "\\") {
      return cursor + 1;
    }
    cursor++;
  }
  return Math.max(index, limit - 1);
}

function skipCsiSequence(
  text: string,
  index: number,
  limit = text.length
): number {
  let cursor = index + 2;
  while (cursor < limit) {
    const code = text.charCodeAt(cursor);
    if (code >= 0x40 && code <= 0x7e) {
      return cursor;
    }
    cursor++;
  }
  return Math.max(index, limit - 1);
}

function skipEscapeSequence(
  text: string,
  index: number,
  limit = text.length
): number {
  const next = index + 1 < limit ? text[index + 1] : undefined;
  if (next === "]") {
    return skipOscSequence(text, index, limit);
  }
  if (next === "[") {
    return skipCsiSequence(text, index, limit);
  }
  return index + 1 < limit ? index + 1 : index;
}

export function stripTerminalControls(text: string): string {
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

export function stripTerminalControlsUpTo(
  text: string,
  maxOutputChars: number,
  maxInputChars = Math.max(maxOutputChars * 16, maxOutputChars + 1024)
): { text: string; truncated: boolean } {
  let out = "";
  const inputLimit = Math.min(text.length, maxInputChars);
  for (let index = 0; index < inputLimit; index++) {
    const code = text.charCodeAt(index);
    if (code === ESC) {
      index = skipEscapeSequence(text, index, inputLimit);
      continue;
    }
    if (code === DELETE || isTextControl(code)) {
      continue;
    }
    out += text[index];
    if (out.length >= maxOutputChars) {
      return { text: out, truncated: index < text.length - 1 };
    }
  }
  return { text: out, truncated: inputLimit < text.length };
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
