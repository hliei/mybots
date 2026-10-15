export const INBOUND_SCHEMA = `
CREATE TABLE IF NOT EXISTS messages_in (
 id TEXT PRIMARY KEY, seq INTEGER NOT NULL UNIQUE, kind TEXT NOT NULL,
 timestamp TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', process_after TEXT,
 tries INTEGER NOT NULL DEFAULT 0, trigger INTEGER NOT NULL DEFAULT 1,
 platform_id TEXT NOT NULL, channel_type TEXT NOT NULL, thread_id TEXT, content TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS session_routing (
 id INTEGER PRIMARY KEY CHECK (id = 1), channel_type TEXT, platform_id TEXT, thread_id TEXT
);
CREATE TABLE IF NOT EXISTS delivered (
 message_out_id TEXT PRIMARY KEY, platform_message_id TEXT,
 status TEXT NOT NULL, delivered_at TEXT NOT NULL
);
`;

export const OUTBOUND_SCHEMA = `
CREATE TABLE IF NOT EXISTS messages_out (
 id TEXT PRIMARY KEY, seq INTEGER NOT NULL UNIQUE, in_reply_to TEXT NOT NULL,
 timestamp TEXT NOT NULL, kind TEXT NOT NULL, platform_id TEXT NOT NULL,
 channel_type TEXT NOT NULL, thread_id TEXT, content TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS processing_ack (
 message_id TEXT PRIMARY KEY, status TEXT NOT NULL, status_changed TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS session_state (
 key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS container_state (
 id INTEGER PRIMARY KEY CHECK (id = 1), current_tool TEXT,
 tool_declared_timeout_ms INTEGER, tool_started_at TEXT, updated_at TEXT NOT NULL
);
`;
