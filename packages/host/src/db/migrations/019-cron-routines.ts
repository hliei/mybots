export const cronRoutineSchema = `
BEGIN IMMEDIATE;
CREATE TABLE bot_timezones (
 bot_id TEXT PRIMARY KEY REFERENCES agent_groups(id), timezone TEXT NOT NULL
);
CREATE TABLE timezone_updates (
 request_id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES agent_groups(id), timezone TEXT NOT NULL
);
ALTER TABLE routines ADD COLUMN cron TEXT;
ALTER TABLE routine_occurrences RENAME TO routine_occurrences_v18;
CREATE TABLE routine_occurrences (
 task_id TEXT PRIMARY KEY REFERENCES tasks(id),
 routine_id TEXT NOT NULL REFERENCES routines(id),
 definition TEXT NOT NULL, due_at TEXT NOT NULL,
 UNIQUE(routine_id, due_at)
);
INSERT INTO routine_occurrences SELECT * FROM routine_occurrences_v18;
DROP TABLE routine_occurrences_v18;
PRAGMA user_version = 19;
COMMIT;
`;
