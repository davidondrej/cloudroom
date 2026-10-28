# Disk safety

Workspace Management measures actual available disk space. Session Management records warnings and gates execution; Runtime pauses and resumes its own workloads. There is no fixed agent allowance, extra reserve deduction, quota dependency, or separate monitoring service.

## Behavior

- At **5 GB available or less**, warn once per low-space episode. Agents, new work, and sync continue. The episode ends above 6 GB, so space hovering at 5 GB does not repeat the warning.
- **Below 2 GB**, block new work and uploads, then freeze managed agents, sync transfers, and attachment writers. Saved history, health, and recovery reads remain available. `room-cli vm run` still works and is never frozen, so a person can read work back and free space; bulk `vm run/raw` project copies stay blocked.
- **Above 2.5 GB**, resume paused work, even if the low-space warning remains. Never replay a prompt or reset an in-flight native RPC deadline because of a pause.
- **Still paused after 30 seconds** (frozen work never frees space): in each session, kill the process group that wrote the most to disk, never the harness's own group (tool commands run in their own groups). Then thaw work and tell the agent what was stopped. Work pauses again only when half of the space left is used, but never lower than an eighth of the pause line (250 MB on a 20 GB box), so history can always be saved. At that line work stays paused until space is freed. Above 2.5 GB the normal thresholds return.
- Failed measurements block work until disk access can be verified. If the guard loop falls more than five seconds behind, each check re-measures the disk itself instead of blocking.
- Validate `/code` and registered workspace paths against the configured filesystem; unsupported mounts block work. Measure the actual workspace root and history location. Linux filesystem-reserved blocks are already excluded from available space; do not subtract another reserve.

Warnings and pause/resume events are saved in session history and replayed to clients. Harness notification acknowledgement is not proof that the model read it. Account isolation, capability dropping, cgroups, and history ownership remain unchanged.

Safe cleanup handles only verified SHA-512-addressed npm download blobs after managed workloads are frozen. It preserves open or mapped files, hardlinks, symlinks, wrong hashes, executable `_npx` packages, project files, history, credentials, and unknown backups. Unmanaged agent processes prevent cleanup. No automatic build-directory deletion.

This is polling-based protection, not a kernel guarantee: rapid writes or unrelated administrator processes can still exhaust a disk. Check capacity before large transfers and keep emergency operator access.

## Sync recovery: manual cleanup

Displaced originals and their metadata stay in `.cloudroom-sync-pending` until explicitly removed. Retaining the original inode preserves later writes through already-open files; a matching hash does not prove a writer has finished. Recovery files are excluded from normal syncing and automatic cache cleanup.

Before cleanup, stop sync and relevant writers on that device. Review the saved copies, recover any needed edits, then remove only the selected copy and its matching `.json` metadata. Do not bulk-delete recovery directories while writers are running. Retained copies consume disk space. Interrupted incoming transfers may leave unpaired staging files; inspect them before manual removal.

Update both the core and the laptop sync helper. Stop old sync workers during rollout: an older helper can still delete its local recovery copies.

A previously initialized cloud sync root that disappears is reported unavailable, never silently recreated as empty. Restore the folder and its contents or its mount before retrying. Older paired installations are handled conservatively; missing roots require recovery, not an empty replacement.

## Provisioning

Follow [setup](setup.md). `install/configure.py --storage-only DIRECTORY` creates the protected `storage.json` and disposable cache directory. Full managed setup calls the same function. Existing policies are preserved on retry.

New installations bind plain HTTP to `127.0.0.1:9840`. Keep this default for an HTTPS proxy on the same VM. An external HTTPS gateway may require `CLOUDROOM_LISTEN=0.0.0.0:9840` during provisioning, but first restrict port 9840 to that gateway over a private or encrypted connection. The installer does not configure TLS or firewall rules. Retries preserve the existing listen address.

The policy retains `agent_uid`, `agent_gid`, `cache_dir`, and `cgroup_root`. Optional `warning_bytes`, `pause_bytes`, and `resume_bytes` default to the rules above. The core requires Linux, a protected service account, and delegated cgroups. Agent paths must share the monitored filesystem. The service recreates its disposable cache directory on boot; no quota restoration or filesystem remount is needed.

`CLOUDROOM_STORAGE_POLICY` remains required. Never use `CLOUDROOM_UNPROTECTED_TEST_MODE` to bypass a broken live installation.

## Containers

Some machines are containers without cgroup delegation or the capabilities above. If their agents may have sudo, the container is the security boundary anyway, so write `"cgroup_root": null` with `"agent_sudo": true`. Core then:

- runs as the agent account, so it needs no capabilities. The image makes `cloudroom` an alias of that account.
- tags each workload's processes with `CLOUDROOM_WORKLOAD`, and stops, freezes and counts them with signals. Processes that clear their environment or switch user through sudo escape.
- skips npm cache cleanup, which needs frozen cgroups, and allows a memory-backed `/var/tmp`.

A policy without cgroups and without `agent_sudo` is rejected.

## Upgrade an existing quota-based VM

Use an approved idle core update. Preserve files, identities, credentials, history, and the old binary/policy for rollback.

1. Remove `quota_mount`, `quota_limit_bytes`, and `reserve_bytes` from the saved policy. Remove old threshold overrides to adopt the new defaults.
2. Remove the old `storage.sh ... restore` startup hook and replace the service with the updated unit. Keep unrelated firewall hooks.
3. Clear only this account's byte and inode quotas: `sudo setquota -u cloudroom-agent 0 0 0 0 /`. Do not disable other users' quotas or change Linux's reserved blocks.
4. Install the tested core and reload/restart the service. Remove the obsolete installed `storage.sh` after its hook is gone.
5. Verify readiness, actual free-space reporting, preserved sessions, and a real task. Recheck after restart so an old hook cannot silently restore the quota.

No database migration is needed. Old cores cannot read the new policy; rollback must restore the matching old policy and quota too. Updating source defaults does not change existing VMs or published templates.

## Verification

Run the Rust checks, `python3 tests/install.py`, and existing API/fixture checks. The Rust boundary cases cover warning-only admission, emergency pausing, recovery below the warning threshold, and missing/stale measurements. Installer tests preserve account, path, and retry protections without invoking quota or mount commands.

On an explicitly disposable Linux VM with `cr-disk-test` and `cr-service-test` accounts, run `sudo python3 tests/storage_e2e.py --disposable --mixed`. It uses a 512 MiB tmpfs and scaled thresholds, never fills the host disk, and exercises real API reads/writes, busy Codex/Pi fixtures, child processes, warnings, emergency pause, safe cleanup, recovery, and database outages. CI runs the same check. This establishes fixture behavior, not real inference or production rollout.

For transfer and mount regressions, run `python3 tests/disk_writers.py --disposable` inside a fresh privileged Linux container with a private cgroup namespace and the compiled core. It refuses non-container hosts, uses a 256 MiB tmpfs, and checks active upload/download pausing, blocked attachment admission, safe resumption, and rejection of an unmonitored `/code` volume. Never run these mount/disk tests on a customer machine.
