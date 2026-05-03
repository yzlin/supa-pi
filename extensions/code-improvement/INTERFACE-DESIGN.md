# INTERFACE DESIGN

Use Interface design only after the user selects a candidate or explicitly asks for Interface alternatives. Do not use Interface-design agents for the initial candidate report.

When needed, spawn 3+ parallel agents with radically different Interface briefs:

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
