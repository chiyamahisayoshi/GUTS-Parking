const assert = require("node:assert/strict");
const { once } = require("node:events");
const { after, before, test } = require("node:test");
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

test("logs in with hashed credentials and seeds the nine lots", async () => {
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
  assert.equal(bootstrap.body.parking_lots.length, 9);
  assert.deepEqual(bootstrap.body.vehicles, []);
});

test("creates vehicles in separate positions and validates updates", async () => {
  const first = await agent.post("/api/vehicles").send({
    plate: "品川 500 あ 1234",
    vehicle_type: "hybrid",
    parking_lot_id: 1,
    unwashed: true,
  });
  assert.equal(first.status, 201);
  assert.equal(first.body.unwashed, true);
  assert.deepEqual([first.body.position_x, first.body.position_y], [0.125, 0.0625]);
  vehicleId = first.body.id;

  const second = await agent.post("/api/vehicles").send({
    plate: "品川 500 あ 5678",
    vehicle_type: "standard",
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
    vehicle_type: "hybrid",
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
    vehicle_type: "standard",
  }).set("Origin", "https://attacker.example")).status, 403);
});
