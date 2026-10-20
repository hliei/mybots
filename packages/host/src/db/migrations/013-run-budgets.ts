export const runBudgetSchema = `
BEGIN IMMEDIATE;
ALTER TABLE runs ADD COLUMN active_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN active_since TEXT;
ALTER TABLE runs ADD COLUMN budget_exhausted_at TEXT;
UPDATE runs SET active_ms = COALESCE((
 SELECT SUM(MAX(0, CAST(ROUND((julianday(a.ended_at) - julianday(a.started_at)) * 86400000) AS INTEGER)))
 FROM attempts a WHERE a.run_id = runs.id AND a.ended_at IS NOT NULL
), 0), active_since = (
 SELECT a.started_at FROM attempts a WHERE a.run_id = runs.id AND a.ended_at IS NULL
 ORDER BY a.rowid DESC LIMIT 1
);
PRAGMA user_version = 13;
COMMIT;
`;
