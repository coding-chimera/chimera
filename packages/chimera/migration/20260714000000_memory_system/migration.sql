CREATE TABLE `memory_note` (
  `id` text PRIMARY KEY NOT NULL,
  `scope` text NOT NULL,
  `project_id` text,
  `text` text NOT NULL,
  `source_kind` text NOT NULL,
  `source_session_id` text,
  `source_message_id` text,
  `content_checksum` text NOT NULL,
  `usage_count` integer DEFAULT 0 NOT NULL,
  `last_usage` integer,
  `selected_for_stage2_time_updated` integer,
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL,
  `time_deleted` integer
);
--> statement-breakpoint
CREATE INDEX `memory_note_scope_project_time_deleted_idx` ON `memory_note` (`scope`,`project_id`,`time_deleted`);
--> statement-breakpoint
CREATE INDEX `memory_note_source_session_idx` ON `memory_note` (`source_session_id`);
--> statement-breakpoint
CREATE INDEX `memory_note_content_checksum_idx` ON `memory_note` (`content_checksum`);
--> statement-breakpoint
CREATE INDEX `memory_note_selected_for_stage2_idx` ON `memory_note` (`selected_for_stage2_time_updated`);
--> statement-breakpoint
CREATE TABLE `memory_stage1_output` (
  `session_id` text PRIMARY KEY NOT NULL,
  `project_id` text,
  `source_updated_at` integer NOT NULL,
  `source_deleted_at` integer,
  `payload` text NOT NULL,
  `rollout_summary` text NOT NULL,
  `rollout_slug` text,
  `generated_at` integer NOT NULL,
  `usage_count` integer DEFAULT 0 NOT NULL,
  `last_usage` integer,
  `selected_for_stage2_source_updated_at` integer
);
--> statement-breakpoint
CREATE INDEX `memory_stage1_output_source_updated_at_idx` ON `memory_stage1_output` (`source_updated_at`,`session_id`);
--> statement-breakpoint
CREATE INDEX `memory_stage1_output_project_generated_at_idx` ON `memory_stage1_output` (`project_id`,`generated_at`);
--> statement-breakpoint
CREATE INDEX `memory_stage1_output_selected_for_stage2_idx` ON `memory_stage1_output` (`selected_for_stage2_source_updated_at`);
--> statement-breakpoint
CREATE TABLE `memory_job` (
  `kind` text NOT NULL,
  `job_key` text NOT NULL,
  `status` text NOT NULL,
  `worker_id` text,
  `ownership_token` text,
  `lease_until` integer,
  `retry_at` integer,
  `retry_remaining` integer DEFAULT 0 NOT NULL,
  `last_error` text,
  `input_watermark` integer,
  `last_success_watermark` integer,
  `time_started` integer,
  `time_finished` integer,
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL,
  PRIMARY KEY (`kind`, `job_key`)
);
--> statement-breakpoint
CREATE INDEX `memory_job_kind_status_retry_lease_idx` ON `memory_job` (`kind`,`status`,`retry_at`,`lease_until`);
--> statement-breakpoint
CREATE TABLE `memory_session_state` (
  `session_id` text PRIMARY KEY NOT NULL,
  `mode` text NOT NULL,
  `pollution_reason` text,
  `time_polluted` integer,
  `created_watermark` integer NOT NULL,
  `updated_watermark` integer NOT NULL,
  `time_created` integer NOT NULL,
  `time_updated` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `memory_session_state_mode_updated_watermark_idx` ON `memory_session_state` (`mode`,`updated_watermark`);
