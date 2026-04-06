export const OM_EXTENSION_NAME = "om";
export const OM_STATE_CUSTOM_TYPE = "om-state";
export const OM_OBSERVATION_BUFFER_CUSTOM_TYPE = "om-observation-buffer";
export const OM_REFLECTION_BUFFER_CUSTOM_TYPE = "om-reflection-buffer";
export const OM_STATE_VERSION = 1 as const;
export const OM_PROMPT_VERSION = "om/v1";
export const OM_CONTINUATION_MAX_LENGTH = 240;

export const OM_OBSERVATION_KINDS = [
  "fact",
  "thread",
  "decision",
  "risk",
  "preference",
] as const;

export const OM_THREAD_STATUSES = [
  "active",
  "blocked",
  "waiting",
  "done",
] as const;
