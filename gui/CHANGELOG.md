# Changelog

Also on [cloudroom.dev/changelog](https://www.cloudroom.dev/changelog).

## 134

Your phone no longer needs your Mac (2026-10-30)

### Changes

- You can now start new Cloud threads from your phone while your Mac is off.
- A loop at its Claude or Codex limit now keeps going on the other agent with a same-level model, and you can turn this off in Settings.
- Finished subagents now show their own unread dot in the sidebar.
- Each project now remembers whether its new threads start in Cloud or on this Mac.
- The chat no longer jumps when you open or close the sidebar.
- Switching branches in a Local thread no longer fails when the repo has untracked files.
- Claude Code no longer shows an Update button for a version that can't install yet.

## 133

Choose the keys each loop gets (2026-10-30)

### Changes

- Each Cloud loop now gets only the API keys and .env files you pick for it, from a new Secrets row in the loop dialog.
- A This Mac loop that hits your plan limit now skips that run instead of pausing, and failures show the real error.
- Switching a Cloud thread to a model that can't start keeps your current agent running and shows why.
- Skills and settings now sync on Linux.
- On Windows, loop check scripts, room-cli in PowerShell, and file copies to and from Cloud now work.
- A stray key press can no longer approve a GPU or computer use.
- Security fixes.

## 132

A nudge toward the right project (2026-10-29)

### Changes

- While you type a new thread, Cloudroom suggests the right project if you are in the wrong one, and Enter switches to it.
- You can turn the project hint off, or set how sure it must be, in Settings.
- Droid now runs in Local and Cloud threads, and a signed-in Droid shows up during setup.
- New threads now start where you ran your last one, and fresh installs still start in Cloud.
- Cmd+K now finds threads by part of a word in their name.
- Image attachments look cleaner, and HEIC photos preview again.

## 131

Agents can ask for a GPU (2026-10-29)

### Changes

- Agents can now ask for a cloud GPU for heavy work, and you approve the cost first in a pop-up.
- When a loop pauses, a card shows why, with a Resume button.
- Quitting the Linux app no longer shows a crash dialog.
- Claude Code no longer gets stuck on approvals after Claude cancels a prompt.
- Codex chats saved in compressed form now import.
- Forks and child threads copy their files more reliably.
- A failed attachment now shows as a chip you can dismiss.

## 130

Top up Cloud credits anytime (2026-10-28)

### Changes

- You can now buy extra Cloud credits from the sidebar, the account menu, or the usage limit notice.
- Cloudroom stays responsive with hundreds of threads and pauses animations while its window is in the background.
- Loops have a new details view that works the same for Local and Cloud loops.
- Importing past chats no longer sends one notification per chat.
- Setup now fits small screens, and Windows updates show their progress.

## 129

One open-source home for Cloudroom (2026-10-28)

### Changes

- The app, Core, and skills now live in one open-source repo, and app updates come from it.
- Each agent in Settings has a new menu to make it the default, disconnect it, or remove it.
- Cloudroom uses less CPU while it sits idle.
- Stopping a sleeping Cloud thread no longer wakes it up.
- A new setting collapses subagents in the sidebar.

## 128

Start threads on your other machines (2026-10-28)

### Changes

- The new-thread picker now lists your other machines, so you can start a thread on any of them.
- A project that only lives on another machine now starts there by default.
- Workflow scans stay pinned while they run and show their progress in the sidebar.
- Pop-ups like the GitHub star prompt show at most once a day and remember your answer on every device.
- Mac access finds tools set up in your shell, like Homebrew and nvm.
- Agents can now read iCloud files that aren't downloaded yet.
- Security fixes.

## 127

Cloudroom comes to Windows (2026-10-27)

### Changes

- Cloudroom now runs on Windows 11 x64, in beta.
- Your cloud usage is one number now: Cloud Credits, shown in the sidebar.
- A new Scans tab in Loops finds the loops that would save you the most time.
- Claude Code reconnects MCP servers that failed before each new turn.
- Loops no longer reset a thread's permission mode.
- Messages held by Stop now show as paused.
- Phone access reconnects faster after a dropped connection.

## 126

Cloud threads ready before you click (2026-10-26)

### Changes

- On paid plans, the Cloud threads you can see in the sidebar start waking up before you click them.
- The app stays smooth when many Cloud subagents start at once.
- Attachments can be up to 100 MB, and HEIC photos are turned into JPEGs.
- Terminal output stays readable after the command exits.
- If a Local thread fails to set up, your first prompt is kept for the retry.
- Teleporting several threads at once no longer mixes up their sandboxes.
- Security fixes.

## 125

One-click security scans (2026-10-26)

### Changes

- New users get one-click security scans under the message box. Turn on "Always show one-click prompts" in Appearance to keep them.
- The usage panel shows your Cloudroom plan next to your other providers.
- The Loops page has new cards, a repo menu, and opens instantly.
- Settings has one clean account menu at the bottom, and the Advanced section is gone.
- A quick second message in a new Cloud thread no longer shows up twice.
- Stopping a thread also cancels its pending retries.
- Security fixes.

## 124

A checklist for your first week (2026-10-25)

### Changes

- A short checklist shows 5 steps that get the most out of Cloudroom, like starting a Cloud agent.
- The Loops page has a new header that shows how your loops are running.
- Loops remember their past runs, including what each run did and how sure it was.
- Cloud loops can stop at your plan limit, so they never use extra credits.
- `room-cli loop` sets priority, adds loops from templates, and shows Cloud run history.
- The phone app keeps working with Cloud threads while your Mac is off.
- Security fixes.

## 123

Hand off long Local runs (2026-10-25)

### Changes

- If you haven't used Cloud lately, Cloudroom suggests it for new and long-running Local threads, so you can close your laptop.
- A new setting hides the thread purpose card in the sidebar.
- Cloudroom no longer quits if your Mac sleeps while it starts.
- Claude sign-in works on Fedora.
- Cloud previews and sync no longer stall on an old, retired cloud machine.
- Unarchived subagents stay under their parent thread.
- Security fixes.

## 122

Jump back with Cmd+E (2026-10-25)

### Changes

- Cmd+E opens your last pinned thread, and you can rebind it.
- Cmd+K shows your newest threads first across all projects, and matches titles instantly.
- Computer use asks once per app, not once per thread.
- Importing chats shows live progress, and setup keeps going while it runs.
- Cloud threads finish a project copy that an app restart cut off.
- The context ring shows how many times the context was compacted.
- Security fixes.

## 121

A 110 MB smaller app (2026-10-24)

### Changes

- The app is about 110 MB smaller.
- Include context fills the composer instantly, even in very long threads.
- Big Mac access uploads no longer hold up other jobs.
- Mac-to-Mac opens this Mac if the other one does not load within 20 seconds.
- Cloud threads show the real error when the agent has crashed, instead of "sent".
- The GitHub plugin keeps syncing when gh is slow.
- Security fixes.

## 120

Faster threads and replies (2026-10-23)

### Changes

- Switching threads is much faster, and recent threads open instantly.
- Follow-up messages in Cloud threads get a reply right away.
- Reply opens instantly, even in very long threads.
- A new send button, and it never turns into Stop while you have text typed.
- The slash-command menu opens instantly and ranks model shortcuts with skills.
- Sent images keep their shape while loading, and thread mentions look cleaner.

## 119

Steadier starts after sleep (2026-10-23)

### Changes

- Threads no longer time out on startup when your Mac was asleep.
- Phone and Mac-to-Mac connections drop less often and retry before giving up.
- fx shows its full model list again, and Cloud fx threads can use Max effort.
- The right-click menu no longer closes instantly near the bottom of the sidebar.
- Security fixes.

## 118

One dialog for every loop (2026-10-23)

### Changes

- Add a loop as a Cloud loop that keeps running while your Mac is off, or switch it to Local.
- Local loops now open the same dialog as Cloud loops, with their run logs and scripts.
- "Project default" is now called "Fresh copy of main", so you know where each run starts.
- Edits in an open loop no longer disappear when a new run comes in, and Fast mode now saves.
- Cloud agents now know when a command ran out of memory, instead of guessing why it stopped.

## 117

Loop templates (2026-10-22)

### Changes

- A new Templates tab in Loops: ready-made loops you add to any of your repos in a few clicks.
- Templates are sorted by category and by priority, from P1 Essential to P4 Niche.
- The Loops Overview is now one list, grouped by priority, with turned-off loops at the bottom.
- Click a Cloud loop to see and edit its details. Failed loops show a Failed tag.
- Drag a thread onto another project in the sidebar to move it there.
- Archiving, sending, pinning, and changing effort now feel instant.
- Cloud threads run on the latest Core.

## 116

Move threads between projects (2026-10-22)

### Changes

- Move Local and Cloud threads to another project with `room-cli thread move`.
- Move a Local thread into a Cloudroom-managed worktree with `room-cli thread worktree`.
- Claude's built-in skills like `/code-review` now work in Cloud threads.
- When a Cloud agent stops unexpectedly, the thread now shows why.
- Big file uploads with `room-cli vm push` no longer fail.
- Loop check scripts that print nothing now skip the run instead of failing.
- Cloud threads run on the latest Core.

## 115

Organizations in the app (2026-10-21)

### Changes

- A new Organization page in the app, with Settings and Threads tabs.
- For team members, the Organization plugin turns on by itself.
- Team and repo rules reach every thread in your team's repos, never your personal work.
- Organization settings apply as soon as you save them.
- Signing out of a Mac now also ends its access to your other Macs.
- Security fixes.
- Cloud threads run on the latest Core.

## 114

Security fixes and a leaner app (2026-10-21)

### Changes

- Security fixes.
- The app now runs on Electron 44.9.3.
- Cloud threads run on the latest Core.
- Fewer third-party libraries, replaced with small built-in code.

## 113

Git diff panel for Cloud threads (2026-10-20)

### Changes

- Cloud threads now have a Git info panel and Diff tab, just like Local threads.
- When your Mac is unavailable, Cloud agents now see why.
- Cloud usage shows agent hours everywhere, so the app and pricing page match.
- Running background tasks use a calm static look, so long tasks no longer burn CPU.
- The side chat button sits under the panel toggle, and typing goes straight into the side chat.
- New custom icons for projects, computers, and branches.

## 112

Fork between Local and Cloud (2026-10-20)

### Changes

- Fork any thread to Local or Cloud, and switch its agent or model as you fork.
- Side chats open instantly with one click and start fresh.
- Cloud threads pick up again on their own when a Claude or Codex usage limit resets, or when you switch accounts.
- The Mac helper tells you why Mac access or previews can't connect, like a VPN, proxy, or firewall.
- Previews work behind more firewalls and proxies.
- An open browser no longer keeps a Cloud sandbox awake or uses up your cloud hours.
- New worktrees for big projects start faster.

## 111

Longer Cloud messages, calmer errors (2026-10-19)

### Changes

- Cloud messages can be up to 256 KB, up from 32 KB.
- Cloud errors show the real reason in one calm line, and a full Cloud disk shows one live card instead of many chat rows.
- Cloudroom warns you when Claude or Codex starts paying API prices from usage credits.
- Loops keep the agent and model you pick, and Cloud Loops show it.
- Code blocks keep their copy button in view while you scroll.
- The phone app sees an offline Mac sooner, and Claude chat import no longer skips chats.

## 110

New phone app and top-level threads (2026-10-18)

### Changes

- Set up the phone app at cloudroom.dev/m: scan the QR code in the Phone tab, sign in, and switch between your Macs from your phone.
- Cloud agents can start top-level threads with room-cli thread spawn --top-level.
- Cursor works in Cloud threads again, and OpenClaw runs in Local and Cloud threads.
- When Cloud rejects your saved ChatGPT login, Connect Codex offers Sign in again, and Retry uses the new login.
- A usage card appears in the sidebar once you pass 80% of your plan, with an upgrade button at the limit.
- Light mode gets a clearer green, and images zoom with a pinch and pan with scroll or drag.
- Archiving returns you to the neighboring thread, plugins get a safe mode, plus computer use and Cloud fork fixes.

## 109

Webhook Loops and Cloud without GitHub (2026-10-18)

### Changes

- Loops can start from a webhook, and the New button lets you pick the trigger.
- Cloud threads work for projects not on GitHub, including subagents, forks, and Loops.
- Downloads and builds keep a Cloud sandbox awake for up to 2 hours, so idle sleep no longer kills them.
- Save any Cloud file to your Downloads folder from the side panel.
- room-cli cloud teleport --check tests if a thread can move to Cloud, and the old Local worktree is cleaned up 2 days after the move.
- Extra Claude accounts keep claude.ai connectors in Local threads, and a queued /clear runs only once.
- Archived worktrees are deleted after 21 days by default, plus onboarding and security fixes.

## 108

Cloud subagents with your Mac closed (2026-10-17)

### Changes

- Cloud agents can message, stop, and archive their subagents even while your Mac is closed.
- Subagents tell their parent why they failed, and long replies come back whole.
- Adding a machine over SSH works again.
- Approval cards for Mac commands show the script they run, with Deny as the default.
- File attachments show a colored type icon and their size.
- Theme and starting machine stay in sync across windows, and Settings search opens with /.
- Claude skills accept arguments, pasted secrets lose stray spaces, and Cloud previews get more time to load.

## 107

Loops and multiple Codex accounts (2026-10-16)

### Changes

- Automations are now called Loops, with new Overview and Review tabs.
- Use several Codex accounts across Local and Cloud threads.
- Settings → Machines lists every Mac on your account and lets you switch between them.
- Settings → Accounts shows cleaner account tiles with full usage bars.
- Cloud /compact shows when it finishes and waits for a sleeping agent to wake up.
- Turns started by agents or automations now ask you for approvals instead of silently denying them.
- Double-click to rename on Mac, right-click images to save them, and Linux no longer shows a crash dialog.

## 106

Cloud without GitHub, steadier Mac access (2026-10-15)

### Changes

- Free accounts can start Cloud threads without a GitHub sign-in.
- Cloud automations with a check script can run as often as every minute.
- Copying big files to your Mac works on slow connections, and a busy Mac now says "Mac not responding" instead of "Mac unavailable".
- Cloud agents can read a subagent's full answer with room-cli thread output.
- Forking a Local thread keeps it Local.
- File paths in chat no longer jitter when you hover them.

## 105

Safer archiving and steadier automations (2026-10-15)

### Changes

- Cloud automations keep running after you archive their chat, and recurring ones start a fresh thread for each run.
- Archiving asks first if anything in the thread is still running, and Undo keeps sub-agents under their parent.
- The expand arrow in the sidebar no longer jumps under the Archive button.
- Free accounts see how many cloud agents and hours are left, with a one-click upgrade when they hit a limit.
- Settings marks which agents are Mac only, and setup offers your other signed-in agents.
- Image previews close when you add the image to chat, and thread notes are shorter.

## 104

Steadier Cloud threads and quick forks (2026-10-14)

### Changes

- Run Devin in Cloud threads, using your Mac's Devin login.
- Select text in a chat to reply, fork a new thread with it quoted, or open a side chat.
- Import chats from Pi and Hermes, and open a folder in one click when you have no chats yet.
- Add your Mac's CLIs to a Cloud environment's setup script with one click.
- Smarter thread names, exact model names in pickers, and new sidebar icons.
- Switching a running Claude Code thread to Manual now takes effect on your next message.
- Cloud threads no longer freeze on a stuck message, subagents no longer start twice, and error cards can be closed. Security fixes.

## 103

Cloud queue and clearer threads (2026-10-13)

### Changes

- Free accounts can join the Cloud queue, and the app shows your place in line.
- Free Cloud shows a simple card to sign in with GitHub or upgrade.
- Hover a thread's title to see what it's for and how far along it is.
- Hiding a project keeps its automations running.
- Cloud agents reach your Mac more reliably, with fewer "Mac unavailable" errors.
- The changes badge counts only work that isn't on GitHub yet.
- Live Teleport to Local progress, voice recording fixes, and a crash fix. Security fixes.

## 102

Smoother setup and sign-in (2026-10-13)

### Changes

- Setup now offers your other signed-in agents with one click.
- Cloud Pi threads bring your Mac's custom providers and packages.
- Codex shows a one-click Sign in when your Mac's login expires, and the Usage panel shows your cloud Claude usage.
- Computer use can now pick options in Electron apps.
- A cleaner sidebar, composer, and thread header, a compact archive toast with Undo, and a phone code box that accepts any paste.
- Fixes for Teleport to Cloud and Claude on Linux. Security fixes.

## 101

Phone app with your Mac off (2026-10-12)

### Changes

- Use the phone app even when your Mac is off. It shows the same chat screens as the desktop.
- Cloud subagents now get their own sandbox.
- Settings → Providers shows every agent in one table, with sign-in, Cloud login, and updates.
- Switching agents in a thread works again, and Automations shows Local and Cloud in one list.
- A Report a bug button in the thread header, plus fixes for setup and Teleport to Local. Security fixes.

## 100

Hermes in Cloud, smoother setup (2026-10-11)

### Changes

- Hermes Agent now runs in Cloud threads, and Cursor, opencode, and omp are found right after you install them.
- Importing your old chats no longer slows down your Mac. Agents start only when you send a message.
- Sign in to MCP servers once in Cloud threads, and Codex sign-in shows the real error when it fails.
- New /worktree command, a sidebar grouped by agent, and click any inline code to copy it.
- Fixes for Claude sign-in in Settings, file links in Cloud threads, and cloud automations. Security fixes.

## 99

Cloud automations and a cleaner composer (2026-10-10)

### Changes

- Schedule automations that run in the cloud, from the new Cloud tab or room-cli.
- Switch to another agent in the same thread, and pick model and effort from one split button.
- Permission modes are now Manual, Auto, and Full Access, with a simpler picker.
- Settings has a Plan & billing row, tabs for Cloudroom Connect, and a choice of how long archived worktrees stay.
- A clear notice when a cloud sandbox runs out of disk, and longer messages before "Show more".

## 98

Chat export and Cloud fixes (2026-10-09)

### Changes

- Export your chats from Settings, and auto-delete unused Cloud threads after a set time.
- Cloud Codex threads no longer freeze, and Cloudroom Connect setup works again.
- The model picker closes after you pick a model, and file previews open in Finder.
- Linux: room-cli works without Node, plus share links, keep awake, and Cursor sign-in.
- Security fixes.

## 97

Better search and tables (2026-10-09)

### Changes

- Search matches words in any order and inside words, in threads, pickers, and Settings.
- Wide tables stay inside the chat, with an expand button to see them full size.
- Update Claude Code from Homebrew in one click, and use Cmd+[ and Cmd+] to go back and forward.
- See how much context a Claude thread uses, and Cloud Codex threads now show context usage too.
- Fixes for Claude and Codex sign-in, Cloud follow-ups, app updates, and Linux menus.

## 96

Compact usage and better previews (2026-10-07)

### Changes

- The usage box is now a compact readout that fits inside the sidebar.
- Markdown and CSV files open in a rendered preview by default.
- The Skills page shows every agent's skills, not just Cloudroom's.
- Imported projects keep their GitHub link, so Cloud threads get the full repo.
- Sign in with one browser button, and Linux zoom shortcuts now work.

## 95

Clearer Claude accounts (2026-10-07)

### Changes

- The usage box is wider and shows the account in use for each provider, with a dropdown to switch.
- Accounts settings show each account as a tile, with the one in use highlighted.
- Stop no longer gets stuck on Cloud threads.
- Cursor shows Claude Opus 5.5 in the model picker, and Enter sends right after you attach files.
- Cloudroom starts faster because plugins load in parallel.

## 94

Multiple Claude accounts (2026-10-06)

### Changes

- Add several Claude Code accounts and switch between them in one click. Local and Cloud threads follow the selected account.
- Share read-only links to your threads, with a "Continue in Cloudroom" button.
- On Linux, Cloudroom now shows its proper name and icon.
- "Remove" in the sidebar now hides a project instead of deleting it.
- Fixes for stuck Cloud threads, Cloud Claude sign-in, and expired Codex logins.

## 93

Cloud terminals and side chats (2026-10-05)

### Changes

- Cloud threads get a real terminal. You can also fork them or reply in a side chat.
- A redesigned model picker with provider tabs, a clearer search box, and reasoning on the selected model.
- Share invite links instead of codes, and install more agents in one click from Settings.
- Voice recordings are saved as you speak, so a recording is never lost.
- Cloud threads stay connected more reliably, and a project copy pauses and resumes when its thread sleeps.

## 92

Mac access levels and new Settings (2026-10-04)

### Changes

- Choose how much Cloud agents may do on your Mac: Off, Read-only, Ask first, or Full. A sidebar chip shows and changes it.
- Settings has a new layout with search, plus an Invite friends row.
- /teleport works both ways, and Teleport now supports OpenCode.
- Pick GitHub repos faster with recent-repo chips and search. A new branded loading screen and app icon.
- The app checks the cloud less often, so Cloud stays fast as more people join.

## 91

Faster Cloud and context history (2026-10-04)

### Changes

- Cloud threads wake when you open them and start faster. Add GitHub repos without cloning them to your Mac.
- Click the context ring to pin it and see how much context each turn used.
- The model picker keeps its icons in place and shows a calm note when models are missing.
- The right panel opens on the New Tab page, and Cloud images show a placeholder while they load.
- Cmd+Shift+D renames a thread, and Mac updates ask for your password only once.

## 90

/copy and lighter Cloud checks (2026-10-03)

### Changes

- The app stops checking archived Cloud threads, so Cloud starts face less server load.
- /copy copies the last agent reply to your clipboard. It never goes to the agent.
- New Codex models show up right after you upgrade Codex.
- The invite popup fits small screens, and its Done button works on mobile.

## 89

OpenCode 2 and smoother Cloud (2026-10-03)

### Changes

- OpenCode 2 support, including logins in Cloud sandboxes.
- A new message in a paused Cloud queue goes first and resumes the queue.
- Former VM users move to Cloud sandboxes on sign-in, and sign-out never gets stuck.
- The Mac helper restarts after app updates, so Cloud agents keep Desktop, Documents, and Downloads access.
- A drop zone shows while dragging files. Cmd+B toggles the sidebar and Cmd+G pins a thread.

## 88

Import chats and Local/Cloud tags (2026-10-02)

### Changes

- Import your Claude Code and Codex chats into Local threads.
- Tagged agents show the same Local or Cloud icon as the sidebar. The @ menu adds status and last activity.
- Cloud agents keep going when their project files arrive late.
- Being offline shows a small pill instead of a scary error card.
- Pi 1.0 support, and Cmd+L jumps the sidebar to the open thread.

## 87

Cloud subagents and Goals (2026-10-02)

### Changes

- Cloud agents can start subagents in their own sandbox. They show nested under the parent thread.
- /goal works in Cloud threads, with Pause and Resume for paused or blocked Goals.
- Changing reasoning effort in Cloud threads is instant and stays in sync with what ran.
- Cloudroom finds Codex and Claude Code in more install folders, including the ChatGPT app.
- Cloud threads no longer look stuck when their sandbox falls asleep mid-turn.

## 86

Lime skills and a Cloud branch picker (2026-10-01)

### Changes

- Tagged skills now show as lime /name text, so they stand apart from agent and file mentions.
- The slash menu ranks the commands and skills you use most first.
- Cloud threads can start from any GitHub branch with the new branch picker.
- Images from Cloud threads now show in chat.
- Claude Connect installs Claude Code if it is missing.

## 85

Rounded or sharp corners (2026-10-01)

### Changes

- Rounded corners are back by default. Settings > Appearance > Corners switches to the sharp look.
- New Defaults settings: choose where new threads start, Cloud or your last machine.
- Signing out of the app now signs out that device on cloudroom.dev too.
- The sidebar can be narrower, down to 200px.

## 84

Smoother Claude and Codex sign-in (2026-10-01)

### Changes

- Claude Connect accepts the new sk-ant-usr API keys from the Anthropic Console.
- Codex Connect signs in on this Mac and opens the browser instead of showing an error.
- Onboarding shows the real Claude and Codex logos, with matching Connect buttons.

## 83

Cloud access and friend invites (2026-09-30)

### Changes

- Existing Cloudroom users can claim free Cloud access after signing in.
- Members can invite friends from a new pop-up, with up to 3 invite codes.
- New thread in the sidebar keeps your last-used project.
- Mac updates no longer ask for your password while you are away.
- Sharper design with square corners, and computer use stops when agents are done with it.

## 82

Easier first run (2026-09-30)

### Changes

- New first-run setup picks your first project from recent repos on your Mac. Sign-in returns to the app without a click.
- Connect GitHub for cloud threads in one step.
- Cloud environment shows API keys that exist only on your Mac, with one-click import.
- A full cloud disk no longer freezes a thread, and small projects not on GitHub upload to Cloud in the background.
- The chat input stands out: white on a light-gray page, and a lighter gray in dark mode.

## 81

Faster cloud starts (2026-09-30)

### Changes

- Cloud threads start faster: a sandbox gets ready while you type.
- New cloud threads clone your repo from GitHub and copy only .env files from your Mac.
- Cloud sandboxes run the same Codex and Claude Code versions as your Mac.
- Cloudroom skills come built in, and claude.ai connectors are off by default.
- Cursor is no longer available for new Cloud threads.

## 80

Faster project copies (2026-09-29)

### Changes

- Copying a project from your Mac to Cloud sends half the data, so it is up to 2x faster.
- Project copies survive network drops and show the time left.
- Updates install while the app is idle, and the app always reopens after one.
- Remote windows reload when the server updates, and show the server's version.

## 79

Agent bug reports (2026-09-29)

### Changes

- New: when an agent hits a Cloudroom bug, it can report it to us by itself. Turn this off in Settings.
- Threads cut off by an app restart continue on their own.
- Cloud project copies retry a failed GitHub clone and show the real Git error.
- Cloud threads reach your Mac again when another Mac helper is paired with the VM.
- Fixed a computer use crash when saving screenshots. Teleport to Local now works for Cursor threads.

## 78

Bigger cloud uploads (2026-09-29)

### Changes

- Large attachments, project copies and Mac access output now upload in small parts, so they work on every cloud provider.
- Cursor Cloud threads accept images.
- @-mentions work in Cloud threads.
- Images show a placeholder while they upload.
- The running background command and the diff now share one row above the composer.

## 77

Computer use (2026-09-29)

### Changes

- New: computer use. Agents can see and control desktop apps on your Mac, and a virtual screen in Cloud threads.
- New welcome screen that helps you set up your agents.
- Teleporting a thread back to Cloud no longer fails with "ambiguous Claude session identity".
- The /room-cli skill now works in Cloud threads.
- Fixed the file watcher crashing every 30 seconds.

## 76

Cloud environment (2026-09-28)

### Changes

- New Settings → Cloud environment: add API keys and a setup script that every cloud thread starts with. You can import keys from your Mac.
- Teleport works for worktree threads too.
- Teleport failures now say why, instead of "Internal server error".
- Teleport no longer cancels its own checks halfway.
- /opus and /astra now show only in new threads.

## 75

Model shortcuts (2026-09-28)

### Changes

- Type /opus or /astra to switch model in one step. /local and /cloud pick where a new thread runs.
- Every Local and Cloud agent gets one Cloudroom system prompt. Turn it off in Settings → Advanced.
- Teleport shows an animated arrow in the sidebar the moment you click it.
- Vague thread titles are renamed once, automatically.
- Cloud threads start faster, and the app checks for updates every 5 minutes.

## 74

Instant cloud queue (2026-09-27)

### Changes

- Messages you send while a new cloud thread starts queue instantly and go out in order.
- The chat box stays usable while a cloud thread starts, with no broken loading spinner.
- New cloud Codex threads start about 2–3 s faster.
- Cloud follow-ups reach the agent sooner: no extra check before each one.
- The changes indicator in the chat box is simpler.

## 73

Instant cloud follow-ups (2026-09-27)

### Changes

- Cloud follow-ups send instantly, like Local threads.
- Your first cloud thread starts faster: a ready sandbox waits for you when the app opens.
- Viewing an old cloud thread no longer wakes its sandbox.
- Your Mac’s Cursor login is copied to cloud threads.
- A sign-in card shows when a Local thread’s login expires.

## 72

Faster cloud starts (2026-09-27)

### Changes

- New cloud threads reply faster: the first message no longer waits on a slow cloud check.
- A Cloud thread that needs Claude shows a friendly sign-in card and continues on its own after you sign in.
- Images Codex generates show directly in the chat.
- Deleting a thread also deletes its subagents.
- The Cloud icon stays green after you pick Cloud.

## 71

One-click Claude sign-in (2026-09-27)

### Changes

- Connect Claude takes one click: approve in your browser, no code to paste.
- New cloud accounts can send right away, before their first cloud sandbox starts.
- The sidebar account button opens a quick account menu.
- Cloud threads start faster: unchanged skills are no longer re-uploaded.
- The Relaunch button shows a spinner while Cloudroom restarts.

## 70

Cursor in the cloud (2026-09-27)

### Changes

- Cursor works in cloud threads. Connect it once with a Cursor API key.
- Connect Claude works for cloud threads, even if you still have a cloud VM.
- The Cloud picker only shows agents your cloud threads can run.
- New cloud threads start faster: one is ready as soon as you pick Cloud.
- Cloud icons are lime and a little bolder.

## 69

Open cloud files on your Mac (2026-09-26)

### Changes

- Click a file link in a cloud thread to download it and open it on your Mac.
- The environment picker has one simple Cloud option.
- Cloud threads wait longer between failed start attempts and show clearer errors.
- The sidebar thread menu and mobile chat input are more polished.

## 68

A cloud computer for every thread (2026-09-26)

### Changes

- Each cloud thread gets its own private cloud computer. It sleeps when idle and wakes up when you send a message.
- Cloud thread menus add Open pull request, Push to main, and Copy branch to Mac.
- Your skills and instructions follow you to the cloud, and changes reach running cloud threads within a minute.
- The home panel toggle no longer hides behind the update banner.

## 67

Smoother updates (2026-09-26)

### Changes

- Updates download quietly in the background. A Restart to update banner appears only when the new version is ready.
- Running Local agents pick up where they left off after you restart to update.
- The website download link now shows only if the in-app update fails.
- The mobile chat input is easier to see and tap.

## 66

No account needed (2026-09-26)

### Changes

- Cloudroom works without an account. Local threads, providers, settings, and plugins all work right away. Cloud agents are invite-only: join the waitlist at cloudroom.dev.
- Cloudroom now updates itself. New versions download in the background. Click Relaunch to finish.
- Add remote machines over SSH. Hard Queue: Option+Enter holds a message until all child threads finish.
- Teleport to Local never overwrites your local work and always brings files back. Custom instructions reach every Local and Cloud prompt.
- Clearer Codex errors, context usage for Cursor threads, a new DMG installer, and local features keep working offline.

## 65

Signed and notarized (2026-09-25)

### Changes

- Cloudroom is now signed and notarized by Apple. Download the DMG, drag it into Applications, and open it. No warnings or workarounds.
- Pick a backup harness and model for thread naming in Settings. Claude Code can name threads when Codex fails.
- Connect Claude with an Anthropic API key. Cloud Claude Code runs the same version as your Mac.
- Teleport to Local works for projects that only ran in Cloud. Simpler setup screen and mobile sidebar fixes.
- Beta for Apple Silicon on macOS 13 or later. Updates remain manual.

## 63

Reliable Teleport (2026-09-25)

### Changes

- Teleport runs the exact model and effort you picked locally, such as Opus 5.5 1M High. It checks first that Cloud can run it; if not, the thread stays local and you can pick a Cloud model.
- Teleport errors show the real cause, and Retry works, including for cloud sessions lost after a restart.
- Teleport back to Local, one-click BB thread import, and Pi API key login.
- First-run setup asks for Mac access. Cloud queue fixes. "Room" is now "Cloudroom" everywhere.
- Trusted-tester beta for Apple Silicon on macOS 13 or later. Ad-hoc signed and unnotarized. Updates remain manual.

## 60

Opus 1M in Cloud (2026-09-24)

### Changes

- Claude Code in Cloud now shows plan-only models like Opus 5.5 1M, with their reasoning levels. Connecting Claude sends your Claude plan along with the one-year token.
- Teleport checks that the Cloud VM can run the exact model before moving a thread.
- On touch screens, voice input has a Send button that stops recording and sends.
- Trusted-tester beta for Apple Silicon on macOS 13 or later. Ad-hoc signed and unnotarized. Updates remain manual.

## 58

Copy images and name threads your way (2026-09-24)

### Changes

- Right-click an image and choose Copy Image to copy the real picture. Pasting it into another thread attaches it as an image.
- New Thread naming settings: pick the title model and write your own naming rules. Auto-titles that failed now work.
- Connecting Claude Code in Cloud first uses a one-year token created on your Mac.
- New Cloud threads copy the project to the VM automatically, with a progress notice.
- Errors show their real cause in sync, Claude sign-in, agent crashes, and core rejections.
- Trusted-tester beta for Apple Silicon on macOS 13 or later. Ad-hoc signed and unnotarized. Updates remain manual.

## 56

Sort each sidebar section your way (2026-09-24)

### Changes

- Each sidebar section's Sort by now changes only that section, and is remembered.
- Pinned sorts by most recent activity by default, and can switch to Drag order.
- The cloudroom skill shows first in the slash menu.
- Removed built-in plugins no longer show warnings.
- New Cloud VMs start on the latest core, and failed Teleport handoffs are flagged.
- Trusted-tester beta for Apple Silicon on macOS 13 or later. Ad-hoc signed and unnotarized. Updates remain manual.

## 55

Window dragging and Teleport for every agent (2026-09-24)

### Changes

- You can drag and move the app window again.
- Teleport Claude Code and Cursor threads to Cloud, not just Codex and Pi.
- Teleport to Cloud from the environment menu under the prompt box, or with /teleport.
- A clear banner shows when a newer Cloudroom version is available.
- Errors show their real cause.
- Trusted-tester beta for Apple Silicon on macOS 13 or later. Ad-hoc signed and unnotarized. Updates remain manual.

## 54

Connect Claude and secure Cloud secrets (2026-09-24)

### Changes

- Connect your Claude subscription from the app. The prompt is a small popup on the new-thread screen, with an X to close it.
- Cloud threads get a secure form for secrets, so keys never pass through chat.
- Cloud threads can start outside a project, and queued Cloud messages can steer the agent.
- Idle sessions go to sleep to save resources.
- Claude Code updates itself when it is too old. Claude skill selection is more reliable.
- Chat links open in your default browser. Browser sign-in returns you to the app.
- Trusted-tester beta for Apple Silicon on macOS 13 or later. Ad-hoc signed and unnotarized. Updates remain manual. Fresh-Mac checks remain pending.

## 51

Faster, simpler Teleport (2026-09-23)

### Changes

- Teleport sends only the conversation, your local Git state, and new files mentioned in the conversation. Ignored files such as .env stay on your Mac.
- Stop during Teleport halts the cloud agent and ends remaining uploads.
- Rename or archive a thread while it is teleporting. Archive always wins.
- Teleport progress is a compact status chip you can close when it finishes.
- Cloudroom checks for new versions every 15 minutes.
- Trusted-tester beta for Apple Silicon on macOS 13 or later. Ad-hoc signed and unnotarized. Updates remain manual. Fresh-Mac checks remain pending.

## 45

Claude skills in Local and Cloud (2026-09-23)

### Changes

- Selected Claude skills now load in both Local and Cloud sessions.
- Your original prompt is preserved. Missing or unsupported skills are reported clearly.
- Trusted-tester beta for Apple Silicon on macOS 13 or later. Ad-hoc signed and unnotarized. Updates remain manual. Fresh-Mac checks remain pending.

## 41

Room branding and mobile setup (2026-09-22)

### Changes

- Cloudroom Connect keeps BB Connect attribution and existing remote-access accounts.
- Install the Cloudroom mobile app from your browser. Native BB mobile pairing is no longer promoted in the interface.
- BB Marketplace remains available with its original authors and attribution.
- New agent instructions, default branches, commits, and session labels use Room naming. Existing history, settings, and credentials are preserved.
- Release notes now have a dedicated changelog page and an optional preview in Room.
- Trusted-tester beta for Apple Silicon on macOS 13 or later. Ad-hoc signed and unnotarized. Updates remain manual. Fresh-Mac and physical-phone checks remain pending.

## 34

Guided Codex sign-in (2026-09-22)

### Changes

- Connect your Codex account using OpenAI’s device-code sign-in.
- Keep your saved prompt while signing in. Cloud credentials stay on your VM.
- Requires a Cloudroom core with guided Codex sign-in support.
- Trusted-tester beta for Apple Silicon on macOS 13 or later. Ad-hoc signed and unnotarized. Updates remain manual.
