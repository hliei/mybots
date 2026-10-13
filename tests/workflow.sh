#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd -P)
fixture=$(mktemp -d "${TMPDIR:-/tmp}/mybots-workflow.XXXXXX")
fixture=$(cd "$fixture" && pwd -P)
trap 'rm -rf "$fixture"' EXIT
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME='Workflow Test' GIT_COMMITTER_NAME='Workflow Test'
export GIT_AUTHOR_EMAIL='workflow@example.invalid' GIT_COMMITTER_EMAIL='workflow@example.invalid'

reject() {
  if "$@" >"$fixture/rejected.log" 2>&1; then
    echo "Expected rejection: $*" >&2
    exit 1
  fi
}

git init -q --initial-branch=main "$fixture/repo"
git init -q --bare --initial-branch=main "$fixture/remote.git"
cd "$fixture/repo"
cp -R "$root/scripts" .
mkdir .husky
cp "$root/.husky/commit-msg" "$root/.husky/pre-push" .husky/
cp "$root/.gitignore" "$root/package.json" .
mkdir node_modules
ln -s "$root/node_modules/husky" node_modules/husky
mkdir node_modules/.bin
ln -s ../husky/bin.js node_modules/.bin/husky
git config core.hooksPath "$fixture/repo/.githooks"
npm run prepare
[[ "$(git config --get core.hooksPath)" == .husky/_ ]]
git check-ignore .husky/_/h >/dev/null
npm run prepare
mkdir -p .scratch .agents
touch .scratch/spec.md .agents/local.md .env AGENTS.override.md skills-lock.json
git check-ignore .scratch/spec.md .agents/local.md .env AGENTS.override.md skills-lock.json >/dev/null
git add .gitignore .husky scripts package.json
reject git commit -qm 'feat: bypass main workflow'
reject git commit -qm 'invalid message'
reject git commit -qm 'chore: setup' -m 'Unrequested body'
reject git commit -qm "chore: $(printf '%080d' 0)"
git commit -qm 'chore: initialize repository'
reject bash scripts/workflow.sh start feat Invalid_Name
[[ "$(git symbolic-ref --short HEAD)" == main ]]
bash scripts/workflow.sh start docs
bash scripts/workflow.sh start feat local-bootstrap
[[ "$(git symbolic-ref --short HEAD)" == feat/local-bootstrap ]]
[[ "$(git worktree list --porcelain | sed -n '/^worktree /p' | wc -l | tr -d ' ')" == 1 ]]
git switch -q main
git remote add origin "$fixture/remote.git"
git push -qu origin main
touch dirty
reject bash scripts/workflow.sh start fix dirty-checkout
[[ "$(git symbolic-ref --short HEAD)" == main ]]
rm dirty
bash scripts/workflow.sh start feat delivery
[[ "$(git symbolic-ref --short HEAD)" == feat/delivery ]]
reject git rev-parse --verify '@{upstream}'
echo feature >feature.txt
git add feature.txt
git commit -qm 'feat: add delivery'
reject bash scripts/workflow.sh start chore
git push -qu origin feat/delivery
reject git push origin feat/delivery:main
git switch -q main
bash scripts/workflow.sh start chore
echo docs >docs.txt
git add docs.txt
git commit -qm 'docs: document delivery'
reject bash scripts/workflow.sh start docs
git push -q origin main
git switch -q feat/delivery
git merge --no-ff --no-commit main
git commit -q -m "Merge main into feat/delivery" -m 'Integration context'
git push -q origin feat/delivery
git switch -q main
reject bash scripts/workflow.sh start feat delivery
git branch -D feat/delivery >/dev/null
reject bash scripts/workflow.sh start feat delivery
git push -q origin :feat/delivery

# Hooks may be bypassed locally; pre-push must inspect every outgoing commit.
echo first >first.txt
git add first.txt
git -c core.hooksPath=/dev/null commit -qm 'feat: bypass commit guard'
echo second >second.txt
git add second.txt
git commit -qm 'chore: follow feature commit'
reject git push origin main
zero=0000000000000000000000000000000000000000
reject bash -c 'printf "%s %s %s %s\n" refs/heads/main "$1" refs/heads/main "$2" | .husky/_/pre-push' _ "$(git rev-parse HEAD)" "$zero"
git reset --hard -q origin/main
reject git push origin :main
reject git push --force origin main~1:main

# Simulate a remote PR merge; starting work must fast-forward local main.
git clone -q "$fixture/remote.git" "$fixture/other"
git -C "$fixture/other" switch -q -c fix/remote
echo remote >"$fixture/other/remote.txt"
git -C "$fixture/other" add remote.txt
git -C "$fixture/other" commit -qm 'fix: add remote delivery'
git -C "$fixture/other" push -qu origin fix/remote
git -C "$fixture/other" switch -q main
git -C "$fixture/other" merge -q --no-ff fix/remote -m 'Merge pull request for remote delivery'
git -C "$fixture/other" push -q origin main
bash scripts/workflow.sh start test synced-base
[[ "$(git rev-parse HEAD)" == "$(git rev-parse origin/main)" ]]
git switch -q main
echo maintenance >maintenance.txt
git add maintenance.txt
git commit -qm 'chore: maintain merged main'
git push -q origin main

# Refuse true force pushes and local merge commits into main.
old=$(git rev-parse HEAD~1)
tip=$(git rev-parse HEAD)
reject bash -c 'printf "%s %s %s %s\n" refs/heads/main "$1" refs/heads/main "$2" | .husky/_/pre-push' _ "$old" "$tip"
git switch -q -c test/local-merge
echo test >test.txt
git add test.txt
git commit -qm 'test: cover delivery'
git switch -q main
git merge -q --no-ff --no-commit test/local-merge
reject git commit -qm 'Merge local delivery'
git merge --abort
git -c core.hooksPath=/dev/null merge -q --no-ff test/local-merge -m 'Merge local delivery'
reject git push origin main
git reset --hard -q origin/main

# Fresh clones and linked worktrees install their own Husky files.
git clone -q "$fixture/remote.git" "$fixture/clone"
(
  cd "$fixture/clone"
  mkdir node_modules
  ln -s "$root/node_modules/husky" node_modules/husky
  mkdir node_modules/.bin
  ln -s ../husky/bin.js node_modules/.bin/husky
  npm run prepare
  reject git commit --allow-empty -qm 'feat: bypass cloned main'
)
git worktree add -q -b test/husky-worktree "$fixture/worktree" main
(
  cd "$fixture/worktree"
  reject bash scripts/workflow.sh start docs
  mkdir node_modules
  ln -s "$root/node_modules/husky" node_modules/husky
  mkdir node_modules/.bin
  ln -s ../husky/bin.js node_modules/.bin/husky
  npm run prepare
  [[ "$(git config --get core.hooksPath)" == .husky/_ ]]
  reject git commit --allow-empty -qm 'invalid message'
  git commit --allow-empty -qm 'test: verify worktree hooks'
)
git worktree remove "$fixture/worktree"

git config core.hooksPath /custom/hooks
reject bash scripts/workflow.sh start docs
npm run prepare
git switch -q --detach
reject bash scripts/workflow.sh start docs

echo 'Workflow checks passed (isolated local repositories; no project remote touched).'
