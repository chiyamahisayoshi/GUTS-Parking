const crypto = require("node:crypto");
const { promisify } = require("node:util");

const scrypt = promisify(crypto.scrypt);
const KEY_LENGTH = 64;

async function hashPassword(password) {
  if (typeof password !== "string" || password.length < 12) {
    throw new Error("Password must contain at least 12 characters.");
  }
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(password, salt, KEY_LENGTH, {
    N: 2 ** 14,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  return `scrypt$16384$8$1$${salt.toString("hex")}$${derived.toString("hex")}`;
}

async function verifyPassword(password, encoded) {
  if (typeof password !== "string" || typeof encoded !== "string") return false;
  try {
    const [algorithm, nText, rText, pText, saltHex, digestHex, ...extra] = encoded.split("$");
    if (
      algorithm !== "scrypt" ||
      extra.length ||
      !/^\d+$/.test(nText) ||
      !/^\d+$/.test(rText) ||
      !/^\d+$/.test(pText) ||
      !/^[\da-f]{32}$/i.test(saltHex) ||
      !/^[\da-f]{128}$/i.test(digestHex)
    ) {
      return false;
    }
    const expected = Buffer.from(digestHex, "hex");
    const actual = await scrypt(password, Buffer.from(saltHex, "hex"), expected.length, {
      N: Number(nText),
      r: Number(rText),
      p: Number(pText),
      maxmem: 64 * 1024 * 1024,
    });
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

module.exports = { hashPassword, verifyPassword };
