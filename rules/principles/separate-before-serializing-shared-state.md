# Separate Before Serializing Shared State

Apply when: parallel children, experiments, or unattended runs might write to the same file, branch, key, build output, or state object.

First ask whether the actors need the same mutable object. If not, remove the sharing. Serialize only when one shared writer is a real invariant, and then do it with structure. Instructions and conventions are not concurrency control.

**Why:** Concurrent writes cause intermittent races that are hard to reproduce. Disjoint write scopes in one checkout still share installs, lockfiles, build output, and formatter runs, and a failed experiment there must be undone edit by edit.

1. **Find the shared mutable state:** files both read and write, branches both push to, a checkout both build in.
2. **Default: give each actor its own target.** Each parallel writer or throwaway experiment gets its own git worktree under `.pi/worktrees/<slug>` (`git worktree add .pi/worktrees/<slug>`), passed as the `subagent` `cwd`. A worktree inside the repo inherits the parent's workspace trust and project instructions. Merge only at the read or reporting boundary: main reviews each tree's diff and applies it. Two workers writing their own field into one `state.json` still share it; two files do not.
3. **Clean up with recovery:** `trash .pi/worktrees/<slug> && git worktree prune`. Do not use `git worktree remove`; it deletes permanently.
4. **Only when one shared target is a real invariant, serialize it structurally:** sequential phases, a single writer, a lockfile, or compare-and-swap. Treat "we need a lock" as a design smell to check first.

---

Adapted from Lauren Tan's MIT-licensed [pstack `principle-separate-before-serializing-shared-state`](https://github.com/cursor/plugins/tree/main/pstack); see `LICENSE.upstream`. Rewritten for Pi.
