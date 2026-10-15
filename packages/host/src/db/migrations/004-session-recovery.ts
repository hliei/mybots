export const recoverySchema = `
BEGIN IMMEDIATE;
CREATE TABLE host_instances (
 instance_id TEXT PRIMARY KEY, pid INTEGER NOT NULL, started_at TEXT NOT NULL,
 heartbeat_at TEXT NOT NULL, stopped_at TEXT
);
CREATE TABLE session_claims (
 session_id TEXT PRIMARY KEY REFERENCES sessions(id), incarnation INTEGER NOT NULL,
 claimed_by TEXT, claimed_at TEXT, container_ref TEXT, updated_at TEXT NOT NULL
);
PRAGMA user_version = 4;
COMMIT;
`;
