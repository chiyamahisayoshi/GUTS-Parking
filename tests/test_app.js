const assert = require("node:assert/strict");
const fs = require("node:fs");
const { once } = require("node:events");
const os = require("node:os");
const path = require("node:path");
const { after, before, test } = require("node:test");
const { DatabaseSync } = require("node:sqlite");
const { WebSocket } = require("ws");
const request = require("supertest");

process.env.SESSION_SECRET ||= "test-only-session-secret-value-123456";

const { createApplication } = require("../app/server");
const { hashPassword, verifyPassword } = require("../app/security");

let application;
let server;
let baseUrl;
let agent;
let vehicleId;
let sessionCookie;
const extraServers = [];

before(async () => {
  application = createApplication({
    databasePath: ":memory:",
    sessionSecret: "test-only-session-secret-value-123456",
  });
  application.db.prepare("INSERT INTO users (username, password_hash) VALUES (?, ?)").run(
    "operator",
    await hashPassword("correct-horse-battery"),
  );
  server = application.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  agent = request.agent(server);
});

after(async () => {
  if (server?.listening) {
    server.close();
    await once(server, "close");
  }
  for (const extraServer of extraServers) {
    if (!extraServer.listening) continue;
    extraServer.close();
    await once(extraServer, "close");
  }
  application?.db.close();
});

test("serves the browser UI but protects vehicle data until login", async () => {
  const page = await request(server).get("/");
  assert.equal(page.status, 200);
  assert.doesNotMatch(page.headers["content-security-policy"], /upgrade-insecure-requests/);
  assert.equal((await request(server).get("/static/app.js")).status, 200);
  assert.deepEqual((await request(server).get("/api/me")).body, { authenticated: false });
  assert.equal((await request(server).get("/api/bootstrap")).status, 401);
  assert.equal((await agent.get("/api/bootstrap")).status, 401);
});

test("keeps HTTPS asset upgrades enabled when secure cookies are configured", async () => {
  const secureApplication = createApplication({
    databasePath: ":memory:",
    sessionSecret: "test-only-session-secret-value-123456",
    cookieSecure: true,
  });
  try {
    const response = await request(secureApplication.app).get("/");
    assert.equal(response.status, 200);
    assert.match(response.headers["content-security-policy"], /upgrade-insecure-requests/);
  } finally {
    secureApplication.db.close();
  }
});

test("logs in with hashed credentials and seeds thirteen peer locations", async () => {
  assert.equal((await agent.post("/api/login").send({
    username: "operator",
    password: "incorrect-password",
  })).status, 401);
  const login = await agent.post("/api/login").send({
    username: "operator",
    password: "correct-horse-battery",
  });
  assert.equal(login.status, 200);
  sessionCookie = login.headers["set-cookie"][0].split(";")[0];
  assert.deepEqual((await agent.get("/api/me")).body, {
    authenticated: true,
    username: "operator",
  });
  const bootstrap = await agent.get("/api/bootstrap");
  assert.equal(bootstrap.status, 200);
  assert.equal(bootstrap.body.parking_lots.length, 13);
  assert.equal(Object.hasOwn(bootstrap.body, "board_sections"), false);
  assert.deepEqual(
    bootstrap.body.parking_lots.slice(9).map((lot) => lot.name),
    ["本店貸出中", "駅前店貸出中", "予備", "立駐"],
  );
  assert.deepEqual(bootstrap.body.vehicles, []);
});

