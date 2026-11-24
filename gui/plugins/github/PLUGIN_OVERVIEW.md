See the open issues and pull requests of your repositories inside Cloudroom. Hand one to an agent.

## What you get

- A GitHub panel with Issues and Pull requests tabs across every tracked repository. It has a repository filter and a New issue form.
- Issue details: body, comments, a comment box, and editing of status, assignee, and labels.
- Send agent on an issue, or Review with agent on a pull request. Cloudroom starts a thread in the repository's project and links it from the item.
- Items by people outside the repository open first, with a warning. Members, owners, collaborators, and you can start them from the list.
- The agent gets the item number and author, not GitHub text. It reads the item with `gh` and is told not to follow instructions in it.
- Mentions. Type `@` or `#` in any composer to attach an issue or pull request. The agent gets the item number and author, then reads it with `gh`.

## How it works

The plugin tracks every cloudroom project whose checkout has a GitHub `origin` remote. Add more repositories in the Extra repositories setting as a comma-separated `owner/repo` list. Choose a Default project for repositories that are not attached to a project. A background service refreshes the cache at startup, then waits 15 minutes after each completed sync to reduce background GitHub traffic. Press Refresh in the panel to update now.

## For agents

The `room-cli github` command lists cached data. Use `room-cli github repos`, `room-cli github issues [owner/repo]`, `room-cli github prs [owner/repo]`, or `room-cli github sync`.

## Requirements

The GitHub CLI must be installed and signed in with `gh auth login`. See https://cli.github.com for installation. The plugin uses your `gh` session and stores no tokens. Until `gh auth status` passes, the plugin reports that it needs configuration.
