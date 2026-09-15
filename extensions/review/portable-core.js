export const runPortableReviewCore = (operation, input) => {
  const PRIORITIES = new Set(["P0", "P1", "P2", "P3"]);
  const VERDICTS = new Set(["correct", "needs attention"]);
  const VERIFIER_CONFIDENCE_VALUES = new Set(["high", "medium", "low"]);
  const REVIEWERS = new Set([
    "code-reviewer",
    "security-reviewer",
    "database-reviewer",
    "performance-reviewer",
  ]);

  function isObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  function hasOnlyKeys(value, allowedKeys) {
    const allowed = new Set(allowedKeys);
    return Object.keys(value).every((key) => allowed.has(key));
  }

  function isStringArray(value) {
    return (
      Array.isArray(value) && value.every((item) => typeof item === "string")
    );
  }

  function isReviewerAgent(value) {
    return typeof value === "string" && REVIEWERS.has(value);
  }

  function isVerdict(value) {
    return typeof value === "string" && VERDICTS.has(value);
  }

  function isPriority(value) {
    return typeof value === "string" && PRIORITIES.has(value);
  }

  function isVerifierConfidence(value) {
    return typeof value === "string" && VERIFIER_CONFIDENCE_VALUES.has(value);
  }

  function getValidationError(result) {
    return isObject(result) && typeof result.error === "string"
      ? result.error
      : "unknown error";
  }

  function validateFinding(value, rejectUnknownFields) {
    if (!isObject(value)) {
      return { ok: false, error: "finding must be an object." };
    }
    if (
      rejectUnknownFields &&
      !hasOnlyKeys(value, [
        "priority",
        "title",
        "file",
        "line",
        "why",
        "change",
      ])
    ) {
      return { ok: false, error: "finding has unknown fields." };
    }
    if (!isPriority(value.priority)) {
      return { ok: false, error: "finding priority is invalid." };
    }
    const fields = [
      ["title", value.title],
      ["file", value.file],
      ["why", value.why],
      ["change", value.change],
    ];
    for (const [field, fieldValue] of fields) {
      if (typeof fieldValue !== "string" || !fieldValue.trim()) {
        return {
          ok: false,
          error: `finding.${field} must be a non-empty string.`,
        };
      }
    }
    if (
      typeof value.line !== "number" ||
      !Number.isInteger(value.line) ||
      value.line < 1
    ) {
      return { ok: false, error: "finding.line must be a positive integer." };
    }
    return {
      ok: true,
      value: {
        priority: value.priority,
        title: value.title.trim(),
        file: value.file.trim(),
        line: value.line,
        why: value.why.trim(),
        change: value.change.trim(),
      },
    };
  }

  function validateFindings(value) {
    if (!Array.isArray(value)) {
      return { ok: false, error: "findings must be an array." };
    }
    const findings = [];
    for (const finding of value) {
      const validated = validateFinding(finding, true);
      if (!validated.ok) {
        return { ok: false, error: getValidationError(validated) };
      }
      findings.push(validated.value);
    }
    return { ok: true, value: findings };
  }

  function validateReviewer(value) {
    if (!isObject(value)) {
      return { ok: false, error: "Reviewer output must be an object." };
    }
    if (
      !hasOnlyKeys(value, [
        "reviewer",
        "verdict",
        "findings",
        "humanReviewerCallouts",
        "notes",
      ])
    ) {
      return { ok: false, error: "Reviewer output has unknown fields." };
    }
    if (!isReviewerAgent(value.reviewer)) {
      return { ok: false, error: "Reviewer output has invalid reviewer." };
    }
    if (!isVerdict(value.verdict)) {
      return { ok: false, error: "Reviewer output has invalid verdict." };
    }
    const findings = validateFindings(value.findings);
    if (!findings.ok) {
      return { ok: false, error: getValidationError(findings) };
    }
    if (!isStringArray(value.humanReviewerCallouts)) {
      return {
        ok: false,
        error: "Reviewer output humanReviewerCallouts must be string[].",
      };
    }
    if (value.notes !== undefined && !isStringArray(value.notes)) {
      return { ok: false, error: "Reviewer output notes must be string[]." };
    }
    return {
      ok: true,
      value: {
        reviewer: value.reviewer,
        verdict: value.verdict,
        findings: findings.value,
        humanReviewerCallouts: value.humanReviewerCallouts,
        notes: value.notes,
      },
    };
  }

  function normalizeText(value) {
    return value.trim().replace(/\s+/g, " ").toLowerCase();
  }

  function collectHumanReviewerCallouts(reviewerOutputs) {
    const callouts = [];
    const seen = new Set();
    for (const output of reviewerOutputs) {
      for (const callout of output.humanReviewerCallouts) {
        const normalized = normalizeText(callout);
        if (!normalized || seen.has(normalized)) {
          continue;
        }
        seen.add(normalized);
        callouts.push(callout.trim());
      }
    }
    return callouts;
  }

  function buildReviewerCoverage(reviewers) {
    const selected = new Set(reviewers);
    return {
      "code-reviewer": selected.has("code-reviewer") ? "used" : "not used",
      "security-reviewer": selected.has("security-reviewer")
        ? "used"
        : "not used",
      "database-reviewer": selected.has("database-reviewer")
        ? "used"
        : "not used",
      "performance-reviewer": selected.has("performance-reviewer")
        ? "used"
        : "not used",
    };
  }

  function buildCorrectReviewResult(workflowInput, args) {
    return {
      reviewScope: [workflowInput.scopeHint.trim() || "reviewed scope"],
      verdict: "correct",
      findings: [],
      humanReviewerCallouts: args.humanReviewerCallouts,
      reviewerCoverage: args.reviewerCoverage,
    };
  }

  function buildCandidateFindings(runs) {
    const candidates = [];
    for (const run of runs) {
      if (run.status !== "succeeded" || !run.output) {
        continue;
      }
      for (const finding of run.output.findings) {
        candidates.push({
          ...finding,
          candidateId: `candidate-${String(candidates.length + 1).padStart(4, "0")}`,
          reviewer: run.reviewer,
          model: run.model,
          thinkingLevel: run.thinkingLevel,
        });
      }
    }
    return candidates;
  }

  function distinctLocations(candidates) {
    const seen = new Set();
    return candidates.flatMap((candidate) => {
      const key = `${candidate.file}\0${candidate.line}`;
      if (seen.has(key)) {
        return [];
      }
      seen.add(key);
      return [{ file: candidate.file, line: candidate.line }];
    });
  }

  function parseSynthesizer(value, candidates) {
    if (
      !(
        isObject(value) &&
        hasOnlyKeys(value, ["clusters"]) &&
        Array.isArray(value.clusters)
      )
    ) {
      return {
        ok: false,
        error: "Synthesizer output must contain only a clusters array.",
      };
    }
    const knownIds = new Set(
      candidates.map((candidate) => candidate.candidateId)
    );
    const usedIds = new Set();
    const byId = new Map(
      candidates.map((candidate) => [candidate.candidateId, candidate])
    );
    const clusters = [];
    for (const raw of value.clusters) {
      if (
        !(
          isObject(raw) &&
          hasOnlyKeys(raw, ["memberIds", "title", "why", "change"]) &&
          isStringArray(raw.memberIds)
        ) ||
        raw.memberIds.length === 0
      ) {
        return { ok: false, error: "Synthesizer cluster has invalid fields." };
      }
      for (const field of ["title", "why", "change"]) {
        if (typeof raw[field] !== "string" || !raw[field].trim()) {
          return {
            ok: false,
            error: `Synthesizer cluster ${field} must be non-empty.`,
          };
        }
      }
      for (const id of raw.memberIds) {
        if (!knownIds.has(id)) {
          return {
            ok: false,
            error: `Synthesizer used unknown candidate ID '${id}'.`,
          };
        }
        if (usedIds.has(id)) {
          return {
            ok: false,
            error: `Synthesizer repeated candidate ID '${id}'.`,
          };
        }
        usedIds.add(id);
      }
      const members = raw.memberIds.map((id) => byId.get(id));
      clusters.push({
        clusterId: `cluster-${String(clusters.length + 1).padStart(4, "0")}`,
        memberIds: raw.memberIds,
        title: raw.title.trim(),
        why: raw.why.trim(),
        change: raw.change.trim(),
        reportedPriorities: members.map((member) => member.priority),
        locations: distinctLocations(members),
      });
    }
    if (usedIds.size !== knownIds.size) {
      const missing = [...knownIds].filter((id) => !usedIds.has(id));
      return {
        ok: false,
        error: `Synthesizer omitted candidate IDs: ${missing.join(", ")}.`,
      };
    }
    return { ok: true, value: clusters };
  }

  function validateVerifier(value, candidateFindings) {
    if (
      !(
        isObject(value) &&
        hasOnlyKeys(value, ["reviewScope", "verdict", "findings"])
      )
    ) {
      return { ok: false, error: "Verifier output must be a closed object." };
    }
    if (
      !(
        isStringArray(value.reviewScope) &&
        isVerdict(value.verdict) &&
        Array.isArray(value.findings)
      )
    ) {
      return {
        ok: false,
        error: "Verifier output has invalid top-level fields.",
      };
    }
    const knownIds = new Set(
      candidateFindings.map((candidate) => candidate.candidateId)
    );
    const usedIds = new Set();
    const findings = [];
    for (const raw of value.findings) {
      if (
        !(
          isObject(raw) &&
          hasOnlyKeys(raw, [
            "memberIds",
            "priority",
            "title",
            "why",
            "change",
            "confidence",
            "reason",
            "consensusEffect",
          ])
        )
      ) {
        return {
          ok: false,
          error: "Verifier finding must be a closed object.",
        };
      }
      if (
        !isStringArray(raw.memberIds) ||
        raw.memberIds.length === 0 ||
        !isPriority(raw.priority) ||
        !isVerifierConfidence(raw.confidence) ||
        (raw.consensusEffect !== "none" &&
          raw.consensusEffect !== "raised-one-level")
      ) {
        return {
          ok: false,
          error: "Verifier finding has invalid typed fields.",
        };
      }
      for (const field of ["title", "why", "change", "reason"]) {
        if (typeof raw[field] !== "string" || !raw[field].trim()) {
          return {
            ok: false,
            error: `Verifier finding ${field} must be non-empty.`,
          };
        }
      }
      for (const id of raw.memberIds) {
        if (!knownIds.has(id)) {
          return {
            ok: false,
            error: `Verifier used unknown member ID '${id}'.`,
          };
        }
        if (usedIds.has(id)) {
          return { ok: false, error: `Verifier repeated member ID '${id}'.` };
        }
        usedIds.add(id);
      }
      if (
        raw.consensusEffect === "raised-one-level" &&
        new Set(
          raw.memberIds.map(
            (id) =>
              candidateFindings.find(
                (candidate) => candidate.candidateId === id
              ).model
          )
        ).size < 2
      ) {
        return {
          ok: false,
          error:
            "Verifier consensusEffect raised-one-level requires support from at least two distinct model IDs.",
        };
      }
      findings.push({
        memberIds: raw.memberIds,
        priority: raw.priority,
        title: raw.title.trim(),
        why: raw.why.trim(),
        change: raw.change.trim(),
        confidence: raw.confidence,
        reason: raw.reason.trim(),
        consensusEffect: raw.consensusEffect,
      });
    }
    return {
      ok: true,
      value: {
        reviewScope: value.reviewScope,
        verdict: value.verdict,
        findings,
      },
    };
  }

  function applyDeterministicReportFields(
    verifier,
    candidateFindings,
    coverage,
    deterministicReportFields
  ) {
    const byId = new Map(
      candidateFindings.map((candidate) => [candidate.candidateId, candidate])
    );
    const findings = verifier.findings.map((finding) => {
      const members = finding.memberIds.map((id) => byId.get(id));
      const locations = distinctLocations(members);
      const supportingModels = [
        ...new Set(members.map((member) => member.model)),
      ];
      const representedRoles = new Set(
        members.map((member) => member.reviewer)
      );
      const eligibleModels = [
        ...new Set(
          coverage.runs
            .filter(
              (run) =>
                run.status === "succeeded" && representedRoles.has(run.reviewer)
            )
            .map((run) => run.model)
        ),
      ];
      const modelReviewerRoles = Object.fromEntries(
        supportingModels.map((model) => [
          model,
          [
            ...new Set(
              members
                .filter((member) => member.model === model)
                .map((member) => member.reviewer)
            ),
          ],
        ])
      );
      const first = members[0];
      return {
        ...finding,
        file: locations[0].file,
        line: locations[0].line,
        sourceReviewer: first.reviewer,
        locations,
        supportingModels,
        modelReviewerRoles,
        eligibleModels,
        supportCount: supportingModels.length,
        eligibleModelCount: eligibleModels.length,
      };
    });
    findings.sort(
      (left, right) =>
        Number(left.priority.slice(1)) - Number(right.priority.slice(1)) ||
        (right.supportCount || 0) - (left.supportCount || 0)
    );
    return {
      reviewScope: verifier.reviewScope,
      verdict: findings.length ? "needs attention" : "correct",
      findings,
      humanReviewerCallouts: deterministicReportFields.humanReviewerCallouts,
      reviewerCoverage: deterministicReportFields.reviewerCoverage,
    };
  }

  switch (operation) {
    case "validateFinding":
      return validateFinding(input.value, input.rejectUnknownFields !== false);
    case "validateFindings":
      return validateFindings(input.value);
    case "validateReviewer":
      return validateReviewer(input.value);
    case "collectHumanReviewerCallouts":
      return collectHumanReviewerCallouts(input.reviewerOutputs);
    case "buildReviewerCoverage":
      return buildReviewerCoverage(input.reviewers);
    case "buildCorrectReviewResult":
      return buildCorrectReviewResult(input.workflowInput, input.args);
    case "buildCandidateFindings":
      return buildCandidateFindings(input.runs);
    case "distinctLocations":
      return distinctLocations(input.candidates);
    case "parseSynthesizer":
      return parseSynthesizer(input.value, input.candidates);
    case "validateVerifier":
      return validateVerifier(input.value, input.candidateFindings || []);
    case "applyDeterministicReportFields":
      return applyDeterministicReportFields(
        input.verifier,
        input.candidateFindings,
        input.coverage,
        input.deterministicReportFields
      );
    default:
      throw new Error(`Unknown portable review core operation '${operation}'.`);
  }
};

