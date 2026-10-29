import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { showAskDialog } from "../shared/ask-ui/dialog";
import { CUSTOM_OPTION_LABEL, type Question } from "../shared/ask-ui/types";

export interface ReviewPrompt {
  title: string;
  options: string[];
  // Adds a final free-text row; only reviewer questions allow it.
  custom?: boolean;
}

// Asks every prompt in order and returns one answer per prompt, or undefined
// when the user cancels. The review text is not repeated here: it is already
// in the transcript as a spec-review message.
export async function askReview(
  ctx: ExtensionContext,
  prompts: ReviewPrompt[],
  signal?: AbortSignal,
): Promise<string[] | undefined> {
  if (ctx.mode === "tui") {
    const questions: Question[] = prompts.map((prompt, index) => ({
      id: `q${index}`,
      label: index === prompts.length - 1 ? "Decision" : `Q${index + 1}`,
      prompt: prompt.title,
      options: prompt.options.map((option) => ({
        value: option,
        label: option,
      })),
      custom: prompt.custom === true,
    }));
    const result = await showAskDialog(ctx.ui, questions, signal);
    // Undefined: the host cannot show custom UI; fall back to select.
    if (result !== undefined) {
      if (result.cancelled) {
        return undefined;
      }
      const answers: string[] = [];
      for (const question of questions) {
        const answer = result.answers.find((item) => item.id === question.id);
        if (answer?.kind !== "option" && answer?.kind !== "custom") {
          return undefined;
        }
        answers.push(answer.value);
      }
      return answers;
    }
  }
  const answers: string[] = [];
  for (const prompt of prompts) {
    const rows = prompt.custom
      ? [...prompt.options, CUSTOM_OPTION_LABEL]
      : prompt.options;
    let answer = await ctx.ui.select(prompt.title, rows, { signal });
    if (
      answer === CUSTOM_OPTION_LABEL &&
      prompt.custom &&
      !prompt.options.includes(answer)
    ) {
      answer = (await ctx.ui.input(prompt.title, "", { signal }))?.trim();
    }
    if (!answer) {
      return undefined;
    }
    answers.push(answer);
  }
  return answers;
}
