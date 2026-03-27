import { DEFAULT_PI_RTK_CONFIG } from "./config";
import { createPiRtkMetricsStore } from "./metrics";
import { checkRtkAvailability } from "./rewrite";
import type { PiRtkConfig, PiRtkRuntime, PiRtkRuntimeStatus } from "./types";

function cloneConfig(config: PiRtkConfig): PiRtkConfig {
  return structuredClone(config);
}

function cloneStatus(status: PiRtkRuntimeStatus): PiRtkRuntimeStatus {
  return { ...status };
}

export function createPiRtkRuntime(
  initialConfig: PiRtkConfig = DEFAULT_PI_RTK_CONFIG
): PiRtkRuntime {
  let config = cloneConfig(initialConfig);
  let status: PiRtkRuntimeStatus = { rtkAvailable: false };
  const metrics = createPiRtkMetricsStore();

  return {
    getConfig() {
      return cloneConfig(config);
    },

    setConfig(nextConfig) {
      config = cloneConfig(nextConfig);
    },

    getStatus() {
      return cloneStatus(status);
    },

    setStatus(nextStatus) {
      status = cloneStatus(nextStatus);
    },

    refreshRtkStatus() {
      status = checkRtkAvailability();
      return cloneStatus(status);
    },

    resetSessionState() {
      metrics.reset();
    },

    metrics,
  };
}
