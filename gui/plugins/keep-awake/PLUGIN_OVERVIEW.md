Stop your computer from going to sleep while agents work. By default, Cloudroom keeps a machine awake while a Local thread runs on it and for 10 minutes after.

## What you get

- Three levels: **Off**, **While agents work** (default), and **Always**, which also keeps the screen on while Cloudroom runs.
- A choice between all hosts and a list of specific hosts.
- Automatic reconnection. When a host connects again, Cloudroom applies the setting again.

## How it works

The plugin runs on each selected host. While agents work, it keeps the Mac awake and lets the screen sleep. Always keeps the Mac and its display awake while Cloudroom is running. On power, both levels also block system sleep. When Cloudroom stops, this stops with it. Closing the lid or choosing Sleep still puts the Mac to sleep. On GNOME, it uses `gnome-session-inhibit` to stop idle sleep and keep the display on, and closing the lid or choosing Suspend still works. On other Linux desktops, it uses `systemd-inhibit` to block idle and system sleep.

Use the settings page or the CLI to manage the plugin:

- `room-cli keep-awake status` shows the level, the host selection, and which hosts agents keep awake now.
- `room-cli keep-awake level off|working|always` sets the level. `enable` means `always`, and `disable` means `off`.
- `room-cli keep-awake hosts all` selects every host. `room-cli keep-awake hosts` followed by one or more host ids selects specific hosts.

Add `--json` to any command for machine-readable output.

## Requirements

macOS hosts, Linux hosts with systemd, and Windows hosts are supported. On Windows the plugin holds a system-required execution state from a PowerShell process. On other hosts, the plugin does nothing and writes a warning to the log.
