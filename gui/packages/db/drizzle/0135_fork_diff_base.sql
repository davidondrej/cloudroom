-- Forks made before v144 compare against their frozen cloudroom/fork-<id> snapshot branch, so after a rebase the diff
-- panel counts everyone else's commits. Clear it: the panel then compares against the project's default branch.
UPDATE `environments` SET `merge_base_branch` = NULL WHERE `merge_base_branch` LIKE 'cloudroom/fork-%';
