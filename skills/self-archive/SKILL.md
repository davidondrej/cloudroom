---
name: self-archive
description: Archive the current Cloudroom thread and release its runtime. Use only when the user explicitly asks to self-archive, archive yourself, or archive this thread.
---

# Self-archive

Act only on an explicit request to archive this thread. Never delete the thread or target unrelated threads.

1. Check that nothing is still running. Archiving kills anything still running. Do not archive if:
   - a background job, server, or script you started is still running (a push, a ship script, checks), or
   - commits you made in this thread are not pushed yet: check with `git log --oneline HEAD --not --remotes`, and only judge the commits that are yours. Skip this check when `git remote` prints nothing.
   Wait for the job to finish or push first. If you can't, don't archive: tell the user why in this thread.
2. Send a brief closing summary before running commands.
3. Archive the current thread and its children: `room-cli thread archive --self --json` (Local and Cloud).
   Child threads that are still running or have queued messages stay open; the command lists them.
4. If the command fails, report the error and keep the runtime running. Do not claim the thread was archived.
5. After success, run nothing else. Archiving stops the thread's runtime. In Cloud, the request is recorded durably and the app applies it when it next connects.

To restore the thread, the user can use Cloudroom's UI or run `room-cli thread unarchive <id> --json` on their computer.
