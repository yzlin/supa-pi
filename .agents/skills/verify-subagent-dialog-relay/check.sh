#!/bin/sh
# Verify the subagent dialog relay model. Run from anywhere:
#   .agents/skills/verify-subagent-dialog-relay/check.sh
# Exit 0: anchors found, model passes, every mutant fails. Anything else: read the output.
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo=$(git -C "$here" rev-parse --show-toplevel)
model="$here/model"
tlc_tool='http:tla2tools[url=https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar,checksum=sha256:936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88]@1.7.4'
java_tool='java@temurin-25'
mise install --quiet "$java_tool" "$tlc_tool" >/dev/null
jar="$(mise where "$tlc_tool")/tla2tools.jar"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
status=0

flat() { tr -s ' \t\n' '   '; } # every whitespace run -> one space
count_in() { # $1 = needle, stdin = haystack; prints occurrence count
  NEEDLE="$1" awk 'BEGIN { RS = "\001"; n = ENVIRON["NEEDLE"] } { c = 0; s = $0
    while ((i = index(s, n)) > 0) { c++; s = substr(s, i + length(n)) } print c }'
}
echo "== 1/3 code anchors (model action -> code text, exactly once)"
while IFS="$(printf '\t')" read -r action file text; do
  case "$action" in '#'* | '') continue ;; esac
  needle=$(printf '%s' "$text" | flat)
  count=$(flat <"$repo/$file" | count_in "$needle")
  if [ "$count" != 1 ]; then
    echo "ANCHOR $action: found $count times in $file: $text"
    status=1
  fi
done <"$model/anchors.tsv"
[ "$status" = 0 ] && echo "ok"

tlc() { # $1 = name, $2 = cfg file; prints TLC output to $work/$1.out
  mkdir -p "$work/$1"
  cp "$model/DialogRelay.tla" "$work/$1/"
  cp "$2" "$work/$1/m.cfg"
  (cd "$work/$1" && mise exec "$java_tool" -- java -XX:+UseParallelGC -cp "$jar" \
    tlc2.TLC -workers 4 -deadlock -config m.cfg DialogRelay.tla >"$work/$1.out" 2>&1) || true
}

echo "== 2/3 model (Req = {r1, r2}, all properties)"
tlc main "$model/DialogRelay.cfg"
if grep -q "No error has been found" "$work/main.out"; then
  grep -E "distinct states found|^Finished in" "$work/main.out" | tail -2
else
  echo "FAIL: TLC output follows (read it with /statechart)"
  cat "$work/main.out"
  status=1
fi

echo "== 3/3 mutants (each must fail its property)"
# mutant flag | property that must break
for row in \
  "BugNoAbortOnClose|NoCopyAfterClose" \
  "BugNoAbortOnClose|ParentCopyGoesAway" \
  "BugFifoNoHold|OneParentDialog" \
  "BugChildIgnoresClose|NeverWaitsOnUnanswerable"; do
  flag=${row%%|*}
  prop=${row##*|}
  {
    echo "CONSTANTS Req = {r1, r2}"
    for f in BugNoAbortOnClose BugFifoNoHold BugChildIgnoresClose; do
      [ "$f" = "$flag" ] && echo "  $f = TRUE" || echo "  $f = FALSE"
    done
    echo "SPECIFICATION Spec"
    case "$prop" in
      *GoesAway | NeverWaits*) echo "PROPERTIES $prop" ;;
      *) echo "INVARIANTS $prop" ;;
    esac
  } >"$work/$flag-$prop.cfg"
  tlc "$flag-$prop" "$work/$flag-$prop.cfg"
  if grep -qE "is violated|Temporal properties were violated" "$work/$flag-$prop.out"; then
    echo "ok    $flag breaks $prop"
  else
    echo "MISS  $flag did not break $prop (model can no longer fail; fix the model)"
    status=1
  fi
done
exit "$status"
