Let any agent in a Local thread see and control desktop apps, like a person would. Agents read each app's buttons and fields, click, type, and check the result, in the background with their own cursor.

## What you get

- Computer use for every harness and model, through `room-cli computer-use`.
- A card that asks you before an agent controls each new app: always allow, only this thread, or deny.
- A Settings section for macOS permissions and your always-allowed apps.

## How it works

The plugin downloads a pinned, verified [Cua Driver](https://github.com/trycua/cua) the first time an agent uses it. It runs as part of Cloudroom, so macOS asks for Accessibility and Screen Recording for Cloudroom only.

## Requirements

macOS 14 or later, or a Linux machine with a desktop session.
