export const deliveryAttemptSchema = `
BEGIN IMMEDIATE;
CREATE TABLE IF NOT EXISTS delivery_attempts (
 message_id TEXT PRIMARY KEY,
 session_id TEXT NOT NULL,
 attempts INTEGER NOT NULL DEFAULT 0,
 last_attempt_at TEXT,
 next_attempt_at TEXT,
 last_error TEXT
);
CREATE INDEX IF NOT EXISTS delivery_attempts_session ON delivery_attempts(session_id);
PRAGMA user_version = 3;
COMMIT;
`;
