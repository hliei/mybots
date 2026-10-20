export const agentPublicationSchema = `
BEGIN IMMEDIATE;
CREATE TABLE agent_publications (
 id TEXT PRIMARY KEY,
 kind TEXT NOT NULL CHECK (kind IN ('progress', 'result')),
 bot_id TEXT NOT NULL,
 task_id TEXT NOT NULL REFERENCES tasks(id),
 run_id TEXT NOT NULL REFERENCES runs(id),
 attempt_id TEXT NOT NULL REFERENCES attempts(id),
 text TEXT NOT NULL,
 created_at TEXT NOT NULL
);
CREATE INDEX agent_publications_run ON agent_publications(run_id);
PRAGMA user_version = 15;
COMMIT;
`;
