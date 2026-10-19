export const chatSchema = `
BEGIN IMMEDIATE;
ALTER TABLE sessions ADD COLUMN name TEXT NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN purpose TEXT NOT NULL DEFAULT 'channel';
CREATE TABLE chat_admissions (
 request_id TEXT PRIMARY KEY, payload TEXT NOT NULL, response TEXT NOT NULL
);
CREATE TABLE work_items (
 id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
 state TEXT NOT NULL CHECK (state IN ('queued', 'active', 'succeeded', 'failed', 'uncertain')),
 outcome TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX unfinished_chat_work ON work_items(session_id) WHERE state IN ('queued', 'active', 'uncertain');
CREATE TABLE work_inputs (
 message_id TEXT PRIMARY KEY, work_id TEXT NOT NULL REFERENCES work_items(id),
 content TEXT NOT NULL, admitted_at TEXT NOT NULL, outcome TEXT
);
CREATE INDEX work_input_order ON work_inputs(work_id);
PRAGMA user_version = 7;
COMMIT;
`;
