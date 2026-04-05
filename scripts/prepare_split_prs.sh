#!/usr/bin/env bash
set -euo pipefail

# usage:
#   scripts/prepare_split_prs.sh <base_branch> <full_branch>
# example:
#   scripts/prepare_split_prs.sh main work

BASE_BRANCH="${1:-main}"
FULL_BRANCH="${2:-work}"
MERGE_SAFE_BRANCH="pr/merge-safe"

printf '\n==> syncing base branch (%s)\n' "$BASE_BRANCH"
git checkout "$BASE_BRANCH"
git pull origin "$BASE_BRANCH"

printf '\n==> creating merge-safe branch (%s)\n' "$MERGE_SAFE_BRANCH"
git checkout -B "$MERGE_SAFE_BRANCH"

printf '\n==> copying merge-safe files from %s\n' "$FULL_BRANCH"
git checkout "$FULL_BRANCH" -- \
  migrations/002_phase1_mvp.sql \
  migrations/003_ops_foundation.sql \
  src/lib/gemini.ts \
  src/cloudflare.d.ts

printf '\n==> committing merge-safe branch\n'
git add migrations/002_phase1_mvp.sql migrations/003_ops_foundation.sql src/lib/gemini.ts src/cloudflare.d.ts

git commit -m "chore: merge-safe foundation (migrations + gemini core)" || true

printf '\n==> pushing merge-safe branch\n'
git push -u origin "$MERGE_SAFE_BRANCH"

printf '\nmerge-safe branch ready. now create and merge pr #1 from %s -> %s\n' "$MERGE_SAFE_BRANCH" "$BASE_BRANCH"

printf '\nafter pr #1 is merged, run:\n'
printf '  git checkout %s\n' "$FULL_BRANCH"
printf '  git fetch origin\n'
printf '  git rebase origin/%s\n' "$BASE_BRANCH"
printf '  # resolve conflicts\n'
printf '  git add .\n'
printf '  git rebase --continue\n'
printf '  git push --force-with-lease origin %s\n' "$FULL_BRANCH"
