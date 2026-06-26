-- Track which MMP extraction version produced each activity's mmp_records.
-- NULL on existing rows (pre-versioning); treated as stale so the next
-- sync re-extracts them with the current DURATIONS_S bucket set.
ALTER TABLE activities ADD COLUMN mmp_version INTEGER;
