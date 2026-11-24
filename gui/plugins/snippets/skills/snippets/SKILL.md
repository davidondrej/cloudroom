---
name: snippets
description: Manage the user's Cloudroom chat snippets, import Raycast JSON, or publish a snippet to their Organization.
---

Run `room-cli snippets list` or `search "words"` to find an ID. Personal is the default. Use `--scope organization` for a shared library.

- Create with `room-cli snippets create --name Review --keyword '!review' --text 'Review {clipboard}'`.
- Update with `room-cli snippets update ID --text-stdin < prompt.txt`. Use `--revision REVISION` when editing an item you already read.
- Import with `room-cli snippets import --file snippets.json` or `room-cli snippets import --data-stdin < snippets.json`. Export with `room-cli snippets export > snippets.json`.
- Use `get`, `duplicate`, `pin`, `unpin`, `tag ID --tags '["work"]'`, or `delete ID`. Render using `render ID --args '{"name":"Alex"}' --clipboard 'sample'`. For clipboard offsets, pass `--clipboard-history '["latest","previous"]'`.
- `share ID` publishes a personal copy to the Organization. Members edit it with `--scope organization`.
- Local commands work with the device library. `sync on` connects personal snippets to the account. A Cloud agent then uses the synced library directly.

Use `room-cli snippets settings --mode keep --within-words false` locally for after-delimiter expansion. Use `--mode immediate`, `discard`, or `off` to change it.
