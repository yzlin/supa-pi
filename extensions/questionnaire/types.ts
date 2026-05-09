export const CUSTOM_OPTION_VALUE = "__other__";
export const CUSTOM_OPTION_LABEL = "Type something.";
export const NEXT_OPTION_VALUE = "__next__";
export const NEXT_OPTION_LABEL = "Next";
export const QUESTIONNAIRE_RESERVED_VALUES = [
  CUSTOM_OPTION_VALUE,
  NEXT_OPTION_VALUE,
] as const;
export const QUESTIONNAIRE_RESERVED_LABELS = [
  CUSTOM_OPTION_LABEL,
  NEXT_OPTION_LABEL,
] as const;

export interface QuestionOption {
  value: string;
  label: string;
  description?: string;
  preview?: string;
}

export type RenderOption = QuestionOption & {
  isNext?: boolean;
  isOther?: boolean;
};

export interface QuestionInput {
  id: string;
  label?: string;
  prompt: string;
  options: QuestionOption[];
  multiSelect?: boolean;
}

export interface Question extends QuestionInput {
  label: string;
}

export type Answer =
  | {
      kind: "option";
      id: string;
      value: string;
      label: string;
      wasCustom: false;
      index: number;
      preview?: string;
      note?: string;
    }
  | {
      kind: "custom";
      id: string;
      value: string;
      label: string;
      wasCustom: true;
      note?: string;
    }
  | {
      kind: "multi";
      id: string;
      value: string[];
      label: string;
      wasCustom: false;
      multi: true;
      selectedOptions: Array<QuestionOption & { index: number }>;
      note?: string;
    };

export interface QuestionnaireResult {
  questions: Question[];
  answers: Answer[];
  cancelled: boolean;
  summary?: string;
  answersByQuestion?: Record<string, Answer>;
}

export interface QuestionnaireValidationIssue {
  path: string;
  code:
    | "question_count"
    | "option_count"
    | "duplicate_question_id"
    | "duplicate_option_value"
    | "duplicate_option_label"
    | "reserved_option_value"
    | "reserved_option_label"
    | "preview_multi_select";
  message: string;
}

export interface QuestionnaireValidationErrorDetails {
  valid: false;
  issues: QuestionnaireValidationIssue[];
}

export interface QuestionnaireParamsInput {
  questions?: QuestionInput[];
}
