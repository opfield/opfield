# Contributing to Opfield

Thank you for your interest in Opfield. Bug reports, reproducible issue descriptions, and feature requests are welcome through [GitHub Issues](https://github.com/opfield/opfield/issues).

## Reporting bugs

Please include:

- steps to reproduce;
- expected and actual behavior;
- Opfield version and environment details; and
- relevant logs with secrets and personal data removed.

## Security reports

Do not report a suspected vulnerability in a public issue or pull request. Follow [SECURITY.md](SECURITY.md).

## Building and testing

Opfield is an Nx and pnpm monorepo: TypeScript app packages (backend, frontend, status page, SDKs) and Go packages (node daemons and the relay). You need Node.js 24 or later, pnpm 9 or later, Go 1.24.4 or later, Docker, and `protoc`.

```bash
pnpm install
pnpm dev:infra      # local Postgres, Redis, ClickHouse and the internal registry (Docker)
pnpm db:migrate
pnpm dev:all        # backend, frontend and status page dev servers
```

Before you propose a change, run:

```bash
pnpm lint
pnpm typecheck
pnpm test           # the light suite: TypeScript and Go
pnpm build
```

For daemon or relay changes, `pnpm proto` (when the protobuf contracts change), `pnpm test:daemon`, `pnpm lint:daemon`, `pnpm test:relay`, and `pnpm lint:relay` are enough. The [development guide](docs/development.md) covers the environment, the repository layout, migrations, and every command.

Keep commits focused, describe what changes for users in the pull request, and add or update tests for authorization, authentication, update trust, data integrity, and untrusted input when you touch them. No CLA or DCO sign-off is needed to open an issue or a pull request.

## Source-code changes

Opfield is source-available under the [PolyForm Perimeter License 1.0.1](LICENSE.md). It permits use, modification, derivative works, and distribution for permitted purposes. It does not permit providing to others a product marketed as a substitute for Opfield.

You may fork the repository and prepare or distribute changes within the scope of PolyForm Perimeter. Contributing changes back to the official Opfield project is separate: the Licensor may require written contribution terms that allow accepted work to be distributed under Opfield's current license, paid agreements, and the Product Continuity Grant.

To propose a code contribution, first email [support@opfield.dev](mailto:support@opfield.dev) with a short description of the intended change. An issue or pull request by itself does not grant permission to modify Opfield or require Opfield to accept the contribution.

## Release notes

Each release's notes are the message of its annotated tag, published on its [GitHub release](https://github.com/opfield/opfield/releases); see [CHANGELOG.md](CHANGELOG.md).

## Rights holder and license

Opfield is published under [LICENSE.md](LICENSE.md). A pull request or other contribution does not itself transfer ownership of the contribution or other rights except as stated in applicable contribution terms.

Use of Opfield remains subject to [LICENSE.md](LICENSE.md). Personal, Business, and Enterprise keys are additionally subject to the [Paid Key Terms](COMMERCIAL-LICENSE.md). Contributions accepted under separate written contribution terms may be licensed as part of Opfield.
