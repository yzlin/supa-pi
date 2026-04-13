import { DEFAULT_RTK_CONFIG } from "./config";
import { createRtkMetricsStore } from "./metrics";
import { checkRtkAvailability } from "./rewrite";
import type { RtkConfig, RtkRuntime, RtkRuntimeStatus } from "./types";

function cloneConfig(config: RtkConfig): RtkConfig {
  return structuredClone(config);
}

function cloneStatus(status: RtkRuntimeStatus): RtkRuntimeStatus {
  return { ...status };
}

export function createRtkRuntime(
  initialConfig: RtkConfig = DEFAULT_RTK_CONFIG
): RtkRuntime {
  let config = cloneConfig(initialConfig);
  let status: RtkRuntimeStatus = { rtkAvailable: false };
  const metrics = createRtkMetricsStore();

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
