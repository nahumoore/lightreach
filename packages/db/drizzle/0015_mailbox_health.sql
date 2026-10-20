ALTER TABLE `connections` ADD `health_reset_at` integer;--> statement-breakpoint
ALTER TABLE `connections` ADD `health_paused_at` integer;--> statement-breakpoint
ALTER TABLE `messages` ADD `failed_at` integer;