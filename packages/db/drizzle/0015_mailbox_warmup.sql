CREATE TABLE `warmup_emails` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`from_connection_id` integer NOT NULL,
	`to_connection_id` integer NOT NULL,
	`parent_id` integer,
	`message_id` text NOT NULL,
	`subject` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'sending' NOT NULL,
	`error` text,
	`sent_at` integer,
	`landed_in` text,
	`handled_at` integer,
	`replied_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`from_connection_id`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`to_connection_id`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `warmup_emails_message_id_idx` ON `warmup_emails` (`message_id`);--> statement-breakpoint
CREATE INDEX `warmup_emails_from_created_idx` ON `warmup_emails` (`from_connection_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `warmup_emails_to_handled_idx` ON `warmup_emails` (`to_connection_id`,`handled_at`);--> statement-breakpoint
ALTER TABLE `connections` ADD `warmup_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `connections` ADD `warmup_start_volume` integer DEFAULT 2 NOT NULL;--> statement-breakpoint
ALTER TABLE `connections` ADD `warmup_daily_increase` integer DEFAULT 2 NOT NULL;--> statement-breakpoint
ALTER TABLE `connections` ADD `warmup_max_volume` integer DEFAULT 20 NOT NULL;--> statement-breakpoint
ALTER TABLE `connections` ADD `warmup_reply_rate` integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE `connections` ADD `warmup_started_at` integer;--> statement-breakpoint
ALTER TABLE `inbound_emails` ADD `is_warmup` integer DEFAULT false NOT NULL;