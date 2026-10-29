DROP TRIGGER IF EXISTS `thread_search_segments_trigram_after_text_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `thread_search_segments_trigram_after_delete`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `thread_search_segments_trigram_after_insert`;
--> statement-breakpoint
DROP TABLE IF EXISTS `thread_search_segments_trigram`;
--> statement-breakpoint
CREATE VIRTUAL TABLE `thread_search_segments_trigram` USING fts5(
  `text`,
  content = '',
  contentless_delete = 1,
  tokenize = 'trigram remove_diacritics 1'
);
--> statement-breakpoint
INSERT INTO `thread_search_segments_trigram` (`rowid`, `text`)
SELECT `rowid`, `text`
FROM `thread_search_segments`;
--> statement-breakpoint
CREATE TRIGGER `thread_search_segments_trigram_after_insert`
AFTER INSERT ON `thread_search_segments`
BEGIN
  INSERT INTO `thread_search_segments_trigram` (`rowid`, `text`)
  VALUES (new.`rowid`, new.`text`);
END;
--> statement-breakpoint
CREATE TRIGGER `thread_search_segments_trigram_after_delete`
AFTER DELETE ON `thread_search_segments`
BEGIN
  DELETE FROM `thread_search_segments_trigram`
  WHERE `rowid` = old.`rowid`;
END;
--> statement-breakpoint
CREATE TRIGGER `thread_search_segments_trigram_after_text_update`
AFTER UPDATE OF `id`, `text` ON `thread_search_segments`
BEGIN
  DELETE FROM `thread_search_segments_trigram`
  WHERE `rowid` = old.`rowid`;

  INSERT INTO `thread_search_segments_trigram` (`rowid`, `text`)
  VALUES (new.`rowid`, new.`text`);
END;
