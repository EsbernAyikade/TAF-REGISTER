process.env.NODE_ENV = "test";
process.env.DATABASE_PATH = ":memory:";

const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");
const { db, initializeDatabase } = require("../src/database");
const { resetSharedAccessPassword } = require("../src/reset-shared-access-password");

test("async SQLite adapter commits and rolls back awaited transactions", async () => {
  await initializeDatabase();
  const fellowship = await db.prepare("SELECT id FROM fellowships ORDER BY id LIMIT 1").get();

  const failedTransaction = db.transaction(async () => {
    await db.prepare("INSERT INTO members (full_name, fellowship_id) VALUES (?, ?)").run(
      "Rolled Back Member",
      fellowship.id
    );
    throw new Error("force rollback");
  });
  await assert.rejects(failedTransaction(), /force rollback/);
  assert.equal(
    await db.prepare("SELECT COUNT(*) AS count FROM members").get().then(({ count }) => count),
    0
  );

  const successfulTransaction = db.transaction(async () => {
    const result = await db
      .prepare("INSERT INTO members (full_name, fellowship_id) VALUES (?, ?)")
      .run("Committed Member", fellowship.id);
    await db
      .prepare("INSERT INTO member_sub_ministries (member_id, sub_ministry_id) VALUES (?, ?)")
      .run(result.lastInsertRowid, 1);
    return result.lastInsertRowid;
  });
  const memberId = await successfulTransaction();
  assert.equal(
    await db.prepare("SELECT full_name FROM members WHERE id = ?").get(memberId).then((row) => row.full_name),
    "Committed Member"
  );
  assert.equal(
    await db
      .prepare("SELECT COUNT(*) AS count FROM member_sub_ministries WHERE member_id = ?")
      .get(memberId)
      .then(({ count }) => count),
    1
  );
});

test("shared-access password reset stores only a bcrypt hash", async () => {
  const password = "test-only-reset-password";
  await resetSharedAccessPassword(db, password);
  const setting = await db
    .prepare("SELECT value FROM app_settings WHERE key = ?")
    .get("shared_access_password_hash");

  assert.notEqual(setting.value, password);
  assert.equal(bcrypt.compareSync(password, setting.value), true);
});

test("production database selection fails closed without DATABASE_URL", () => {
  const result = spawnSync(
    process.execPath,
    ["-e", 'delete process.env.DATABASE_URL; process.env.NODE_ENV = "production"; require("./src/database");'],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, NODE_ENV: "production", DATABASE_URL: "" },
    }
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DATABASE_URL is required in production/);
});
