# Cloudroom

- `core/`: the Rust core. Keep one Rust package and one service; apps call its API. From `core/`, run `cargo fmt --check`, `cargo clippy --locked --all-targets -- -D warnings`, and `cargo test --locked --all-targets`.
- `gui/`: the desktop app, built on BB. Build and checks: [gui/README.md](gui/README.md).
- `skills/`: built-in skills the app gives every agent.
- Keep credentials and internal notes in ignored files. Keep upstream license notices.
