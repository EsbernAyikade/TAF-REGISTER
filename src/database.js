const fs = require("node:fs");
const path = require("node:path");
const bcrypt = require("bcryptjs");
const Database = require("better-sqlite3");
const {
  COURSE_OPTIONS,
  LOVE_FELLOWSHIPS,
  SUB_MINISTRIES,
  buildRoleSeed,
} = require("./constants");

const isProduction = process.env.NODE_ENV === "production";
const configuredDatabasePath = process.env.DATABASE_PATH;
const dataDirectory = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, "..", "data");
const defaultDatabasePath = path.join(dataDirectory, "teens-aloud.db");
const SHARED_ACCESS_PASSWORD_KEY = "shared_access_password_hash";
const INTERNAL_ACTOR_EMAIL = "shared-access@teensaloud.local";

if (isProduction && !process.env.SESSION_SECRET) {
  throw new Error("SESSION_SECRET must be set in production.");
}

function resolveDatabasePath() {
  if (!configuredDatabasePath) {
    return defaultDatabasePath;
  }

  const candidate = path.resolve(configuredDatabasePath);
  try {
    const databaseDirectory = path.dirname(candidate);
    if (!fs.existsSync(databaseDirectory)) {
      fs.mkdirSync(databaseDirectory, { recursive: true });
    }
    return candidate;
  } catch (error) {
    console.warn(
      `Falling back to local database path because DATABASE_PATH was unusable: ${error.message}`
    );
    return defaultDatabasePath;
  }
}

const databasePath = resolveDatabasePath();

if (!fs.existsSync(path.dirname(databasePath))) {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
}

const db = new Database(databasePath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

function requireSharedAccessPassword() {
  const password = process.env.SHARED_ACCESS_PASSWORD || (isProduction ? null : "TafAccess_2026");

  if (isProduction && !password) {
    throw new Error("SHARED_ACCESS_PASSWORD must be set in production.");
  }

  return password;
}

function initializeDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS fellowships (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      slug TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sub_ministries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS courses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS roles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role_type TEXT NOT NULL,
      position_name TEXT NOT NULL,
      scope_type TEXT NOT NULL,
      display_name TEXT NOT NULL,
      fellowship_id INTEGER,
      FOREIGN KEY (fellowship_id) REFERENCES fellowships(id),
      UNIQUE (role_type, position_name, scope_type, fellowship_id)
    );

    CREATE TABLE IF NOT EXISTS members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      full_name TEXT NOT NULL,
      gender TEXT,
      birth_day INTEGER,
      birth_month INTEGER,
      hostel TEXT,
      room_no TEXT,
      course_id INTEGER,
      fellowship_id INTEGER NOT NULL,
      sub_ministry_id INTEGER,
      role_id INTEGER,
      phone TEXT,
      email TEXT,
      level TEXT,
      status TEXT NOT NULL DEFAULT 'Active',
      approval_status TEXT NOT NULL DEFAULT 'approved',
      duplicate_flag INTEGER NOT NULL DEFAULT 0,
      duplicate_notes TEXT,
      joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      approved_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (course_id) REFERENCES courses(id),
      FOREIGN KEY (fellowship_id) REFERENCES fellowships(id),
      FOREIGN KEY (sub_ministry_id) REFERENCES sub_ministries(id),
      FOREIGN KEY (role_id) REFERENCES roles(id)
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      full_name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      access_role TEXT NOT NULL,
      fellowship_id INTEGER,
      must_change_password INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (fellowship_id) REFERENCES fellowships(id)
    );

    CREATE TABLE IF NOT EXISTS attendance_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fellowship_id INTEGER NOT NULL,
      week_start TEXT NOT NULL,
      week_end TEXT NOT NULL,
      recorded_by_user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (fellowship_id) REFERENCES fellowships(id),
      FOREIGN KEY (recorded_by_user_id) REFERENCES users(id),
      UNIQUE (fellowship_id, week_start)
    );

    CREATE TABLE IF NOT EXISTS attendance_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      attendance_session_id INTEGER NOT NULL,
      member_id INTEGER NOT NULL,
      present INTEGER NOT NULL CHECK (present IN (0, 1)),
      marked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (attendance_session_id) REFERENCES attendance_sessions(id) ON DELETE CASCADE,
      FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE,
      UNIQUE (attendance_session_id, member_id)
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id INTEGER,
      details TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const userColumns = db.prepare("PRAGMA table_info(users)").all();
  if (!userColumns.some((column) => column.name === "must_change_password")) {
    db.exec("ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 1");
  }

  migrateMembersTableToRelaxedSchema();

  seedReferenceData();
  seedInternalActor();
  seedSharedAccessPassword();
}

