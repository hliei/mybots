export const chatBackgroundSchema = `
BEGIN IMMEDIATE;
ALTER TABLE runs ADD COLUMN selected_message_ids TEXT NOT NULL DEFAULT '[]';
PRAGMA user_version = 11;
COMMIT;
`;
