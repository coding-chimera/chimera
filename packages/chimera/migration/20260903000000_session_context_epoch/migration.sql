CREATE TABLE IF NOT EXISTS `session_context_epoch` (
	`session_id` text PRIMARY KEY NOT NULL,
	`baseline` text NOT NULL,
	`snapshot` text NOT NULL,
	`baseline_seq` integer NOT NULL,
	CONSTRAINT `fk_session_context_epoch_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
);
