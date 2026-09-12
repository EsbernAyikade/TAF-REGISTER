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

function getDefaultPassword() {
  const password =
    process.env.DEFAULT_USER_PASSWORD ||
    process.env.SUPER_ADMIN_PASSWORD ||
    (isProduction ? null : "Taf_2026!Secure");

  if (isProduction && !password) {
    throw new Error("DEFAULT_USER_PASSWORD must be set in production.");
  }

  return password;
}

function getSeedUsers() {
  const gazaFellowship = db
    .prepare("SELECT id FROM fellowships WHERE slug = ?")
    .get("gaza-love-fellowship");
  const defaultPassword = getDefaultPassword();

  return [
    {
      fullName: "System Super Admin",
      email: process.env.SUPER_ADMIN_EMAIL || "admin@teensaloud.local",
      passwordHash: bcrypt.hashSync(
        process.env.SUPER_ADMIN_PASSWORD || defaultPassword,
        10
      ),
      accessRole: "super_admin",
      fellowshipId: null,
      mustChangePassword: true,
    },
    {
      fullName: "Gaza Fellowship Admin",
      email: "gaza.admin@teensaloud.local",
      passwordHash: bcrypt.hashSync(
        process.env.FELLOWSHIP_ADMIN_PASSWORD || "GazaLF_2026!Secure",
        10
      ),
      accessRole: "fellowship_admin",
      fellowshipId: gazaFellowship ? gazaFellowship.id : null,
      mustChangePassword: true,
    },
    {
      fullName: "Records Viewer",
      email: "viewer@teensaloud.local",
      passwordHash: bcrypt.hashSync(
        process.env.VIEWER_PASSWORD || "Viewer_2026!Secure",
        10
      ),
      accessRole: "viewer",
      fellowshipId: null,
      mustChangePassword: true,
    },
  ];
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
      gender TEXT NOT NULL,
      birth_day INTEGER NOT NULL,
      birth_month INTEGER NOT NULL,
      hostel TEXT NOT NULL,
      course_id INTEGER NOT NULL,
      fellowship_id INTEGER NOT NULL,
      sub_ministry_id INTEGER,
      role_id INTEGER,
      phone TEXT NOT NULL,
      email TEXT NOT NULL,
      level TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'Active',
      approval_status TEXT NOT NULL DEFAULT 'pending',
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
  `);

  const userColumns = db.prepare("PRAGMA table_info(users)").all();
  if (!userColumns.some((column) => column.name === "must_change_password")) {
    db.exec("ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 1");
  }

  seedReferenceData();
  seedUsers();
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
}

function seedUsers() {
  const upsertUser = db.prepare(`
    INSERT INTO users (full_name, email, password_hash, access_role, fellowship_id, must_change_password)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(email)
    DO UPDATE SET
      full_name = excluded.full_name,
      password_hash = excluded.password_hash,
      access_role = excluded.access_role,
      fellowship_id = excluded.fellowship_id,
      must_change_password = excluded.must_change_password
  `);

  getSeedUsers().forEach((user) => {
    upsertUser.run(
      user.fullName,
      user.email,
      user.passwordHash,
      user.accessRole,
      user.fellowshipId,
      user.mustChangePassword ? 1 : 0
    );
  });
}

module.exports = {
  db,
  initializeDatabase,
};
