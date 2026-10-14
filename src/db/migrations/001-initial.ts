export const schema = `
CREATE TABLE agent_groups (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, folder TEXT NOT NULL UNIQUE,
 agent_provider TEXT NOT NULL CHECK (agent_provider = 'pi'), created_at TEXT NOT NULL
);
CREATE TABLE users (
 id TEXT PRIMARY KEY, kind TEXT NOT NULL, display_name TEXT, created_at TEXT NOT NULL
);
CREATE TABLE user_roles (
 user_id TEXT NOT NULL REFERENCES users(id), role TEXT NOT NULL CHECK (role = 'owner'),
 agent_group_id TEXT REFERENCES agent_groups(id), granted_by TEXT REFERENCES users(id),
 granted_at TEXT NOT NULL, CHECK (agent_group_id IS NULL)
);
CREATE UNIQUE INDEX user_role_scope ON user_roles(user_id, role, COALESCE(agent_group_id, ''));
CREATE TABLE messaging_groups (
 id TEXT PRIMARY KEY, channel_type TEXT NOT NULL, platform_id TEXT NOT NULL,
 instance TEXT NOT NULL, is_group INTEGER NOT NULL DEFAULT 0,
 unknown_sender_policy TEXT NOT NULL DEFAULT 'strict', created_at TEXT NOT NULL,
 UNIQUE(channel_type, platform_id, instance)
);
CREATE TABLE messaging_group_agents (
 id TEXT PRIMARY KEY, messaging_group_id TEXT NOT NULL REFERENCES messaging_groups(id),
 agent_group_id TEXT NOT NULL REFERENCES agent_groups(id),
 engage_mode TEXT NOT NULL DEFAULT 'pattern', engage_pattern TEXT NOT NULL DEFAULT '.',
 sender_scope TEXT NOT NULL DEFAULT 'known', session_mode TEXT NOT NULL DEFAULT 'shared',
 threads INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
 UNIQUE(messaging_group_id, agent_group_id)
);
CREATE TABLE container_configs (
 agent_group_id TEXT PRIMARY KEY REFERENCES agent_groups(id), provider TEXT NOT NULL,
 model TEXT NOT NULL, model_config TEXT NOT NULL, instructions TEXT, updated_at TEXT NOT NULL
);
CREATE TABLE sessions (
 id TEXT PRIMARY KEY, agent_group_id TEXT NOT NULL REFERENCES agent_groups(id),
 messaging_group_id TEXT NOT NULL REFERENCES messaging_groups(id), thread_id TEXT,
 agent_provider TEXT, status TEXT NOT NULL DEFAULT 'active',
 container_status TEXT NOT NULL DEFAULT 'stopped', last_active TEXT, created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX session_affinity ON sessions(agent_group_id, messaging_group_id, COALESCE(thread_id, '')) WHERE status = 'active';
PRAGMA user_version = 1;
`;
