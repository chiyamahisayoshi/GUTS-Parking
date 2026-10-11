import os

import pytest
from fastapi.testclient import TestClient

os.environ.setdefault("SESSION_SECRET", "test-only-session-secret-value-123456")

from app.db import connect, initialize
from app.main import create_app
from app.security import hash_password


@pytest.fixture
def client(tmp_path):
    database = tmp_path / "rentalcar.db"
    initialize(database)
    with connect(database) as connection:
        connection.execute(
            "INSERT INTO users (username, password_hash) VALUES (?, ?)",
            ("operator", hash_password("correct-horse-battery")),
        )
    app = create_app(database_path=database, session_secret="x" * 48)
    with TestClient(app) as test_client:
        yield test_client


def sign_in(client: TestClient) -> None:
    response = client.post(
        "/api/login",
        json={"username": "operator", "password": "correct-horse-battery"},
    )
    assert response.status_code == 200


def test_board_is_protected_and_login_sets_session(client: TestClient) -> None:
    assert client.get("/").status_code == 200
    assert client.get("/static/app.js").status_code == 200
    assert client.get("/static/style.css").status_code == 200
    assert client.get("/api/bootstrap").status_code == 401
    assert client.get("/api/me").json() == {"authenticated": False}

    response = client.post(
        "/api/login",
        json={"username": "operator", "password": "incorrect-password"},
    )
    assert response.status_code == 401
    sign_in(client)
    assert client.get("/api/me").json() == {"authenticated": True, "username": "operator"}
    assert len(client.get("/api/bootstrap").json()["parking_lots"]) == 9


def test_vehicle_create_update_validation_and_delete(client: TestClient) -> None:
    sign_in(client)
    created = client.post(
        "/api/vehicles",
        json={
            "plate": "品川 500 あ 1234",
            "vehicle_type": "hybrid",
            "parking_lot_id": 1,
            "position_x": 0.25,
            "position_y": 0.75,
            "unwashed": True,
        },
    )
    assert created.status_code == 201
    vehicle = created.json()
    assert vehicle["position_x"] == 0.25
    assert vehicle["unwashed"] is True
    assert client.patch(f"/api/vehicles/{vehicle['id']}", json={"position_x": 1.1}).status_code == 422
    assert client.patch(f"/api/vehicles/{vehicle['id']}", json={"position_x": None}).status_code == 422
    assert client.patch(f"/api/vehicles/{vehicle['id']}", json={"parking_lot_id": 999}).status_code == 422
    assert client.patch(
        f"/api/vehicles/{vehicle['id']}",
        json={"plate": "品川 500 あ 1234"},
        headers={"Origin": "https://attacker.example"},
    ).status_code == 403

    updated = client.patch(
        f"/api/vehicles/{vehicle['id']}",
        json={"parking_lot_id": 2, "position_x": 0.6, "no_fuel": True},
    )
    assert updated.status_code == 200
    assert updated.json()["parking_lot_id"] == 2
    assert updated.json()["position_x"] == 0.6
    assert updated.json()["no_fuel"] is True
    assert client.delete(f"/api/vehicles/{vehicle['id']}").status_code == 204
    assert client.delete(f"/api/vehicles/{vehicle['id']}").status_code == 404


def test_realtime_websocket_notifies_on_changes(client: TestClient) -> None:
    sign_in(client)
    with client.websocket_connect("/ws") as websocket:
        response = client.post(
            "/api/vehicles",
            json={"plate": "横浜 300 あ 5678", "vehicle_type": "standard", "parking_lot_id": 1},
        )
        assert response.status_code == 201
        assert websocket.receive_json() == {"type": "refresh"}


def test_new_vehicles_receive_separate_default_positions(client: TestClient) -> None:
    sign_in(client)
    positions = []
    for plate in ("東京 300 あ 0001", "東京 300 あ 0002", "東京 300 あ 0003"):
        response = client.post(
            "/api/vehicles",
            json={"plate": plate, "vehicle_type": "standard", "parking_lot_id": 1},
        )
        assert response.status_code == 201
        positions.append((response.json()["position_x"], response.json()["position_y"]))
    assert len(set(positions)) == len(positions)


def test_passwords_are_salted_and_verified() -> None:
    first = hash_password("correct-horse-battery")
    second = hash_password("correct-horse-battery")
    assert first != second
    from app.security import verify_password

    assert verify_password("correct-horse-battery", first)
    assert not verify_password("wrong-password", first)
    with pytest.raises(ValueError):
        hash_password("short")


def test_erp_sync_is_optional_idempotent_and_preserves_board_fields(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    payload = [{
        "external_id": "fleet-vehicle-42",
        "plate": "品川 500 あ 1111",
        "vehicle_type": "hybrid",
        "parking_lot_id": 1,
    }]
    assert client.post("/api/integration/vehicles:sync", json=payload).status_code == 503
    monkeypatch.setenv("ERP_API_KEY", "erp-test-key")
    headers = {"X-ERP-API-Key": "erp-test-key"}
    assert client.post(
        "/api/integration/vehicles:sync", json=payload, headers=headers
    ).json() == {"synced": 1}
    sign_in(client)
    vehicle = client.get("/api/bootstrap").json()["vehicles"][0]
    assert (vehicle["position_x"], vehicle["position_y"]) == (0.1, 0.05)
    client.patch(
        f"/api/vehicles/{vehicle['id']}",
        json={"unwashed": True, "position_x": 0.8, "position_y": 0.2},
    )
    payload[0]["plate"] = "品川 500 あ 2222"
    assert client.post(
        "/api/integration/vehicles:sync", json=payload, headers=headers
    ).json() == {"synced": 1}
    updated = client.get("/api/bootstrap").json()["vehicles"][0]
    assert updated["plate"] == "品川 500 あ 2222"
    assert updated["unwashed"] is True
    assert updated["position_x"] == 0.8
