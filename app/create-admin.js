const readline = require("node:readline/promises");
const { stdin, stdout } = require("node:process");
const path = require("node:path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });
const { openDatabase } = require("./db");
const { hashPassword } = require("./security");

async function readHidden(question) {
  stdout.write(question);
  stdin.setRawMode?.(true);
  stdin.resume();
  let result = "";
  return new Promise((resolve, reject) => {
    const onData = (chunk) => {
      const key = chunk.toString("utf8");
      if (key === "\u0003") {
        cleanup();
        reject(new Error("Cancelled."));
      } else if (key === "\r" || key === "\n") {
        cleanup();
        stdout.write("\n");
        resolve(result);
      } else if (key === "\u007f" || key === "\b") {
        result = result.slice(0, -1);
      } else if (key >= " ") {
        result += key;
      }
    };
    function cleanup() {
      stdin.removeListener("data", onData);
      stdin.setRawMode?.(false);
      stdin.pause();
    }
    stdin.on("data", onData);
  });
}

async function main() {
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error("Run this command from an interactive terminal so the password can be hidden.");
  }
  const rl = readline.createInterface({ input: stdin, output: stdout });
  let username;
  try {
    username = (await rl.question("Admin username: ")).trim();
  } finally {
    rl.close();
  }
  if (!username || username.length > 80) throw new Error("Username must contain 1 to 80 characters.");

  const password = await readHidden("Admin password (12+ characters): ");
  const confirmation = await readHidden("Confirm password: ");
  if (password !== confirmation) throw new Error("Passwords do not match.");

  const databasePath = process.env.DATABASE_PATH || "data/rentalcar.db";
  const db = openDatabase(databasePath);
  try {
    const insertUser = db.prepare("INSERT INTO users (username, password_hash) VALUES (?, ?)");
    insertUser.run(username, await hashPassword(password));
  } catch (error) {
    if (error.code === "SQLITE_CONSTRAINT_UNIQUE") throw new Error("That username already exists.");
    throw error;
  } finally {
    db.close();
  }
  console.log(`Created user ${username}.`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { main };
