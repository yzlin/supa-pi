# Guard the Context Window

Apply when: outputs are large, files are long, reads repeat, or work fans out.

**Why:** Context overflow degrades reasoning, creates compaction artifacts, and halts progress.

- Read with `offset`/`limit` and `grep` before whole files. Do not re-read what you already hold.
- Filter large command output in `bash` or `codemode`; keep summaries, not raw payloads, in the main thread.
- Route bulk reading and parallel disjoint work to the `subagent` tool with a self-contained task; keep its conclusions, not its transcript.
- Size phases and cap scope: limit files per phase and account for tool and subagent cost.
- When a plan must outlive this session, persist it (`/to-spec`) instead of carrying it in context.

---

Adapted from Lauren Tan's MIT-licensed [pstack `principle-guard-the-context-window`](https://github.com/cursor/plugins/tree/main/pstack); see `LICENSE.upstream`. Rewritten for Pi.
