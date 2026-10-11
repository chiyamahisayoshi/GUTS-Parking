import sqlite3
from pathlib import Path

LOT_NAMES = tuple(f"駐車場 {number}" for number in range(1, 10))


def connect(database_path: str | Path) -> sqlite3.Connection:
    connection = sqlite3.connect(database_path, timeout=10)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA busy_timeout = 10000")
    return connection


def initialize(database_path: str | Path) -> None:
    path = Path(database_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with connect(path) as connection:
        connection.execute("PRAGMA journal_mode = WAL")
        connection.executescript(
            """
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
            CREATE INDEX IF NOT EXISTS vehicles_lot_idx ON vehicles(parking_lot_id);
            CREATE INDEX IF NOT EXISTS vehicles_plate_idx ON vehicles(plate);
            """
        )
        connection.executemany(
            "INSERT OR IGNORE INTO parking_lots (name) VALUES (?)",
            ((name,) for name in LOT_NAMES),
        )
