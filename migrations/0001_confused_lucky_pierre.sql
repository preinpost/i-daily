CREATE TABLE `oauth_states` (
	`state` text PRIMARY KEY NOT NULL,
	`payload` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`sid` text PRIMARY KEY NOT NULL,
	`user` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL
);
