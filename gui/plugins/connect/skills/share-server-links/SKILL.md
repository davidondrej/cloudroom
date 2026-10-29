---
name: share-server-links
description: "Expose a local HTTP server through Cloudroom Connect and give the user its remotely accessible URL."
---

# Share local server links via cloudroom connect

When you start an HTTP server the user should open, give them a connect share
URL — not a localhost URL. Shares work from threads running on any enrolled
host, and the command resolves the thread's host automatically.

1. Check status: run `room-cli connect status --json`. If not paired / not
   connected, give the localhost URL. Connect sets itself up once the user is
   signed in to Cloudroom.
2. From the thread that started the HTTP server, run `cloudroom connect expose
<port>`. It prints that host's share URL. Use `--host <name-or-id>` only
   when you intentionally need another enrolled host; outside a thread,
   sharing defaults to the machine running the Cloudroom server.
3. Give the returned URL to the user as a markdown link. It opens on the
   user's signed-in phones and browsers; it is not a public internet link.
   To set up a new phone, send the user to cloudroom.dev/m to sign in
   (`room-cli connect phone` prints the link).
4. When the server stops, run `room-cli connect unexpose <port>` from the same
   thread (or with the same `--host`) so the share is cleaned up. Use
   `room-cli connect shares [--host <name-or-id>]` to inspect that host's shares.

Server-host shares use `https://<server-label>--<port>.<base-domain>` through
the server tunnel. Other enrolled hosts use
`https://<machine-label>--<port>.<base-domain>` through their daemon. If a
machine was not enrolled through Connect, expose fails with instructions to
remove and re-add it under Settings > Machines.

## Agent instructions setting

Settings → Machines → Cloudroom Connect has a "Tell agents about remote access"
toggle, enabled by default. Use
`room-cli plugin config connect set sendRemoteInstructions false` to suppress the
remote-access message, or `true` to restore it. This controls only the message;
sharing still works. The message otherwise requires active or recent remote
usage. Changes apply when session instructions are next assembled.
