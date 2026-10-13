# Git workflow

This document is the source of truth for Git rules. Agent instructions and local
skills point here; scripts and hooks enforce the mechanical parts.
Write workspace files, commit messages, and PR descriptions in English.

## Repository contents and initialization

Commit source code, tests, configuration, examples, user documentation,
`AGENTS.md`, project conventions in `docs/agents/`, domain vocabulary, and ADRs.
Keep documentation alongside the behavior it describes.

Local planning in `.scratch/`, personal skills in `.agents/`, `skills-lock.json`,
and local overrides stay outside version control. Back up needed local material
separately. Cloning does not restore planning files or install personal skills.
When installing the local `implement` skill, have it read this workflow and
verify the delivery branch before its first implementation edit.

Before the first commit, review ignore rules and intended files, then inspect
the staged diff for local material and credentials. Initialize `main` and use a
`chore` commit for repository setup. Configure only the remote repository the
user specifies. Until `origin` exists, starts use local `main`; once configured,
starts require synchronization with `origin/main`. The first push creates
remote `main` from the reviewed bootstrap history.

## Starting work

Define one cohesive delivery from a ticket, related tickets, or a small direct
request. Each branch and PR must be independently reviewable, mergeable, and
reversible. Ticket count does not determine branch count. Split large features
into independently useful deliveries. Merge a prerequisite delivery before
starting work that depends on it.

After installing development dependencies, run `npm run prepare` in each clone
or worktree. The standard `prepare: husky` lifecycle also runs this command when
dependency installation allows scripts. Husky sets `core.hooksPath` to
`.husky/_`, resolved relative to the checkout where Git runs. Each checkout
needs its own generated files. Commit-message and push checks live directly in
`.husky/`; generated `.husky/_` files stay outside version control.

Before the first implementation edit, inspect the working directory and branch.
For a new delivery, run:

```bash
bash scripts/workflow.sh start feat conversation-history
bash scripts/workflow.sh start docs
bash scripts/workflow.sh start chore
```

The start command requires a clean checkout on `main`. With `origin` configured,
it fetches and fast-forwards to `origin/main`, refusing local divergence or
unpublished commits. Feature starts create and switch to a new branch in the
current directory, with no upstream until the first push. Docs/chore stay on
`main`. An existing delivery resumes on its own branch after verifying its scope
and working directory. Preserve existing edits before switching branches; if
implementation edits already exist on `main`, inspect and move them to the
appropriate delivery branch before continuing. Separate mixed scopes deliberately.

## Branches and direct commits

Use `<type>/<short-delivery-name>` with lowercase English words separated by
hyphens, for both human and agent work. Name the change; ticket IDs belong in
local planning. Use `main` as the integration branch.

| Type | Purpose | Route |
| --- | --- | --- |
| `feat` | New capability | Branch and PR |
| `fix` | Correct broken behavior | Branch and PR |
| `refactor` | Restructure without changing intended behavior | Branch and PR |
| `test` | Tests without a production behavior change | Branch and PR |
| `docs` | Documentation and project conventions | Direct commit on `main` |
| `chore` | Tooling, dependencies, and maintenance | Direct commit on `main` |

Choose the type by the primary purpose. A delivery's implementation, tests, and
necessary documentation stay together on its branch. Docs/chore need no PR or
pre-merge review, but still require validation and staged-diff inspection.
Serialize direct commits on clean, idle, synchronized `main`.

## Isolation and parallel work

Use branches in the current checkout by default. One writer owns that directory
at a time; coordinate branch switches and writes with the current owner.
Different branch names do not isolate uncommitted files or the index.

Use a worktree only when a ticket or implementation instruction explicitly
requires it, typically for parallel `implement` sessions. Assign each parallel
delivery a distinct directory, branch, and writer, based on updated `main`.
Record ownership, branch, directory, and blockers in canonical local tickets
using the tracker conventions. Give each session absolute ticket/spec paths;
when planning or local skills are absent from a worktree, provide access to the
canonical local files before implementation. Preserve needed ignored material
before cleanup. Use the creating tool's cleanup mechanism for managed worktrees.

## Validation and delivery

Implement only the selected scope and update its tests and documentation.
Run applicable local checks before every code push. Application and tooling
checks follow [Development](development.md#validation-and-completion), with test
rules in [Testing](testing.md). Currently, workflow changes are checked with
`bash tests/workflow.sh`; documentation changes require content and link
verification. Inspect selected staged files before committing.

Push a delivery with `git push -u origin <type>/<delivery-name>` and open a PR
describing the problem, resulting behavior, scope, and validation. Include enough
context for reviewers without local planning files; a GitHub Issue is optional.
Fix CI failures on the same branch, reproduce failing commands where possible,
and verify affected platforms when relevant.

Integrate PRs one at a time. Fetch the latest `origin/main` before merging; if it
has advanced beyond the delivery base, merge it into the delivery branch, resolve
conflicts, verify both deliveries' behavior, and push the integration changes.
Merge only after review and required checks pass. Always use GitHub's **Create a
merge commit** to retain the branch boundary and original history. Squash and
rebase merges are outside this workflow.

Disable automatic head-branch deletion and merge without `--delete-branch`.
Retain remote delivery branches at their final heads; delete them only on the
user's explicit request. Later deliveries use new branches from updated `main`.
After merge, update ticket outcomes and PR links, then switch a clean, idle
checkout to `main` and synchronize it with `git pull --ff-only origin main`.
Local delivery branches may be removed after confirming their heads are in
`main`.

After a PR is merged, remove its delivery worktree as part of completion once
its writer is idle and the worktree is no longer needed. Confirm its head is
included in updated `main`, inspect tracked, untracked, and ignored files, and
preserve any needed local material before removal. Use the creating tool's
cleanup mechanism for managed worktrees; use `git worktree remove <path>` for
ordinary Git worktrees. Do not force removal to discard unresolved changes.
Record the cleanup in the canonical ticket. If cleanup must be deferred, record
the reason and remaining owner in the ticket. Worktree cleanup does not delete
the retained remote delivery branch.

## Commit messages and guards

Use a single-line Conventional Commit subject:
`<type>(<scope>): <short imperative summary>`. Omit scope when it adds no value.
Keep the subject within 72 characters and omit the body by default. Put delivery
details and validation in the PR; use a body only when explicitly requested.
Git-generated integration messages are allowed on delivery branches.

The commit-message hook validates the subject and allows only docs/chore direct
commits on `main`. The push hook checks every newly pushed `main` commit,
including bootstrap history, for direct docs/chore commits and rejects deletion,
non-fast-forward updates, and pushes from other source refs into `main`.
Feature branches and version tags push normally. These guards inspect declared
types, not semantic scope, and can be deliberately bypassed; they supplement
review and CI. An explicitly requested commit body requires bypassing the local
single-line check after reviewing the message.

When a remote and CI exist, configure merge commits, retained head branches, and
required PR checks. Any remote protection must accommodate the agreed docs/chore
direct-push route. Local installation alone does not configure remote settings.

## Releases

Tag a reviewed release commit with a version such as `v0.1.0` and document its
changes. Package publication and deployment are separate release actions.
