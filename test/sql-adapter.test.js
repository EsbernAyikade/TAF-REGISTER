const test = require("node:test");
const assert = require("node:assert/strict");
const { translateSql } = require("../src/sql-adapter");

test("translates SQLite placeholders and ignore inserts for PostgreSQL", () => {
  assert.equal(
    translateSql("INSERT OR IGNORE INTO courses (name) VALUES (?)"),
    "INSERT INTO courses (name) VALUES ($1) ON CONFLICT DO NOTHING"
  );
});

test("translates SQLite aggregate expressions used by member queries", () => {
  assert.equal(
    translateSql("SELECT GROUP_CONCAT(sub_ministries.name, ', ')\nFROM members\nWHERE id = ?\nORDER BY sub_ministries.name"),
    "SELECT STRING_AGG(sub_ministries.name, ', ' ORDER BY sub_ministries.name)\nFROM members\nWHERE id = $1"
  );
  assert.equal(
    translateSql("UPDATE records SET present = MAX(present, excluded.present)"),
    "UPDATE records SET present = GREATEST(present, excluded.present)"
  );
});
