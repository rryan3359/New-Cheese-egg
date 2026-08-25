ALTER TABLE `alerts` ADD COLUMN `strategy` text;
--> statement-breakpoint
ALTER TABLE `alerts` ADD COLUMN `strategy_version` integer DEFAULT 13 NOT NULL;
--> statement-breakpoint
ALTER TABLE `alerts` ADD COLUMN `strategy_legacy` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE `alerts`
SET `strategy` = json_extract(`payload`, '$.strategy'), `strategy_version` = 12, `strategy_legacy` = 1
WHERE json_extract(`payload`, '$.strategy') IS NOT NULL;
--> statement-breakpoint
CREATE INDEX `alerts_user_strategy_idx` ON `alerts` (`user_id`,`strategy`);
--> statement-breakpoint
ALTER TABLE `journal_entries` ADD COLUMN `strategy_version` integer DEFAULT 13 NOT NULL;
--> statement-breakpoint
ALTER TABLE `journal_entries` ADD COLUMN `strategy_legacy` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE `journal_entries`
SET `strategy_version` = 12, `strategy_legacy` = 1
WHERE `strategy` NOT IN ('EMA Trend', 'Bollinger Breakout', 'ICT / SMC');
--> statement-breakpoint
CREATE INDEX `journal_user_strategy_idx` ON `journal_entries` (`user_id`,`strategy`);
--> statement-breakpoint
PRAGMA optimize;
