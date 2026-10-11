const http = require("node:http");
const path = require("node:path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });
const express = require("express");
const session = require("express-session");
const helmet = require("helmet");
const cookie = require("cookie");
const signature = require("cookie-signature");
const { rateLimit } = require("express-rate-limit");
const { WebSocket, WebSocketServer } = require("ws");

const { openDatabase } = require("./db");
const { SQLiteSessionStore } = require("./session-store");
const { hashPassword, verifyPassword } = require("./security");

const STATIC_DIR = path.resolve(__dirname, "..", "static");
const STATUSES = ["unwashed", "no_fuel", "needs_repair"];
const POSITION_GRID = Array.from({ length: 32 }, (_, index) => [
  [0.125, 0.375, 0.625, 0.875][index % 4],
  [0.0625, 0.1875, 0.3125, 0.4375, 0.5625, 0.6875, 0.8125, 0.9375][Math.floor(index / 4)],
]);
const DUMMY_PASSWORD_HASH = "scrypt$16384$8$1$00112233445566778899aabbccddeeff$".concat("00".repeat(64));

class RealtimeBoard {
  constructor(db, sessionSecret) {
    this.db = db;
    this.sessionSecret = sessionSecret;
    this.clients = new Set();
    this.webSocketServer = new WebSocketServer({ noServer: true });
  }

  attach(server) {
    server.on("upgrade", (request, socket, head) => {
      this.acceptUpgrade(request, socket, head).catch(() => socket.destroy());
    });
  }

  async acceptUpgrade(request, socket, head) {
    if (request.url?.split("?")[0] !== "/ws") {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    const origin = request.headers.origin;
    const forwardedProto = request.headers["x-forwarded-proto"]?.split(",")[0]?.trim();
    const expectedScheme = forwardedProto || (socket.encrypted ? "https" : "http");
    if (origin && origin !== `${expectedScheme}://${request.headers.host}`) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }

    let sessionId;
    try {
      const cookies = cookie.parse(request.headers.cookie || "");
      const signedId = cookies.rentalcar_session;
      if (signedId?.startsWith("s:")) {
        sessionId = signature.unsign(signedId.slice(2), this.sessionSecret);
      }
    } catch {
      sessionId = undefined;
    }
    if (!sessionId) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    this.db.prepare("DELETE FROM sessions WHERE expires <= ?").run(Date.now());
    const row = this.db.prepare("SELECT sess FROM sessions WHERE sid = ?").get(sessionId);
    if (!row || !JSON.parse(row.sess).username) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    this.webSocketServer.handleUpgrade(request, socket, head, (websocket) => {
      this.clients.add(websocket);
      websocket.on("close", () => this.clients.delete(websocket));
      websocket.on("error", () => this.clients.delete(websocket));
      websocket.on("message", () => {
        if (websocket.readyState === WebSocket.OPEN) websocket.send(JSON.stringify({ type: "pong" }));
      });
    });
  }

  notify() {
    const message = JSON.stringify({ type: "refresh" });
    for (const websocket of this.clients) {
      if (websocket.readyState === WebSocket.OPEN) websocket.send(message);
    }
  }
}

function vehicleFromRow(row) {
  const vehicle = { ...row };
  for (const status of STATUSES) vehicle[status] = Boolean(vehicle[status]);
  return vehicle;
}

function parseVehicleId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function getNextPosition(db, lotId) {
  if (lotId === null || lotId === undefined) return { positionX: 0.5, positionY: 0.5 };
  const counts = new Map();
  for (const row of db.prepare(
    "SELECT position_x, position_y FROM vehicles WHERE parking_lot_id = ?",
  ).all(lotId)) {
    const key = `${row.position_x.toFixed(2)},${row.position_y.toFixed(2)}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const [positionX, positionY] = POSITION_GRID.reduce((best, point) => {
    const key = `${point[0].toFixed(2)},${point[1].toFixed(2)}`;
    const bestKey = `${best[0].toFixed(2)},${best[1].toFixed(2)}`;
    return (counts.get(key) || 0) < (counts.get(bestKey) || 0) ? point : best;
  }, POSITION_GRID[0]);
  return { positionX, positionY };
}

function createApplication(options = {}) {
  const databasePath = options.databasePath || process.env.DATABASE_PATH || "data/rentalcar.db";
  const sessionSecret = options.sessionSecret || process.env.SESSION_SECRET;
  if (!sessionSecret || sessionSecret.length < 32) {
    throw new Error("Set SESSION_SECRET to a random value of at least 32 characters.");
  }
  const cookieSecure = options.cookieSecure ?? process.env.COOKIE_SECURE === "1";
  const erpApiKey = options.erpApiKey ?? process.env.ERP_API_KEY;
  const db = openDatabase(databasePath);
  const sessionStore = new SQLiteSessionStore(db);
  const realtime = new RealtimeBoard(db, sessionSecret);
  const app = express();

  app.set("trust proxy", 1);
  app.use(helmet({
    contentSecurityPolicy: {
      directives: { styleSrc: ["'self'", "'unsafe-inline'"] },
    },
  }));
  app.use(express.json({ limit: "64kb" }));
  app.use(session({
    name: "rentalcar_session",
    secret: sessionSecret,
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      secure: cookieSecure,
      sameSite: "strict",
      maxAge: 12 * 60 * 60 * 1000,
    },
  }));

  function requireUser(request, response, next) {
    if (!request.session.username) return response.status(401).json({ detail: "Please sign in." });
    next();
  }

  function requireSameOrigin(request, response, next) {
    const origin = request.get("origin");
    if (origin && origin !== `${request.protocol}://${request.get("host")}`) {
      return response.status(403).json({ detail: "Cross-origin request rejected." });
    }
    next();
  }

  function validateLot(lotId) {
    return lotId === null || lotId === undefined ||
      Boolean(db.prepare("SELECT 1 FROM parking_lots WHERE id = ?").get(lotId));
  }

  app.use("/static", express.static(STATIC_DIR));
  app.use(express.static(STATIC_DIR));
  app.get("/api/me", (request, response) => {
    if (!request.session.username) return response.json({ authenticated: false });
    response.json({ authenticated: true, username: request.session.username });
  });

  app.post(
    "/api/login",
    rateLimit({
      windowMs: 60_000,
      limit: 10,
      standardHeaders: "draft-8",
      legacyHeaders: false,
    }),
    requireSameOrigin,
    async (request, response, next) => {
      try {
        const { username, password } = request.body || {};
        if (
          typeof username !== "string" || !username.trim() || username.length > 80 ||
          typeof password !== "string" || !password || password.length > 1024
        ) {
          return response.status(422).json({ detail: "Valid username and password are required." });
        }
        const row = db.prepare("SELECT password_hash FROM users WHERE username = ?").get(username.trim());
        const matches = await verifyPassword(password, row?.password_hash || DUMMY_PASSWORD_HASH);
        if (!row || !matches) {
          return response.status(401).json({ detail: "Username or password is incorrect." });
        }
        request.session.regenerate((error) => {
          if (error) return next(error);
          request.session.username = username.trim();
          request.session.save((saveError) => {
            if (saveError) return next(saveError);
            response.json({ username: request.session.username });
          });
        });
      } catch (error) {
        next(error);
      }
    },
  );

  app.post("/api/logout", requireUser, requireSameOrigin, (request, response, next) => {
    request.session.destroy((error) => {
      if (error) return next(error);
      response.clearCookie("rentalcar_session", {
        httpOnly: true, secure: cookieSecure, sameSite: "strict",
      });
      response.json({ ok: true });
    });
  });

  app.get("/api/bootstrap", requireUser, (_request, response) => {
    const parkingLots = db.prepare("SELECT id, name FROM parking_lots ORDER BY id").all();
    const vehicles = db.prepare(`
      SELECT id, external_id, plate, vehicle_type, parking_lot_id,
             position_x, position_y, unwashed, no_fuel, needs_repair
      FROM vehicles ORDER BY plate, id
    `).all().map(vehicleFromRow);
    response.json({ parking_lots: parkingLots, vehicles });
  });

  app.post("/api/vehicles", requireUser, requireSameOrigin, (request, response, next) => {
    try {
      const { plate, vehicle_type: vehicleType, parking_lot_id: lotId } = request.body || {};
      if (
        typeof plate !== "string" || !plate.trim() || plate.trim().length > 40 ||
        typeof vehicleType !== "string" || !vehicleType.trim() || vehicleType.trim().length > 40
      ) {
        return response.status(422).json({ detail: "Valid plate and vehicle type are required." });
      }
      if (lotId !== undefined && lotId !== null && (!Number.isInteger(lotId) || !validateLot(lotId))) {
        return response.status(422).json({ detail: "Unknown parking lot." });
      }
      const hasX = Object.hasOwn(request.body, "position_x");
      const hasY = Object.hasOwn(request.body, "position_y");
      if (hasX !== hasY) {
        return response.status(422).json({ detail: "Supply both position coordinates or neither." });
      }
      let position;
      if (hasX) {
        const { position_x: x, position_y: y } = request.body;
        if (![x, y].every((value) => typeof value === "number" && value >= 0 && value <= 1)) {
          return response.status(422).json({ detail: "Vehicle coordinates must be between 0 and 1." });
        }
        position = { positionX: x, positionY: y };
      } else {
        position = getNextPosition(db, lotId);
      }
      const result = db.prepare(`
        INSERT INTO vehicles
          (plate, vehicle_type, parking_lot_id, position_x, position_y,
           unwashed, no_fuel, needs_repair)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        plate.trim(), vehicleType.trim(), lotId ?? null, position.positionX, position.positionY,
        Number(request.body.unwashed === true), Number(request.body.no_fuel === true),
        Number(request.body.needs_repair === true),
      );
      realtime.notify();
      response.status(201).json(vehicleFromRow(db.prepare("SELECT * FROM vehicles WHERE id = ?").get(result.lastInsertRowid)));
    } catch (error) {
      if (error.code === "SQLITE_CONSTRAINT_CHECK") {
        return response.status(422).json({ detail: "Invalid vehicle data." });
      }
      next(error);
    }
  });

  app.patch("/api/vehicles/:id", requireUser, requireSameOrigin, (request, response, next) => {
    try {
      const vehicleId = parseVehicleId(request.params.id);
      if (vehicleId === null) return response.status(404).json({ detail: "Vehicle not found." });
      const allowed = new Set([
        "plate", "vehicle_type", "parking_lot_id", "position_x", "position_y", ...STATUSES,
      ]);
      const entries = Object.entries(request.body || {});
      if (!entries.length) return response.status(422).json({ detail: "No vehicle fields supplied." });
      if (entries.some(([key]) => !allowed.has(key))) {
        return response.status(422).json({ detail: "Unknown vehicle field." });
      }
      const data = Object.fromEntries(entries);
      if (
        ["plate", "vehicle_type"].some((field) =>
          Object.hasOwn(data, field) &&
          (typeof data[field] !== "string" || !data[field].trim() || data[field].trim().length > 40))
      ) {
        return response.status(422).json({ detail: "Plate and vehicle type cannot be empty." });
      }
      if (["position_x", "position_y"].some((field) =>
        Object.hasOwn(data, field) &&
        (typeof data[field] !== "number" || data[field] < 0 || data[field] > 1))
      ) {
        return response.status(422).json({ detail: "Vehicle coordinates must be between 0 and 1." });
      }
      if (Object.hasOwn(data, "parking_lot_id") &&
          data.parking_lot_id !== null &&
          (!Number.isInteger(data.parking_lot_id) || !validateLot(data.parking_lot_id))) {
        return response.status(422).json({ detail: "Unknown parking lot." });
      }
      if (STATUSES.some((field) => Object.hasOwn(data, field) && typeof data[field] !== "boolean")) {
        return response.status(422).json({ detail: "Vehicle statuses must be boolean." });
      }
      for (const field of ["position_x", "position_y"]) {
        if (Object.hasOwn(data, field) && !Object.hasOwn(data, field === "position_x" ? "position_y" : "position_x")) {
          return response.status(422).json({ detail: "Supply both position coordinates or neither." });
        }
      }
      for (const field of ["plate", "vehicle_type"]) {
        if (Object.hasOwn(data, field)) data[field] = data[field].trim();
      }
      for (const field of STATUSES) {
        if (Object.hasOwn(data, field)) data[field] = Number(data[field]);
      }
      const assignments = Object.keys(data).map((field) => `${field} = ?`).join(", ");
      const result = db.prepare(`UPDATE vehicles SET ${assignments} WHERE id = ?`)
        .run(...Object.values(data), vehicleId);
      if (!result.changes) return response.status(404).json({ detail: "Vehicle not found." });
      realtime.notify();
      response.json(vehicleFromRow(db.prepare("SELECT * FROM vehicles WHERE id = ?").get(vehicleId)));
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/vehicles/:id", requireUser, requireSameOrigin, (request, response) => {
    const vehicleId = parseVehicleId(request.params.id);
    if (vehicleId === null) return response.status(404).json({ detail: "Vehicle not found." });
    const result = db.prepare("DELETE FROM vehicles WHERE id = ?").run(vehicleId);
    if (!result.changes) return response.status(404).json({ detail: "Vehicle not found." });
    realtime.notify();
    response.status(204).end();
  });

  app.post("/api/integration/vehicles:sync", requireSameOrigin, (request, response, next) => {
    if (!erpApiKey) return response.status(503).json({ detail: "ERP integration is not enabled." });
    const providedKey = request.get("x-erp-api-key") || "";
    const expected = Buffer.from(erpApiKey);
    const provided = Buffer.from(providedKey);
    if (expected.length !== provided.length || !require("node:crypto").timingSafeEqual(expected, provided)) {
      return response.status(401).json({ detail: "Invalid ERP API key." });
    }
    const payload = request.body;
    if (!Array.isArray(payload)) return response.status(422).json({ detail: "Expected a vehicle array." });
    if (payload.length > 500) return response.status(413).json({ detail: "A sync batch may contain at most 500 vehicles." });
    try {
      for (const vehicle of payload) {
        if (
          !vehicle || typeof vehicle.external_id !== "string" || !vehicle.external_id.trim() ||
          vehicle.external_id.length > 120 || typeof vehicle.plate !== "string" ||
          !vehicle.plate.trim() || vehicle.plate.trim().length > 40 ||
          typeof vehicle.vehicle_type !== "string" || !vehicle.vehicle_type.trim() ||
          vehicle.vehicle_type.trim().length > 40
        ) return response.status(422).json({ detail: "Each vehicle requires external_id, plate, and vehicle_type." });
        if (vehicle.parking_lot_id != null &&
            (!Number.isInteger(vehicle.parking_lot_id) || !validateLot(vehicle.parking_lot_id))) {
          return response.status(422).json({ detail: "Unknown parking lot." });
        }
      }
      const existing = db.prepare("SELECT id FROM vehicles WHERE external_id = ?");
      const update = db.prepare(`
        UPDATE vehicles SET plate = ?, vehicle_type = ?, parking_lot_id = ? WHERE external_id = ?
      `);
      const insert = db.prepare(`
        INSERT INTO vehicles
          (external_id, plate, vehicle_type, parking_lot_id, position_x, position_y)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const vehicle of payload) {
          const externalId = vehicle.external_id.trim();
          if (existing.get(externalId)) {
            update.run(vehicle.plate.trim(), vehicle.vehicle_type.trim(), vehicle.parking_lot_id ?? null, externalId);
          } else {
            const position = getNextPosition(db, vehicle.parking_lot_id);
            insert.run(
              externalId, vehicle.plate.trim(), vehicle.vehicle_type.trim(),
              vehicle.parking_lot_id ?? null, position.positionX, position.positionY,
            );
          }
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      if (payload.length) realtime.notify();
      response.json({ synced: payload.length });
    } catch (error) {
      next(error);
    }
  });

  app.use((error, _request, response, _next) => {
    if (error.type === "entity.parse.failed") return response.status(400).json({ detail: "Malformed JSON." });
    if (error.type === "entity.too.large") return response.status(413).json({ detail: "Request body is too large." });
    console.error(error);
    response.status(500).json({ detail: "Internal server error." });
  });

  function createServer() {
    const server = http.createServer(app);
    realtime.attach(server);
    return server;
  }

  return { app, db, sessionStore, createServer };
}

async function start() {
  const application = createApplication();
  const server = application.createServer();
  const port = Number(process.env.PORT || 8000);
  const host = process.env.HOST || "127.0.0.1";
  server.listen(port, host, () => console.log(`Rental car board listening on http://${host}:${port}`));
  const shutdown = () => {
    server.close(() => {
      application.db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (require.main === module) {
  try {
    start().catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}

module.exports = { createApplication, getNextPosition, vehicleFromRow };