test("creates vehicles in separate positions and validates updates", async () => {
  const first = await agent.post("/api/vehicles").send({
    plate: "品川 500 あ 1234",
    vehicle_type: "A-2",
    parking_lot_id: 1,
    unwashed: true,
    options: ["ETC", "ナビ"],
  });
  assert.equal(first.status, 201);
  assert.equal(first.body.unwashed, true);
  assert.deepEqual(first.body.options, ["ETC", "ナビ"]);
  assert.equal(Object.hasOwn(first.body, "board_section"), false);
  assert.deepEqual([first.body.position_x, first.body.position_y], [0.125, 0.0625]);
  vehicleId = first.body.id;

  const second = await agent.post("/api/vehicles").send({
    plate: "品川 500 あ 5678",
    vehicle_type: "A-1",
    parking_lot_id: 1,
  });
  assert.equal(second.status, 201);
  assert.notDeepEqual(
    [second.body.position_x, second.body.position_y],
    [first.body.position_x, first.body.position_y],
  );
  assert.equal((await agent.patch(`/api/vehicles/${vehicleId}`).send({ position_x: 1.1 })).status, 422);
  assert.equal((await agent.patch(`/api/vehicles/${vehicleId}`).send({ position_x: null })).status, 422);
  assert.equal((await agent.patch(`/api/vehicles/${vehicleId}`).send({ parking_lot_id: 999 })).status, 422);
  assert.equal((await agent.patch(`/api/vehicles/${vehicleId}`).send({ vehicle_type: "unknown" })).status, 422);
  assert.equal((await agent.patch(`/api/vehicles/${vehicleId}`).send({ board_section: "unknown" })).status, 422);
  assert.equal((await agent.patch(`/api/vehicles/${vehicleId}`).send({ options: ["unknown"] })).status, 422);
  assert.equal((await agent.patch(`/api/vehicles/${vehicleId}`).send({ unknown: true })).status, 422);
  assert.equal((await request(server).post("/api/vehicles").send({
    plate: "No auth",
    vehicle_type: "standard",
  })).status, 401);
});

