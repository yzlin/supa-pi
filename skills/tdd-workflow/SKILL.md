---
name: tdd-workflow
description: Canonical test-driven methodology for behavior changes and bug fixes.
origin: ECC
---

# Test-Driven Development Workflow

Use this workflow for every behavior change and bug fix, whether the work is direct or delegated. Documentation-only, configuration-only, generated, and purely mechanical changes are outside this workflow unless they change behavior.

## Build and diagnostic safeguards

For a build, compilation, type, module-resolution, dependency, or build-configuration failure:

- Reproduce the exact failing repository command before editing and capture the complete diagnostics.
- Separate primary root-cause diagnostics from cascades; inspect the cited source, configuration, imports, dependencies, and generated inputs before changing code.
- Apply the smallest behavior-preserving root-cause fix. Do not redesign, optimize, rename, or refactor unrelated code.
- Prefer correct types, imports, guards, and configuration over assertions or suppression. Never use `any`, `@ts-ignore`, disabled checks, or broad casts to hide a diagnostic.
- When generated source is involved, fix its source or generator rather than hand-editing generated output unless repository guidance explicitly says otherwise.
- Rerun the exact failing command unchanged after editing, then run the relevant build/check and changed-file diagnostics or LSP verification when available. Confirm that no new diagnostics appeared.

## Method

1. **Define the behavior.** Identify the observable outcome, relevant failure paths, and the narrowest test level that can prove them.
2. **RED.** Add or adjust a test for the requested behavior, then run it before implementation. A valid RED must fail for the expected reason because the behavior is missing or the bug is present—not because of syntax, setup, environment, or unrelated failures. For a bug fix, preserve the test as a regression test. Continue without a meaningful RED only for a reversible, low-impact change when a concrete alternative verification is available and you explain why a meaningful RED is unavailable. This exception does not apply to security, payment, data-integrity, or irreversible work. Never fabricate a RED. If alternative verification is unavailable or cannot establish the requested behavior, stop and report a blocker. Meaningful regression coverage, relevant failure-path coverage, and required repository checks remain mandatory.
3. **GREEN.** Make the smallest implementation change that makes the new test pass. Rerun the exact RED command without changing its arguments or scope, then run relevant existing tests to preserve current behavior.
4. **REFACTOR.** Improve structure only while tests are green. Keep refactoring behavior-preserving and rerun affected tests after each meaningful change.
5. **COVERAGE.** Use repository-native coverage tooling and the test level appropriate to the changed behavior. Meet existing repository coverage thresholds when they are defined. Otherwise, cover the meaningful changed behavior and failure paths; do not invent a universal percentage. If coverage tooling is unavailable, report that explicitly rather than substituting an arbitrary threshold.

For delegated work, prefer a directly installed test runner for RED and GREEN (for example, `bun test`, `vitest`, `python -m pytest`, `dotnet test`, `mvn test`, `./gradlew test`, or `swift test`). Use one focused command for RED, then rerun that exact command for the first GREEN. Run broader tests only after the matched GREEN and report them as coverage or additional validation. Do not use package-manager scripts or `bun run` wrappers as authoritative evidence when the direct runner is available.

TDD is implementation guidance, not a substitute for current-state verification. If the sequence must adapt, report the observed commands and reason honestly; the main session independently inspects the result and runs current tests before accepting it.

Prefer observable behavior over implementation details, deterministic isolated tests over brittle fixtures, and the narrowest test that provides sufficient confidence. Escalate to broader integration or end-to-end tests only when the behavior crosses boundaries that narrower tests cannot prove.

## Required validation evidence

Report:

- `RED:` the command and observed expected failing result before implementation for standard TDD work. For eligible work, report `RED: unavailable because <specific reason>` and the concrete alternative verification instead of fabricating a failure.
- `GREEN:` the command and passing result after implementation, including relevant regression tests.
- `COVERAGE:` the repository threshold/result, meaningful changed-behavior and failure-path coverage, or a concrete reason in the form `coverage tooling unavailable because ...` after a valid focused GREEN run.
