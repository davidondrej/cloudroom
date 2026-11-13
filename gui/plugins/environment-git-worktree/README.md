# Worktree

Creates an isolated Git worktree from the project checkout on an enrolled machine. The plugin supplies base-branch inputs, runs workspace setup, and removes owned worktrees after core retires them. Project sub-threads receive fresh worktrees by default. Local forks with a named base branch from the CLI, SDK or a plugin use the thread's repo when it differs from the project's (`sourcePath` input). The app's branch picker keeps using the project's repo.

After each new worktree, the plugin prebuilds one spare per checkout in the background (`worktrees/.spare-<hash>/`). The next create moves it into place and switches branch instead of writing every file, then runs `post-checkout` once, as `git worktree add` does. It falls back to a normal `git worktree add` when there is no usable spare. No spare is built after a fork, for a checkout with submodules, on Git older than 2.36, or with under 10 GB free. Spares unused for 7 days are deleted, as are all spares when the disk is that full.

Bundled and installed automatically. Select it through the environment picker or `bb thread spawn --environment-provider git-worktree`. Use `bb environment providers --json` for its inputs and availability.

The Plugin Guide documents the experimental environment-provider contract. Core owns durable launches, retries, cancellation, retirement, and teardown; this plugin owns resource creation and removal.