// Earlier versions of this schema required gender, birth_day, birth_month,
// hostel, course_id, phone, and email on every member. Real bulk registers
// (paper attendance books digitized into spreadsheets) routinely omit course,
// and frequently omit phone/birthday/hostel too. Rather than force admins to
// invent placeholder data, this migration rebuilds the members table with
// those columns made optional, preserving every existing row and ID exactly.
// SQLite can't relax a NOT NULL constraint with a plain ALTER TABLE, so a
// full table rebuild (rename -> recreate -> copy -> drop) is the standard
// way to do this safely.
function migrateMembersTableToRelaxedSchema() {
  const tableExists = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'members'")
    .get();
  if (!tableExists) {
    return;
  }

  const columns = db.prepare("PRAGMA table_info(members)").all();
  const hasRoomNo = columns.some((column) => column.name === "room_no");
  const genderColumn = columns.find((column) => column.name === "gender");
  const needsRelaxedConstraints = genderColumn && genderColumn.notnull === 1;

  if (hasRoomNo && !needsRelaxedConstraints) {
    return;
  }

  const migrate = db.transaction(() => {
    if (needsRelaxedConstraints) {
      db.exec("ALTER TABLE members RENAME TO members_legacy");
      db.exec(`
        CREATE TABLE members (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          full_name TEXT NOT NULL,
          gender TEXT,
          birth_day INTEGER,
          birth_month INTEGER,
          hostel TEXT,
          room_no TEXT,
          course_id INTEGER,
          fellowship_id INTEGER NOT NULL,
          sub_ministry_id INTEGER,
          role_id INTEGER,
          phone TEXT,
          email TEXT,
          level TEXT,
          status TEXT NOT NULL DEFAULT 'Active',
          approval_status TEXT NOT NULL DEFAULT 'approved',
          duplicate_flag INTEGER NOT NULL DEFAULT 0,
          duplicate_notes TEXT,
          joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          approved_at TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (course_id) REFERENCES courses(id),
          FOREIGN KEY (fellowship_id) REFERENCES fellowships(id),
          FOREIGN KEY (sub_ministry_id) REFERENCES sub_ministries(id),
          FOREIGN KEY (role_id) REFERENCES roles(id)
        );
      `);
      db.exec(`
        INSERT INTO members (
          id, full_name, gender, birth_day, birth_month, hostel, course_id,
          fellowship_id, sub_ministry_id, role_id, phone, email, level,
          status, approval_status, duplicate_flag, duplicate_notes,
          joined_at, approved_at, created_at, updated_at
        )
        SELECT
          id, full_name, gender, birth_day, birth_month, hostel, course_id,
          fellowship_id, sub_ministry_id, role_id, phone, email, level,
          status, approval_status, duplicate_flag, duplicate_notes,
          joined_at, approved_at, created_at, updated_at
        FROM members_legacy;
      `);
      db.exec("DROP TABLE members_legacy");
    } else if (!hasRoomNo) {
      db.exec("ALTER TABLE members ADD COLUMN room_no TEXT");
    }
  });

  migrate();
}

