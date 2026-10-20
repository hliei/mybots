export const ownerQuestionSchema = `
BEGIN IMMEDIATE;
CREATE TABLE owner_questions (
 id TEXT PRIMARY KEY,
 bot_id TEXT NOT NULL REFERENCES agent_groups(id),
 task_id TEXT NOT NULL REFERENCES tasks(id),
 run_id TEXT NOT NULL REFERENCES runs(id),
 attempt_id TEXT NOT NULL REFERENCES attempts(id),
 text TEXT NOT NULL,
 state TEXT NOT NULL CHECK (state IN ('pending', 'answered', 'expired', 'cancelled')),
 deadline TEXT,
 answer TEXT,
 created_at TEXT NOT NULL,
 resolved_at TEXT
);
CREATE INDEX owner_questions_run ON owner_questions(run_id);
PRAGMA user_version = 17;
COMMIT;
`;
