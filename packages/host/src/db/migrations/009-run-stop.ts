export const runStopSchema = `
PRAGMA foreign_keys = OFF;
BEGIN IMMEDIATE;
CREATE TABLE runs_v9 (
 id TEXT PRIMARY KEY REFERENCES sessions(id), task_id TEXT NOT NULL REFERENCES tasks(id),
 state TEXT NOT NULL CHECK (state IN ('queued', 'active', 'stopping', 'succeeded', 'failed', 'uncertain', 'closed')),
 background_boundary INTEGER NOT NULL, source_message_id TEXT NOT NULL,
 context TEXT, outcome TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 prior_run_id TEXT, stop_error TEXT, held INTEGER NOT NULL DEFAULT 0
);
INSERT INTO runs_v9 (
 id, task_id, state, background_boundary, source_message_id, context, outcome, created_at, updated_at
) SELECT id, task_id, state, background_boundary, source_message_id, context, outcome, created_at, updated_at FROM runs;
DROP INDEX unfinished_task_run;
DROP TABLE runs;
ALTER TABLE runs_v9 RENAME TO runs;
CREATE UNIQUE INDEX unfinished_task_run ON runs(task_id) WHERE state IN ('queued', 'active', 'stopping', 'uncertain');
CREATE TABLE late_results (
 id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id),
 content TEXT NOT NULL, created_at TEXT NOT NULL
);
PRAGMA user_version = 9;
COMMIT;
PRAGMA foreign_keys = ON;
`;
