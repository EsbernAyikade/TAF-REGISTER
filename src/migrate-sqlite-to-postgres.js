const path = require("node:path");
const Database = require("better-sqlite3");
const { db, postgresMode } = require("./database");

const REFERENCE_TABLES = ["fellowships", "sub_ministries", "courses", "roles"];
const TABLES = [
  "members",
  "member_sub_ministries",
  "member_fellowship_transfers",
  "attendance_sessions",
  "attendance_records",
  "notifications",
  "notification_deliveries",
  "terms",
];
const ID_TABLES = TABLES.filter((table) => table !== "member_sub_ministries");
const USER_REFERENCE_COLUMNS = {
  member_fellowship_transfers: ["transferred_by_user_id"],
  attendance_sessions: ["recorded_by_user_id"],
  notifications: ["recipient_user_id"],
};

function parseArgs(args) {
  const options = {};
  for (const arg of args) {
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (match) options[match[1]] = match[2];
    else if (arg.startsWith("--")) options[arg.slice(2)] = true;
  }
  return options;
}

function stableKey(table, row, fellowshipMap) {
  if (table === "fellowships") return row.slug;
  if (table === "sub_ministries" || table === "courses") return row.name;
  if (table === "roles") {
    const fellowshipId = row.fellowship_id == null
      ? null
      : fellowshipMap
        ? fellowshipMap.get(Number(row.fellowship_id))
        : Number(row.fellowship_id);
    if (row.fellowship_id != null && fellowshipId == null) return null;
    return JSON.stringify([
      row.role_type,
      row.position_name,
      row.scope_type,
      row.display_name,
      fellowshipId,
    ]);
  }
  throw new Error(`Unsupported reference table: ${table}`);
}

async function loadReferenceMaps(sqlite) {
  const maps = { fellowships: new Map(), sub_ministries: new Map(), courses: new Map(), roles: new Map() };
  const sourceFellowships = sqlite.prepare("SELECT * FROM fellowships").all();
  const targetFellowships = await db.prepare("SELECT * FROM fellowships").all();
  const targetBySlug = new Map(targetFellowships.map((row) => [row.slug, row.id]));
  for (const row of sourceFellowships) {
    const id = targetBySlug.get(row.slug);
    if (id == null) continue;
    maps.fellowships.set(Number(row.id), Number(id));
  }

  for (const table of ["sub_ministries", "courses"]) {
    const sourceRows = sqlite.prepare(`SELECT * FROM ${table}`).all();
    const targetRows = await db.prepare(`SELECT * FROM ${table}`).all();
    const targetByName = new Map(targetRows.map((row) => [row.name, row.id]));
    for (const row of sourceRows) {
      const id = targetByName.get(row.name);
      if (id != null) maps[table].set(Number(row.id), Number(id));
    }
  }

  const sourceRoles = sqlite.prepare("SELECT * FROM roles").all();
  const targetRoles = await db.prepare("SELECT * FROM roles").all();
  const targetByKey = new Map(
    targetRoles.map((row) => [stableKey("roles", row), Number(row.id)])
  );
  for (const row of sourceRoles) {
    const key = stableKey("roles", row, maps.fellowships);
    if (key == null) continue;
    const id = targetByKey.get(key);
    if (id != null) maps.roles.set(Number(row.id), Number(id));
  }
  return maps;
}

function mapReference(table, field, value, maps) {
  if (value == null) return value;
  const referenceTable = {
    fellowship_id: "fellowships",
    from_fellowship_id: "fellowships",
    to_fellowship_id: "fellowships",
    course_id: "courses",
    sub_ministry_id: "sub_ministries",
    role_id: "roles",
  }[field];
  if (referenceTable) {
    const mapped = maps.references[referenceTable].get(Number(value));
    if (mapped == null) {
      maps.conflicts.push({ table, reason: `unmatched_${referenceTable}_reference` });
      return value;
    }
    return mapped;
  }

  if ((USER_REFERENCE_COLUMNS[table] || []).includes(field)) {
    const mapped = maps.users.get(Number(value));
    if (mapped == null) {
      maps.conflicts.push({ table, reason: "unmatched_user_reference" });
      return value;
    }
    return mapped;
  }
  return value;
}

async function loadUserMap(sqlite, conflicts) {
  const sourceUsers = sqlite.prepare("SELECT id, email FROM users").all();
  const targetUsers = await db.prepare("SELECT id, email FROM users").all();
  const targetByEmail = new Map(targetUsers.map((row) => [String(row.email).toLowerCase(), Number(row.id)]));
  const userMap = new Map();
  for (const row of sourceUsers) {
    const id = targetByEmail.get(String(row.email).toLowerCase());
    if (id == null) {
      conflicts.push({ table: "users", reason: "source_user_not_present_in_target" });
      continue;
    }
    userMap.set(Number(row.id), id);
  }
  return userMap;
}

