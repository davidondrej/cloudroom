The Director keeps your other agents moving. It is a normal thread that wakes on a timer, reads one stopped thread, and unblocks it when the next move is obvious.

## What you get

- A **Director** row at the top of the sidebar, above Pinned. It opens the Director's thread. Hover it for three dots that open its settings.
- An automatic ping you turn on yourself, once an hour by default. Each ping checks one thread that stopped since the Director last looked.
- No model turn when nothing has stopped.
- A learning mode. For its first 50 turns the Director asks before it acts, and it remembers each correction you give it. A meter shows how far along it is. Lessons are saved with your Cloudroom account, so they follow you to every computer.
- Settings for the interval, both prompts, the harness, model and effort, which projects it watches, and its icon and color.
- The same settings from the terminal: `room-cli director`, `room-cli director set <setting> <value>`.

## How it works

At each ping, plain code lists your stopped threads and picks one: a failed one first, then the most recent. The Director reads that thread with `room-cli` and either sends it a short message, retries its failed turn, or leaves it and says why in its own thread. It never answers permission prompts or forms, and it leaves real decisions to you.

The Director runs on this computer, so pings stop while it sleeps.
