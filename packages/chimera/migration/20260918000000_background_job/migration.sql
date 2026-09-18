CREATE TABLE IF NOT EXISTS `background_job` (
	`id` text NOT NULL,
	`instance_directory` text NOT NULL,
	`generation` integer NOT NULL,
	`status` text NOT NULL,
	`data` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`instance_directory`, `id`)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `background_job_instance_updated_idx` ON `background_job` (`instance_directory`,`updated_at`);
