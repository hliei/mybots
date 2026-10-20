export const deliveredArtifactSchema = `
BEGIN IMMEDIATE;
CREATE TABLE delivered_artifacts (
 id TEXT PRIMARY KEY,
 publication_id TEXT NOT NULL REFERENCES agent_publications(id),
 bot_id TEXT NOT NULL REFERENCES agent_groups(id),
 task_id TEXT NOT NULL REFERENCES tasks(id),
 run_id TEXT NOT NULL REFERENCES runs(id),
 name TEXT NOT NULL,
 byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
 created_at TEXT NOT NULL
);
CREATE INDEX delivered_artifacts_publication ON delivered_artifacts(publication_id);
PRAGMA user_version = 16;
COMMIT;
`;