test("rejects cross-origin changes and broadcasts edits only to authenticated websockets", async () => {
  const crossOrigin = await agent.patch(`/api/vehicles/${vehicleId}`)
    .set("Origin", "https://attacker.example")
    .send({ plate: "forbidden" });
  assert.equal(crossOrigin.status, 403);

  const unauthenticatedSocket = new WebSocket(`${baseUrl.replace("http", "ws")}/ws`);
  const [, rejectedResponse] = await Promise.race([
    once(unauthenticatedSocket, "unexpected-response"),
    once(unauthenticatedSocket, "open").then(() => {
      throw new Error("Unauthenticated websocket connection unexpectedly opened.");
    }),
  ]);
  assert.equal(rejectedResponse.statusCode, 401);
  unauthenticatedSocket.terminate();

  const websocket = new WebSocket(`${baseUrl.replace("http", "ws")}/ws`, {
    headers: { Cookie: sessionCookie, Origin: baseUrl },
  });
  await once(websocket, "open");
  try {
    const message = once(websocket, "message");
    const updated = await agent.patch(`/api/vehicles/${vehicleId}`).send({
      parking_lot_id: 2,
      position_x: 0.6,
      position_y: 0.2,
      no_fuel: true,
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.no_fuel, true);
    assert.equal(updated.body.parking_lot_id, 2);
    assert.deepEqual(JSON.parse((await message)[0].toString()), { type: "refresh" });
  } finally {
    websocket.close();
    await once(websocket, "close");
  }
});

test("syncs ERP records idempotently while preserving board-managed status and position", async () => {
  const payload = [{
    external_id: "fleet-vehicle-42",
    plate: "品川 500 あ 1111",
    vehicle_type: "A-2",
    parking_lot_id: 1,
  }];
  assert.equal((await agent.post("/api/integration/vehicles:sync").send(payload)).status, 503);

  const appWithErp = createApplication({
    databasePath: ":memory:",
    sessionSecret: "another-test-session-secret-value-123",
    erpApiKey: "erp-test-key",
  });
  try {
    const erpServer = appWithErp.createServer();
    erpServer.listen(0, "127.0.0.1");
    extraServers.push(erpServer);
    await once(erpServer, "listening");
    const erpAgent = request(erpServer);
    const headers = { "X-ERP-API-Key": "erp-test-key" };
    assert.equal((await erpAgent.post("/api/integration/vehicles:sync").send(payload)).status, 401);
    assert.deepEqual(
      (await erpAgent.post("/api/integration/vehicles:sync").set(headers).send(payload)).body,
      { synced: 1 },
    );
    const vehicle = appWithErp.db.prepare("SELECT * FROM vehicles WHERE external_id = ?").get("fleet-vehicle-42");
    appWithErp.db.prepare("UPDATE vehicles SET unwashed = 1, position_x = 0.8 WHERE id = ?").run(vehicle.id);
    payload[0].plate = "品川 500 あ 2222";
    assert.deepEqual(
      (await erpAgent.post("/api/integration/vehicles:sync").set(headers).send(payload)).body,
      { synced: 1 },
    );
    const updated = appWithErp.db.prepare("SELECT * FROM vehicles WHERE external_id = ?").get("fleet-vehicle-42");
    assert.equal(updated.plate, "品川 500 あ 2222");
    assert.equal(updated.unwashed, 1);
    assert.equal(updated.position_x, 0.8);

    const withoutLocation = {
      external_id: "fleet-vehicle-43",
      plate: "品川 500 あ 3333",
      vehicle_type: "B",
    };
    assert.deepEqual(
      (await erpAgent.post("/api/integration/vehicles:sync").set(headers).send([withoutLocation])).body,
      { synced: 1 },
    );
    const reserveLotId = appWithErp.db.prepare("SELECT id FROM parking_lots WHERE name = '予備'").get().id;
    const defaultVehicle = appWithErp.db.prepare("SELECT * FROM vehicles WHERE external_id = ?")
      .get(withoutLocation.external_id);
    assert.equal(defaultVehicle.parking_lot_id, reserveLotId);
    appWithErp.db.prepare("UPDATE vehicles SET parking_lot_id = 2 WHERE id = ?").run(defaultVehicle.id);
    withoutLocation.plate = "品川 500 あ 4444";
    await erpAgent.post("/api/integration/vehicles:sync").set(headers).send([withoutLocation]);
    assert.equal(
      appWithErp.db.prepare("SELECT parking_lot_id FROM vehicles WHERE id = ?").get(defaultVehicle.id).parking_lot_id,
      2,
    );
  } finally {
    appWithErp.db.close();
  }
});

test("password hashes are unique, verifiable, and reject short passwords", async () => {
  const first = await hashPassword("correct-horse-battery");
  const second = await hashPassword("correct-horse-battery");
  assert.notEqual(first, second);
  assert.equal(await verifyPassword("correct-horse-battery", first), true);
  assert.equal(await verifyPassword("wrong-password", first), false);
  await assert.rejects(hashPassword("short"), /at least 12/);
});

test("deletes a vehicle and reports missing ids", async () => {
  const deleted = await agent.delete(`/api/vehicles/${vehicleId}`);
  assert.equal(deleted.status, 204);
  assert.equal((await agent.delete(`/api/vehicles/${vehicleId}`)).status, 404);
  assert.equal((await agent.post("/api/vehicles").send({
    plate: "cross-origin",
    vehicle_type: "A-1",
  }).set("Origin", "https://attacker.example")).status, 403);
});

test("creates new vehicles in reserve and moves them between peer locations", async () => {
  const created = await agent.post("/api/vehicles").send({
    plate: "予備 100 あ 0001",
    vehicle_type: "A-1",
    options: ["禁煙", "スタッドレス"],
  });
  assert.equal(created.status, 201);
  const locations = (await agent.get("/api/bootstrap")).body.parking_lots;
  const reserve = locations.find((lot) => lot.name === "予備");
  assert.equal(created.body.parking_lot_id, reserve.id);
  assert.equal(Object.hasOwn(created.body, "board_section"), false);
  assert.deepEqual(created.body.options, ["禁煙", "スタッドレス"]);
  const moved = await agent.patch(`/api/vehicles/${created.body.id}`).send({
    parking_lot_id: locations.find((lot) => lot.name === "駅前店貸出中").id,
    position_x: 0.37,
    position_y: 0.62,
    options: ["ETC"],
  });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.parking_lot_id, locations.find((lot) => lot.name === "駅前店貸出中").id);
  assert.deepEqual([moved.body.position_x, moved.body.position_y], [0.37, 0.62]);
  assert.deepEqual(moved.body.options, ["ETC"]);
  for (const location of locations) {
    const placed = await agent.patch(`/api/vehicles/${created.body.id}`).send({
      parking_lot_id: location.id,
      position_x: 0.25,
      position_y: 0.75,
    });
    assert.equal(placed.status, 200, `vehicle should move to ${location.name}`);
    assert.equal(placed.body.parking_lot_id, location.id);
  }
  assert.deepEqual(
    (await agent.get("/api/bootstrap")).body.vehicle_types,
    ["A-1", "A-2", "A-2P", "B", "B軽トラ", "C-1", "C-2", "D", "H-1", "H-2", "その他"],
  );
});

