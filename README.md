# Mybots

A local personal assistant with multiple Bots, one direct Thread per Bot, and
one shared Team Computer for shell commands and working files. Host-side Pi
Durable owns conversation execution and history; Docker supplies the tools.

## Local startup

Use Node.js 24.21.0 and npm. Install and build:

```sh
npm ci
npm run prepare
npm run build
```

Start without credentials and use Web Provider settings as described in the [local configuration
guide](docs/durable-chat.md#provider-settings-and-startup). Configuration, SQLite
state and Computer files live together under `data/`, outside Git. Start the API,
worker and built Web:

```sh
npm start
```

Open `http://127.0.0.1:4173` and connect with the credential in
`data/client-credential`. Ctrl+C stops the application
and preserves its data. Start Docker Desktop and run `npm run build:computer`
once before using shell/file tools. Plain chat does not require Docker.

See [local operation](docs/durable-chat.md) for model configuration, alternate
roots/ports, recovery and [retiring an older installation](docs/durable-chat.md#retiring-an-older-installation).

## Documentation and development

The [documentation index](docs/README.md) covers the implemented architecture and
its four decision records. See the [glossary](GLOSSARY.md) for product vocabulary.

Install Chromium with `npx playwright install chromium`. Run `npm run verify`
for formatting, lint, types, offline tests, builds, compiled startup and browser
checks; run `bash tests/workflow.sh` for Git workflow checks.
`npm run test:infrastructure` separately exercises real Docker with a controlled
model. These checks do not establish actual-provider acceptance.

Use `npm run dev` for source API/worker startup with the same arguments as
`npm start`; it serves the built Web. Use `npm run test:watch` for offline tests.

- [Development](docs/agents/development.md)
- [Testing](docs/agents/testing.md)
- [Git workflow](docs/agents/git-workflow.md)
