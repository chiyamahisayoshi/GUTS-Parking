import asyncio
import hmac
import os
import sqlite3
from collections import Counter
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from fastapi import Depends, FastAPI, Header, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field, field_validator
from starlette.middleware.sessions import SessionMiddleware

from app.db import connect, initialize
from app.security import verify_password

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"
STATUSES = ("unwashed", "no_fuel", "needs_repair")
POSITION_GRID = tuple(
    (x, y)
    for y in (0.05, 0.23, 0.41, 0.59, 0.77, 0.95)
    for x in (0.10, 0.30, 0.50, 0.70, 0.90)
)


class LoginInput(BaseModel):
    username: str = Field(min_length=1, max_length=80)
    password: str = Field(min_length=1, max_length=1024)


class VehicleCreate(BaseModel):
    plate: str = Field(min_length=1, max_length=40)
    vehicle_type: str = Field(min_length=1, max_length=40)
    parking_lot_id: int | None = None
    position_x: float | None = Field(default=None, ge=0, le=1)
    position_y: float | None = Field(default=None, ge=0, le=1)
    unwashed: bool = False
    no_fuel: bool = False
    needs_repair: bool = False

    @field_validator("plate", "vehicle_type")
    @classmethod
    def non_empty_text(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Value must not be blank.")
        return value


class VehicleUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    plate: str | None = Field(default=None, min_length=1, max_length=40)
    vehicle_type: str | None = Field(default=None, min_length=1, max_length=40)
    parking_lot_id: int | None = None
    position_x: float | None = Field(default=None, ge=0, le=1)
    position_y: float | None = Field(default=None, ge=0, le=1)
    unwashed: bool | None = None
    no_fuel: bool | None = None
    needs_repair: bool | None = None

    @field_validator("plate", "vehicle_type")
    @classmethod
    def non_empty_text(cls, value: str | None) -> str | None:
        if value is None:
            return value
        value = value.strip()
        if not value:
            raise ValueError("Value must not be blank.")
        return value


class IntegrationVehicle(BaseModel):
    external_id: str = Field(min_length=1, max_length=120)
    plate: str = Field(min_length=1, max_length=40)
    vehicle_type: str = Field(min_length=1, max_length=40)
    parking_lot_id: int | None = None

    @field_validator("external_id", "plate", "vehicle_type")
    @classmethod
    def non_empty_text(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Value must not be blank.")
        return value


class ConnectionManager:
    def __init__(self) -> None:
        self.connections: set[WebSocket] = set()
        self.lock = asyncio.Lock()

    async def add(self, websocket: WebSocket) -> None:
        async with self.lock:
            self.connections.add(websocket)

    async def remove(self, websocket: WebSocket) -> None:
        async with self.lock:
            self.connections.discard(websocket)

    async def notify(self) -> None:
        async with self.lock:
            connections = tuple(self.connections)
        stale = []
        for websocket in connections:
            try:
                await websocket.send_json({"type": "refresh"})
            except (RuntimeError, OSError):
                stale.append(websocket)
        for websocket in stale:
            await self.remove(websocket)


def _vehicle(row: sqlite3.Row) -> dict[str, Any]:
    result = dict(row)
    for status in STATUSES:
        result[status] = bool(result[status])
    return result


def _check_lot(database_path: str, lot_id: int | None) -> None:
    if lot_id is None:
        return
    with connect(database_path) as connection:
        if connection.execute("SELECT 1 FROM parking_lots WHERE id = ?", (lot_id,)).fetchone() is None:
            raise HTTPException(status_code=422, detail="Unknown parking lot.")


def _next_position(connection: sqlite3.Connection, lot_id: int | None) -> tuple[float, float]:
    if lot_id is None:
        return (0.5, 0.5)
    occupied = Counter(
        (round(row["position_x"], 2), round(row["position_y"], 2))
        for row in connection.execute(
            "SELECT position_x, position_y FROM vehicles WHERE parking_lot_id = ?", (lot_id,)
        )
    )
    return min(POSITION_GRID, key=lambda point: occupied[point])


def create_app(
    database_path: str | Path | None = None,
    session_secret: str | None = None,
    cookie_secure: bool | None = None,
) -> FastAPI:
    db_path = str(database_path or os.environ.get("DATABASE_PATH", "data/rentalcar.db"))
    secret = session_secret or os.environ.get("SESSION_SECRET")
    if not secret or len(secret) < 32:
        raise RuntimeError("Set SESSION_SECRET to a random value of at least 32 characters.")
    secure_cookie = cookie_secure if cookie_secure is not None else os.environ.get("COOKIE_SECURE", "0") == "1"
    manager = ConnectionManager()

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        initialize(db_path)
        yield

    app = FastAPI(title="Rental Car Live Board", lifespan=lifespan)
    app.add_middleware(
        SessionMiddleware,
        secret_key=secret,
        session_cookie="rentalcar_session",
        same_site="strict",
        https_only=secure_cookie,
        max_age=60 * 60 * 12,
    )
    app.state.database_path = db_path

    def require_user(request: Request) -> str:
        username = request.session.get("username")
        if not username:
            raise HTTPException(status_code=401, detail="Please sign in.")
        return username

    def require_same_origin(request: Request) -> None:
        origin = request.headers.get("origin")
        if origin:
            expected = f"{request.url.scheme}://{request.headers.get('host', '')}"
            if origin.rstrip("/") != expected.rstrip("/"):
                raise HTTPException(status_code=403, detail="Cross-origin request rejected.")

    @app.get("/")
    async def index() -> FileResponse:
        return FileResponse(STATIC_DIR / "index.html")

    @app.get("/api/me")
    async def me(request: Request) -> JSONResponse:
        username = request.session.get("username")
        if not username:
            return JSONResponse({"authenticated": False})
        return JSONResponse({"authenticated": True, "username": username})

    @app.post("/api/login")
    async def login(payload: LoginInput, request: Request) -> dict[str, str]:
        require_same_origin(request)
        with connect(db_path) as connection:
            row = connection.execute(
                "SELECT password_hash FROM users WHERE username = ?", (payload.username,)
            ).fetchone()
        if row is None or not verify_password(payload.password, row["password_hash"]):
            raise HTTPException(status_code=401, detail="Username or password is incorrect.")
        request.session.clear()
        request.session["username"] = payload.username
        return {"username": payload.username}

    @app.post("/api/logout")
    async def logout(request: Request, _: str = Depends(require_user)) -> dict[str, bool]:
        require_same_origin(request)
        request.session.clear()
        return {"ok": True}

    @app.get("/api/bootstrap")
    async def bootstrap(_: str = Depends(require_user)) -> dict[str, Any]:
        with connect(db_path) as connection:
            lots = [dict(row) for row in connection.execute("SELECT id, name FROM parking_lots ORDER BY id")]
            vehicles = [
                _vehicle(row)
                for row in connection.execute(
                    """
                    SELECT id, external_id, plate, vehicle_type, parking_lot_id,
                           position_x, position_y, unwashed, no_fuel, needs_repair
                    FROM vehicles ORDER BY plate, id
                    """
                )
            ]
        return {"parking_lots": lots, "vehicles": vehicles}

    @app.post("/api/vehicles", status_code=201)
    async def create_vehicle(
        payload: VehicleCreate, request: Request, _: str = Depends(require_user)
    ) -> dict[str, Any]:
        require_same_origin(request)
        _check_lot(db_path, payload.parking_lot_id)
        data = payload.model_dump()
        position_fields = {"position_x", "position_y"} & payload.model_fields_set
        if position_fields and position_fields != {"position_x", "position_y"}:
            raise HTTPException(status_code=422, detail="Supply both position coordinates or neither.")
        if position_fields and (data["position_x"] is None or data["position_y"] is None):
            raise HTTPException(status_code=422, detail="Vehicle positions cannot be null.")
        with connect(db_path) as connection:
            position_x, position_y = (
                (data["position_x"], data["position_y"])
                if position_fields
                else _next_position(connection, data["parking_lot_id"])
            )
            cursor = connection.execute(
                """
                INSERT INTO vehicles
                    (plate, vehicle_type, parking_lot_id, position_x, position_y,
                     unwashed, no_fuel, needs_repair)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    data["plate"].strip(), data["vehicle_type"].strip(), data["parking_lot_id"],
                    position_x, position_y, int(data["unwashed"]),
                    int(data["no_fuel"]), int(data["needs_repair"]),
                ),
            )
            row = connection.execute("SELECT * FROM vehicles WHERE id = ?", (cursor.lastrowid,)).fetchone()
        await manager.notify()
        return _vehicle(row)

    @app.patch("/api/vehicles/{vehicle_id}")
    async def update_vehicle(
        vehicle_id: int, payload: VehicleUpdate, request: Request, _: str = Depends(require_user)
    ) -> dict[str, Any]:
        require_same_origin(request)
        data = payload.model_dump(exclude_unset=True)
        if not data:
            raise HTTPException(status_code=422, detail="No vehicle fields supplied.")
        nullable_fields = {"plate", "vehicle_type", "position_x", "position_y", *STATUSES}
        if any(field in data and data[field] is None for field in nullable_fields):
            raise HTTPException(status_code=422, detail="Vehicle fields cannot be null.")
        if "parking_lot_id" in data:
            _check_lot(db_path, data["parking_lot_id"])
        for field in STATUSES:
            if field in data and data[field] is not None:
                data[field] = int(data[field])
        assignments = ", ".join(f"{field} = ?" for field in data)
        with connect(db_path) as connection:
            cursor = connection.execute(
                f"UPDATE vehicles SET {assignments} WHERE id = ?",
                [*data.values(), vehicle_id],
            )
            if cursor.rowcount == 0:
                raise HTTPException(status_code=404, detail="Vehicle not found.")
            row = connection.execute("SELECT * FROM vehicles WHERE id = ?", (vehicle_id,)).fetchone()
        await manager.notify()
        return _vehicle(row)

    @app.delete("/api/vehicles/{vehicle_id}", status_code=204)
    async def delete_vehicle(
        vehicle_id: int, request: Request, _: str = Depends(require_user)
    ) -> None:
        require_same_origin(request)
        with connect(db_path) as connection:
            cursor = connection.execute("DELETE FROM vehicles WHERE id = ?", (vehicle_id,))
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail="Vehicle not found.")
        await manager.notify()

    @app.post("/api/integration/vehicles:sync")
    async def integration_sync(
        payload: list[IntegrationVehicle],
        request: Request,
        x_erp_api_key: str | None = Header(default=None),
    ) -> dict[str, int]:
        configured_key = os.environ.get("ERP_API_KEY")
        if not configured_key:
            raise HTTPException(status_code=503, detail="ERP integration is not enabled.")
        if not x_erp_api_key or not hmac.compare_digest(x_erp_api_key, configured_key):
            raise HTTPException(status_code=401, detail="Invalid ERP API key.")
        require_same_origin(request)
        if len(payload) > 500:
            raise HTTPException(status_code=413, detail="A sync batch may contain at most 500 vehicles.")
        for vehicle in payload:
            _check_lot(db_path, vehicle.parking_lot_id)
        with connect(db_path) as connection:
            for vehicle in payload:
                existing = connection.execute(
                    "SELECT id FROM vehicles WHERE external_id = ?", (vehicle.external_id,)
                ).fetchone()
                if existing:
                    connection.execute(
                        """
                        UPDATE vehicles
                        SET plate = ?, vehicle_type = ?, parking_lot_id = ?
                        WHERE external_id = ?
                        """,
                        (
                            vehicle.plate,
                            vehicle.vehicle_type,
                            vehicle.parking_lot_id,
                            vehicle.external_id,
                        ),
                    )
                    continue
                position_x, position_y = _next_position(connection, vehicle.parking_lot_id)
                connection.execute(
                    """
                    INSERT INTO vehicles
                        (external_id, plate, vehicle_type, parking_lot_id, position_x, position_y)
                    VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (
                        vehicle.external_id,
                        vehicle.plate,
                        vehicle.vehicle_type,
                        vehicle.parking_lot_id,
                        position_x,
                        position_y,
                    ),
                )
        if payload:
            await manager.notify()
        return {"synced": len(payload)}

    @app.websocket("/ws")
    async def websocket_endpoint(websocket: WebSocket) -> None:
        if not websocket.scope.get("session", {}).get("username"):
            await websocket.close(code=4401)
            return
        origin = websocket.headers.get("origin")
        host = websocket.headers.get("host", "")
        if origin:
            expected_scheme = "https" if websocket.url.scheme in ("https", "wss") else "http"
            parsed_origin = urlsplit(origin)
            if parsed_origin.scheme != expected_scheme or parsed_origin.netloc != host:
                await websocket.close(code=4403)
                return
        await websocket.accept()
        await manager.add(websocket)
        try:
            while True:
                await websocket.receive_text()
        except WebSocketDisconnect:
            await manager.remove(websocket)

    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
    return app


app = create_app()
