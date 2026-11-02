import pg from 'pg';
import 'dotenv/config';

// Set DB_SSL=true for hosted databases (Neon, Supabase, RDS, ...) that require TLS.
export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/devboard',
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
});

export const query = (text, params) => pool.query(text, params);
