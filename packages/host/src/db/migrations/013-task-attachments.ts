export const taskAttachmentSchema = `
BEGIN IMMEDIATE;
CREATE TABLE task_attachments (
 id TEXT PRIMARY KEY,
 task_id TEXT NOT NULL REFERENCES tasks(id),
 bot_id TEXT NOT NULL REFERENCES agent_groups(id),
 filename TEXT NOT NULL,
 byte_size INTEGER NOT NULL CHECK (byte_size > 0),
 created_at TEXT NOT NULL,
 UNIQUE (task_id, filename)
);
CREATE INDEX task_attachment_task ON task_attachments(task_id);
PRAGMA user_version = 13;
COMMIT;
`;
