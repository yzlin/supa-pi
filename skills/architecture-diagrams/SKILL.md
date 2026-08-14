---
name: architecture-diagrams
description: Create focused Mermaid architecture diagrams for assessments and system design tasks, using only the views needed to answer the question.
---

# Architecture Diagrams

## Trigger Conditions

- Architectural assessment requested
- New system design task
- C4 diagrams needed
- "diagram", "architecture", or "system design" mentioned

## Selection

Choose the smallest diagram set that answers the question. Start with one diagram. Add another only when it shows a distinct boundary, flow, or decision that the first cannot.

| Question | Diagram |
| --- | --- |
| Where does the system sit? | System context |
| Which modules own what? | Component |
| Where does it run? | Deployment |
| How does information move? | Data flow |
| In what order do calls happen? | Sequence |
| How does state change? | State |
| How is persisted data related? | Entity relationship |
| Where are trust boundaries? | Security architecture |

## Guidance

- Ground every node and edge in inspected evidence; label unknown or proposed elements.
- Keep labels concrete and diagrams focused on the current decision.
- Put a short explanation before each diagram.
- Omit decorative infrastructure, actors, and flows.
- Do not repeat the same relationships across multiple diagram types.
- If a text tree or pseudocode is clearer, render it directly instead of Mermaid.
