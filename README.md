# Cloudroom

Start an agent on your Mac. Move it to the cloud mid-task.

[Download](https://www.cloudroom.dev/download) · [Website](https://www.cloudroom.dev) · [Changelog](https://www.cloudroom.dev/changelog) · [Security](https://www.cloudroom.dev/security)

![Teleport moves a running agent from your Mac to the cloud and back, with the same chat, model, and effort.](.github/teleport.png)

Cloudroom is a desktop app for Claude Code, Codex, and Pi. Your agents run on your Mac or in the cloud, on your own subscriptions. This repo holds all of its open-source code.

- **Teleport.** Move a running thread to the cloud and back. Same chat, model, and effort.
- **Local and Cloud, side by side.** Each Cloud thread gets its own sandbox and Git branch.
- **Mac access.** Cloud agents can reach your Mac. You pick Off, Read-only, Ask first, or Full.
- **Your own cloud.** Run the core on your own Linux machine. No Cloudroom account needed.

For Apple Silicon Macs (macOS 13+), Linux x64 (alpha), and Windows 11 (beta).

## What's in this repo

- [`gui/`](gui/): the desktop app, built on [BB](https://github.com/get-bb/bb).
- [`core/`](core/): the Rust service that runs agents in the cloud and saves their history. Works with Claude Code, Codex, Pi, OpenCode, Hermes, Cursor, and Devin.
- [`skills/`](skills/): the agent skills that ship with Cloudroom.

## Get started

- **Use the app:** [download it](https://www.cloudroom.dev/download). It updates itself.
- **Host the core yourself:** on Ubuntu 24.04, run the commands below, then [connect the app](core/docs/setup.md#connect-the-desktop-app) with your server's URL and token. Full guide: [setup](core/docs/setup.md).

    ```sh
    curl -fsSL https://cloudroom.dev/install.sh -o install.sh
    sudo bash install.sh
    ```

- **Build the app:** see [gui/README.md](gui/README.md).
- **Build the core:** needs Rust 1.89+.

    ```sh
    cd core
    cargo build --locked --release
    cargo test --locked --all-targets
    ```

Don't want to host it yourself? [Get hosted Cloudroom free](https://www.cloudroom.dev).

Core docs: [HTTP API](core/docs/api.md) · [storage](core/docs/storage.md) · [harnesses](core/docs/harnesses.md) · [session lifecycle](core/docs/session-lifecycle.md) · [diagnostics](core/docs/observability.md) · [dashboard API](core/docs/dashboard.md)

## Security

- Agents run as a separate Linux user, with no admin rights.
- Every API request needs a secret token. The API listens only on localhost unless you put it behind HTTPS.
- History stays on your machine's own disk.
- Agents run without approval prompts, so give each trusted user their own machine.

Report vulnerabilities privately: see [SECURITY.md](.github/SECURITY.md).

## Contributing

Issues and pull requests are welcome. For big changes, open an issue first. See [CONTRIBUTING.md](.github/CONTRIBUTING.md).

Licensed under [Apache 2.0](LICENSE). BB's MIT notice is in [NOTICE](NOTICE).
