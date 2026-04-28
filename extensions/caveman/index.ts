import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { registerCavemanMode } from "./caveman-mode.js";

export default function (pi: ExtensionAPI): void {
  registerCavemanMode(pi);
}
