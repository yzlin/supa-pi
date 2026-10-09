# Trust GitHub repos

Active Extension that automatically grants project trust for checked-out GitHub repositories whose owners you explicitly allow. No owners are trusted by default.

## Commands

```text
/trust-github-repos                 # list owners and config path
/trust-github-repos list
/trust-github-repos add <owner>
/trust-github-repos remove <owner>
```

Owners are case-insensitive and stored lowercase. After lowercasing, each owner must match `^[a-z0-9](?:[a-z0-9-]{0,38})$`: 1–39 characters, starting with a letter or digit, followed by letters, digits, or hyphens. Add is idempotent; removing an absent owner reports that it is not present. Remove completes saved owners.

Add/remove changes apply on next Pi start; they do not change trust in the running session.

## Config

Global, user-managed file: `~/.pi/agent/trust-github-repos.json`.

```json
{
  "owners": ["example", "my-team"]
}
```

The file must be a JSON object with an `owners` array of valid owner strings. Writes create parent directories, deduplicate and sort lowercase owners, preserve unknown top-level keys, and end with a newline. Missing file or an empty owners list means no auto-trust. There is no project-local owners config.

Malformed JSON, invalid shape/owners, or a read error fails closed: project trust stays `undecided`, and the error is reported through the UI or stderr in headless mode. Commands report the error and refuse to overwrite malformed config; fix the file manually first.

## Trust behavior

At each Pi startup trust evaluation, the Extension reads the current config, then runs `git remote get-url --all origin` in the project directory with a 5000 ms timeout. With no owners it skips git. All nonempty origin URLs must parse as GitHub repositories whose owners are in the saved list; mixed owners are allowed only when each is listed. Only SCP-style SSH, `https://`, and `ssh://` forms are accepted; other protocols (including `file://`, `http://`, and `git://`) leave trust `undecided`. Non-GitHub origins, extra path parts, missing origins, or git failures leave trust `undecided` for Pi's normal handling.

A match returns `{ trusted: "yes" }` with **no `remember` field**. Trust is evaluated each start instead of being written to Pi's trust store by this Extension. Only personal or explicitly loaded Extensions can participate before project resources load.

**Pi never revokes trust it already stored**, including entries remembered by the earlier version of this Extension. Removing an owner does not revoke those entries. Managing Pi's trust store is outside this Extension.

## Attribution

Copied and adapted from Armin Ronacher (mitsuhiko), [`agent-stuff/extensions/trust-github-repos.ts`](https://github.com/mitsuhiko/agent-stuff/blob/main/extensions/trust-github-repos.ts), under **Apache License 2.0**. Local changes: attribution and repository formatting/lint rules, user-managed owners config, `/trust-github-repos`, and dropping remembered trust. The repository's root license remains MIT.
