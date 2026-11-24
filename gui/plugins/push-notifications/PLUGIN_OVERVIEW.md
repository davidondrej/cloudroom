Get a system notification when an agent asks a question, stops on an error, or finishes a turn. Turn web and desktop delivery on or off in Settings → Notifications.

## Delivery

The desktop app and open browser tabs show notifications over Cloudroom’s live connection. Quitting the app or closing every tab stops delivery. Browsers need HTTPS (or localhost) and notification permission.

Click a notification to open its thread. Events for one thread within 2 seconds become one notification; a question wins over an error, and an error wins over a finished turn. Read, archived, deleted, and hidden threads stay quiet, and so do chats that settle without a new turn. Several tabs or windows show each notification once.

## Settings

- `webEnabled` / **Web notifications**: notify browsers with permission. Default: true.
- `desktopEnabled` / **Desktop notifications**: notify the running desktop app. Default: true.

Switches apply to the whole server and save at once. Each device grants permission with **Allow notifications**. **Send test notification** sends to every connected client of that type with permission.

## CLI and SDK

- `room-cli push-notifications status [--json]`: which channels are on.
- `room-cli push-notifications test <web|desktop>`: send a test. Fails if that channel is off.
- `room-cli plugin config push-notifications set <webEnabled|desktopEnabled> <true|false>`: change a channel.

Agents can send a test with `sdk.plugins.callRpc({ pluginId: "push-notifications", method: "notifications.test", input: { channel: "web" }, outputSchema: z.object({ ok: z.literal(true) }) })`.
