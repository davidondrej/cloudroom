---
name: cloud-preview
description: 'Show a web app running in a Cloudroom cloud thread through the user’s laptop localhost. Use after starting a development server or when asked to show a browser preview.'
---

# Cloud preview

1. Start the HTTP development server on IPv4 loopback (`127.0.0.1`) as the normal agent user. Keep its process running. Do not install packages just to expose it.
2. Run `room-cli preview PORT` with its actual port.
3. Only when the JSON says `state: ready`, post the returned `url` as a Markdown link. Do not guess a localhost port, open the browser automatically, or use BB Connect or other public hosting.
4. If pending, explain that the paired Mac must be connected; use `room-cli preview status PORT` to check again. A failed or pending preview does not stop cloud work.
5. `room-cli preview close PORT` closes forwarding, not the app. Stop the app separately only when requested.

Local threads use their ordinary localhost server directly. Do not change server security settings to allow all hosts/origins. Never ask for or print SSH private keys, core tokens, or hosting credentials.
