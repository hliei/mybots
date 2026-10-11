# mybots

A TypeScript and Node.js project for an interactive CLI and a message-platform
bot, with a shared agent core.

The development toolchain is configured. Application entry points currently
print a setup message or help and exit; chat, model calls, and platform
connections are not implemented yet.

## Setup

Use Node.js 24.21.0, pinned in `.nvmrc`, and npm. With nvm installed:

```sh
nvm install
nvm use
npm ci --ignore-scripts
```

If Node.js 24 is not installed, npm can run a command with a temporary runtime:

```sh
npm exec --yes --package=node@24.21.0 -- npm ci --ignore-scripts
npm exec --yes --package=node@24.21.0 -- npm run verify
```

Direct development dependencies use exact versions. Commit `package-lock.json`
with dependency changes. To install or update dependencies locally, use
`npm install --ignore-scripts` and review the resulting changes.

## Development

```sh
npm run dev:cli
npm run dev:bot
```

These commands watch their TypeScript entry point and restart after changes.
The current entry points exit after printing their setup message; the watcher
stays active until stopped with Ctrl+C. Pass `-- --help` to print help.

## Checks and tests

```sh
npm run check
npm test
npm run test:watch
npm run verify
```

`check` checks formatting, lint, and types without modifying files. Type checking
includes application source, tests, and the Vitest configuration. Run
`npm run format` to apply formatting fixes.

Ordinary tests use Vitest in Node.js and do not require credentials. Run a
specific file with `npm test -- tests/startup.test.ts`. Live-service tests belong
in `tests/live/` and are excluded from ordinary test discovery; no live-test
command is configured yet.

`verify` runs checks, ordinary tests, compilation, and offline startup checks
of both compiled entry points. It does not start a long-running service or
contact a model or messaging platform.

## Build and run

```sh
npm run build
npm run start:cli
npm run start:bot
```

Builds contain application code under `dist/`; tests and tool configuration
are not emitted. Start commands use the existing build. For offline help:

```sh
npm run start:cli -- --help
npm run start:bot -- --help
```

## Project rules

- [Development](docs/agents/development.md)
- [Testing](docs/agents/testing.md)
- [Git workflow](docs/agents/git-workflow.md)
- [Agent instructions](AGENTS.md)