export const validatePortableFinding = (value, rejectUnknownFields = true) =>
  runPortableReviewCore("validateFinding", { value, rejectUnknownFields });
export const validatePortableFindings = (value) =>
  runPortableReviewCore("validateFindings", { value });
export const validatePortableReviewer = (value) =>
  runPortableReviewCore("validateReviewer", { value });
export const collectPortableHumanReviewerCallouts = (reviewerOutputs) =>
  runPortableReviewCore("collectHumanReviewerCallouts", { reviewerOutputs });
export const buildPortableReviewerCoverage = (reviewers) =>
  runPortableReviewCore("buildReviewerCoverage", { reviewers });
export const buildPortableCorrectReviewResult = (workflowInput, args) =>
  runPortableReviewCore("buildCorrectReviewResult", { workflowInput, args });
export const buildPortableCandidateFindings = (runs) =>
  runPortableReviewCore("buildCandidateFindings", { runs });
export const distinctPortableLocations = (candidates) =>
  runPortableReviewCore("distinctLocations", { candidates });
export const parsePortableSynthesizerOutput = (value, candidates) =>
  runPortableReviewCore("parseSynthesizer", { value, candidates });
export const validatePortableVerifier = (value, candidateFindings) =>
  runPortableReviewCore("validateVerifier", { value, candidateFindings });
export const applyPortableDeterministicReportFields = (
  verifier,
  candidateFindings,
  coverage,
  deterministicReportFields
) =>
  runPortableReviewCore("applyDeterministicReportFields", {
    verifier,
    candidateFindings,
    coverage,
    deterministicReportFields,
  });
