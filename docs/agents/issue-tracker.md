# Issue tracker: Local Markdown

Specs, decision questions, and execution tickets live as markdown
files in `.scratch/`.

## Conventions

- One feature per directory: `.scratch/<feature-slug>/`.
- Spec: `.scratch/<feature-slug>/spec.md`.
- Decision questions: `.scratch/<feature-slug>/issues/<NN>-<slug>.md`.
- Execution tickets: `.scratch/<feature-slug>/tickets/<NN>-<slug>.md`.
- Number files from `01` independently within each directory.
  Use one file per question or ticket.
- Record triage state as a `Status:` line near the top of each file.
  See `triage-labels.md` for the role strings.
- Append comments and conversation history under a `## Comments` heading.

## When a skill says "publish to the issue tracker"

Choose the path by purpose:

- A spec goes in `spec.md`.
- A question requiring investigation or a decision goes in `issues/`.
- Defined work to implement goes in `tickets/`.

Create directories as needed.

## When a skill says "fetch the relevant ticket"

Read the referenced file. If only a number is supplied, resolve it
within the feature and directory. Ask for clarification when both
an issue and a ticket match.

## Wayfinding operations

Used by `/wayfinder`. The map links to decision questions and execution
tickets.

- Map: `.scratch/<feature-slug>/map.md`, containing Notes,
  Decisions-so-far, and Fog.
- Child file: use `issues/NN-<slug>.md` for investigation or decision
  questions and `tickets/NN-<slug>.md` for execution work.
- Record the question or work in the body. A `Type:` line records
  `research`, `prototype`, `grilling`, or `task`.
  Choose the directory by purpose, including whether a prototype
  answers a question or implements a settled decision.
- Blocking: use feature-relative paths, such as
  `Blocked by: issues/01-storage-choice.md, tickets/02-schema.md`.
  A child is unblocked when every referenced file is resolved.
- Frontier: scan both directories for open, unblocked, unclaimed
  files. Sort by number, then by path to break ties.
- Claim: set `Status: claimed` and save before any work.
- Resolve: append the result under an `## Answer` heading,
  set `Status: resolved`, then append a context pointer
  (gist + link) to Decisions-so-far in `map.md`.
