CREATE TABLE `model_telemetry_event` (
  `project_id` text NOT NULL REFERENCES `project`(`id`) ON DELETE CASCADE,
  `event_id` text NOT NULL,
  `content_checksum` text NOT NULL,
  `schema_version` integer NOT NULL,
  `event_type` text NOT NULL,
  `episode_id` text NOT NULL,
  `decision_id` text,
  `delegation_id` text,
  `parent_delegation_id` text,
  `attempt_index` integer,
  `workload` text NOT NULL,
  `workload_context` text,
  `action` text,
  `policy` text,
  `execution` text,
  `usage` text,
  `quota` text,
  `verification` text,
  `feedback` text,
  `fanout` text,
  `time_occurred` integer NOT NULL,
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL,
  PRIMARY KEY (`project_id`, `event_id`)
);
--> statement-breakpoint
CREATE INDEX `model_telemetry_event_project_time_occurred_event_id_idx` ON `model_telemetry_event` (`project_id`,`time_occurred`,`event_id`);
--> statement-breakpoint
CREATE INDEX `model_telemetry_event_project_episode_time_occurred_idx` ON `model_telemetry_event` (`project_id`,`episode_id`,`time_occurred`);
--> statement-breakpoint
CREATE INDEX `model_telemetry_event_project_delegation_time_occurred_idx` ON `model_telemetry_event` (`project_id`,`delegation_id`,`time_occurred`);
--> statement-breakpoint
CREATE INDEX `model_telemetry_event_project_event_type_time_occurred_idx` ON `model_telemetry_event` (`project_id`,`event_type`,`time_occurred`);
--> statement-breakpoint
CREATE TABLE `model_telemetry_tombstone` (
  `project_id` text NOT NULL REFERENCES `project`(`id`) ON DELETE CASCADE,
  `event_id` text NOT NULL,
  `content_checksum` text NOT NULL,
  `time_compacted` integer NOT NULL,
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL,
  PRIMARY KEY (`project_id`, `event_id`)
);
--> statement-breakpoint
CREATE INDEX `model_telemetry_tombstone_time_compacted_idx` ON `model_telemetry_tombstone` (`time_compacted`);
