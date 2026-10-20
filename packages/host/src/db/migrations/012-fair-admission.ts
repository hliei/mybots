export const fairAdmissionSchema = `
PRAGMA foreign_keys = OFF;
BEGIN IMMEDIATE;
CREATE TABLE runs_v12 (
 id TEXT PRIMARY KEY REFERENCES sessions(id), task_id TEXT NOT NULL REFERENCES tasks(id),
 state TEXT NOT NULL CHECK (state IN ('queued', 'active', 'stopping', 'succeeded', 'failed', 'uncertain', 'closed', 'waiting')),
 background_boundary INTEGER NOT NULL, source_message_id TEXT NOT NULL,
 context TEXT, outcome TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 prior_run_id TEXT, stop_error TEXT, held INTEGER NOT NULL DEFAULT 0, wait_reason TEXT,
 selected_message_ids TEXT NOT NULL DEFAULT '[]'
);
INSERT INTO runs_v12 (
 id, task_id, state, background_boundary, source_message_id, context, outcome, created_at, updated_at,
 prior_run_id, stop_error, held, selected_message_ids
) SELECT
 id, task_id, state, background_boundary, source_message_id, context, outcome, created_at, updated_at,
 prior_run_id, stop_error, held, selected_message_ids
FROM runs;
DROP INDEX unfinished_task_run;
DROP TABLE runs;
ALTER TABLE runs_v12 RENAME TO runs;
CREATE UNIQUE INDEX unfinished_task_run ON runs(task_id) WHERE state IN ('queued', 'active', 'stopping', 'uncertain', 'waiting');
CREATE TABLE admission_scheduler (
 id INTEGER PRIMARY KEY CHECK (id = 1),
 next_class TEXT NOT NULL CHECK (next_class IN ('interactive', 'background')),
 last_seq INTEGER NOT NULL,
 active_limit INTEGER NOT NULL
);
INSERT INTO admission_scheduler VALUES (1, 'interactive', 0, 4);
CREATE TABLE admission_queue (
 run_id TEXT PRIMARY KEY REFERENCES runs(id),
 bot_id TEXT NOT NULL REFERENCES agent_groups(id),
 admission_class TEXT NOT NULL CHECK (admission_class IN ('interactive', 'background')),
 seq INTEGER NOT NULL UNIQUE,
 runnable INTEGER NOT NULL CHECK (runnable IN (0, 1)),
 enqueued_at TEXT NOT NULL
);
INSERT INTO admission_queue (run_id, bot_id, admission_class, seq, runnable, enqueued_at)
SELECT r.id, s.agent_group_id,
 CASE WHEN t.origin = 'chat' THEN 'interactive' ELSE 'background' END,
 ROW_NUMBER() OVER (ORDER BY r.rowid),
 1,
 r.created_at
FROM runs r
JOIN sessions s ON s.id = r.id
JOIN tasks t ON t.id = r.task_id
WHERE r.state IN ('queued', 'active', 'stopping');
UPDATE admission_scheduler SET last_seq = COALESCE((SELECT MAX(seq) FROM admission_queue), 0);
CREATE TABLE execution_reservations (
 bot_id TEXT PRIMARY KEY REFERENCES agent_groups(id),
 run_id TEXT NOT NULL UNIQUE REFERENCES runs(id),
 reserved_at TEXT NOT NULL
);
INSERT INTO execution_reservations (bot_id, run_id, reserved_at)
SELECT bot_id, id, updated_at FROM (
 SELECT s.agent_group_id AS bot_id, r.id AS id, r.updated_at AS updated_at,
        ROW_NUMBER() OVER (PARTITION BY s.agent_group_id ORDER BY r.rowid) AS n
 FROM runs r JOIN sessions s ON s.id = r.id
 WHERE r.state IN ('active', 'stopping')
) WHERE n = 1;
CREATE TABLE admission_service (
 bot_id TEXT PRIMARY KEY REFERENCES agent_groups(id),
 served_seq INTEGER NOT NULL
);
INSERT INTO admission_service (bot_id, served_seq)
SELECT q.bot_id, q.seq FROM admission_queue q
JOIN execution_reservations e ON e.run_id = q.run_id;
PRAGMA user_version = 12;
COMMIT;
PRAGMA foreign_keys = ON;
`;
