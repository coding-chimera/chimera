CREATE TABLE IF NOT EXISTS `session_turn_lease` (
	`session_id` text PRIMARY KEY NOT NULL,
	`owner_boot_id` text NOT NULL,
	`owner_pid` integer NOT NULL,
	`acquired_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
