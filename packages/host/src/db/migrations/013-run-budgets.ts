export const runBudgetSchema = `
BEGIN IMMEDIATE;
ALTER TABLE runs ADD COLUMN active_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN active_since TEXT;
ALTER TABLE runs ADD COLUMN budget_exhausted_at TEXT;
PRAGMA user_version = 13;
COMMIT;
`;
