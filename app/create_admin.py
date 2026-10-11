import getpass
import os

from app.db import connect, initialize
from app.security import hash_password


def main() -> None:
    database_path = os.environ.get("DATABASE_PATH", "data/rentalcar.db")
    username = input("Admin username: ").strip()
    if not username or len(username) > 80:
        raise SystemExit("Username must contain 1 to 80 characters.")
    password = getpass.getpass("Admin password (12+ characters): ")
    if password != getpass.getpass("Confirm password: "):
        raise SystemExit("Passwords do not match.")
    try:
        password_hash = hash_password(password)
    except ValueError as error:
        raise SystemExit(str(error)) from error
    initialize(database_path)
    with connect(database_path) as connection:
        try:
            connection.execute(
                "INSERT INTO users (username, password_hash) VALUES (?, ?)",
                (username, password_hash),
            )
        except Exception as error:
            if "UNIQUE constraint failed" in str(error):
                raise SystemExit("That username already exists.") from error
            raise
    print(f"Created user {username!r}.")


if __name__ == "__main__":
    main()
