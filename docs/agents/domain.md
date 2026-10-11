# Domain Docs

How the engineering skills consume this repo's domain documentation.

## Before exploring, read these

- `GLOSSARY.md` at the repo root.
- ADRs in `docs/adr/` that touch the area you're about to work in.

If these files don't exist, proceed silently. Don't flag their absence
or suggest creating them upfront. The `/domain-modeling` skill,
reached via `/grill-with-docs` and `/improve-codebase-architecture`,
creates them lazily when terms or decisions get resolved.

## File structure

Use a single-context layout:

- `GLOSSARY.md`: domain vocabulary for the repo.
- `docs/adr/`: architectural decision records,
  numbered as `0001-<decision-slug>.md`.

## Use the glossary's vocabulary

When your output names a domain concept—in an issue title, refactor
proposal, hypothesis, or test name—use the term defined in `GLOSSARY.md`.
Don't drift to synonyms the glossary explicitly avoids.

If a concept isn't in the glossary, reconsider whether the project
uses that language. If it's a real gap, note it for `/domain-modeling`.

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly
rather than silently overriding it. Name the ADR and explain why
the decision may need reopening.
