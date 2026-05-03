# LANGUAGE

Use these architecture terms exactly. Avoid substitute terms such as component, service, API, or boundary when describing architecture.

- **Module** — anything with an Interface and an Implementation: function, class, package, slice, or tier-spanning area.
- **Interface** — everything a caller must know to use the Module correctly: types, invariants, error modes, ordering constraints, required configuration, and performance characteristics. Not just a type signature.
- **Implementation** — the code inside a Module.
- **Depth** — Leverage at the Interface. A deep Module hides a lot of behavior behind a small Interface. A shallow Module has an Interface nearly as complex as its Implementation.
- **Seam** — where an Interface lives; a place behavior can be altered without editing in place.
- **Adapter** — a concrete thing satisfying an Interface at a Seam.
- **Leverage** — what callers get from Depth: more capability per unit of Interface they must learn.
- **Locality** — what maintainers get from Depth: change, bugs, knowledge, and verification concentrated in one place.