async function migrate({ sourceDbPath, sourceLabel, apply = false }) {
  if (!postgresMode) {
    throw new Error("DATABASE_URL is required for SQLite-to-PostgreSQL migration.");
  }
  if (!sourceDbPath || !["local", "production"].includes(sourceLabel)) {
    throw new Error("Choose one backup explicitly with --source-db=PATH and --source-label=local|production.");
  }

  const resolvedSource = path.resolve(sourceDbPath);
  const sqlite = new Database(resolvedSource, { readonly: true, fileMustExist: true });
  try {
    const sourceTables = new Set(
      sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(({ name }) => name)
    );
    const presentTables = TABLES.filter((table) => sourceTables.has(table));
    const sourceReferences = REFERENCE_TABLES.filter((table) => sourceTables.has(table));
    const rowsByTable = new Map(
      presentTables.map((table) => [table, sqlite.prepare(`SELECT * FROM ${table}`).all()])
    );

    for (const table of [...presentTables, ...sourceReferences]) {
      await db.prepare(`SELECT 1 FROM ${table} LIMIT 0`).all();
    }
    if (!sourceTables.has("users")) {
      throw new Error("The selected SQLite database has no users table; cannot safely map user references.");
    }

    const conflicts = [];
    const references = await loadReferenceMaps(sqlite);
    for (const table of sourceReferences) {
      const sourceRows = sqlite.prepare(`SELECT * FROM ${table}`).all();
      const map = references[table];
      if (map.size !== sourceRows.length) {
        conflicts.push({ table, reason: "reference_rows_not_matched_by_stable_key" });
      }
    }
    const users = await loadUserMap(sqlite, conflicts);
    const mappings = { references, users, conflicts };

    const counts = {};
    for (const table of presentTables) {
      const sourceRows = rowsByTable.get(table);
      const targetRows = await db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get();
      counts[table] = { source: sourceRows.length, target: Number(targetRows.count) };
      for (const sourceRow of sourceRows) {
        const row = { ...sourceRow };
        for (const column of Object.keys(row)) {
          row[column] = mapReference(table, column, row[column], mappings);
        }

        if (ID_TABLES.includes(table) && row.id != null) {
          const existing = await db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(row.id);
          if (existing) {
            const same = Object.keys(row).every(
              (column) => String(existing[column] ?? "") === String(row[column] ?? "")
            );
            if (!same) conflicts.push({ table, reason: "primary_key_conflict" });
          }
        }

        if (table === "members") {
          for (const column of ["email", "phone"]) {
            if (!row[column]) continue;
            const existing = await db.prepare(
              `SELECT id FROM members WHERE LOWER(${column}) = LOWER(?) AND id != ? LIMIT 1`
            ).get(row[column], row.id);
            if (existing) conflicts.push({ table, reason: `duplicate_${column}` });
          }
        }
      }
    }

    if (!apply) {
      return { applied: false, sourceLabel, counts, conflicts };
    }
    if (conflicts.length) {
      throw new Error(`Migration stopped; resolve ${conflicts.length} reported conflict(s) before applying.`);
    }

    await db.transaction(async () => {
      for (const table of TABLES) {
        const rows = rowsByTable.get(table) || [];
        for (const sourceRow of rows) {
          const row = { ...sourceRow };
          for (const column of Object.keys(row)) {
            row[column] = mapReference(table, column, row[column], mappings);
          }
          const columns = Object.keys(row);
          if (ID_TABLES.includes(table) && row.id != null) {
            const existing = await db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(row.id);
            if (existing) continue;
          }
          const placeholders = columns.map(() => "?").join(", ");
          await db.prepare(
            `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`
          ).run(...columns.map((column) => row[column]));
        }
      }

      for (const table of ID_TABLES) {
        if (!rowsByTable.has(table)) continue;
        await db.prepare(`
          SELECT setval(
            pg_get_serial_sequence(?, 'id'),
            GREATEST(COALESCE((SELECT MAX(id) FROM ${table}), 1), 1),
            EXISTS (SELECT 1 FROM ${table})
          )
        `).get(table);
      }
    })();

    return { applied: true, sourceLabel, counts, conflicts: [] };
  } finally {
    sqlite.close();
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await migrate({
    sourceDbPath: options["source-db"],
    sourceLabel: options["source-label"],
    apply: options.apply === true,
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.applied) {
    console.log("Dry run only. It does not import users, settings, or audit history.");
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { migrate, parseArgs, TABLES, stableKey };
