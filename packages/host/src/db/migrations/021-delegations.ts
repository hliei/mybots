export const delegationSchema = `
PRAGMA foreign_keys = OFF;
BEGIN IMMEDIATE;
CREATE TABLE tasks_v21 (
 id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id),
 origin TEXT NOT NULL CHECK (origin IN ('chat', 'routine', 'delegation')), created_at TEXT NOT NULL
);
INSERT INTO tasks_v21 SELECT * FROM tasks;
DROP TABLE tasks;
ALTER TABLE tasks_v21 RENAME TO tasks;
CREATE TABLE collaboration_grants (
 source_bot_id TEXT NOT NULL REFERENCES agent_groups(id),
 target_bot_id TEXT NOT NULL REFERENCES agent_groups(id),
 mode TEXT NOT NULL CHECK (mode IN ('deny', 'allow')),
 updated_at TEXT NOT NULL,
 PRIMARY KEY (source_bot_id, target_bot_id),
 CHECK (source_bot_id != target_bot_id)
);
CREATE TABLE delegations (
 id TEXT PRIMARY KEY,
 source_bot_id TEXT NOT NULL REFERENCES agent_groups(id),
 target_bot_id TEXT NOT NULL REFERENCES agent_groups(id),
 parent_task_id TEXT NOT NULL REFERENCES tasks(id),
 parent_run_id TEXT NOT NULL REFERENCES runs(id),
 parent_attempt_id TEXT NOT NULL REFERENCES attempts(id),
 originating_run_id TEXT NOT NULL REFERENCES runs(id),
 child_task_id TEXT REFERENCES tasks(id),
 child_run_id TEXT REFERENCES runs(id),
 text TEXT NOT NULL,
 state TEXT NOT NULL CHECK (state IN ('pending', 'succeeded', 'failed', 'denied', 'cancelled', 'uncertain')),
 result TEXT,
 created_at TEXT NOT NULL,
 resolved_at TEXT
);
CREATE INDEX delegations_parent ON delegations(parent_run_id);
CREATE INDEX delegations_child ON delegations(child_run_id);
PRAGMA user_version = 21;
COMMIT;
PRAGMA foreign_keys = ON;
`;
