export const EXECUTE_COMMAND_NAME = "execute";
export const EXECUTE_INVOCATION_PREAMBLE =
  "Use the `execute` skill behavior as canonical.\n\nExecute invocation packet:";
export const EXECUTE_SYNTHESIS_MODE =
  "Synthesize a new Execution Brief from current session context, then execute it in this same run if safe and unambiguous.";
export const EXECUTE_SYNTHESIS_MESSAGE = `${EXECUTE_INVOCATION_PREAMBLE}
- Mode: ${EXECUTE_SYNTHESIS_MODE}`;
