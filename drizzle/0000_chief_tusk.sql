CREATE TABLE `online_presence` (
	`room_code` text NOT NULL,
	`player_id` text NOT NULL,
	`last_seen` integer NOT NULL,
	PRIMARY KEY(`room_code`, `player_id`)
);
--> statement-breakpoint
CREATE TABLE `online_rooms` (
	`code` text PRIMARY KEY NOT NULL,
	`state` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`updated_at` integer NOT NULL
);
