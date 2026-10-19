export const threadExecutionSchema = `
BEGIN IMMEDIATE;
DROP TABLE work_inputs;
DROP TABLE work_items;
DROP TABLE chat_admissions;
DROP INDEX session_affinity;
CREATE UNIQUE INDEX session_affinity ON sessions(agent_group_id, messaging_group_id, COALESCE(thread_id, '')) WHERE status = 'active' AND purpose = 'channel';
CREATE TABLE threads (
 id TEXT PRIMARY KEY, bot_id TEXT NOT NULL UNIQUE REFERENCES agent_groups(id),
 background_boundary INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE TABLE tasks (
 id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id),
 origin TEXT NOT NULL CHECK (origin = 'chat'), created_at TEXT NOT NULL
);
CREATE TABLE runs (
 id TEXT PRIMARY KEY REFERENCES sessions(id), task_id TEXT NOT NULL REFERENCES tasks(id),
 state TEXT NOT NULL CHECK (state IN ('queued', 'active', 'succeeded', 'failed', 'uncertain')),
 background_boundary INTEGER NOT NULL, source_message_id TEXT NOT NULL,
 context TEXT, outcome TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX unfinished_task_run ON runs(task_id) WHERE state IN ('queued', 'active', 'uncertain');
CREATE TABLE attempts (
 id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), incarnation INTEGER NOT NULL,
 configuration_version INTEGER NOT NULL, started_at TEXT NOT NULL, ended_at TEXT,
 UNIQUE(run_id, incarnation)
);
CREATE TABLE thread_messages (
 seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
 thread_id TEXT NOT NULL REFERENCES threads(id), run_id TEXT NOT NULL REFERENCES runs(id),
 role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE run_inputs (
 message_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id),
 content TEXT NOT NULL, admitted_at TEXT NOT NULL, outcome TEXT, destination_id TEXT NOT NULL REFERENCES messaging_groups(id), recorded_at TEXT
);
CREATE TABLE input_admissions (
 request_id TEXT PRIMARY KEY, payload TEXT NOT NULL, response TEXT NOT NULL
);
PRAGMA user_version = 8;
COMMIT;
`;
