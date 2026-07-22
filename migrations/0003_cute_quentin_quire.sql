ALTER TABLE `list_items` ADD `space` text DEFAULT '' NOT NULL;--> statement-breakpoint
DROP VIEW `task_rows`;--> statement-breakpoint
CREATE VIEW `task_rows` AS 
  SELECT t.user AS user, t.date AS date, t.side AS side, sp.label AS space,
         t.jkey AS jkey, t.descr AS descr, t.progress AS progress, t.due AS due, t.subs_json AS subs_json
    FROM tasks t
    JOIN spaces sp ON sp.user = t.user AND sp.date = t.date AND sp.side = t.side AND sp.pos = t.space_pos
   WHERE t.jkey <> '' OR t.descr <> ''
  UNION ALL
  SELECT user, date, 'daily' AS side, space AS space, jkey, descr, progress, due, subs_json
    FROM list_items
   WHERE jkey <> '' OR descr <> ''
;