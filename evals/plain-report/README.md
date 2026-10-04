# Plain report calibration

Offline linter that measures how closely Markdown prose follows `skills/plain-report/SKILL.md`. It has no runtime wiring: no Extension loads it, and it never blocks or re-prompts a model. Use it to calibrate the skill against saved Final reports or reviewer `why`/`change` text.

## Run

```bash
# Built-in fixtures
bun run eval:plain-report

# Your own saved reports
bun run eval:plain-report -- path/to/report.md other.md
```

The output lists warnings as `L<line> [rule] message → fix` and the share of clean sentences per file and overall. The target is the skill's ~80% rule; falling short is information, not a failure.

## Rules

- `sentence-length`: more than 20 words in a numbered step, or more than 25 words elsewhere.
- `paragraph-length`: more than six sentences in one paragraph.
- `passive-voice`: a heuristic match of a form of "be" followed by a participle.
- `avoid-word`: a small, repo-owned list of long words with short replacements.
- `telegraph`: fewer than 4 articles ("a", "an", "the") per 100 prose words in a file with at least 50 prose words. This checks the skill's "complete sentences with articles" rule, which the per-sentence rules cannot see. It is a file-level warning and does not change the sentence score.

Exact Text is skipped: fenced and inline code, blockquotes, quoted strings, tables, headings, link targets, and paths. Technical names in plain prose still count as words.

The rules paraphrase the skill. No ASD-STE100 specification text or dictionary is copied. The structure of the checks was inspired by the MIT-licensed [answer-me-with-html](https://github.com/QingYunA/answer-me-with-html) STE lint; no code was copied.

## Fixtures

`fixtures/compliant.md` and `fixtures/noncompliant.md` are synthetic. They pin the linter's behavior, not model behavior. Real compliance needs real saved reports passed as arguments.

## Calibration results

Local run on 2026-10-04 over Final reports written after `plain-report` landed (2026-10-02). A Final report here is the last assistant message of a turn with at least three tool calls and at least 400 characters. Reviewer JSON was scored on its `why`/`change` fields only. Caveman mode was on in 2 of these sessions. The corpus came from local session logs and is not committed.

| Corpus | Files | Clean sentences | Telegraph files |
| --- | ---: | ---: | ---: |
| claude-opus-5-5 | 42 | 91% | 1 |
| gpt-6.1-sol | 64 | 98% | 42 |
| gpt-6-astra | 8 | 98% | 6 |
| Review `why`/`change` | 71 | 96% | 1 |

The GPT models pass the sentence rules because they write short telegraph fragments, not complete Plain report sentences. Review fields follow the skill. Treat these numbers as a baseline, not a model-adherence guarantee.

## Live prompt eval

On 2026-10-04, the `plain-report-*` cases in `evals/prompt-optimization` compared the committed `AGENTS.global.md` with a candidate. The candidate put the Final report exception first and said "complete sentences with articles, not telegraph". The run used 3 cases, 3 repetitions, and 2 arms on `openai-codex/gpt-6.1-sol` and `openai-codex/gpt-6-astra` at high thinking: 36 runs.

- Both baselines already wrote Plain report prose (about 4 to 9 articles per 100 words). Only one of 36 outputs had a `telegraph` warning.
- The candidate changed nothing: the pass-rate delta was 0 pp for both models. The candidate was reverted.
- The eval therefore does not reproduce the telegraph Final reports seen in real sessions.

A second 36-run comparison used the `plain-report-*-history` cases. They seed three terse user turns and three telegraph assistant turns before the same tasks. No output had a `telegraph` warning either; article rates stayed at about 4 to 15 per 100 words. Sol showed a 0 pp pass-rate delta. Astra showed +22 pp, but the failures were sentence length, not telegraph, and the gap was two runs per nine. The candidate was reverted again.

Short seeded history does not explain the real-session gap. Untested differences remain: the full production system prompt and tool list, skill text read through a tool instead of preloaded, long sessions with many tool results, and production reasoning settings. Track real compliance with this CLI on saved reports before more paid evals.

## Develop

```bash
bun test evals/plain-report
bun run check
```
