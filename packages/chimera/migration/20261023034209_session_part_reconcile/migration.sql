CREATE TABLE `session_part_reconcile` (
	`session_id` text PRIMARY KEY,
	`watermark` integer NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `message_session_time_updated_idx` ON `message` (`session_id`,`time_updated`);--> statement-breakpoint
CREATE INDEX `part_session_time_updated_idx` ON `part` (`session_id`,`time_updated`);