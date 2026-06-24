import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { loadConfig } from './config.js';

const config = loadConfig();
const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const migrationDirectory = new URL('../../../database/migrations/', import.meta.url);

try {
  await pool.query(`CREATE TABLE IF NOT EXISTS bf_schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  const files = (await readdir(migrationDirectory)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const applied = await pool.query(`SELECT 1 FROM bf_schema_migrations WHERE name = $1`, [file]);
    if (applied.rowCount) continue;
    const sql = await readFile(join(migrationDirectory.pathname, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(`INSERT INTO bf_schema_migrations (name) VALUES ($1)`, [file]);
      await client.query('COMMIT');
      console.log(`Applied ${file}`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
} finally {
  await pool.end();
}
