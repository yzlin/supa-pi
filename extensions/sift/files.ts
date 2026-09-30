import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";

export const MAX_FILE_BYTES = 50 * 1024;
const SENSITIVE_NAMES = new Set([
  ".npmrc",
  ".pypirc",
  "credentials",
  "credentials.json",
]);
const SENSITIVE_NAME_PATTERNS = [
  /^\.env(?:\..+)?$/i,
  /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/i,
  /\.(?:pem|key|p12|pfx)$/i,
];
const SENSITIVE_MARKERS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)["']?\s*[:=]\s*["']?[A-Za-z0-9_./+\-=]{8,}/i,
  /\b(?:gh[opusr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{16,})\b/,
];

export interface LoadedFile {
  path: string;
  externalPath: string;
  content: string;
  truncated: boolean;
  bytes: number;
}

interface FileValidationHooks {
  afterRealpath?: () => Promise<void>;
}

function isOutsideWorkspace(workspace: string, path: string): boolean {
  const rel = relative(workspace, path);
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

export async function loadWorkspaceFile(
  cwd: string,
  candidate: string,
  maxBytes = MAX_FILE_BYTES,
  hooks: FileValidationHooks = {},
): Promise<LoadedFile> {
  if (!candidate || maxBytes < 1) {
    throw new Error("Invalid file input");
  }
  const workspace = await realpath(cwd);
  const requested = isAbsolute(candidate)
    ? candidate
    : resolve(workspace, candidate);
  let actual: string;
  try {
    actual = await realpath(requested);
  } catch {
    throw new Error("File is unavailable");
  }
  const rel = relative(workspace, actual);
  if (isOutsideWorkspace(workspace, actual)) {
    throw new Error("File is outside the current workspace");
  }
  const info = await stat(actual);
  if (!info.isFile()) {
    throw new Error("Path is not a regular file");
  }
  const filename = basename(actual).toLowerCase();
  if (
    SENSITIVE_NAMES.has(filename) ||
    SENSITIVE_NAME_PATTERNS.some((pattern) => pattern.test(filename))
  ) {
    throw new Error(
      "Blocked sensitive filename (secret detection is not complete)",
    );
  }
  if (info.size === 0) {
    throw new Error("File is empty");
  }

  await hooks.afterRealpath?.();

  // O_NOFOLLOW prevents a last-component symlink swap. Comparing the opened
  // descriptor with the contained file inspected above also prevents a
  // replaced parent directory from redirecting the open outside the workspace.
  // OS open flags are combined as a bitmask.
  const openFlags =
    // oxlint-disable-next-line no-bitwise -- OS API requires bitwise flags.
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const handle = await open(actual, openFlags);
  try {
    let currentPath: string;
    try {
      currentPath = await realpath(actual);
    } catch {
      throw new Error("File changed during validation");
    }
    if (isOutsideWorkspace(workspace, currentPath)) {
      throw new Error("File is outside the current workspace");
    }
    const openedInfo = await handle.stat();
    if (
      !openedInfo.isFile() ||
      openedInfo.dev !== info.dev ||
      openedInfo.ino !== info.ino
    ) {
      throw new Error("File changed during validation");
    }
    // At most three extra bytes can be needed to finish a UTF-8 code point
    // which begins before the content boundary.
    const buffer = Buffer.alloc(Math.min(info.size, maxBytes + 3));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const prefix = buffer.subarray(0, bytesRead);
    if (prefix.includes(0)) {
      throw new Error("File appears to be binary");
    }
    let content: string | undefined;
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const largest =
      info.size > maxBytes ? Math.min(bytesRead, maxBytes + 3) : bytesRead;
    for (let end = Math.min(maxBytes, bytesRead); end <= largest; end++) {
      try {
        content = decoder.decode(prefix.subarray(0, end));
        break;
      } catch {
        // Only additional bytes completing the boundary character may help.
      }
    }
    if (content === undefined) {
      throw new Error("File is not valid UTF-8 text");
    }
    if (SENSITIVE_MARKERS.some((marker) => marker.test(content))) {
      throw new Error(
        "Blocked sensitive marker (secret detection is not complete)",
      );
    }
    const truncated = info.size > maxBytes;
    return {
      path: candidate,
      externalPath: rel.split(sep).join("/"),
      content: truncated ? `${content}\n[truncated]` : content,
      truncated,
      bytes: info.size,
    };
  } finally {
    await handle.close();
  }
}