test("persists parking lot size and order and rejects invalid layouts", async () => {
  const initialLots = (await agent.get("/api/bootstrap")).body.parking_lots;
  assert.equal(initialLots.length, 13);
  assert.deepEqual(
    [initialLots[0].display_order, initialLots[0].area_height, initialLots[0].area_width],
    [0, 210, 50],
  );
  const resized = await agent.patch("/api/parking-lots/4").send({
    area_height: 370,
    area_width: 73,
  });
  assert.equal(resized.status, 200);
  assert.deepEqual([resized.body.area_height, resized.body.area_width], [370, 73]);
  assert.equal((await agent.patch("/api/parking-lots/4").send({ area_height: 900 })).status, 422);
  assert.equal((await agent.patch("/api/parking-lots/4").send({ area_width: 101 })).status, 422);
  assert.equal((await agent.patch("/api/parking-lots/4").send({ area_width: 29 })).status, 422);
  assert.equal((await agent.put("/api/parking-lots/order").send({ ids: [1, 2] })).status, 422);
  const reordered = await agent.put("/api/parking-lots/order").send({
    ids: [4, ...initialLots.filter((lot) => lot.id !== 4).map((lot) => lot.id)],
  });
  assert.equal(reordered.status, 200);
  assert.deepEqual(
    (await agent.get("/api/bootstrap")).body.parking_lots.map((lot) => lot.id),
    [4, ...initialLots.filter((lot) => lot.id !== 4).map((lot) => lot.id)],
  );
});

test("adds locations and renames them without moving their vehicles", async () => {
  const navigationUrl = "https://maps.app.goo.gl/example";
  const created = await agent.post("/api/parking-lots").send({
    name: "洗車待ち",
    navigation_url: navigationUrl,
  });
  assert.equal(created.status, 201);
  assert.deepEqual(
    [created.body.name, created.body.display_order, created.body.area_height, created.body.area_width],
    ["洗車待ち", 13, 210, 50],
  );
  assert.equal(created.body.navigation_url, navigationUrl);
  assert.equal((await agent.post("/api/parking-lots").send({ name: "洗車待ち" })).status, 409);
  assert.equal((await agent.post("/api/parking-lots").send({ name: "   " })).status, 422);
  assert.equal((await agent.post("/api/parking-lots").send({ name: "x".repeat(41) })).status, 422);
  assert.equal((await agent.post("/api/parking-lots").send({
    name: "不正リンク",
    navigation_url: "https://attacker.example/maps",
  })).status, 422);
  assert.equal((await agent.post("/api/parking-lots").send({
    name: "HTTPリンク",
    navigation_url: "http://maps.google.com/maps",
  })).status, 422);
  assert.equal((await agent.post("/api/parking-lots").send({
    name: "偽装リンク",
    navigation_url: "https://attacker.example@maps.google.com/maps",
  })).status, 422);
  const vehicle = await agent.post("/api/vehicles").send({
    plate: "位置変更 100 あ 0001",
    vehicle_type: "A-1",
    parking_lot_id: created.body.id,
  });
  assert.equal(vehicle.status, 201);
  const renamed = await agent.patch(`/api/parking-lots/${created.body.id}`).send({
    name: "洗車エリア",
    navigation_url: "https://www.google.com/maps/dir/?api=1",
  });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.name, "洗車エリア");
  assert.equal(renamed.body.navigation_url, "https://www.google.com/maps/dir/?api=1");
  assert.equal((await agent.patch(`/api/parking-lots/${created.body.id}`).send({
    navigation_url: "https://www.google.com.evil.example/maps",
  })).status, 422);
  const cleared = await agent.patch(`/api/parking-lots/${created.body.id}`).send({ navigation_url: "" });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.navigation_url, "");
  await agent.patch(`/api/parking-lots/${created.body.id}`).send({
    navigation_url: "https://www.google.com/maps/search/?api=1",
  });
  assert.equal((await agent.patch(`/api/parking-lots/${created.body.id}`).send({ name: "駐車場 1" })).status, 409);
  const bootstrap = await agent.get("/api/bootstrap");
  assert.equal(bootstrap.body.parking_lots.find((lot) => lot.id === created.body.id).name, "洗車エリア");
  assert.equal(
    bootstrap.body.parking_lots.find((lot) => lot.id === created.body.id).navigation_url,
    "https://www.google.com/maps/search/?api=1",
  );
  assert.equal(
    bootstrap.body.vehicles.find((entry) => entry.id === vehicle.body.id).parking_lot_id,
    created.body.id,
  );
  assert.equal((await request(server).post("/api/parking-lots").send({ name: "認証なし" })).status, 401);
});

