#!/usr/bin/env bash
set -euo pipefail

fail() { echo "workflow: $*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage:
  bash scripts/workflow.sh start <feat|fix|refactor|test> <delivery-name>
  bash scripts/workflow.sh start <docs|chore>

Start uses the current checkout and requires clean main.
With origin configured, main must synchronize with origin/main.
Without origin, local main is the bootstrap baseline.
Worktrees are created only by explicit ticket or implementation instructions.
EOF
}

case "${1:-help}" in
  help|--help|-h) usage; exit 0 ;;
  start) ;;
  *) usage >&2; exit 1 ;;
esac

root=$(git rev-parse --show-toplevel)
cd "$root"

case "$1" in
  start)
    [[ $# -ge 2 ]] || fail "start needs a task type"
    branch=""
    case "$2" in
      docs|chore) [[ $# == 2 ]] || fail "docs/chore take no delivery name" ;;
      feat|fix|refactor|test)
        [[ $# == 3 ]] || fail "start needs a type and delivery name"
        [[ "$3" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]] || fail "use a lowercase hyphenated delivery name"
        branch="$2/$3"
        git show-ref --verify --quiet "refs/heads/$branch" && fail "branch already exists: $branch"
        ;;
      *) fail "unknown task type: $2" ;;
    esac
    [[ "$(git config --get core.hooksPath || true)" == .husky/_ ]] ||
      fail "run npm run prepare first"
    [[ -x .husky/_/commit-msg && -x .husky/_/pre-push ]] || fail "run npm run prepare in this checkout first"
    [[ "$(git symbolic-ref --quiet --short HEAD || true)" == main ]] || fail "start from main"
    [[ -z "$(git status --porcelain --untracked-files=all)" ]] || fail "preserve working directory changes before starting"
    if git remote get-url origin >/dev/null 2>&1; then
      git fetch origin
      if [[ -n "$branch" ]] && git show-ref --verify --quiet "refs/remotes/origin/$branch"; then
        fail "remote branch already exists: $branch"
      fi
      git merge --ff-only origin/main
      [[ "$(git rev-parse HEAD)" == "$(git rev-parse origin/main)" ]] || fail "reconcile unpublished main commits before starting"
    else
      echo "No origin configured; using local main."
    fi
    if [[ -n "$branch" ]]; then
      git switch --no-track -c "$branch" main
      echo "First push: git push -u origin $branch"
    fi
    echo "Ready in $root ($(git symbolic-ref --short HEAD)); keep one writer in this checkout."
    ;;
esac
