#!/usr/bin/env bash
set -Eeuo pipefail

cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"

root=$(git config --global --get gj.root)
root="${root/#\~/$HOME}"

fetch=1
if [[ ${1:-} == --no-fetch ]]; then
    fetch=0
    shift
fi

pattern='^// Source: https://github\.com/([^/]+/[^/]+)/(?:blob|tree)/([0-9a-f]+)/(\S+)'
fetched=" "

rg --no-heading --no-line-number -P -o -r '$1 $2 $3' "$pattern" \
    -g 'index.ts' -g '!node_modules' extensions |
    sort |
    while IFS=: read -r file match; do
        read -r repo base path <<<"$match"
        ext=${file#extensions/}
        ext=${ext%%/*}

        if [[ $# -gt 0 && " $* " != *" $ext "* ]]; then
            continue
        fi

        dir="$root/github.com/$repo"
        if [[ ! -d "$dir/.git" ]]; then
            gj get "$repo" >/dev/null </dev/null
        elif [[ $fetch == 1 && "$fetched" != *" $repo "* ]]; then
            git -C "$dir" fetch --quiet origin </dev/null
            fetched+="$repo "
        fi

        if ! git -C "$dir" cat-file -e "origin/HEAD:$path" 2>/dev/null; then
            printf '%-20s removed upstream  %s\n' "$ext" "$(git -C "$dir" log -1 --format='%h %s' origin/HEAD -- "$path")"
            continue
        fi

        commits=$(git -C "$dir" log --oneline "$base..origin/HEAD" -- "$path")
        if [[ -z "$commits" ]]; then
            printf '%-20s up to date\n' "$ext"
            continue
        fi

        printf '%-20s %s new  git -C %s log -p %s..origin/HEAD -- %s\n' \
            "$ext" "$(wc -l <<<"$commits" | tr -d ' ')" "$dir" "$base" "$path"
        sed 's/^/    /' <<<"$commits"
    done
