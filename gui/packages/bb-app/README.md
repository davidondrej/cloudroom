# Cloudroom launcher

Runs Cloudroom's server and host daemon as child processes, restarts either one if it crashes, and captures their logs in `<data-dir>/logs/*-stdio.log`.

- `bb-app` starts the whole app. The desktop app and `pnpm start` run this.
- `bb-app host-daemon [join]` runs only the host daemon on a joined machine. `install-machine.sh` runs it.
- `room-cli` finds this machine's server and runs the bundled CLI.

Code: `src/start.ts` (whole app), `src/host.ts` (joined machine, `room-cli`), `src/context.ts` (folders, ports, environment), `src/processes.ts` (child processes and health checks).

The npm name `bb-app` stays for now: joined machines update by installing the server's `/install/bb-app.tgz`.
