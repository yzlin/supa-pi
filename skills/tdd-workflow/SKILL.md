---
name: tdd-workflow
description: Canonical test-driven methodology for behavior changes and bug fixes.
origin: ECC
---

# Test-Driven Development Workflow

Use this workflow for every behavior change and bug fix. It applies whether work is performed directly or delegated. Documentation-only, configuration-only, generated, and purely mechanical changes are outside this workflow unless they change behavior.

## Method

1. **Define the behavior.** Identify the observable outcome, relevant failure paths, and the narrowest test level that can prove them.
2. **RED.** Add or adjust a test for the requested behavior, then run it before implementation. A valid red must fail for the expected reason because the behavior is missing or the bug is present—not because of syntax, setup, environment, or unrelated failures. For a bug fix, preserve the test as a regression test. If no valid red can be produced, stop implementation and report the blocker.
3. **GREEN.** Make the smallest implementation change that makes the new test pass. Run the focused test and relevant existing tests to preserve current behavior.
4. **REFACTOR.** Improve structure only while tests are green. Keep refactoring behavior-preserving and rerun affected tests after each meaningful change.
5. **COVERAGE.** Use repository-native coverage tooling and the test level appropriate to the changed behavior. Meet existing repository coverage thresholds when they are defined. Otherwise, cover the meaningful changed behavior and failure paths; do not invent a universal percentage. If coverage tooling is unavailable, report that explicitly rather than substituting an arbitrary threshold.

For managed TDD evidence, invoke a supported test runner directly for RED and GREEN (for example, `bun test`, `vitest`, `python -m pytest`, `dotnet test`, `mvn test`, `./gradlew test`, or `swift test`). Do not use npm/pnpm/yarn package scripts or `bun run` scripts as authoritative RED/GREEN evidence: their hooks and workspace mutations are opaque. Managed Pytest coverage may use `--cov` with `--cov-report=term` or `--cov-report=term-missing`; file/directory report destinations remain unsupported because their workspace effects cannot be safely treated as verification.

Prefer observable behavior over implementation details, deterministic isolated tests over brittle fixtures, and the narrowest test that provides sufficient confidence. Escalate to broader integration or end-to-end tests only when the behavior crosses boundaries that narrower tests cannot prove.

## Required Validation Evidence

Report:

- `RED:` command and expected failing result before implementation.
- `GREEN:` command and passing result after implementation, including relevant regression tests.
- `COVERAGE:` repository threshold/result, meaningful changed-behavior and failure-path coverage, or a concrete reason in the form `coverage tooling unavailable because ...` after a valid focused GREEN run.
