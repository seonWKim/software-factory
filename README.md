# software-factory

A local-first software factory: agents take a work item from intake to a reviewed pull request, humans decide what the design reserves for them, and the factory improves itself from recorded outcomes.

- Plan: [`PLAN.md`](PLAN.md)
- Design: [`docs/design.md`](docs/design.md)
- Setup and secrets: [`docs/setup.md`](docs/setup.md)
- Architecture: [`docs/architecture.md`](docs/architecture.md)
- Plugins (which implementations exist, how to enable, switch or disable them): [`docs/plugins.md`](docs/plugins.md)

Status: Phase 1 (minimal factory, built by hand). Set up: [`SET_UP.md`](SET_UP.md) (`npm run setup`).

## Commands

Run `make help` (or just `make`) to list the commands. Each target wraps `npm run factory -- <cmd>` (setup wraps `npm run setup`), for example `make dev`, `make status ID=<work item id>`, `make setup ARGS=--rotate-github`. `make` is optional; the npm commands work without it.
