import 'dotenv/config';
import { Client } from 'pg';
import pgvector from 'pgvector/pg';

export type PgClient = Client;

export async function getClient(): Promise<PgClient> {
  const client = new Client({
    host: process.env.PGHOST,
    port: Number(process.env.PGPORT || 5432),
    database: process.env.PGDATABASE,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
  });
  await client.connect();
  pgvector.registerType(client);
  return client;
}

export async function ensureGlobal(client: PgClient) {
  await client.query('CREATE EXTENSION IF NOT EXISTS vector');
  await client.query(`
    CREATE TABLE IF NOT EXISTS sites (
      domain text PRIMARY KEY,
      base_url text NOT NULL,
      refresh_minutes int NOT NULL DEFAULT 60,
      last_crawled_at timestamptz
    )
  `);
}

export async function ensureSchema(client: PgClient, table: string, dim: number) {
  await ensureGlobal(client);
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${table} (
      id text PRIMARY KEY,
      url text NOT NULL,
      title text,
      content text,
      images jsonb,
      content_hash text,
      last_seen_at timestamptz DEFAULT now(),
      deleted_at timestamptz,
      embedding vector(${dim})
    )
  `);
  // Add columns if missing
  await client.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = '${table}' AND column_name = 'images'
      ) THEN
        ALTER TABLE ${table} ADD COLUMN images jsonb;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = '${table}' AND column_name = 'content_hash'
      ) THEN
        ALTER TABLE ${table} ADD COLUMN content_hash text;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = '${table}' AND column_name = 'last_seen_at'
      ) THEN
        ALTER TABLE ${table} ADD COLUMN last_seen_at timestamptz DEFAULT now();
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = '${table}' AND column_name = 'deleted_at'
      ) THEN
        ALTER TABLE ${table} ADD COLUMN deleted_at timestamptz;
      END IF;
    END$$;
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS ${table}_url_idx ON ${table}(url);
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS ${table}_embedding_idx ON ${table} USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
  `);
}