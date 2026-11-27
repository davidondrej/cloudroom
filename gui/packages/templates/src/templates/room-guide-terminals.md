---
kind: instruction
title: Cloudroom Terminal Guide
summary: Creating and managing persistent terminals across thread, environment, and machine scopes.
intent: Help agents route terminal sessions explicitly and manage them by terminal ID.
editingNotes: Keep scope selectors and ID-only commands aligned with room-cli terminal --help.
---
Terminal commands

Use terminals for long-running commands that should stay alive for the user,
such as dev servers, watch tasks, REPLs, and database consoles. A terminal is a
real persistent PTY and appears in the Cloudroom UI.

List and create require exactly one explicit scope:

  room-cli terminal list --thread <thread-id>
  room-cli terminal list --environment <environment-id>
  room-cli terminal list --machine <id-or-name> [--cwd <path>]

  room-cli terminal create --thread <thread-id> --command "pnpm dev"
  room-cli terminal create --environment <environment-id>
  room-cli terminal create --machine <id-or-name> [--cwd <path>]
    --host <id-or-name>                   Alias for --machine
    --title <title>                       Display title
    --cols <n>                            Initial terminal columns
    --rows <n>                            Initial terminal rows
    --attach                              Attach after creating
    --json                                Print machine-readable output

Machine names are resolved to an explicit machine ID. No scope defaults to the
primary machine, and --cwd is valid only with --machine or --host.

Thread-scoped terminals receive ROOM_THREAD_ID, ROOM_PROJECT_ID,
ROOM_ENVIRONMENT_ID, and ROOM_THREAD_STORAGE. Use room-cli status or --self
without setting context manually. Environment-only and machine-only terminals
have no current thread and do not inherit another thread's context.

A terminal runs the machine's own shell: $SHELL (then zsh, bash, sh) on macOS
and Linux; on Windows, PowerShell 7 when `pwsh` is on PATH, otherwise Windows
PowerShell, otherwise cmd. Write --command in that shell's syntax. To run a
program with arguments without knowing the shell, pass them after `--`
(`room-cli terminal create --thread <id> -- pnpm test "my file.ts"`): the machine
quotes each argument for its own shell. On Windows it runs the program directly,
so shell built-ins (`echo`, `dir`, PowerShell cmdlets) need --command instead. `send --enter` appends a newline; on Windows
it sends a carriage return, as the Enter key does. The terminal's exit code is
the command's own exit code on every shell.

All other operations need only the terminal ID:

  room-cli terminal show <terminal-id>
  room-cli terminal attach <terminal-id>        Ctrl-B d detaches
  room-cli terminal send <terminal-id> --text <text> [--enter]
    --stdin                               Read bytes from stdin instead of --text
  room-cli terminal resize <terminal-id> --cols <n> --rows <n>
  room-cli terminal rename <terminal-id> <title>
  room-cli terminal restart <terminal-id>       Atomically replaces it with a shell; does not replay the original command
  room-cli terminal close <terminal-id> [--if-clean]

  room-cli terminal output <terminal-id>
    --since-seq <n>                       Read output chunks from a sequence
    --tail-bytes <n>                      Bound output to latest N bytes
    --limit-chunks <n>                    Bound output to latest N chunks
    --json                                Print chunks, nextSeq, and truncated

  room-cli terminal wait <terminal-id>
    --contains <text>                     Wait for new output containing text
    --regex <pattern>                     Wait for new output matching regex
    --exit                                Wait until the terminal exits
    --from-start                          Include existing scrollback
    --timeout <seconds>                   Timeout
    --poll-interval <ms>                  Polling interval

For a dev server, prefer:

  room-cli terminal create --thread <thread-id> --title "pnpm dev" --command "pnpm dev"
  room-cli terminal wait <terminal-id> --contains "Local:" --timeout 120

Do not run long-lived servers as one-off foreground commands when the user will
need to inspect logs, refresh the page, or stop the process later.
