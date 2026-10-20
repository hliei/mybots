export const collaborationRevocationSchema = `
BEGIN IMMEDIATE;
ALTER TABLE delegations ADD COLUMN revoked_at TEXT;
PRAGMA user_version = 23;
COMMIT;
`;
