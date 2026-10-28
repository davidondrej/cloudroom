Ask a side question without adding noise to the main conversation. A side chat is a fresh agent in the thread's folder that opens in a panel beside it.

## What you get

- A **Side chat** button under the header's panel button, and a **Start side chat** panel action.
- A **Side chat** action on any message. Select part of the message first to ask about only that text.
- A panel that shows the quoted message and a compact chat with its own composer.
- A **Send to main thread** action on side-chat replies. It queues the reply as a message in the original thread.

## How it works

A side chat copies no conversation, so it opens at once and replies fast. It reuses the same workspace. The quoted text is its only context. Its agent starts in the background; messages sent before it is ready wait in the queue. Side chats stay hidden from the sidebar.

Once per hour, the plugin looks for side chats older than 24 hours. A side chat with no user message and no queued message is archived. A side chat you used is kept.

The plugin adds no agent tools or CLI commands.
