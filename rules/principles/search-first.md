# Search First

Apply when: about to write a utility, helper, abstraction, integration, or dependency.

Check existing capability before writing custom code. Before external package or web research, check in order:

1. **Repository** — relevant modules, tests, scripts, and patterns (`grep`, `find`).
2. **Stdlib** — the language or runtime standard library.
3. **Native platform** — what the target platform or framework supplies.
4. **Already-installed dependency** — the manifest, lockfile, and existing usage.

Test each candidate against the actual requirements, including safety, correctness, accessibility, and edge cases. If one meets them, stop and use it; do not keep researching just to compare. Then check local skills and MCP servers. External research is justified only when these do not meet the requirements; dispatch it per the `investigation` Playbook. Do not treat a shorter implementation as better without checking fit.

| Signal | Action |
| --- | --- |
| Existing capability meets requirements | **Adopt** and stop |
| Exact external match, maintained, permissive license | **Adopt** the package |
| Partial match, good foundation | **Extend** with a thin wrapper |
| Several weak matches | **Compose** two or three small packages |
| Nothing suitable | **Build**, informed by what you found |

Avoid: jumping to code, ignoring MCP, over-wrapping a library, and installing a large package for one small feature.

---

Origin: the ECC `search-first` skill, rewritten for Pi.
