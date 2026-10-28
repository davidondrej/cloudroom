# Using bb on multiple devices

There are two separate ways to use more than one device with bb:

- A browser device is a control surface for one bb server. It can view projects,
  send prompts, and manage threads, but it does not execute them.
- An execution machine runs a host daemon. One bb server can dispatch project
  sources and thread environments across several enrolled machines.

You can use either story independently or combine them.

## Open bb from another browser

The simplest managed route is **Cloudroom Connect**. Once you are signed in to
Cloudroom, the server registers itself with our relay at cloudroom.run, holds the
tunnel, and reconnects after restart. On a phone, open cloudroom.dev/m and sign in
with your Cloudroom account (`room-cli connect phone` prints the link).

For a private tailnet route, keep bb on its loopback default and publish it
through Tailscale Serve:

```bash
tailscale serve --bg --https=443 http://127.0.0.1:38886
npx bb-app config set BB_APP_URL https://<machine>.<tailnet>.ts.net
```

Start bb with `npx bb-app` and open the HTTPS URL. Tailscale ACLs are the access
boundary for this route; do not expose the server through Funnel or the public
internet. Cloudroom Connect addresses only open on phones and browsers signed in
to that Mac.

Existing remote host daemons that target a direct tailnet IP or
`http://<machine>.<tailnet>.ts.net:38886` must migrate before restarting an
upgraded server. Prefer signing in to Cloudroom and re-adding the machine from
Settings → Machines so its installer records the cloudroom.run route. The
private alternative is to open bb through the Tailscale Serve URL and re-run
the Add machine installer from there.

For compatibility only, `npx bb-app --server-bind-host 0.0.0.0` restores direct
IPv4 network access. The public API is unauthenticated and permits command
execution and file reads, so use wildcard binding only behind a trusted network
boundary and never through Funnel or the public internet.

Inside a container, `0.0.0.0` listens on the container's IPv4 interfaces; the
container runtime must still publish that port to the host (for example,
`docker run -p 3000:3000 ...`). Host firewall and upstream network rules also
remain separate from bb's bind setting.

### Use editors installed on the browser device

Local editor integration is optional. It connects the remote bb page to the
loopback-only helper started by the bb desktop app or `npx bb-app` on the
computer running the browser. The helper discovers installed editors and opens
paths without exposing its API to the network.

If that browser should open work-host files in its local editor, first make
sure bb is running on the browser device. Verify `ssh <work-host>` succeeds
there, then map the server/work-host to that SSH target:

```bash
npx bb-app client ssh-target set <bb-server-origin> <ssh-target> --host-id <work-host-id>
```

Copy the work-host ID from `bb machine list`. `--host-id` may be omitted when
the server has exactly one machine. A browser running on an enrolled execution
machine needs no SSH mapping for that same machine: connected daemons report
their helper ports to the server, and the browser discovers the matching local
helper after you enable integration.

Then open Settings → Files in that browser and enable **Local editor
integration**. The browser may ask once for permission to connect to software
on the computer. bb does not request that permission during normal remote page
loads; it is only needed for discovering and launching local editors.

If Settings reports that it cannot connect to the helper:

1. Confirm the bb desktop app or `npx bb-app` is running on the browser device.
2. Confirm the browser allows local network access for the bb page.
3. A helper enrolled with this exact server trusts its origin automatically.
   For a separate local bb helper serving a custom HTTPS or Tailscale browser,
   configure that exact origin with
   `npx bb-app config set BB_APP_URL <origin>` and restart bb.
4. Return to Settings → Files and choose **Retry**.

Phones and tablets need no helper; editor-launch actions are simply unavailable.

## Use Cloudroom on your phone

The phone runs the same Cloudroom app as a PWA, at app.cloudroom.run. Open
cloudroom.dev/m, or scan the QR code in Settings → Cloudroom Connect, sign in, and
tap Open Cloudroom. Then use Add to Home Screen. Settings → Cloudroom Connect → Sign out all phones ends every
phone session.

### Push notifications on a self-hosted server

The built-in Push notifications plugin sends messages through Expo. A
self-hosted server must reach `https://exp.host`. The server needs no Apple or
Google key.

An Expo push token lets its holder send a notification to one app installation.
The token cannot read notifications. It cannot access the phone or authenticate
to the bb server. Treat the token as private because a leak can cause unwanted
notifications.

The server sends a thread title and a short preview. Use these commands to
manage device registrations and inspect the sender:

```bash
bb push-notifications list
bb push-notifications add --token <expo-push-token> --platform ios --label <device-name>
bb push-notifications remove <id>
bb push-notifications status
```

Turn delivery off with `bb plugin disable push-notifications`. The plugin keeps
registrations in its private storage. Enable the plugin to resume delivery.

