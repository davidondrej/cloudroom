---
kind: instruction
title: Cloudroom Guide Overview
summary: System overview and chapter index for the Cloudroom CLI guide.
intent: Orient agents to cloudroom core concepts and help them find the right guide chapter.
editingNotes: Keep this concise. Concepts only — command details belong in chapter files.
---
Cloudroom is an agent orchestration tool for managing multiple agents.

Core concepts:

- Project — maps to a repository. All threads belong to a project.
- Thread — a single agent conversation. The fundamental unit of work.
- Environment — where a thread runs. Kinds: project checkout or isolated worktree. Multiple threads can share an environment.
- Machine — an execution host where project sources and thread environments live.
- Terminal — a persistent PTY session scoped to a thread, environment, or machine path. Use terminals for long-running commands such as dev servers.
- Provider — the agent backend powering a thread (e.g., codex, claude-code). Each provider supports different models.

Threads can have a parent-child relationship. The parent coordinates the child and receives lifecycle notifications when it completes, fails, or is interrupted. Threads without a parent are managed directly by the user.

Context variables set automatically inside a thread environment:

- ROOM_PROJECT_ID — current project
- ROOM_THREAD_ID — current thread
- ROOM_ENVIRONMENT_ID — current environment
- ROOM_CLI — absolute path to Cloudroom's daemon-managed `room-cli` executable; `room-cli` re-execs to this path when needed. Official BB is separate.

Run `room-cli status` to see your current context (resolved project and thread IDs).
It also warns when an enabled plugin is not running (incompatible after a Cloudroom
upgrade, failed to load, or missing); run `room-cli plugin list` for the detail.

All commands support --json for machine-readable output.

To make a repo work with cloudroom worktrees, run `room-cli guide environments` for the
repo-level `.bb-env-setup.sh` and `.bb-env-teardown.sh` hooks. Run `room-cli guide
agent-configuration` for the data-dir and workspace files that customize agent
behavior.

Run `room-cli guide <chapter>` for command details:

  threads              Spawning, inspecting, messaging, and managing threads
  environments         Environment lifecycle hooks, operations, commits, and merges
  agent-configuration  AGENTS.md and skills files that shape agents
  providers            Discovering providers and models
  projects             Project CRUD and sources
  machines             Listing and targeting execution machines
  terminals            Persistent PTY sessions across all supported scopes
  browser              Experimental built-in browser tabs and control leases
  customization        Theming the app palette, settings, mobile push
                       notifications
  plugins              Installing plugins, plugin marketplaces, and their
                       contributed cloudroom commands
  automations          Loops: scheduling, editing, and reviewing recurring or one-shot work
