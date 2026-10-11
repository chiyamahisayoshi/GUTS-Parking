const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const LOT_NAMES = [
  ...Array.from({ length: 9 }, (_, index) => `駐車場 ${index + 1}`),
  "本店貸出中",
  "駅前店貸出中",
  "予備",
  "立駐",
];
const VEHICLE_TYPES = ["A-1", "A-2", "A-2P", "B", "B軽トラ", "C-1", "C-2", "D", "H-1", "H-2", "その他"];
const VEHICLE_OPTIONS = ["ETC", "車載器", "禁煙", "喫煙", "ナビ", "スタッドレス"];

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
      name TEXT NOT NULL UNIQUE,
      display_order INTEGER NOT NULL DEFAULT 0,
      area_height INTEGER NOT NULL DEFAULT 210,
      area_width INTEGER NOT NULL DEFAULT 1
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
      needs_repair INTEGER NOT NULL DEFAULT 0 CHECK(needs_repair IN (0, 1)),
      options TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE IF NOT EXISTS sessions (
      sid TEXT PRIMARY KEY,
      sess TEXT NOT NULL,
      expires INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS vehicles_lot_idx ON vehicles(parking_lot_id);
    CREATE INDEX IF NOT EXISTS vehicles_plate_idx ON vehicles(plate);
    CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions(expires);
  `);
  const columns = new Set(db.prepare("PRAGMA table_info(vehicles)").all().map((column) => column.name));
  const lotColumns = new Set(db.prepare("PRAGMA table_info(parking_lots)").all().map((column) => column.name));
  if (!lotColumns.has("display_order")) {
    db.exec("ALTER TABLE parking_lots ADD COLUMN display_order INTEGER NOT NULL DEFAULT 0");
    db.exec("UPDATE parking_lots SET display_order = id - 1");
  }
  if (!lotColumns.has("area_height")) {
    db.exec("ALTER TABLE parking_lots ADD COLUMN area_height INTEGER NOT NULL DEFAULT 210");
  }
  if (!lotColumns.has("area_width")) {
    db.exec("ALTER TABLE parking_lots ADD COLUMN area_width INTEGER NOT NULL DEFAULT 1");
  }
  if (!columns.has("options")) {
    db.exec("ALTER TABLE vehicles ADD COLUMN options TEXT NOT NULL DEFAULT '[]'");
  }
  db.exec(`
    UPDATE vehicles
    SET vehicle_type = CASE vehicle_type
      WHEN 'standard' THEN 'A-1'
      WHEN 'hybrid' THEN 'A-2'
      WHEN 'ev' THEN 'A-2P'
      WHEN 'van' THEN 'B'
      ELSE 'その他'
    END
    WHERE vehicle_type NOT IN ('A-1', 'A-2', 'A-2P', 'B', 'B軽トラ', 'C-1', 'C-2', 'D', 'H-1', 'H-2', 'その他')
  `);
  const addLot = db.prepare("INSERT OR IGNORE INTO parking_lots (name, display_order) VALUES (?, ?)");
  db.exec("BEGIN IMMEDIATE");
  try {
    LOT_NAMES.forEach((name, index) => addLot.run(name, index));
    const migration = "flatten-board-sections-into-locations";
    if (columns.has("board_section") &&
        !db.prepare("SELECT 1 FROM schema_migrations WHERE name = ?").get(migration)) {
      const moveToLocation = db.prepare(`
        UPDATE vehicles
        SET parking_lot_id = (
          SELECT id FROM parking_lots WHERE name = ?
        )
        WHERE board_section = ?
      `);
      for (const name of ["本店貸出中", "駅前店貸出中", "予備"]) {
        moveToLocation.run(name, name);
      }
      db.prepare("INSERT INTO schema_migrations (name) VALUES (?)").run(migration);
    }
    const reserveLotId = db.prepare("SELECT id FROM parking_lots WHERE name = '予備'").get().id;
    db.prepare("UPDATE vehicles SET parking_lot_id = ? WHERE parking_lot_id IS NULL").run(reserveLotId);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    db.close();
    throw error;
  }
  return db;
}

module.exports = { LOT_NAMES, VEHICLE_OPTIONS, VEHICLE_TYPES, openDatabase };