The `expoPushUrl` plugin setting changes the Expo endpoint. Use it only for a
controlled test service or a compatible relay:

```bash
bb plugin config push-notifications set expoPushUrl <url>
```

The Expo request supports `HTTPS_PROXY` and `NO_PROXY`.

## Open another of your Macs

Settings → Machines lists every Mac signed in to the same Cloudroom account,
through Cloudroom Connect on cloudroom.run. Choose Open to use that Mac's
projects and threads in this window. Choose Run threads on it to add that Mac as
a machine: its own Cloudroom installs the machine helper, with nothing to paste. Window → Server shows the
same list, plus a custom URL. When you pick another Mac, the app stops starting
a server on this Mac.

The app remembers the pick and opens that Mac on every launch. If it doesn't
answer, the app keeps trying for 30 seconds, then opens this Mac instead and
shows a banner. When the other Mac comes back online, the banner offers Switch.

The sign-in to the other Mac lasts 30 days. The app renews it a week early. If
the other Mac answers "Sign in required" (for example after Sign out all phones),
the app gets a new sign-in and reloads. If that fails, it reopens the Mac.

The app keeps this Mac's Connect key, encrypted with the OS keychain, so it can
open another Mac without starting its own server. It gets the key from the local
server once, and again if the relay rejects it.

A remote server has no realtime link for keybindings and theme. The app re-reads
them when it starts, when it becomes active, and every five minutes.

## Add an execution machine

Open Settings → Machines and choose Add machine. Run the generated one-line
installer on the computer that should
execute work. It installs and enrolls a host daemon. When this Mac is signed in
to Cloudroom, the installer also configures the machine's own Cloudroom Connect
credential, so the machine reaches this Mac through cloudroom.run. Signed out,
open the server through a Tailscale Serve URL before generating the installer;
the loopback listener is not directly reachable from another machine. When this
Mac is signed out and the server URL is a loopback or unspecified address, the
dialog does not show an installer.

The installer always installs the exact host-only `bb-app` package exposed by
that server at `/install/bb-app.tgz`. The package contains the host daemon,
provider/plugin workers, native host dependencies, and bundled `bb` CLI, but no
web app or server. If the server provides no package, installation stops with
an error; it never reuses a `bb-app` on PATH or installs from npm. Version strings cannot
distinguish unpublished builds, so the route also publishes a SHA-256 digest.
The installer verifies that digest and uses a conditional request on later runs
to skip an identical installed artifact. The package route is public like
`/install.sh`: `bb-app` is public software, and exposing an unpublished build
slightly early through a paired tunnel is an accepted tradeoff. npm installs
the package into the machine's bb data directory, not its system-wide global
prefix, so enrollment needs neither `sudo` nor a PATH change.

Each joined server gets its own daemon instance, data directory
(`~/.bb-machines/<server-host>`, override with `BB_DATA_DIR` when running the
installer), local API port, and launchd/systemd service. The installer persists
the selected port in that data directory. Subsequent runs reuse it; pass
`--host-daemon-port <port>` to the installer to override the selection. One machine can therefore
serve several bb servers at once, and joining never touches a full local bb
install's `~/.bb`. Each instance keeps its own `bb-app` under that data
directory and self-updates against its own server, so servers running different
bb versions on one machine remain isolated.

The installed launchd/systemd service enables `--auto-update`. If session open
reports a newer server protocol, the daemon downloads the server artifact,
verifies its SHA-256 digest, updates its private install, then exits so the
service manager restarts it. If the identical artifact is already installed,
the server returns `304` and the daemon restarts without downloading or running
npm again.
Failed attempts fall back to normal reconnect behavior with a persisted
exponential retry backoff from 5 seconds to 5 minutes. Settings → Machines and
`bb machine retry-update <id-or-name>` can bypass the current backoff. A daemon
never downgrades itself to an older server protocol. To opt out, remove
`--auto-update` from
`~/Library/LaunchAgents/app.getbb.host-daemon.<server>.plist` or
`~/.config/systemd/user/bb-host-daemon-<server>.service`, then reload the
service.

After it connects:

1. To create a project from that machine, choose New project, select the
   machine, and browse to its folder. To map an existing project there instead,
   add its path or clone source in project settings.
2. Select the machine when creating a thread, or use `bb thread spawn --machine
<id-or-name> ...`.
3. Inspect enrolled machines with `bb machine list`.

Machine names are conveniences and may be duplicated; CLI targeting by name
requires an unambiguous match. IDs are always accepted. Removing a machine from
Settings stops bb from dispatching new work to it and revokes its Cloudroom
Connect credential.

Browser access and execution remain independent: opening bb on a laptop does
not enroll that laptop, and enrolling it as a machine does not expose the bb UI.
