PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`campaign_id` integer,
	`lead_id` integer NOT NULL,
	`connection_id` integer,
	`step_position` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`scheduled_at` integer,
	`sent_at` integer,
	`message_id` text,
	`rendered_subject` text,
	`rendered_body` text,
	`error` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`lead_id`) REFERENCES `leads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connection_id`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_messages`("id", "campaign_id", "lead_id", "connection_id", "step_position", "status", "scheduled_at", "sent_at", "message_id", "rendered_subject", "rendered_body", "error", "created_at") SELECT "id", "campaign_id", "lead_id", "connection_id", "step_position", "status", "scheduled_at", "sent_at", "message_id", "rendered_subject", "rendered_body", "error", "created_at" FROM `messages`;--> statement-breakpoint
DROP TABLE `messages`;--> statement-breakpoint
ALTER TABLE `__new_messages` RENAME TO `messages`;--> statement-breakpoint
PRAGMA foreign_keys=ON;