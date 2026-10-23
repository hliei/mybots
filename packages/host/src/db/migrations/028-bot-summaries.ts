/** Index latest Thread originals without loading full conversation bodies. */
export const botSummarySchema = `
BEGIN IMMEDIATE;
CREATE INDEX thread_messages_latest ON thread_messages(thread_id, seq DESC);
CREATE INDEX tasks_thread ON tasks(thread_id);
CREATE INDEX runs_task_state ON runs(task_id, state);
CREATE INDEX owner_questions_bot_state ON owner_questions(bot_id, state);
PRAGMA user_version = 28;
COMMIT;
`;
