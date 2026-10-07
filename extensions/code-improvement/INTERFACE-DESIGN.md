# INTERFACE DESIGN

Use Interface design only after the user selects a candidate or explicitly asks for Interface alternatives. Do not use Interface-design agents for the initial candidate report.

When needed, use 3+ blocking generic `subagent({task})` calls with radically different Interface briefs. Pass each fresh child the selected candidate, evidence, strict vocabulary, and read-only/no-implementation constraints; do not rely on parent conversation or invent named roles. Await all reports before main-session synthesis. Calls share four active slots per parent; additional calls queue. The user must select a candidate or explicitly request alternatives before this step; approval is not implementation authorization. If delegation is unavailable, report the blocker rather than silently replacing the workflow.

Briefs:

- Minimal Interface: 1-3 entry points, maximum Leverage per entry point.
- Flexible Interface: supports more use cases and extension.
- Common-caller Interface: makes the main path trivial.
- Ports-and-Adapters Interface: only if cross-Seam variation is real.

Each interface-design agent must use the strict architecture terms and output:

1. Interface, including invariants, ordering, error modes, and configuration.
2. Usage example.
3. What the Implementation hides behind the Seam.
4. Adapter strategy.
5. Trade-offs in Depth, Leverage, and Locality.

Compare the alternatives and recommend one plan.
