const CONTEXT_MAP_SIGNAL_PATTERNS = [
  /\bcontext[- ]?map\b/i,
  /\bboundar(?:y|ies)\b/i,
  /\bowns?\b/i,
  /\bdepends on\b/i,
  /\bcoordinates? with\b/i,
  /\bentry point\b/i,
  /\b(do not|don't) cross\b/i,
];

const WEAK_ADR_DECISION_PATTERNS = [
  /\badr\b/i,
  /\bdecision\b/i,
  /\bdecided\b/i,
];

const ADR_RATIONALE_PATTERNS = [
  /\bbecause\b/i,
  /\brationale\b/i,
  /\btrade[- ]?off\b/i,
  /\bconsequence\b/i,
  /\bstatus\b/i,
];

const REJECTED_NOTE_PATTERNS = [
  /\breject(?:ed)?\b/i,
  /\bdo not document\b/i,
  /\bno docs?\b/i,
  /\bnot worth documenting\b/i,
];

const ADR_SIGNAL_PATTERNS = [
  /\badr\b/i,
  /\barchitecture decision\b/i,
  /\bwe decided\b/i,
  /\bdecision:\b/i,
];

const AGENT_CONVENTION_PATTERNS = [
  /\bagent convention\b/i,
  /\bagents\.md\b/i,
  /\bagents? must\b/i,
  /\bwhen agents?\b/i,
];

const PROJECT_CONVENTION_PATTERNS = [
  /\bbun\b.*\b(package manager|instead of npm|not npm|bun install|bun test)\b/i,
  /\b(package manager|instead of npm|not npm)\b.*\bbun\b/i,
];

const DOMAIN_TERM_PATTERNS = [
  /\bdomain term\b/i,
  /\bglossary\b/i,
  /\bwe call\b/i,
  /\bmeans\b/i,
  /\bis called\b/i,
];
export type ContextDocKind =
  | "adr"
  | "agent-convention"
  | "context-map"
  | "domain-term"
  | "project-convention";

export type ClassificationResult =
  | {
      accepted: true;
      kind: ContextDocKind;
      confidence: "high" | "medium";
      reason: string;
    }
  | {
      accepted: false;
      reason: string;
      challenge?: string;
    };

const CONTEXT_MAP_BOUNDARY_THRESHOLD = 3;

function hasAny(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function countBoundarySignals(text: string): number {
  return CONTEXT_MAP_SIGNAL_PATTERNS.filter((signal) => signal.test(text))
    .length;
}

export function reachesContextMapThreshold(
  text: string,
  threshold = CONTEXT_MAP_BOUNDARY_THRESHOLD
): boolean {
  return countBoundarySignals(text) >= threshold;
}

function isWeakAdr(text: string): boolean {
  const hasDecision = hasAny(text, WEAK_ADR_DECISION_PATTERNS);
  const hasRationale = hasAny(text, ADR_RATIONALE_PATTERNS);

  return hasDecision && !hasRationale;
}

export function classifyContextDocNote(note: string): ClassificationResult {
  const text = note.trim();
  if (!text) {
    return { accepted: false, reason: "empty note" };
  }

  if (hasAny(text, REJECTED_NOTE_PATTERNS)) {
    return { accepted: false, reason: "explicitly rejected" };
  }

  if (isWeakAdr(text)) {
    return {
      accepted: false,
      reason: "weak adr",
      challenge:
        "ADR notes need a decision plus rationale, trade-offs, or consequences before writing docs.",
    };
  }

  if (hasAny(text, ADR_SIGNAL_PATTERNS)) {
    return {
      accepted: true,
      kind: "adr",
      confidence: "high",
      reason: "architecture decision signal",
    };
  }

  if (hasAny(text, AGENT_CONVENTION_PATTERNS)) {
    return {
      accepted: true,
      kind: "agent-convention",
      confidence: "high",
      reason: "agent convention signal",
    };
  }

  if (reachesContextMapThreshold(text)) {
    return {
      accepted: true,
      kind: "context-map",
      confidence: "high",
      reason: "context boundary threshold reached",
    };
  }

  if (hasAny(text, PROJECT_CONVENTION_PATTERNS)) {
    return {
      accepted: true,
      kind: "project-convention",
      confidence: "high",
      reason: "package manager convention",
    };
  }

  if (hasAny(text, DOMAIN_TERM_PATTERNS)) {
    return {
      accepted: true,
      kind: "domain-term",
      confidence: "medium",
      reason: "domain vocabulary signal",
    };
  }

  return { accepted: false, reason: "no durable docs signal" };
}
