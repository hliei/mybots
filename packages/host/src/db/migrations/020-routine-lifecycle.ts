export const routineLifecycleSchema = `
BEGIN IMMEDIATE;
ALTER TABLE routines ADD COLUMN paused INTEGER NOT NULL DEFAULT 0;
ALTER TABLE routines ADD COLUMN deleted_at TEXT;
CREATE TABLE routine_commands (
 request_id TEXT PRIMARY KEY,
 routine_id TEXT NOT NULL REFERENCES routines(id),
 bot_id TEXT NOT NULL REFERENCES agent_groups(id),
 action TEXT NOT NULL,
 fingerprint TEXT NOT NULL
);
PRAGMA user_version = 20;
COMMIT;
`;
