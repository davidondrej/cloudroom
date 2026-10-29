# Contributing

Use this repo for Cloudroom issues and pull requests, for both the core and the app. Don't file app issues on BB's tracker.

- Include steps to reproduce, what you expected, what happened, and logs. Remove credentials and personal data.
- Keep changes focused. Open an issue before big changes.
- Build and check your change, and say what you tested: the core with [core/](../core/), the app with [gui/README.md](../gui/README.md).
- Keep upstream copyright and license notices. Never commit credentials, runtime data, or build output.

Development happens in a private monorepo. Each release publishes `core/` and `gui/` here together. Accepted pull requests go into the monorepo and ship with the next release.
