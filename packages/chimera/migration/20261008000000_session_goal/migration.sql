CREATE TABLE IF NOT EXISTS `goal` (
	`session_id` text PRIMARY KEY NOT NULL,
	`data` text NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	CONSTRAINT `fk_goal_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
);
