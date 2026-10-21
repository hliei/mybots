export const botAvailabilitySchema = `
BEGIN IMMEDIATE;
ALTER TABLE agent_groups ADD COLUMN availability TEXT NOT NULL DEFAULT 'active'
 CHECK (availability IN ('active', 'disabled', 'deleted'));
CREATE TABLE bot_lifecycle_requests (
 request_id TEXT PRIMARY KEY,
 bot_id TEXT NOT NULL REFERENCES agent_groups(id),
 operation TEXT NOT NULL CHECK (operation IN ('disable', 'enable', 'delete'))
);
PRAGMA user_version = 25;
COMMIT;
`;
