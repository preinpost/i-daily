CREATE TABLE `weekly_reports` (
	`user` text NOT NULL,
	`from_date` text NOT NULL,
	`to_date` text NOT NULL,
	`this_week` text DEFAULT '' NOT NULL,
	`next_week` text DEFAULT '' NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`user`, `from_date`, `to_date`)
);
