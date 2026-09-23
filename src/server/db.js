import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const DB_PATH = process.env.DB_PATH || resolve('data/event.db');

export function openDb(path = DB_PATH) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS guests (
      guest_id   TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      group_name TEXT,
      dietary    TEXT,
      contact    TEXT,
      id_card    TEXT,
      photo      TEXT,
      code       TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS meal_slots (
      slot_id    TEXT PRIMARY KEY,
      day        TEXT NOT NULL,
      meal       TEXT NOT NULL CHECK (meal IN ('breakfast','lunch','dinner')),
      label      TEXT,
      starts_at  TEXT,
      UNIQUE (day, meal)
    );

    CREATE TABLE IF NOT EXISTS stations (
      station_id TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      active     INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS staff (
      staff_id   TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      role       TEXT,
      contact    TEXT
    );

    CREATE TABLE IF NOT EXISTS checkins (
      event_id   TEXT PRIMARY KEY,
      guest_id   TEXT NOT NULL REFERENCES guests(guest_id),
      slot_id    TEXT NOT NULL REFERENCES meal_slots(slot_id),
      scanned_at TEXT NOT NULL,
      station_id TEXT,
      staff_id TEXT,
      received_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_checkins_first
      ON checkins (guest_id, slot_id);

    CREATE INDEX IF NOT EXISTS idx_checkins_slot ON checkins (slot_id);
    CREATE INDEX IF NOT EXISTS idx_checkins_station ON checkins (station_id, slot_id);

    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  const seeded = db.prepare(`SELECT value FROM meta WHERE key='schema_version'`).get();
  if (!seeded) {
    db.prepare(`INSERT INTO meta (key, value) VALUES ('schema_version', '1')`).run();
  }

  // Additive column migrations for databases created before these fields existed.
  ensureColumn(db, 'guests', 'id_card', 'TEXT');
  ensureColumn(db, 'guests', 'photo', 'TEXT');
  ensureColumn(db, 'staff', 'role', 'TEXT');
  ensureColumn(db, 'staff', 'contact', 'TEXT');
}

function ensureColumn(db, table, column, type) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

export const MEALS = ['breakfast', 'lunch', 'dinner'];

export const SLOT_ORDER_SQL =
  "CASE meal WHEN 'breakfast' THEN 1 WHEN 'lunch' THEN 2 WHEN 'dinner' THEN 3 ELSE 4 END";
