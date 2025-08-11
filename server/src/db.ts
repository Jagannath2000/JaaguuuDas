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

export async function ensureSchema(client: PgClient, table: string, dim: number) {
  await client.query('CREATE EXTENSION IF NOT EXISTS vector');
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${table} (
      id text PRIMARY KEY,
      url text NOT NULL,
      title text,
      content text,
      image text,
      embedding vector(${dim})
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS ${table}_embedding_idx ON ${table} USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
  `);
}