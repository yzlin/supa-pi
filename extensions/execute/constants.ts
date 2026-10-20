export const EXECUTE_COMMAND_NAME = "execute";
export const EXECUTE_INVOCATION_PREAMBLE =
  "Use the `execute` skill behavior as canonical.\n\nThis explicit `/execute` invocation authorizes blocking `subagent` calls by the main session for one accepted plan in this session. Record the canonical plan and danger preflight/approval with `execute_checkpoint`, start assignments before delegation, and complete them only after independent main verification. Workers cannot manage the ledger. Use fresh children, disjoint parallel write scopes, and at most two mutation repairs per original lineage. Do not continue automatically after stop or reload.\n\nExecution invocation packet:";
export const EXECUTE_SYNTHESIS_MODE =
  "Synthesize a new Execution Brief from current session context, then execute it with blocking subagent calls if it is safe and unambiguous. Preserve attached images in main context; resolve their relevant task requirements before delegation because children receive only the task, not parent conversation or images.";
export const EXECUTE_SYNTHESIS_MESSAGE = `${EXECUTE_INVOCATION_PREAMBLE}
- Mode: ${EXECUTE_SYNTHESIS_MODE}`;
export const EXECUTE_DRAFT_MODE =
  "Draft a Spec, then execute it. First follow the `to-spec` skill to write `.pi/specs/<slug>.md` from current session context: derive the slug, apply its collision rules, and ask at most its one optional seam question. Then, without pausing for review, follow the `execute` skill on that Spec and pass its `specPath` on `accept`. Preserve attached images in main context; resolve their relevant task requirements before delegation because children receive only the task, not parent conversation or images.";
export const EXECUTE_DRAFT_MESSAGE = `${EXECUTE_INVOCATION_PREAMBLE}
- Mode: ${EXECUTE_DRAFT_MODE}`;
export const EXECUTE_DRAFT_SOURCE_LABEL =
  "- Source: use this latest fresh assistant Execution Brief as the Spec source material.";
export const SPEC_DRAFTED_ENTRY_TYPE = "execute-spec-drafted-v1";
export const EXECUTE_STALE_SPEC_TITLE =
  "Messages followed the drafted Spec. Run it or draft a new Spec?";
export const EXECUTE_USE_SPEC_LABEL = "Use ";
export const EXECUTE_DRAFT_NEW_SPEC_LABEL = "Draft a new Spec";
export const EXECUTE_CANCELLED_MESSAGE = "/execute cancelled";

export const TO_SPEC_COMMAND_NAME = "to-spec";
export const TO_SPEC_COMMAND_DESCRIPTION =
  "Persist the locked plan as a Spec, or show progress: /to-spec [slug] | /to-spec status [slug]";
export const TO_SPEC_INVOCATION_PREAMBLE =
  "Use the `to-spec` skill as canonical for this explicit command.";
export const TO_SPEC_SLUG_LABEL = "Slug: ";
export const TO_SPEC_DERIVE_SLUG = "derive one from the goal";
export const TO_SPEC_EXISTING_LABEL = "Existing unaccepted Spec: ";
export const TO_SPEC_OVERWRITE_NOTE =
  " — confirm overwrite with the user before writing.";
export const TO_SPEC_ACCEPTED_NOTE = "was already accepted; choose a new slug";
export const TO_SPEC_INVALID_SLUG =
  "Invalid Spec slug. Use 1–48 lowercase letters, digits or hyphens, starting with a letter or digit.";
export const TO_SPEC_QUEUED_MESSAGE = "Queued /to-spec as a follow-up";
export const SPEC_STATUS_MESSAGE_TYPE = "spec-status";
