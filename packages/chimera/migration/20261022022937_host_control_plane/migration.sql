CREATE TABLE `host_event` (
	`seq` integer PRIMARY KEY,
	`event_id` text NOT NULL UNIQUE,
	`dedupe_key` text NOT NULL UNIQUE,
	`workspace_id` text,
	`project_id` text,
	`aggregate_id` text NOT NULL,
	`aggregate_seq` integer,
	`type` text NOT NULL,
	`worker_id` text,
	`worker_generation` integer,
	`payload` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `host_state` (
	`scope` text PRIMARY KEY,
	`schema_version` integer NOT NULL,
	`host_generation` integer NOT NULL,
	`next_worker_generation` integer NOT NULL,
	`next_event_seq` integer NOT NULL,
	`boot_id` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `host_worker` (
	`worker_id` text PRIMARY KEY,
	`workspace_id` text NOT NULL,
	`generation` integer NOT NULL,
	`boot_id` text NOT NULL,
	`pid` integer NOT NULL,
	`pgid` integer,
	`status` text NOT NULL,
	`protocol_version` text NOT NULL,
	`capabilities` text NOT NULL,
	`started_at` integer NOT NULL,
	`heartbeat_at` integer,
	`drain_requested_at` integer,
	`exited_at` integer,
	`exit_reason` text,
	`last_error` text,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `pending_request` (
	`request_id` text PRIMARY KEY,
	`request_key` text NOT NULL,
	`kind` text NOT NULL,
	`session_id` text NOT NULL,
	`turn_id` text,
	`worker_id` text,
	`worker_generation` integer,
	`tool_call_id` text,
	`status` text NOT NULL,
	`payload` text NOT NULL,
	`answer` text,
	`generation` integer NOT NULL,
	`expires_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `request_idempotency` (
	`scope` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_hash` text NOT NULL,
	`operation` text NOT NULL,
	`status` text NOT NULL,
	`response_ref` text,
	`response_body` text,
	`generation` integer,
	`owner_session_id` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	CONSTRAINT `request_idempotency_pk` PRIMARY KEY(`scope`, `idempotency_key`)
);
--> statement-breakpoint
CREATE TABLE `session_turn_checkpoint` (
	`session_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`turn_seq` integer NOT NULL,
	`generation` integer NOT NULL,
	`worker_id` text,
	`worker_generation` integer,
	`status` text NOT NULL,
	`commit_state` text NOT NULL,
	`commit_token` text,
	`completion_source` text,
	`terminal_source` text,
	`intent` text NOT NULL,
	`resume_policy` text NOT NULL,
	`side_effect_state` text NOT NULL,
	`last_message_id` text,
	`last_event_seq` integer,
	`cancel_requested_at` integer,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `session_turn_checkpoint_pk` PRIMARY KEY(`session_id`, `turn_id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `host_event_aggregate_seq_idx` ON `host_event` (`aggregate_id`,`aggregate_seq`) WHERE aggregate_seq IS NOT NULL;--> statement-breakpoint
CREATE INDEX `host_event_created_idx` ON `host_event` (`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `host_worker_workspace_generation_idx` ON `host_worker` (`workspace_id`,`generation`);--> statement-breakpoint
CREATE UNIQUE INDEX `host_worker_active_idx` ON `host_worker` (`workspace_id`) WHERE status NOT IN ('exited', 'crashed', 'killed');--> statement-breakpoint
CREATE INDEX `host_worker_status_heartbeat_idx` ON `host_worker` (`status`,`heartbeat_at`);--> statement-breakpoint
CREATE INDEX `host_worker_workspace_status_idx` ON `host_worker` (`workspace_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `pending_request_active_key_idx` ON `pending_request` (`session_id`,`request_key`) WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX `pending_request_session_status_idx` ON `pending_request` (`session_id`,`status`);--> statement-breakpoint
CREATE INDEX `pending_request_status_expires_idx` ON `pending_request` (`status`,`expires_at`);--> statement-breakpoint
CREATE INDEX `request_idempotency_expires_idx` ON `request_idempotency` (`expires_at`);--> statement-breakpoint
CREATE INDEX `session_turn_checkpoint_session_status_idx` ON `session_turn_checkpoint` (`session_id`,`status`);--> statement-breakpoint
CREATE INDEX `session_turn_checkpoint_worker_idx` ON `session_turn_checkpoint` (`worker_id`,`worker_generation`);--> statement-breakpoint
CREATE UNIQUE INDEX `session_turn_checkpoint_active_idx` ON `session_turn_checkpoint` (`session_id`) WHERE status IN ('accepted', 'running', 'waiting_permission', 'waiting_question', 'waiting_tool', 'cancelling');