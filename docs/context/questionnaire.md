# Questionnaire extension

Read when changing `extensions/questionnaire/*`, prompt guidance for user clarification, or README claims about the active Questionnaire Extension.

## Purpose

`questionnaire` is the active structured clarification tool for interactive Pi sessions. It replaces plain-text clarification questions with a bounded TUI picker so agents can collect the minimum user input needed and then continue the original task.

Do not use it from background or non-interactive contexts. The tool returns an error envelope when `ctx.hasUI` is false.

## Input schema

Tool parameters:

- `questions`: required array, 1-3 questions.
Each question:

- `id`: unique question identifier. Used in answers and `answersByQuestion`.
- `label`: optional short label for tabs and summaries. Defaults to `Q1`, `Q2`, etc.
- `prompt`: full prompt shown to the user.
- `options`: 2-5 options.
- `multiSelect`: optional boolean. When true, the question uses checkbox-style selection and a `Next` commit row.

Each option:

- `value`: returned value.
- `label`: visible label.
- `description`: optional muted helper text under the option.
- `preview`: optional preview content. When any option in the current question has preview content, the UI enables preview mode automatically.

Reserved values and labels are injected by the extension and cannot be supplied by callers:

- Values: `__other__`, `__next__`
- Labels: `Type something.`, `Next`

## Result union

Successful results are returned through `createQuestionnaireEnvelope` as both text content and structured `details`.

`details` contains:

- `questions`: normalized questions, including default labels.
- `answers`: answer union array.
- `cancelled`: false when submitted, true when cancelled or validation/UI errors occur.
- `summary`: text summary added for submitted answers.
- `answersByQuestion`: map keyed by question id, added for submitted answers.

Answer variants:

- Single-select option answer: `{ kind: "option", id, value, label, wasCustom: false, index, preview?, note? }`
- Custom answer: `{ kind: "custom", id, value, label, wasCustom: true, note? }`
- Multi-select answer: `{ kind: "multi", id, value: string[], label, wasCustom: false, multi: true, selectedOptions, note? }`

`index` is 1-based. `selectedOptions` contains original option fields, including `preview` when supplied, plus a 1-based `index`. `preview` is copied onto submitted single-select option answers only. `note` is available for preview-enabled single-select/custom answers; the UI does not expose note editing for multi-select questions.

Cancelled or invalid runs return text content plus `details.cancelled: true`; validation errors also include `details.error` with issue objects.

## Pieditor replacement lease integration

When the questionnaire opens its custom TUI through `ctx.ui.custom`, it loads `@yzlin/pieditor/replacement-surface-lease` and wraps that UI in pieditor's replacement-surface lease with owner `questionnaire` and id `custom-ui`. If the pieditor package is unavailable, questionnaire still opens normally without a lease.

Effects:

- The lease is acquired only after validation passes; validation errors return the cancelled error envelope without opening UI.
- The lease releases after submit, cancellation, or thrown custom UI errors.
- While active, pieditor fixed editor mode stands down: it does not reserve or repaint the fixed editor cluster, draw the root scrollbar, or consume fixed-editor scroll/mouse/selection input.
- Diagnostics are visible through `/pieditor fixed-editor status` as `replacement leases: 1 (questionnaire)` while the questionnaire UI is open.

## Keyboard behavior

Base single-question behavior:

- `↑` / `↓` or `k` / `j`: move option cursor.
- `Enter` or `Space`: select current row.
- `Esc`: cancel.
- Selecting `Type something.` opens editor input; `Enter` submits non-empty custom text and `Esc` exits input. Empty custom text is rejected and keeps the editor open.

Multiple questions:

- `Tab` / `→` / `l`: next tab.
- `Shift+Tab` / `←` / `h`: previous tab.
- After each single-select answer, focus advances to the next question or review tab.
- Review tab lists submitted answers by question label. Multi-select answers show their comma-separated selected labels, or `(none)` for an empty commit.
- Review tab requires all questions answered before `Submit` can complete and shows an `Unanswered:` warning for missing labels. `Cancel` is always available.

Multi-select questions:

- `Space` / `Enter`: toggle selected option.
- `Next`: commits the current selected set, including an empty set if none are selected.
- Multi-select omits the custom-answer row.

Preview mode:

- Enables automatically for the current question when any option has `preview` content, including multi-select questions.
- Wide layouts render option titles in the left column and one active preview pane in the right column. The preview pane follows the highlighted row only; inactive option previews are not rendered.
- Single-select custom rows show `Custom answer preview will appear after you type it.` while highlighted.
- Rows without preview content show `No preview available.` in the active preview pane.
- Narrow layouts that cannot satisfy the preview column minimums render only the option list; they omit the active preview pane instead of stacking it below the options.
- Questionnaire-provided display text strips terminal control sequences before rendering.
- A preview wrapped in one outer fenced code block renders the fence contents without the surrounding backtick fence.
- Multi-select preview mode supports highlighted-option previews while retaining checkbox toggles and the `Next` commit row. The `Next` row has no preview unless the injected row is highlighted, in which case the pane shows `No preview available.`
- `n`: edit a preview note for the current single-select question.
- In note editor, `Enter` saves the note and `Esc` cancels note editing.

## Validation

`validateQuestionnaireParams` rejects:

- Question count outside 1-3.
- Option count outside 2-5.
- Duplicate question ids.
- Duplicate option values within a question.
- Duplicate option labels within a question.
- Reserved option values or labels.

Multi-select questions may include option previews. They still omit the custom-answer row and preview note editing.

Validation failures return a cancelled error envelope and do not open UI.

## Intentional divergences from rpiv

This extension is locally maintained for Pi and is not a drop-in rpiv clone.

Intentional differences:

- Uses Pi `registerTool` and `ctx.ui.custom` instead of an rpiv runtime boundary.
- Keeps answers as a discriminated TypeScript union with Pi tool `details`, including `answersByQuestion` for easier agent consumption.
- Injects reserved `Type something.` and `Next` rows rather than requiring callers to model those options.
- Supports up to 3 questions and 5 options per question to keep clarification small and decision-oriented.
- Provides an explicit review tab for multi-question flows before final submission.
- Allows empty multi-select commits instead of forcing at least one selected option.
- Preview mode is activated by option preview content and supports both single-select and multi-select questions, but only the active option preview is rendered.
- Preview notes remain single-select only to keep multi-select result semantics clear.
- Logs and auto-redirects likely plain-text clarification misses within an interactive session.
