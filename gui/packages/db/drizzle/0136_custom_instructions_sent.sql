CREATE TABLE `thread_custom_instructions` (
	`thread_id` text PRIMARY KEY NOT NULL,
	`hash` text NOT NULL,
	`reset_at` integer NOT NULL,
	`messages` integer NOT NULL,
	`resend` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
