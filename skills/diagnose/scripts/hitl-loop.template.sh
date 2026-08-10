#!/usr/bin/env bash
# Structured human-in-the-loop reproduction fallback.
# Adapted from Matt Pocock's MIT-licensed diagnosing-bugs skill,
# reviewed at commit 84fdeffd12f2ee307994d1eb6feb48173b6e0502.
#
# Copy this file to a temporary diagnostic location and edit the bounded
# instructions. Ask the user to perform them in a separate agent/user turn,
# then validate and redact their reply. Choose a run ID containing only letters,
# digits, and hyphens, create its private handoff directory, and provide the
# derived concrete observation path literally to Pi's write tool. For example:
#   install -d -m 700 /tmp/supa-pi-diagnose-$(id -u)-diag-a4f2
#   write: /tmp/supa-pi-diagnose-501-diag-a4f2/observation.txt
#   bash hitl-loop.template.sh --reproduced y --run-id diag-a4f2
# Replace 501 with the concrete output of `id -u`; do not pass shell expressions
# or placeholders to Pi's write tool.
#
# Never capture secrets, credentials, tokens, cookies, authorization headers,
# or raw sensitive bodies. Keep authentication as a user-only step. Capture
# only allowlisted, redacted observations needed for the anchored symptom.

set -euo pipefail

usage() {
  printf 'Usage: %s --reproduced y|n --run-id <letters-digits-hyphens>\n' "$0" >&2
  exit 2
}

REPRODUCED=""
RUN_ID=""
while (($#)); do
  case "$1" in
    --reproduced)
      (($# >= 2)) || usage
      REPRODUCED="$2"
      shift 2
      ;;
    --run-id)
      (($# >= 2)) || usage
      RUN_ID="$2"
      shift 2
      ;;
    *) usage ;;
  esac
done

[[ "$REPRODUCED" == "y" || "$REPRODUCED" == "n" ]] || usage
[[ "$RUN_ID" =~ ^[A-Za-z0-9][A-Za-z0-9-]{0,63}$ ]] || usage

HANDOFF_DIRECTORY="/tmp/supa-pi-diagnose-$(id -u)-${RUN_ID}"
OBSERVATION_FILE="$HANDOFF_DIRECTORY/observation.txt"
[[ -d "$HANDOFF_DIRECTORY" && ! -L "$HANDOFF_DIRECTORY" && -O "$HANDOFF_DIRECTORY" ]] || usage
DIRECTORY_MODE=$(
  stat -f '%Lp' "$HANDOFF_DIRECTORY" 2>/dev/null ||
    stat -c '%a' "$HANDOFF_DIRECTORY" 2>/dev/null
) || usage
[[ "$DIRECTORY_MODE" == "700" ]] || usage
[[ -f "$OBSERVATION_FILE" && ! -L "$OBSERVATION_FILE" && -O "$OBSERVATION_FILE" ]] || usage

OBSERVATION=""
IFS= read -r OBSERVATION < "$OBSERVATION_FILE" || [[ -n "$OBSERVATION" ]] || usage
EXTRA_OBSERVATION=""
if IFS= read -r EXTRA_OBSERVATION < <(tail -n +2 -- "$OBSERVATION_FILE") ||
  [[ -n "$EXTRA_OBSERVATION" ]]; then
  usage
fi
[[ -n "$OBSERVATION" ]] || usage
trap 'rm -f -- "$OBSERVATION_FILE"; rmdir -- "$HANDOFF_DIRECTORY" 2>/dev/null || true' EXIT

# --- edit below ---------------------------------------------------------
# Ask the user in a separate turn to:
# 1. Open the controlled test environment and authenticate if required.
# 2. Perform the exact trigger and report whether the anchored symptom occurred.
# 3. Return one allowlisted, redacted observation (or "none").
# --- edit above ---------------------------------------------------------

printf '%s\n' '--- Captured ---'
printf 'REPRODUCED=%s\n' "$REPRODUCED"
printf 'OBSERVATION=%s\n' "$OBSERVATION"
