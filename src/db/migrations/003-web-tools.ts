export const webSchema = `
BEGIN IMMEDIATE;
ALTER TABLE container_configs ADD COLUMN web TEXT;
PRAGMA user_version = 3;
COMMIT;
`;
