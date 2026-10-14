import { join } from "node:path";
import { lockDatabase } from "./lock.ts";

interface Statement {
  run(...values: Array<string | number | null>): unknown;
  get(...values: Array<string | number | null>): unknown;
  all(...values: Array<string | number | null>): unknown[];
}
interface Connection {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  close(): void;
}

// Both runtimes use SQLite itself; only the constructor options differ.
const bunSqliteModule = "bun:sqlite";
const openConnection: (file: string, readOnly: boolean) => Connection = process.versions.bun
  ? await (
      import(bunSqliteModule) as Promise<{
        Database: new (file: string, options: { readonly: boolean; create: boolean }) => Connection;
      }>
    ).then(
      ({ Database }) =>
        (file: string, readOnly: boolean) =>
          new Database(file, { readonly: readOnly, create: !readOnly }),
    )
  : await import("node:sqlite").then(
      ({ DatabaseSync }) =>
        (file: string, readOnly: boolean) =>
          new DatabaseSync(file, { readOnly }),
    );

export function withDatabase<T>(
  directory: string,
  side: "inbound" | "outbound",
  readOnly: boolean,
  operation: (db: Connection) => T,
): T {
  const release = lockDatabase(directory, side);
  try {
    const db = openConnection(join(directory, `${side}.db`), readOnly);
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
}