test("flattens previous board sections into peer locations without losing vehicle data", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rentalcar-migration-"));
  const databasePath = path.join(directory, "legacy.db");
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    CREATE TABLE parking_lots (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      display_order INTEGER NOT NULL DEFAULT 0,
      area_height INTEGER NOT NULL DEFAULT 210,
      area_width INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE vehicles (
      id INTEGER PRIMARY KEY,
      external_id TEXT UNIQUE,
      plate TEXT NOT NULL,
      vehicle_type TEXT NOT NULL,
      parking_lot_id INTEGER,
      position_x REAL NOT NULL DEFAULT 0.5,
      position_y REAL NOT NULL DEFAULT 0.5,
      unwashed INTEGER NOT NULL DEFAULT 0,
      no_fuel INTEGER NOT NULL DEFAULT 0,
      needs_repair INTEGER NOT NULL DEFAULT 0,
      board_section TEXT NOT NULL DEFAULT '予備',
      options TEXT NOT NULL DEFAULT '[]'
    )
  `);
  for (let index = 1; index <= 9; index += 1) {
    legacy.prepare("INSERT INTO parking_lots (name, display_order) VALUES (?, ?)").run(`駐車場 ${index}`, index - 1);
  }
  legacy.prepare("UPDATE parking_lots SET area_width = 2 WHERE id = 7").run();
  legacy.prepare(`
    INSERT INTO vehicles
      (plate, vehicle_type, parking_lot_id, position_x, position_y, unwashed, no_fuel,
       needs_repair, board_section, options)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("旧データ", "hybrid", 4, 0.37, 0.62, 1, 0, 1, "駅前店貸出中", '["ETC"]');
  legacy.close();
  try {
    const migrated = require("../app/db").openDatabase(databasePath);
    const vehicle = migrated.prepare("SELECT * FROM vehicles WHERE plate = ?").get("旧データ");
    assert.equal(vehicle.vehicle_type, "A-2");
    assert.equal(vehicle.board_section, "駅前店貸出中");
    assert.equal(
      vehicle.parking_lot_id,
      migrated.prepare("SELECT id FROM parking_lots WHERE name = '駅前店貸出中'").get().id,
    );
    assert.deepEqual([vehicle.position_x, vehicle.position_y, vehicle.unwashed, vehicle.needs_repair], [0.37, 0.62, 1, 1]);
    assert.deepEqual(JSON.parse(vehicle.options), ["ETC"]);
    assert.equal(migrated.prepare("SELECT COUNT(*) AS count FROM parking_lots").get().count, 13);
    const lot = migrated.prepare("SELECT * FROM parking_lots WHERE id = 4").get();
    assert.deepEqual([lot.display_order, lot.area_height, lot.area_width], [3, 210, 50]);
    assert.equal(lot.navigation_url, "");
    assert.equal(migrated.prepare("SELECT area_width FROM parking_lots WHERE id = 7").get().area_width, 100);
    migrated.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
