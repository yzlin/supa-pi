# Wayfinder contract scenarios

These inspection scenarios describe expected workflow outcomes; they are not a runtime state-engine specification.

### Sole resumable map

Bare invocation finds one active map, validates it, acquires or confirms ownership, and resumes its checkpoint.

### Ambiguous resume

Bare invocation finds multiple active maps and asks the human which map to resume without claiming one.

### Interrupted claim

A stale or uncertain claim is reported. The new session obtains explicit approval before taking over, records the handoff, then checkpoints.

### Decision revision

A human revises an answer. The record appends an answer version, keeps revision history, and revalidates or reopens every transitive dependent.

### Interrupted completed-map revision

A completed map receives revised in-scope work. It becomes active, its handoff is stale, and every affected transitive dependent has `Status: unresolved`; pending revalidation is recorded as a checkpoint reason, not another question status. Old answers remain historical. On resume, evidence-backed records allow the interrupted revalidation to finish; otherwise normal work stops with the exact inconsistency rather than inferring a human choice.

### Interrupted question creation

A question record was saved before an interrupted Question order update. Resume enumerates compact headers for every file under the map's `questions/` directory, identifies the orphan or unindexed record without reading all answer bodies, and repairs the index only when record evidence supports it. It never infers a missing answer.

### Excluded dependency

A dependency is excluded as out of scope. Its dependent is not ready: exclusion is not successful resolution, so the map must revise scope/dependencies or leave it blocked.

### Inconsistent incremental write

A question says resolved while its answer version is absent or the index conflicts. The session fails closed, reports the contradiction, and repairs the index only from question-record evidence.

### Prototype scope change

The proposed prototype changes artifact path or side effects. Existing approval is invalid; the human must approve the concrete revised action set before work.

### Approval is not inferred

A prototype record has every action field filled but no granted status and human approval reference. No action occurs: proposal fields or evidence text cannot impersonate consent. Changed scope invalidates prior approval, and external or dangerous action consent remains separate.

### Ignored storage

The workspace ignores `.pi/`. Before creating a map, path inspection reports the intended records as ignored and stops for approval of a narrow Wayfinder-only exception; it does not edit ignore rules, force-add, stage, initialize, or write the map.

### Completion with fog

All questions are resolved but unexplained in-scope fog remains. The map stays active until the fog becomes questions, is explained away, or is explicitly excluded by the human.

### Unsafe destination path

A target path traverses outside the workspace or resolves through a symlink outside it. The session rejects it without writing.

### Topic shift

The user changes topics. The session checkpoints and releases the coherent branch with unresolved questions recorded; it does not fabricate decisions.
