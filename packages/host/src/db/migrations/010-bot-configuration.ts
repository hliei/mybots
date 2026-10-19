export const botConfigurationSchema = `
BEGIN IMMEDIATE;
ALTER TABLE container_configs ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE attempts ADD COLUMN steer_through_rowid INTEGER;
CREATE TABLE configuration_versions (
 agent_group_id TEXT NOT NULL REFERENCES agent_groups(id),
 version INTEGER NOT NULL,
 instructions TEXT, model_config TEXT NOT NULL, resources TEXT, web TEXT,
 created_at TEXT NOT NULL,
 PRIMARY KEY (agent_group_id, version)
);
INSERT INTO configuration_versions (agent_group_id, version, instructions, model_config, resources, web, created_at)
SELECT agent_group_id, version, instructions, model_config, resources, web, updated_at FROM container_configs;
CREATE TABLE bot_updates (
 request_id TEXT PRIMARY KEY,
 agent_group_id TEXT NOT NULL REFERENCES agent_groups(id),
 payload TEXT NOT NULL,
 version INTEGER NOT NULL
);
PRAGMA user_version = 10;
COMMIT;
`;
