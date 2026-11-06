/** Every relay wait has a deadline. A lost answer must fail one request fast, never freeze many (2026-11-05). */
export const DB_TIMEOUT_MS = 3_000;

export class RelayTimeout extends Error {}

export function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      console.log({ event: "relay_timeout", what: label, ms });
      reject(new RelayTimeout(`${label} timed out after ${ms} ms`));
    }, ms);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

const unwrapped = new WeakMap<object, D1PreparedStatement>();

function statement(inner: D1PreparedStatement, sql: string, ms: number): D1PreparedStatement {
  // Only reads are retried: a write that timed out may still have happened.
  const read = /^\s*select\b/i.test(sql);
  const label = `query ${sql.trim().slice(0, 60)}`;
  const call = <T>(run: () => Promise<T>): Promise<T> =>
    withTimeout(run(), ms, label).catch((error: unknown) => {
      if (!read || !(error instanceof RelayTimeout)) throw error;
      return withTimeout(run(), ms, `${label} (retry)`);
    });
  const wrapped = {
    bind: (...values: unknown[]) => statement(inner.bind(...values), sql, ms),
    first: (column?: string) => call(() => (column === undefined ? inner.first() : inner.first(column))),
    all: () => call(() => inner.all()),
    run: () => call(() => inner.run()),
    raw: (options?: { columnNames?: false }) => call(() => inner.raw(options)),
  } as unknown as D1PreparedStatement;
  unwrapped.set(wrapped, inner);
  return wrapped;
}

/** The relay database with a deadline on every query, and one retry for reads. */
export function timedDb(db: D1Database, ms = DB_TIMEOUT_MS): D1Database {
  return {
    prepare: (sql: string) => statement(db.prepare(sql), sql, ms),
    batch: (statements: D1PreparedStatement[]) =>
      withTimeout(db.batch(statements.map((s) => unwrapped.get(s) ?? s)), ms, "batch"),
    exec: (sql: string) => withTimeout(db.exec(sql), ms, "exec"),
  } as unknown as D1Database;
}
