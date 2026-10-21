export const workNoticeSchema = `
BEGIN IMMEDIATE;
ALTER TABLE runs ADD COLUMN collaboration_waited INTEGER NOT NULL DEFAULT 0;
UPDATE runs SET collaboration_waited = 1 WHERE state = 'waiting' AND EXISTS (SELECT 1 FROM delegations d WHERE d.parent_run_id = runs.id AND d.state IN ('pending', 'uncertain'));
CREATE TABLE notices (
 id TEXT PRIMARY KEY,
 kind TEXT NOT NULL CHECK (kind IN ('question', 'approval', 'outcome', 'uncertain')),
 question_id TEXT REFERENCES owner_questions(id),
 request_id TEXT,
 routine_id TEXT,
 prior_run_id TEXT,
 source_chain TEXT NOT NULL DEFAULT '[]',
 bot_id TEXT NOT NULL REFERENCES agent_groups(id),
 task_id TEXT NOT NULL REFERENCES tasks(id),
 run_id TEXT NOT NULL REFERENCES runs(id),
 summary TEXT NOT NULL,
 locator TEXT NOT NULL,
 eligibility TEXT NOT NULL CHECK (eligibility IN ('eligible', 'suppressed')),
 state TEXT NOT NULL CHECK (state IN ('pending', 'delivered', 'failed', 'suppressed')),
 attempts INTEGER NOT NULL,
 next_attempt_at TEXT,
 last_error TEXT,
 accepted_at TEXT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
INSERT INTO notices (id, kind, question_id, request_id, bot_id, task_id, run_id,
 summary, locator, eligibility, state, attempts, next_attempt_at, last_error,
 accepted_at, created_at, updated_at)
 SELECT 'question:' || question_id, 'question', question_id, question_id, bot_id, task_id, run_id,
 summary, locator, eligibility, state, attempts, next_attempt_at, last_error,
 accepted_at, created_at, updated_at FROM question_notices;
DROP TABLE question_notices;
CREATE INDEX notices_bot ON notices(bot_id, state);
PRAGMA user_version = 27;
COMMIT;
`;
