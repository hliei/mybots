import { DatabaseSync } from "node:sqlite";
import { createWithDatabase } from "./sqlite/connection.ts";
import { createMailbox } from "./sqlite/mailbox.ts";

const withDatabase = createWithDatabase((file, readOnly) => {
  const db = new DatabaseSync(file, { readOnly });
  return {
    exec: (sql) => {
      db.exec(sql);
    },
    run: (sql, ...values) => {
      db.prepare(sql).run(...values);
    },
    get: (sql, ...values) => db.prepare(sql).get(...values),
    all: (sql, ...values) => db.prepare(sql).all(...values),
    close: () => db.close(),
  };
});

export const { HostMailbox, initializeMailbox, RunnerMailbox } = createMailbox(withDatabase);
export type HostMailbox = InstanceType<typeof HostMailbox>;
export type RunnerMailbox = InstanceType<typeof RunnerMailbox>;
export { clearMailboxLocks } from "./sqlite/lock.ts";
export type * from "./types.ts";
