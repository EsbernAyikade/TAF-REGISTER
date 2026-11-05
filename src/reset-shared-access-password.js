const bcrypt = require("bcryptjs");
const SHARED_ACCESS_PASSWORD_KEY = "shared_access_password_hash";

async function resetSharedAccessPassword(db, password) {
  if (!password || !password.trim()) {
    throw new Error("SHARED_ACCESS_PASSWORD must be provided through the environment.");
  }

  const result = await db
    .prepare("UPDATE app_settings SET value = ?, updated_at = CURRENT_TIMESTAMP WHERE key = ?")
    .run(bcrypt.hashSync(password, 10), SHARED_ACCESS_PASSWORD_KEY);

  if (result.changes !== 1) {
    throw new Error("The shared-access password setting was not found; no password was changed.");
  }
}

async function main() {
  if (!process.argv.includes("--apply")) {
    throw new Error("No changes made. Pass --apply to update the shared-access password hash.");
  }
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required; this utility only updates PostgreSQL.");
  }
  if (!process.env.SHARED_ACCESS_PASSWORD || !process.env.SHARED_ACCESS_PASSWORD.trim()) {
    throw new Error("SHARED_ACCESS_PASSWORD must be provided through the environment.");
  }

  const { db, postgresMode } = require("./database");
  if (!postgresMode) {
    throw new Error("This utility only supports PostgreSQL.");
  }

  try {
    await resetSharedAccessPassword(db, process.env.SHARED_ACCESS_PASSWORD);
    console.log("Shared-access password hash updated.");
  } finally {
    await db.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { resetSharedAccessPassword };
