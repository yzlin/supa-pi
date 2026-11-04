# Benchmark checklist

Use this before you report or act on a measured number: a before/after for a change, a regression claim, an eval score or token count, or a choice between options. Answer each question with evidence from a run, not a guess from reading code. The `explain-the-number` Principle is the rule; this is the procedure.

For a quick ballpark the user asked for, one run is enough. Still check questions 4 and 7, and say that it is one run. A choice between options is never a ballpark.

## Before you run

- Write the claim you expect to make, in the words you would ship: "main-session tokens fall 30% on review-clean". The questions test that sentence.
- Read the measurement script. Note what it times or counts, and what it ignores.
- Check machine load (`uptime`) and core count (`sysctl -n hw.ncpu` on macOS, `nproc` on Linux). If the machine is busy and you cannot stop the cause, alternate the sides so both see the same noise, and say so.

## The questions

1. **Why not double?** Name the limiter: CPU per process (`top`, `ps`), a runtime profiler (`bun --cpu-prof`, `node --cpu-prof`), I/O wait, or for agent runs, which turns and children use the tokens. Profile in a run you do not report; profilers slow the work. If the load generator or the harness saturates first, you measured the harness. If a change did not move the number, the limiter says why.
2. **Was it tuned?** Run every side the way it really runs: release builds, real flags and environment, the same versions, data, model, and thinking level, caches as warm or cold as in real use. If one side runs on defaults, you compared configurations. Tune it and measure again before you pick a winner.
3. **Did it break limits?** Do the arithmetic. Removing a piece that takes 10% of the run makes the run at most about 11% faster. A result past a limit measured something else: a cache, a no-op, or a bug.
4. **Did it error?** Count failures, error results, and retries, and check that outputs are correct, not only present. Errors are often fast; timeouts and retries are slow. If the script does not count errors, add the count.
5. **Does it reproduce?** Run each side at least 5 times, alternating (A, B, A, B) so warmup, caches, and drift favor neither. Report the median and the range. A gap smaller than the run-to-run spread is no measurable difference. Live model runs need user approval of the run count; when it is under 5, say so and call the size of the effect a direction, not a measurement.
6. **Does it matter?** Next to a micro result, measure the path the user waits on, and give the micro result as a share of the whole.
7. **Did it even happen?** Confirm the work ran inside the measured region: the request reached the server, the rows were written, the child actually ran the task, the result was used. Lazy code, unawaited promises, and timeouts produce numbers for work that never happened.

## Report

- Lead with the verdict: faster, slower, no measurable difference, or inconclusive.
- Give the number with its unit, the run count, the range, and the limiter: "main tokens 172k, 213k → 103k, 127k (2 runs per side), bound by main-session turns that resend about 25k each".
- Call it inconclusive when you claim a difference but cannot name the limiter, when a side ran untuned, or when you could not check questions 4 and 7. Name the gap.
- Keep a PR body to one primary number; put the runs, range, and limiter evidence in a linked file.

---

Adapted from Lauren Tan's MIT-licensed [pstack `benchmark-checklist` skill](https://github.com/cursor/plugins/tree/main/pstack). Rewritten for Pi, with macOS commands and agent-run measurements added.
