import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { loadConfig } from './config.js';

const config = loadConfig();
const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  options: `-c search_path=${config.DATABASE_SCHEMA},public`
});
const migrationDirectory = new URL('../../../database/migrations/', import.meta.url);

try {
  await pool.query(`CREATE SCHEMA IF NOT EXISTS ${config.DATABASE_SCHEMA}`);
  // TPS keeps its own ledger inside its schema. The parent platform owns
  // public.bf_schema_migrations and the two must not share it.
  await pool.query(`CREATE TABLE IF NOT EXISTS ${config.DATABASE_SCHEMA}.schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  const files = (await readdir(migrationDirectory)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const applied = await pool.query(`SELECT 1 FROM ${config.DATABASE_SCHEMA}.schema_migrations WHERE name = $1`, [file]);
    if (applied.rowCount) continue;
    // fileURLToPath, not URL.pathname — on Windows the latter yields "/C:/..." which readFile rejects.
    const sql = await readFile(fileURLToPath(new URL(file, migrationDirectory)), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(`INSERT INTO ${config.DATABASE_SCHEMA}.schema_migrations (name) VALUES ($1)`, [file]);
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
