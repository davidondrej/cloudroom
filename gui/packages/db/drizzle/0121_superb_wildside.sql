CREATE TABLE `cloudroom_commands` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`command` text NOT NULL,
	`input` text NOT NULL,
	`state` text DEFAULT 'sending' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `cloudroom_threads`(`thread_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `cloudroom_threads` (
	`thread_id` text PRIMARY KEY NOT NULL,
	`core_url` text NOT NULL,
	`start_request_id` text NOT NULL,
	`session_id` text,
	`model` text NOT NULL,
	`reasoning` text NOT NULL,
	`cursor` integer DEFAULT 0 NOT NULL,
	`native_id` text,
	`turn_id` text,
	`queue_paused` integer DEFAULT false NOT NULL,
	`error` text,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cloudroom_threads_start_request_id_unique` ON `cloudroom_threads` (`start_request_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `cloudroom_threads_session_id_unique` ON `cloudroom_threads` (`session_id`);--> statement-breakpoint
ALTER TABLE `threads` ADD `execution_target` text DEFAULT 'local' NOT NULL;