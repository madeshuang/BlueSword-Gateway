import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export class ApplicationStorage {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS records (scope TEXT, key TEXT, value TEXT NOT NULL, PRIMARY KEY(scope, key));
    `);
  }

  get<T>(scope: string, key: string): T | undefined {
    const row = this.db.prepare("SELECT value FROM records WHERE scope = ? AND key = ?").get(scope, key);
    return row ? JSON.parse(row.value as string) as T : undefined;
  }

  set(scope: string, key: string, value: unknown): void {
    this.db.prepare("INSERT INTO records VALUES (?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value")
      .run(scope, key, JSON.stringify(value));
  }

  list<T>(scope: string): T[] {
    return this.db.prepare("SELECT value FROM records WHERE scope = ?").all(scope)
      .map((row) => JSON.parse(row.value as string) as T);
  }

  close(): void { this.db.close(); }
}
