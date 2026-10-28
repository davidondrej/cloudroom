Stop your computer from going to sleep while Cloudroom runs long agent work. Enable the plugin once, and Cloudroom keeps the selected machines awake for as long as the app is running.

## What you get

- One switch in the plugin settings that turns sleep prevention on or off.
- A choice between all hosts and a list of specific hosts.
- Automatic reconnection. When a host connects again, Cloudroom applies the setting again.

## How it works

The plugin runs on each selected host and keeps the Mac and its display awake while Cloudroom is running. On power, it also blocks system sleep. When Cloudroom stops, this stops with it. Closing the lid or choosing Sleep still puts the Mac to sleep. On Linux, it uses `systemd-inhibit` to block idle and system sleep.

Use the settings page or the CLI to manage the plugin:

- `room-cli keep-awake status` shows the current state and the host selection.
- `room-cli keep-awake enable` and `room-cli keep-awake disable` change the switch.
- `room-cli keep-awake hosts all` selects every host. `room-cli keep-awake hosts` followed by one or more host ids selects specific hosts.

Add `--json` to any command for machine-readable output.

## Requirements

macOS hosts, Linux hosts with systemd, and Windows hosts are supported. On Windows the plugin holds a system-required execution state from a PowerShell process. On other hosts, the plugin does nothing and writes a warning to the log.
