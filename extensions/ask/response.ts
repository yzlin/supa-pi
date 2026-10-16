import type { Answer, AskResult, Question } from "./types";

function createAnswerSummary(questions: Question[], answers: Answer[]): string {
  return answers
    .map((answer) => {
      const qLabel =
        questions.find((question) => question.id === answer.id)?.label ||
        answer.id;
      const note = answer.note ? ` Note: ${answer.note}` : "";
      if (answer.kind === "custom") {
        return `${qLabel}: user wrote: ${answer.label}${note}`;
      }
      if (answer.kind === "multi") {
        const selected = answer.selectedOptions
          .map((option) => `${option.index}. ${option.label}`)
          .join(", ");
        return `${qLabel}: user selected: ${selected || "(none)"}`;
      }
      const preview = answer.preview ? ` Preview: ${answer.preview}` : "";
      return `${qLabel}: user selected: ${answer.index}. ${answer.label}${preview}${note}`;
    })
    .join("\n");
}

export function createAskEnvelope(result: AskResult): {
  content: { type: "text"; text: string }[];
  details: AskResult;
} {
  if (result.cancelled) {
    return {
      content: [{ type: "text", text: "User cancelled the ask" }],
      details: result,
    };
  }

  const summary = createAnswerSummary(result.questions, result.answers);
  // Free text can be a meta-question ("elaborate more"). A conditional nudge was
  // not enough: models answered only in hidden reasoning and re-asked at once.
  const customLabels = result.answers
    .filter((answer) => answer.kind === "custom")
    .map(
      (answer) =>
        result.questions.find((question) => question.id === answer.id)?.label ||
        answer.id,
    );
  const closing = customLabels.length
    ? `Free-text replies (${customLabels.join(", ")}) may be questions or requests for clarification rather than answers. Reply to them in visible text to the user first; do not re-ask those questions before the user has seen your reply.`
    : "You can now continue with the user's answers in mind.";
  const text = `User has answered your questions:\n${summary}\n\n${closing}`;
  return {
    content: [{ type: "text", text }],
    details: {
      ...result,
      summary,
      answersByQuestion: Object.fromEntries(
        result.answers.map((answer) => [answer.id, answer]),
      ),
    },
  };
}