function seedReferenceData() {
  const insertFellowship = db.prepare(
    "INSERT OR IGNORE INTO fellowships (name, slug) VALUES (?, ?)"
  );
  LOVE_FELLOWSHIPS.forEach((fellowship) => {
    insertFellowship.run(fellowship.name, fellowship.slug);
  });

  const insertSubMinistry = db.prepare(
    "INSERT OR IGNORE INTO sub_ministries (name) VALUES (?)"
  );
  SUB_MINISTRIES.forEach((name) => insertSubMinistry.run(name));

  const insertCourse = db.prepare("INSERT OR IGNORE INTO courses (name) VALUES (?)");
  COURSE_OPTIONS.forEach((course) => insertCourse.run(course));

  const fellowships = db
    .prepare("SELECT id, slug FROM fellowships ORDER BY id")
    .all();
  const fellowshipBySlug = new Map(fellowships.map((item) => [item.slug, item.id]));

  const insertRole = db.prepare(`
    INSERT OR IGNORE INTO roles (
      role_type,
      position_name,
      scope_type,
      display_name,
      fellowship_id
    ) VALUES (?, ?, ?, ?, ?)
  `);

  buildRoleSeed(LOVE_FELLOWSHIPS).forEach((role) => {
    const fellowshipId = role.fellowshipSlug
      ? fellowshipBySlug.get(role.fellowshipSlug)
      : null;
    insertRole.run(
      role.roleType,
      role.positionName,
      role.scopeType,
      role.displayName,
      fellowshipId
    );
  });

  deduplicateRoles();
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS roles_unique_scope_idx
    ON roles (role_type, position_name, scope_type, IFNULL(fellowship_id, -1))
  `);
}

// SQLite treats NULLs as distinct inside a UNIQUE constraint, so the existing
// table-level UNIQUE(...) on roles does not prevent duplicate global roles
// where fellowship_id is NULL. Clean up any historical duplicates and keep all
// member role assignments pointing at the surviving row before we add an
// expression-based unique index that collapses NULL fellowship scopes.
function deduplicateRoles() {
  const duplicateGroups = db.prepare(`
    SELECT
      role_type,
      position_name,
      scope_type,
      fellowship_id,
      MIN(id) AS keep_id
    FROM roles
    GROUP BY role_type, position_name, scope_type, fellowship_id
    HAVING COUNT(*) > 1
  `).all();

  if (duplicateGroups.length === 0) {
    return;
  }

  const updateMemberRoles = db.prepare(
    "UPDATE members SET role_id = ? WHERE role_id = ?"
  );
  const deleteRole = db.prepare("DELETE FROM roles WHERE id = ?");

  const dedupe = db.transaction(() => {
    duplicateGroups.forEach((group) => {
      const duplicateIds = db.prepare(`
        SELECT id
        FROM roles
        WHERE role_type = ?
          AND position_name = ?
          AND scope_type = ?
          AND (
            (fellowship_id IS NULL AND ? IS NULL)
            OR fellowship_id = ?
          )
          AND id != ?
        ORDER BY id
      `).all(
        group.role_type,
        group.position_name,
        group.scope_type,
        group.fellowship_id,
        group.fellowship_id,
        group.keep_id
      );

      duplicateIds.forEach(({ id }) => {
        updateMemberRoles.run(group.keep_id, id);
        deleteRole.run(id);
      });
    });
  });

  dedupe();
}

function seedInternalActor() {
  db.prepare(`
    INSERT OR IGNORE INTO users (full_name, email, password_hash, access_role, fellowship_id, must_change_password)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    "Shared Access",
    INTERNAL_ACTOR_EMAIL,
    bcrypt.hashSync(requireSharedAccessPassword(), 10),
    "system",
    null,
    0
  );
}

function seedSharedAccessPassword() {
  db.prepare(`
    INSERT OR IGNORE INTO app_settings (key, value)
    VALUES (?, ?)
  `).run(
    SHARED_ACCESS_PASSWORD_KEY,
    bcrypt.hashSync(requireSharedAccessPassword(), 10)
  );
}

module.exports = {
  db,
  initializeDatabase,
  INTERNAL_ACTOR_EMAIL,
  SHARED_ACCESS_PASSWORD_KEY,
};
