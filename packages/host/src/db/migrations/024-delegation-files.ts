export const delegationFileSchema = `
BEGIN IMMEDIATE;
ALTER TABLE task_attachments ADD COLUMN source_delegation_id TEXT;
ALTER TABLE task_attachments ADD COLUMN source_bot_id TEXT;
ALTER TABLE task_attachments ADD COLUMN source_task_id TEXT;
ALTER TABLE task_attachments ADD COLUMN source_run_id TEXT;
ALTER TABLE task_attachments ADD COLUMN source_kind TEXT;
ALTER TABLE task_attachments ADD COLUMN source_file_id TEXT;
CREATE TABLE delegation_files (
 delegation_id TEXT NOT NULL REFERENCES delegations(id),
 position INTEGER NOT NULL,
 kind TEXT NOT NULL CHECK (kind IN ('attachment', 'artifact')),
 source_file_id TEXT NOT NULL,
 filename TEXT NOT NULL,
 byte_size INTEGER NOT NULL CHECK (byte_size > 0),
 content_sha256 TEXT NOT NULL,
 PRIMARY KEY (delegation_id, position)
);
PRAGMA user_version = 24;
COMMIT;
`;
