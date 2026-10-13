# Development Rules

## Language

Write workspace files in English. Follow the user's language in conversation.

Before naming files or identifiers, writing comments or documentation, or
preparing commit messages and PR descriptions, read the repository-language
rules in `docs/agents/domain.md`.

## Development and testing

Before changing application code, dependencies, or development tooling, read
`docs/agents/development.md`. Before writing tests or fixing a bug, also read
`docs/agents/testing.md`. Follow their validation requirements before delivery.

## Git workflow

Before editing, committing, pushing, or merging, read
`docs/agents/git-workflow.md`. Use branches in the current checkout by default;
use a worktree only when the ticket or implementation instructions require one.

## Agent skills

### Issue tracker

Specs live under `.scratch/<feature>/`, decision questions in `issues/`,
and execution tickets in `tickets/`.
Before reading or publishing work, read `docs/agents/issue-tracker.md`.

### Triage labels

Use the five default triage roles as issue status strings.
Before triaging issues, read `docs/agents/triage-labels.md`.

### Domain docs

Use a single-context layout: root `GLOSSARY.md` and `docs/adr/`.
Before exploring the codebase, read `docs/agents/domain.md`.
