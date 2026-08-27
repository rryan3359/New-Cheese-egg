ALTER TABLE `alerts` ADD COLUMN `strategy_model` text;
--> statement-breakpoint
ALTER TABLE `alerts` ADD COLUMN `strategy_ruleset` text DEFAULT 'v13-legacy' NOT NULL;
--> statement-breakpoint
ALTER TABLE `journal_entries` ADD COLUMN `strategy_model` text;
--> statement-breakpoint
ALTER TABLE `journal_entries` ADD COLUMN `strategy_ruleset` text DEFAULT 'v13-legacy' NOT NULL;
--> statement-breakpoint
PRAGMA optimize;
