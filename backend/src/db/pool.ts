import pg from "pg";
export const { Pool } = pg;
export type Database = pg.Pool;
export type Connection = pg.Pool | pg.PoolClient;

export function createPool(connectionString: string, schema?: string) {
  if (schema && !/^test_[a-f0-9]+$/.test(schema))
    throw new Error("Invalid isolated test schema");
  const pool = new Pool({
    connectionString,
    max: 10,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 10000,
    statement_timeout: 10000,
    ...(schema ? { options: `-c search_path=${schema},public` } : {}),
  });
  pool.on("error", () => console.error("Database connection error"));
  return pool;
}

export async function transaction<T>(
  pool: Database,
  operation: (client: pg.PoolClient) => Promise<T>,
) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const value = await operation(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
