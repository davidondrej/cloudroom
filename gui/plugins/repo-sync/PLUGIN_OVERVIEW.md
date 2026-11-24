Push your cloud work to GitHub automatically, like the repo-sync tool does on a Mac. Pick a repo, and every Cloud thread working in it commits its changes and pushes them to that repo's main branch when the agent finishes a turn, whatever branch the thread is on.

## What you get

- A list of repos in Settings → Cloud → RepoSync, each with its own branch, how often it may push (30 seconds to 15 minutes), and switch.
- The last push time of each repo, read from GitHub.
- The same repos on every computer and in every Cloud thread, with your Mac on or off.

## Safety

- Files named like secrets (`.env`, keys, credentials) and files over 50 MB are left out, and the agent is told which ones.
- It never force-pushes, never runs Git hooks, and never pushes commits from someone else's branch.
- It waits while an agent is mid-turn, or in the middle of its own rebase or merge.
- When newer work on GitHub conflicts, it keeps the commits and asks the agent to resolve the conflict.

Turning the plugin off hides the tab on this computer. Switch a repo off to stop syncing it.
