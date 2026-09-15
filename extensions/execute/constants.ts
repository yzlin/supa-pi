export const EXECUTE_COMMAND_NAME = "execute";
export const EXECUTE_INVOCATION_PREAMBLE =
  "Use the `execute` skill behavior as canonical.\n\nThis explicit `/execute` invocation authorizes the main session to call `SubagentWorkflow` for the plan below.\n\nExecution invocation packet:";
export const EXECUTE_SYNTHESIS_MODE =
  "Synthesize a new Execution Brief from current session context, then execute it with the native SubagentWorkflow if it is safe and unambiguous.";
export const EXECUTE_SYNTHESIS_MESSAGE = `${EXECUTE_INVOCATION_PREAMBLE}
- Mode: ${EXECUTE_SYNTHESIS_MODE}`;
