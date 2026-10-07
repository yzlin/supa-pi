export const EXECUTE_COMMAND_NAME = "execute";
export const EXECUTE_INVOCATION_PREAMBLE =
  "Use the `execute` skill behavior as canonical.\n\nThis explicit `/execute` invocation authorizes blocking `subagent` calls by the main session for one accepted plan in this session. Record the canonical plan and danger preflight/approval with `execute_checkpoint`, start assignments before delegation, and complete them only after independent main verification. Workers cannot manage the ledger. Use fresh children, disjoint parallel write scopes, and at most two mutation repairs per original lineage. Do not continue automatically after stop or reload.\n\nExecution invocation packet:";
export const EXECUTE_SYNTHESIS_MODE =
  "Synthesize a new Execution Brief from current session context, then execute it with blocking subagent calls if it is safe and unambiguous. Preserve attached images in main context; resolve their relevant task requirements before delegation because children receive only the task, not parent conversation or images.";
export const EXECUTE_SYNTHESIS_MESSAGE = `${EXECUTE_INVOCATION_PREAMBLE}
- Mode: ${EXECUTE_SYNTHESIS_MODE}`;
