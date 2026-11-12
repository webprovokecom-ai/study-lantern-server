// Storage for users, subscriptions and school invoices.
// Online (DATABASE_URL set): Postgres. Locally without it: a JSON file in data/.
// The whole state is one small JSON document; that's plenty for one server instance.
// When Study Lantern grows, move to proper tables (users, subscriptions, invoices).
import fs from "node:fs";
import path from "node:path";
import pg from "pg";

const empty = () => ({ users: {}, customers: {}, schools: {}, alerts: [], processedEvents: [] });
const tidy = db => { db.processedEvents = db.processedEvents.slice(-2000); db.alerts = db.alerts.slice(-500); return db; };

let pool = null;
if (process.env.DATABASE_URL) {
  pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: /localhost|127\.0\.0\.1|\.internal/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false },
    max: 5,
  });
}

export async function init() {
  if (!pool) return "file";
  await pool.query("create table if not exists app_state (id text primary key, doc jsonb not null, updated_at timestamptz not null default now())");
  return "postgres";
}

const FILE = path.resolve("data/db.json");

export async function load() {
  if (pool) {
    const { rows } = await pool.query("select doc from app_state where id = 'main'");
    return { ...empty(), ...(rows[0]?.doc || {}) };
  }
  try { return { ...empty(), ...JSON.parse(fs.readFileSync(FILE, "utf8")) }; } catch { return empty(); }
}

export async function save(db) {
  tidy(db);
  if (pool) {
    await pool.query(
      "insert into app_state (id, doc, updated_at) values ('main', $1, now()) on conflict (id) do update set doc = excluded.doc, updated_at = now()",
      [JSON.stringify(db)],
    );
    return;
  }
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(db, null, 2));
}

// Run read-modify-write steps one at a time so two webhooks arriving together can't overwrite each other.
let queue = Promise.resolve();
export function withLock(fn) {
  const run = queue.then(fn);
  queue = run.catch(() => {});
  return run;
}
