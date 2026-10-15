export const resourceSchema = `
BEGIN IMMEDIATE;
ALTER TABLE container_configs ADD COLUMN resources TEXT;
PRAGMA user_version = 2;
COMMIT;
`;
