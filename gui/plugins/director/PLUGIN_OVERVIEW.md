The Director keeps your other agents moving. It is a normal thread that wakes on a timer, reads one stopped thread, and unblocks it when the next move is obvious.

## What you get

- A **Director** row at the top of the sidebar, above Pinned. It opens the Director's thread.
- An automatic ping, once an hour by default. Each ping checks one thread that stopped since the Director last looked.
- No model turn when nothing has stopped.
- Settings for the interval, both prompts, the harness, model and effort, which projects it watches, and its icon and color.

## How it works

At each ping, plain code lists your stopped threads and picks one: a failed one first, then the most recent. The Director reads that thread with `room-cli` and either sends it a short message, retries its failed turn, or leaves it and says why in its own thread. It never answers permission prompts or forms, and it leaves real decisions to you.

The Director runs on this computer, so pings stop while it sleeps.
