import type { Answer, Question, QuestionnaireResult } from "./types";

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

export function createQuestionnaireEnvelope(result: QuestionnaireResult): {
  content: { type: "text"; text: string }[];
  details: QuestionnaireResult;
} {
  if (result.cancelled) {
    return {
      content: [{ type: "text", text: "User cancelled the questionnaire" }],
      details: result,
    };
  }

  const summary = createAnswerSummary(result.questions, result.answers);
  const text = `User has answered your questions:\n${summary}\n\nYou can now continue with the user's answers in mind.`;
  return {
    content: [{ type: "text", text }],
    details: {
      ...result,
      summary,
      answersByQuestion: Object.fromEntries(
        result.answers.map((answer) => [answer.id, answer])
      ),
    },
  };
}
