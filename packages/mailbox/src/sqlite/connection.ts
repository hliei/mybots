import { join } from "node:path";
import { lockDatabase } from "./lock.ts";

type Binding = string | number | null;

/** SQL operations used by the mailbox protocol, independent of a runtime's driver API. */
export interface MailboxDatabase {
  exec(sql: string): void;
  run(sql: string, ...values: Binding[]): void;
  get(sql: string, ...values: Binding[]): unknown;
  all(sql: string, ...values: Binding[]): unknown[];
  close(): void;
}

export type WithDatabase = <T>(
  directory: string,
  side: "inbound" | "outbound",
  readOnly: boolean,
  operation: (db: MailboxDatabase) => T,
) => T;

export function createWithDatabase(
  openDatabase: (file: string, readOnly: boolean) => MailboxDatabase,
): WithDatabase {
  return (directory, side, readOnly, operation) => {
    const release = lockDatabase(directory, side);
    try {
      const db = openDatabase(join(directory, `${side}.db`), readOnly);
      try {
        db.exec("PRAGMA busy_timeout = 5000; PRAGMA mmap_size = 0;");
        if (!readOnly) db.exec("PRAGMA journal_mode = DELETE;");
        return operation(db);
      } finally {
        db.close();
      }
    } finally {
      release();
    }
  };
}
