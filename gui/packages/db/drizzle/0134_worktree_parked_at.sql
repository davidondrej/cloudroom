ALTER TABLE `environments` ADD `parked_at` integer;
--> statement-breakpoint
-- Worktrees no longer wait after archive: restart pending timers so the next sweep saves and parks them.
UPDATE `environments` SET `retire_at` = NULL WHERE `environment_provider_id` = 'git-worktree' AND `teardown_status` IS NULL AND `retire_at` IS NOT NULL;
--> statement-breakpoint
DELETE FROM `app_settings_values` WHERE `key` = 'worktreeRetention';
