Resume Local threads that died because your internet dropped. When the internet is back, each thread gets "Please continue." and picks up where it stopped. You do not have to come back and press send.

## What you get

- A "Waiting for internet" card on each thread that lost its connection.
- Threads resume within about 10 seconds of the internet coming back, even after an app restart.
- Flaky Wi-Fi cannot burn your retries: each retry needs the internet to stay up longer (5 s, then 30 s, 2 min, 5 min).
- After 6 hours offline it stops waiting and says so. A Mac waking from sleep checks the internet before it gives up. Send now still retries.
- Cloud threads are left alone: they keep running when your Mac goes offline.
- With a proxy set (`HTTPS_PROXY`) that Node does not use, it cannot check the agents' route, so it retries right away instead of waiting.

## How it works

The plugin reacts to turns that failed on a network error: Claude Code's "Can't reach the API server" family, Codex connection failures, and Pi's "fetch failed". A Codex stream disconnect, or a Claude server error with no HTTP status, counts only if a check right then finds no internet. While a thread waits, it checks every 5 seconds with a real request to Claude's and Codex's API hosts, and at once when the Mac's network addresses change. Each held thread is re-asked every minute. Nothing runs while no thread waits.

## CLI

- `bb internet-watch status [--json]`: show the internet state and the threads waiting for it.
