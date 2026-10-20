export const actionApprovalSchema = `
PRAGMA foreign_keys = OFF;
BEGIN IMMEDIATE;
CREATE TABLE collaboration_grants_v22 (
 source_bot_id TEXT NOT NULL REFERENCES agent_groups(id),
 target_bot_id TEXT NOT NULL REFERENCES agent_groups(id),
 mode TEXT NOT NULL CHECK (mode IN ('deny', 'ask-each-time', 'allow')),
 updated_at TEXT NOT NULL,
 PRIMARY KEY (source_bot_id, target_bot_id),
 CHECK (source_bot_id != target_bot_id)
);
INSERT INTO collaboration_grants_v22 SELECT * FROM collaboration_grants;
DROP TABLE collaboration_grants;
ALTER TABLE collaboration_grants_v22 RENAME TO collaboration_grants;
CREATE TABLE action_approvals (
 id TEXT PRIMARY KEY REFERENCES delegations(id),
 operation TEXT NOT NULL CHECK (operation = 'delegate'),
 target_bot_id TEXT NOT NULL REFERENCES agent_groups(id),
 text TEXT NOT NULL,
 deadline TEXT,
 state TEXT NOT NULL CHECK (state IN ('pending', 'approved', 'executed', 'denied', 'expired', 'cancelled', 'stale')),
 decision TEXT CHECK (decision IN ('approve', 'deny')),
 decided_at TEXT,
 resolved_at TEXT
);
PRAGMA user_version = 22;
COMMIT;
PRAGMA foreign_keys = ON;
`;
