CREATE TABLE `blocks` (
	`user` text NOT NULL,
	`date` text NOT NULL,
	`side` text NOT NULL,
	`issues` text DEFAULT '없음' NOT NULL,
	`collab` text DEFAULT '없음' NOT NULL,
	PRIMARY KEY(`user`, `date`, `side`)
);
--> statement-breakpoint
CREATE TABLE `days` (
	`user` text NOT NULL,
	`date` text NOT NULL,
	`owner` text DEFAULT '' NOT NULL,
	`preamble` text DEFAULT '' NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`user`, `date`)
);
--> statement-breakpoint
CREATE TABLE `jira_auth` (
	`user` text PRIMARY KEY NOT NULL,
	`json` text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `list_items` (
	`user` text NOT NULL,
	`date` text NOT NULL,
	`pos` integer NOT NULL,
	`done` integer DEFAULT 0 NOT NULL,
	`jkey` text DEFAULT '' NOT NULL,
	`descr` text DEFAULT '' NOT NULL,
	`progress` integer,
	`due` text DEFAULT '' NOT NULL,
	`subs_json` text DEFAULT '[]' NOT NULL,
	PRIMARY KEY(`user`, `date`, `pos`)
);
--> statement-breakpoint
CREATE INDEX `idx_items_ud` ON `list_items` (`user`,`date`);--> statement-breakpoint
CREATE TABLE `sections` (
	`user` text NOT NULL,
	`date` text NOT NULL,
	`pos` integer NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	PRIMARY KEY(`user`, `date`, `pos`)
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`user` text PRIMARY KEY NOT NULL,
	`json` text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `shortcuts` (
	`user` text NOT NULL,
	`pos` integer NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`url` text DEFAULT '' NOT NULL,
	PRIMARY KEY(`user`, `pos`)
);
--> statement-breakpoint
CREATE TABLE `spaces` (
	`user` text NOT NULL,
	`date` text NOT NULL,
	`side` text NOT NULL,
	`pos` integer NOT NULL,
	`label` text DEFAULT '' NOT NULL,
	PRIMARY KEY(`user`, `date`, `side`, `pos`)
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`user` text NOT NULL,
	`date` text NOT NULL,
	`side` text NOT NULL,
	`space_pos` integer NOT NULL,
	`pos` integer NOT NULL,
	`jkey` text DEFAULT '' NOT NULL,
	`descr` text DEFAULT '' NOT NULL,
	`progress` integer,
	`due` text DEFAULT '' NOT NULL,
	`subs_json` text DEFAULT '[]' NOT NULL,
	PRIMARY KEY(`user`, `date`, `side`, `space_pos`, `pos`)
);
--> statement-breakpoint
CREATE INDEX `idx_tasks_ud` ON `tasks` (`user`,`date`);--> statement-breakpoint
CREATE INDEX `idx_tasks_key` ON `tasks` (`jkey`);--> statement-breakpoint
CREATE VIEW `task_rows` AS 
  SELECT t.user AS user, t.date AS date, t.side AS side, sp.label AS space,
         t.jkey AS jkey, t.descr AS descr, t.progress AS progress, t.due AS due, t.subs_json AS subs_json
    FROM tasks t
    JOIN spaces sp ON sp.user = t.user AND sp.date = t.date AND sp.side = t.side AND sp.pos = t.space_pos
   WHERE t.jkey <> '' OR t.descr <> ''
  UNION ALL
  SELECT user, date, 'daily' AS side, '' AS space, jkey, descr, progress, due, subs_json
    FROM list_items
   WHERE jkey <> '' OR descr <> ''
;