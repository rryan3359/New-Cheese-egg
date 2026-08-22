CREATE TABLE `alerts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`symbol` text NOT NULL,
	`enabled` integer NOT NULL,
	`payload` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `alerts_user_idx` ON `alerts` (`user_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `alerts_user_id_unique` ON `alerts` (`user_id`,`id`);
--> statement-breakpoint
CREATE TABLE `alert_events` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`alert_id` text NOT NULL,
	`dedupe_key` text NOT NULL,
	`symbol` text NOT NULL,
	`triggered_at` text NOT NULL,
	`payload` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `alert_events_user_time_idx` ON `alert_events` (`user_id`,`triggered_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `alert_events_user_dedupe_unique` ON `alert_events` (`user_id`,`dedupe_key`);
--> statement-breakpoint
CREATE TABLE `journal_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`symbol` text NOT NULL,
	`strategy` text NOT NULL,
	`timeframe` text NOT NULL,
	`actual_pnl` real NOT NULL,
	`r_multiple` real NOT NULL,
	`trade_date` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `journal_user_date_idx` ON `journal_entries` (`user_id`,`trade_date`);
--> statement-breakpoint
CREATE UNIQUE INDEX `journal_user_id_unique` ON `journal_entries` (`user_id`,`id`);
--> statement-breakpoint
CREATE TABLE `user_settings` (`user_id` text PRIMARY KEY NOT NULL, `payload` text NOT NULL, `updated_at` text NOT NULL);
--> statement-breakpoint
CREATE TABLE `watchlist` (`id` text PRIMARY KEY NOT NULL, `user_id` text NOT NULL, `symbol` text NOT NULL, `created_at` text NOT NULL);
--> statement-breakpoint
CREATE INDEX `watchlist_user_idx` ON `watchlist` (`user_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `watchlist_user_symbol_unique` ON `watchlist` (`user_id`,`symbol`);

