const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const LOT_NAMES = Array.from({ length: 9 }, (_, index) => `駐車場 ${index + 1}`);

function openDatabase(databasePath) {
  if (databasePath !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 10000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS parking_lots (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE
    );
    CREATE TABLE IF NOT EXISTS vehicles (
      id INTEGER PRIMARY KEY,
      external_id TEXT UNIQUE,
      plate TEXT NOT NULL,
      vehicle_type TEXT NOT NULL,
      parking_lot_id INTEGER REFERENCES parking_lots(id) ON DELETE SET NULL,
      position_x REAL NOT NULL DEFAULT 0.5 CHECK(position_x >= 0 AND position_x <= 1),
      position_y REAL NOT NULL DEFAULT 0.5 CHECK(position_y >= 0 AND position_y <= 1),
      unwashed INTEGER NOT NULL DEFAULT 0 CHECK(unwashed IN (0, 1)),
      no_fuel INTEGER NOT NULL DEFAULT 0 CHECK(no_fuel IN (0, 1)),
      needs_repair INTEGER NOT NULL DEFAULT 0 CHECK(needs_repair IN (0, 1))
    );
    CREATE TABLE IF NOT EXISTS sessions (
      sid TEXT PRIMARY KEY,
      sess TEXT NOT NULL,
      expires INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS vehicles_lot_idx ON vehicles(parking_lot_id);
    CREATE INDEX IF NOT EXISTS vehicles_plate_idx ON vehicles(plate);
    CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions(expires);
  `);
  const addLot = db.prepare("INSERT OR IGNORE INTO parking_lots (name) VALUES (?)");
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const name of LOT_NAMES) addLot.run(name);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    db.close();
    throw error;
  }
  return db;
}

module.exports = { LOT_NAMES, openDatabase };
