require('dotenv').config();
const { Client } = require('pg');

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query('alter table nook_chapters add column if not exists ai_annotated boolean not null default false');
  await client.query("NOTIFY pgrst, 'reload schema'");
  await client.end();
  console.log('done');
}

main().catch(err => { console.error(err); process.exit(1); });
