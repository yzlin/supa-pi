#!/bin/bash
# Gets completions using bash's native completion system
# Usage: bash-complete.bash "command line" "/path/to/cwd"

__cmdline="$1"
__cwd="$2"

cd "$__cwd" 2>/dev/null || exit 1

# Extract command name
__cmd=${__cmdline%% *}

# Source bash-completion framework if available
for f in /usr/share/bash-completion/bash_completion /etc/bash_completion /opt/homebrew/etc/bash_completion /opt/homebrew/share/bash-completion/bash_completion; do
    [[ -f "$f" ]] && { source "$f" 2>/dev/null; break; }
done

# Also try to source command-specific completions directly (macOS/Homebrew)
for dir in /opt/homebrew/etc/bash_completion.d /usr/share/bash-completion/completions /etc/bash_completion.d; do
    for f in "$dir/$__cmd" "$dir/$__cmd.bash" "$dir/${__cmd}-completion.bash"; do
        [[ -f "$f" ]] && source "$f" 2>/dev/null
    done
done

# Set up completion environment
COMP_LINE="$__cmdline"
COMP_POINT=${#COMP_LINE}
eval set -- "$COMP_LINE"
COMP_WORDS=("$@")

# Add empty word if line ends with space (completing new word)
[[ "${COMP_LINE: -1}" = ' ' ]] && COMP_WORDS+=('')

COMP_CWORD=$(( ${#COMP_WORDS[@]} - 1 ))

# Load completion for the command if available
declare -F _completion_loader &>/dev/null && _completion_loader "$__cmd" 2>/dev/null

# Get the completion function
completion=$(complete -p "$__cmd" 2>/dev/null | awk '{print $(NF-1)}')

if [[ -n "$completion" ]] && declare -F "$completion" &>/dev/null; then
    # Call the completion function
    "$completion" 2>/dev/null
    # Output unique results
    printf '%s\n' "${COMPREPLY[@]}" | sort -u | head -30
fi
