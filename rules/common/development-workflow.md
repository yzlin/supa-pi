# Development Workflow

> This file extends [common/git-workflow.md](./git-workflow.md) with the development process that happens before git operations.

Scale effort to scope, uncertainty, and risk. Clear, local, low-risk work can use a short inspect → patch → targeted verify loop. Broader, unfamiliar, cross-cutting, security-sensitive, or irreversible work warrants proportionally deeper research, planning, and review.

Every change must leave these outcomes:

1. **Context understood** — inspect the relevant code, repository guidance, and existing patterns before editing.
2. **Success defined** — identify the requested result, constraints, and practical validation. For phased work, each phase must leave a usable, verified end-to-end path.
3. **Smallest complete change** — address the root cause without unrelated refactoring, unnecessary dependencies, or suppressed failures.
4. **Applicable policy followed** — use [testing.md](./testing.md) when its trigger applies; perform security, performance, compatibility, or external research when the change's risks require it.
5. **Validation completed** — run the strongest practical repository-native checks targeted to the change, then broaden checks when impact or uncertainty justifies it.
6. **Result reported** — state what changed, validation evidence, and any remaining blocker or risk.

Use durable planning documents only when complexity, coordination, or rollout needs durable review. Seek independent review when risk, ambiguity, or blast radius makes it valuable; it is not mandatory for trivial changes.

Follow [git-workflow.md](./git-workflow.md) for commit and pull-request practices when git operations are requested.
