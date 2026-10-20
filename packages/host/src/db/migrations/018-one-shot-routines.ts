export const oneShotRoutineSchema = `
PRAGMA foreign_keys = OFF;
BEGIN IMMEDIATE;
CREATE TABLE tasks_v18 (
 id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id),
 origin TEXT NOT NULL CHECK (origin IN ('chat', 'routine')), created_at TEXT NOT NULL
);
INSERT INTO tasks_v18 SELECT * FROM tasks;
DROP TABLE tasks;
ALTER TABLE tasks_v18 RENAME TO tasks;
CREATE TABLE routines (
 id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE,
 bot_id TEXT NOT NULL REFERENCES agent_groups(id), text TEXT NOT NULL,
 run_at TEXT NOT NULL, timezone TEXT NOT NULL, next_occurrence TEXT,
 selected_message_ids TEXT NOT NULL,
 source_run_id TEXT REFERENCES runs(id), source_attempt_id TEXT REFERENCES attempts(id),
 created_at TEXT NOT NULL
);
CREATE TABLE routine_occurrences (
 task_id TEXT PRIMARY KEY REFERENCES tasks(id),
 routine_id TEXT NOT NULL UNIQUE REFERENCES routines(id),
 definition TEXT NOT NULL, due_at TEXT NOT NULL
);
PRAGMA user_version = 18;
COMMIT;
PRAGMA foreign_keys = ON;
`;
