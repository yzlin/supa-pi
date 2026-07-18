# Behavior-neutral instrumentation

Operational detail for the canonical protocol in `../SKILL.md`. This reference does not relax its scoped authorization, privacy, proof, or fix-gate requirements. An explicit Diagnose invocation already authorizes reversible, behavior-neutral temporary probes within its requested diagnosis scope; it does not authorize the separately approved actions listed in the canonical protocol.

## Probe worksheet

Before adding an invocation-authorized probe, write down and disclose:

```text
Probe ID:
Candidates distinguished:
Prediction by candidate:
Files/components/environment:
Temporary changes:
Allowlisted fields:
Capture-time redaction:
Duration and risk:
Cleanup command or edit:
```

A behavior-neutral probe observes existing execution without intentionally changing product decisions, outputs, persistence semantics, or external side effects. Logging can still affect timing, cost, and storage, so keep it bounded and disclose those risks.

## Structured correlation

Use one generated probe ID for the instrumentation scope and one generated run ID per reproduction. Emit stable structured records only at boundaries needed to distinguish candidates:

```json
{"probe":"diag-a4f2","runId":"r17","boundary":"api->queue","event":"enqueued","candidate":"C1","shape":"job:v2"}
{"probe":"diag-a4f2","runId":"r17","boundary":"queue->worker","event":"received","candidate":"C1","shape":"job:v2"}
```

Prefer allowlisted values such as event names, state classifications, booleans, counts, durations, schema versions, and keyed hashes generated only when safe. Do not serialize whole objects as a convenience.

## Privacy and redaction

- Default deny every field; explicitly allow only fields required by a prediction.
- Redact at capture rather than after writing logs.
- Use synthetic inputs where possible.
- Never collect secrets, tokens, credentials, private keys, cookies/session material, authorization headers, or raw sensitive bodies.
- Treat URLs, filenames, query text, user identifiers, stack locals, and database values as potentially sensitive.
- Keep redacted artifacts only while they remain useful; follow repository and environment retention rules.

## Probe selection

Build a candidate/probe matrix before editing. Prefer the smallest group of observations whose outcome patterns separate all live candidates. Correlated observations at two boundaries can be one probe set when they share a run ID and answer one causal question. Avoid broad telemetry and probes that produce the same prediction for every candidate.

Use existing debuggers, traces, metrics, query plans, or test assertions before temporary logging. Route platform operation to the relevant specialized skill and request only the bounded, redacted evidence needed by the matrix.

## Cleanup inventory

Track every agent-added log, flag, config change, fixture, temporary file, deployed setting, and retained artifact. Keep the inventory through approved fix verification. Clean up on successful verification, decline, cancellation, abandonment, and before every terminal `Diagnosis: Incomplete` / `Fix: Not attempted` report. The only exception is a user's explicit approval to retain specific inventoried items; report those items and that approval.

1. remove probes and restore temporary state;
2. confirm unique probe tags no longer exist;
3. delete unneeded raw captures;
4. retain only redacted artifacts needed to explain the result;
5. report cleanup status and any item the agent could not remove.
