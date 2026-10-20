ALTER TABLE `inbound_emails` ADD `lead_id` integer REFERENCES leads(id) ON UPDATE no action ON DELETE set null;--> statement-breakpoint
ALTER TABLE `inbound_emails` ADD `campaign_id` integer REFERENCES campaigns(id) ON UPDATE no action ON DELETE set null;--> statement-breakpoint
ALTER TABLE `inbound_emails` ADD `is_auto_reply` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX `inbound_email_lead_idx` ON `inbound_emails` (`lead_id`);