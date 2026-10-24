# Development

## Tooling status

The [architecture](../architecture.md) is accepted but not yet implemented.
The isolated [persistent chat entry](../durable-chat.md) implements the first
Web/API/worker slice. Default launch commands still describe the previous runtime.
`package.json`, the lockfile and tool configurations are authoritative for
commands available in this checkout. Update them with each implementation slice;
keep one supported startup path after cutover.

## Technical baseline

- Use TypeScript with Node.js 24.21.0 and npm. Pin direct dependencies and keep
  local development and CI on the same baseline; commit lockfile changes.
- Use ESM, strict types and explicit type-only imports. Relative TypeScript
  imports use `.ts`; configure compilation to rewrite them to `.js` and verify
  that Node.js can execute the output.
- Keep syntax erasable for native Node.js type stripping. Use `tsc` for types
  and builds, Vitest for tests, Biome for formatting/lint and Playwright for Web.
- Type-check source, tests and TypeScript configuration. Keep dependencies,
  generated output, credentials and runtime data outside Git.
- Organize new code under the accepted application/package boundaries. Create
  packages when used; legacy paths and runner-specific tooling do not constrain
  the target. Retire obsolete dependencies and callers with their implementation.

## Code conventions

- Keep model SDK details in Agent integration and Docker details in the sandbox
  boundary. Core behavior must be testable without live credentials.
- Use explicit types at module boundaries. Validate `unknown` external inputs;
  use `any` only when an external API requires it, with a local explanation.
- Check installed dependency types and documentation before using an API.
- Change only the requested behavior. Add abstractions for actual uses, not
  hypothetical extensions.
- Start processes only at entry points; imports must not open connections or
  start workers. Give long-running resources explicit cleanup and cancellation.
- Preserve the ownership rules in [conversation execution](../conversation-execution.md)
  and [Computer and resources](../computer-and-resources.md). Do not recreate
  legacy queues, recovery engines or resource versioning behind new interfaces.

## Command contract

| Script | Required behavior |
| --- | --- |
| `check` | Formatting, lint and type checks without modifying files |
| `format` | Apply formatting fixes |
| `test` / `test:watch` | Run/watch ordinary offline tests |
| `build` | Clean and compile active workspaces |
| `verify` | Check, ordinary tests, build, compiled startup smoke and browser checks |
| `test:browser` | Build and run browser checks |
| `test:infrastructure` | Separately invoked Docker checks with controlled providers |

Startup checks must exercise executable entry points and exit without live
credentials. The existing infrastructure command covers the legacy runtime;
replace its scope with Team Computer checks during implementation. The new
one-command startup must be documented and verified when delivered. Existing
startup scripts do not establish that the target system is runnable.

## Validation and completion

1. Define expected behavior and follow [Testing](testing.md) for application changes.
2. Run affected tests and type checks during development; after code changes,
   run `check` and fix reported problems.
3. Before application or tooling delivery, run `verify`. For tooling changes,
   also exercise development startup and test watching. Keep CI on the same
   verification command and retain `bash tests/workflow.sh` for workflow checks.
4. For documentation-only changes, verify content, relative links and agreement
   with actual tooling status. Follow [Git workflow](git-workflow.md#validation-and-delivery).
5. Report behavior changes and validation results, including unavailable checks.

Update tests and documentation with their behavior. A passing test suite does
not replace type checks or compiled execution. Docker integration and explicitly
authorized real-provider acceptance remain distinct from ordinary validation.
