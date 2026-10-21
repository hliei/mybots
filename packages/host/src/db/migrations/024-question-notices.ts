export const questionNoticeSchema = `
BEGIN IMMEDIATE;
CREATE TABLE telegram_topics (
 bot_id TEXT PRIMARY KEY REFERENCES agent_groups(id),
 chat_id TEXT NOT NULL,
 topic_id TEXT,
 state TEXT NOT NULL CHECK (state IN ('mapped', 'repairable')),
 failure TEXT,
 updated_at TEXT NOT NULL
);
CREATE TABLE question_notices (
 question_id TEXT PRIMARY KEY REFERENCES owner_questions(id),
 bot_id TEXT NOT NULL REFERENCES agent_groups(id),
 task_id TEXT NOT NULL,
 run_id TEXT NOT NULL,
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
CREATE INDEX question_notices_bot ON question_notices(bot_id, state);
PRAGMA user_version = 24;
COMMIT;
`;
