#!/bin/zsh
# Simple zsh completion capture using _complete_help
# Usage: zsh-capture.zsh "command line" "/path/to/cwd"

emulate -L zsh
setopt no_beep

local cmdline="$1"
local cwd="$2"

cd "$cwd" 2>/dev/null || exit 1

# Initialize completion system (use user's zcompdump)
autoload -Uz compinit
compinit -C 2>/dev/null

# Parse command line
local -a words
words=("${(@Q)${(z)cmdline}}")

# If line ends with space, we're completing a new word
if [[ "$cmdline" == *" " ]]; then
    words+=("")
fi

local cmd="${words[1]}"
local current="${words[-1]}"

# Helper to output completions
output() {
    local val="$1" desc="$2"
    if [[ -n "$desc" ]]; then
        print -r -- "${val}"$'\t'"${desc}"
    else
        print -r -- "${val}"
    fi
}

# Git completions
if [[ "$cmd" == "git" ]]; then
    if (( ${#words} == 2 )); then
        # Git subcommands
        git --list-cmds=main,others 2>/dev/null | while read -r subcmd; do
            [[ -z "$current" || "$subcmd" == "$current"* ]] && output "$subcmd"
        done
    else
        local subcmd="${words[2]}"
        case "$subcmd" in
            checkout|switch|merge|rebase|branch|log)
                # Branches
                git for-each-ref --format='%(refname:short)' refs/heads 2>/dev/null | while read -r b; do
                    [[ -z "$current" || "$b" == "$current"* ]] && output "$b" "branch"
                done
                git for-each-ref --format='%(refname:short)' refs/remotes 2>/dev/null | while read -r b; do
                    [[ "$b" == */HEAD ]] && continue
                    local short="${b#*/}"
                    [[ -z "$current" || "$short" == "$current"* ]] && output "$short" "remote"
                done
                ;;
            add|diff|restore|reset)
                # Modified files
                git diff --name-only 2>/dev/null | while read -r f; do
                    [[ -z "$current" || "$f" == "$current"* ]] && output "$f" "modified"
                done
                git diff --cached --name-only 2>/dev/null | while read -r f; do
                    [[ -z "$current" || "$f" == "$current"* ]] && output "$f" "staged"
                done
                ;;
            push|pull|fetch)
                if (( ${#words} == 3 )); then
                    git remote 2>/dev/null | while read -r r; do
                        [[ -z "$current" || "$r" == "$current"* ]] && output "$r" "remote"
                    done
                fi
                ;;
            stash)
                for sub in apply drop list pop show push; do
                    [[ -z "$current" || "$sub" == "$current"* ]] && output "$sub"
                done
                ;;
        esac
    fi
    exit 0
fi

# SSH/SCP completions - hosts
if [[ "$cmd" == "ssh" || "$cmd" == "scp" || "$cmd" == "sftp" ]]; then
    {
        [[ -f ~/.ssh/config ]] && awk '/^Host / && !/\*/{for(i=2;i<=NF;i++)print $i}' ~/.ssh/config
        [[ -f ~/.ssh/known_hosts ]] && awk -F'[, ]' '{print $1}' ~/.ssh/known_hosts
    } 2>/dev/null | sort -u | while read -r h; do
        [[ -z "$current" || "$h" == "$current"* ]] && output "$h" "host"
    done
    exit 0
fi

# Make completions
if [[ "$cmd" == "make" ]]; then
    local mf
    for f in GNUmakefile Makefile makefile; do
        [[ -f "$f" ]] && mf="$f" && break
    done
    if [[ -n "$mf" ]]; then
        awk -F: '/^[a-zA-Z_][a-zA-Z0-9_-]*:/ && !/^\./{print $1}' "$mf" 2>/dev/null | while read -r t; do
            [[ -z "$current" || "$t" == "$current"* ]] && output "$t" "target"
        done
    fi
    exit 0
fi

# NPM/Yarn/PNPM completions
if [[ "$cmd" == "npm" || "$cmd" == "yarn" || "$cmd" == "pnpm" ]]; then
    if (( ${#words} == 2 )); then
        for sub in install add remove run build test start dev publish; do
            [[ -z "$current" || "$sub" == "$current"* ]] && output "$sub"
        done
    elif [[ "${words[2]}" == "run" && -f package.json ]]; then
        jq -r '.scripts // {} | keys[]' package.json 2>/dev/null | while read -r s; do
            [[ -z "$current" || "$s" == "$current"* ]] && output "$s" "script"
        done
    fi
    exit 0
fi

# Docker completions
if [[ "$cmd" == "docker" ]]; then
    if (( ${#words} == 2 )); then
        for sub in build compose exec images logs ps pull push rm rmi run start stop; do
            [[ -z "$current" || "$sub" == "$current"* ]] && output "$sub"
        done
    fi
    exit 0
fi

# Fallback: file completion
if [[ -n "$current" ]]; then
    local -a matches
    matches=( ${current}*(N) )
    for f in "${matches[@]:0:20}"; do
        [[ -d "$f" ]] && output "${f}/" "directory" || output "$f" "file"
    done
else
    local -a matches
    matches=( *(N) )
    for f in "${matches[@]:0:20}"; do
        [[ -d "$f" ]] && output "${f}/" "directory" || output "$f" "file"
    done
fi
