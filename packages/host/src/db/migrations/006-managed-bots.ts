export const managedBotSchema = `
BEGIN IMMEDIATE;
CREATE TABLE bot_bootstrap (
 singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
 agent_group_id TEXT NOT NULL REFERENCES agent_groups(id)
);
INSERT INTO bot_bootstrap SELECT 1, id FROM agent_groups ORDER BY created_at, id LIMIT 1;
CREATE TABLE bot_creations (
 request_id TEXT PRIMARY KEY,
 agent_group_id TEXT NOT NULL UNIQUE REFERENCES agent_groups(id),
 payload TEXT NOT NULL
);
PRAGMA user_version = 6;
COMMIT;
`;
