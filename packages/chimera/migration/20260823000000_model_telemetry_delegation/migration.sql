CREATE TABLE `model_telemetry_session_binding` (
  `project_id` text NOT NULL REFERENCES `project`(`id`) ON DELETE CASCADE,
  `session_id` text NOT NULL REFERENCES `session`(`id`) ON DELETE CASCADE,
  `episode_id` text NOT NULL,
  `parent_delegation_id` text,
  `next_attempt_index` integer NOT NULL,
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL,
  PRIMARY KEY (`project_id`, `session_id`)
);
--> statement-breakpoint
CREATE INDEX `model_telemetry_session_binding_project_episode_idx` ON `model_telemetry_session_binding` (`project_id`,`episode_id`);
--> statement-breakpoint
CREATE TABLE `model_telemetry_delegation` (
  `project_id` text NOT NULL REFERENCES `project`(`id`) ON DELETE CASCADE,
  `session_id` text NOT NULL REFERENCES `session`(`id`) ON DELETE CASCADE,
  `episode_id` text NOT NULL,
  `decision_id` text NOT NULL,
  `delegation_id` text NOT NULL,
  `parent_delegation_id` text,
  `attempt_index` integer NOT NULL,
  `workload` text NOT NULL,
  `action` text NOT NULL,
  `fanout` text,
  `terminal_event_type` text,
  `terminal_event_id` text,
  `terminal_checksum` text,
  `terminal_time` integer,
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL,
  PRIMARY KEY (`project_id`, `delegation_id`)
);
--> statement-breakpoint
CREATE INDEX `model_telemetry_delegation_project_session_attempt_idx` ON `model_telemetry_delegation` (`project_id`,`session_id`,`attempt_index`);
--> statement-breakpoint
CREATE TABLE `model_telemetry_oracle_link` (
  `project_id` text NOT NULL REFERENCES `project`(`id`) ON DELETE CASCADE,
  `oracle_key` text NOT NULL,
  `session_id` text NOT NULL,
  `delegation_id` text NOT NULL,
  `episode_id` text NOT NULL,
  `attempt_index` integer NOT NULL,
  `verification_event_id` text NOT NULL,
  `verification_kind` text NOT NULL,
  `status` text NOT NULL,
  `trusted` integer NOT NULL,
  `time_occurred` integer NOT NULL,
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL,
  PRIMARY KEY (`project_id`, `oracle_key`)
);
--> statement-breakpoint
CREATE INDEX `model_telemetry_oracle_link_project_session_idx` ON `model_telemetry_oracle_link` (`project_id`,`session_id`);
--> statement-breakpoint
CREATE INDEX `model_telemetry_oracle_link_project_delegation_idx` ON `model_telemetry_oracle_link` (`project_id`,`delegation_id`);
