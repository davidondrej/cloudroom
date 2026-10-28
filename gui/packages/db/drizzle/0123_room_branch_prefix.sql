-- Settings saves persist every key, so old defaults ("bb/", "cloudroom/") got frozen. Move them to the "room/" default.
UPDATE `app_settings_values` SET `value` = '"room/"' WHERE `key` = 'managedBranchPrefix' AND `value` IN ('"bb/"', '"cloudroom/"');
