# Mybots

A local personal assistant with multiple Bots, one direct Thread per Bot, and
one shared Team Computer for shell commands and working files.

The accepted target architecture uses host-side Pi Durable for conversation
execution and Docker for tools. The refactor is **not implemented yet**; the
current source and startup scripts still use the previous runtime. The documents
below describe the target, not a completed migration or acceptance result.

## Documentation

Start with the [documentation index](docs/README.md): three short architecture
guides and four decision records, numbered from `0001`.
See the [glossary](GLOSSARY.md) for product vocabulary.

## Development

Use Node.js 24.21.0 and npm. Install dependencies and browser test prerequisites:

```sh
npm ci
npm run prepare
npx playwright install chromium
```

Run `npm run verify` for formatting, lint, types, offline tests, builds, compiled
startup checks and browser tests. These checks cover the current implementation;
they do not establish acceptance of the target architecture. Existing launch
commands remain legacy until the implementation cutover supplies the new
one-command startup.

- [Development](docs/agents/development.md)
- [Testing](docs/agents/testing.md)
- [Git workflow](docs/agents/git-workflow.md)

## Persistent chat entry

The isolated Web/API/worker chat slice is available with `npm run start:durable`.
See [persistent local chat](docs/durable-chat.md) for host model configuration,
connection credentials, storage ownership and verification. The default entry
has not yet switched to this runtime.
