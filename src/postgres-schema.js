const POSTGRES_SCHEMA = `
CREATE TABLE IF NOT EXISTS fellowships (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  slug TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text
);
CREATE TABLE IF NOT EXISTS sub_ministries (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS courses (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  duration_years INTEGER
);
CREATE TABLE IF NOT EXISTS roles (
  id SERIAL PRIMARY KEY,
  role_type TEXT NOT NULL,
  position_name TEXT NOT NULL,
  scope_type TEXT NOT NULL,
  display_name TEXT NOT NULL,
  fellowship_id INTEGER REFERENCES fellowships(id),
  UNIQUE (role_type, position_name, scope_type, fellowship_id)
);
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  full_name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  access_role TEXT NOT NULL,
  fellowship_id INTEGER REFERENCES fellowships(id),
  must_change_password INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text
);
CREATE TABLE IF NOT EXISTS members (
  id SERIAL PRIMARY KEY,
  full_name TEXT NOT NULL,
  gender TEXT,
  birth_day INTEGER,
  birth_month INTEGER,
  hostel TEXT,
  room_no TEXT,
  course_id INTEGER REFERENCES courses(id),
  fellowship_id INTEGER REFERENCES fellowships(id),
  sub_ministry_id INTEGER REFERENCES sub_ministries(id),
  role_id INTEGER REFERENCES roles(id),
  phone TEXT,
  email TEXT,
  level TEXT,
  status TEXT NOT NULL DEFAULT 'Active',
  approval_status TEXT NOT NULL DEFAULT 'approved',
  duplicate_flag INTEGER NOT NULL DEFAULT 0,
  duplicate_notes TEXT,
  joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text,
  approved_at TEXT,
  archived_at TEXT,
  archived_reason TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text
);
CREATE TABLE IF NOT EXISTS member_sub_ministries (
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  sub_ministry_id INTEGER NOT NULL REFERENCES sub_ministries(id) ON DELETE CASCADE,
  PRIMARY KEY (member_id, sub_ministry_id)
);
CREATE TABLE IF NOT EXISTS member_fellowship_transfers (
  id SERIAL PRIMARY KEY,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  from_fellowship_id INTEGER REFERENCES fellowships(id),
  to_fellowship_id INTEGER REFERENCES fellowships(id),
  transferred_by_user_id INTEGER REFERENCES users(id),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text
);
CREATE TABLE IF NOT EXISTS attendance_sessions (
  id SERIAL PRIMARY KEY,
  fellowship_id INTEGER NOT NULL REFERENCES fellowships(id),
  week_start TEXT NOT NULL,
  week_end TEXT NOT NULL,
  recorded_by_user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text,
  UNIQUE (fellowship_id, week_start)
);
CREATE TABLE IF NOT EXISTS attendance_records (
  id SERIAL PRIMARY KEY,
  attendance_session_id INTEGER NOT NULL REFERENCES attendance_sessions(id) ON DELETE CASCADE,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  present INTEGER NOT NULL CHECK (present IN (0, 1)),
  marked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text,
  UNIQUE (attendance_session_id, member_id)
);
CREATE TABLE IF NOT EXISTS audit_logs (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id INTEGER,
  details TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text
);
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text
);
CREATE TABLE IF NOT EXISTS notifications (
  id SERIAL PRIMARY KEY,
  type TEXT NOT NULL DEFAULT 'info',
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  target_link TEXT,
  member_id INTEGER REFERENCES members(id) ON DELETE SET NULL,
  fellowship_id INTEGER REFERENCES fellowships(id) ON DELETE SET NULL,
  recipient_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text
);
CREATE TABLE IF NOT EXISTS notification_preferences (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  in_app INTEGER NOT NULL DEFAULT 1,
  email INTEGER NOT NULL DEFAULT 0,
  sms INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text
);
CREATE TABLE IF NOT EXISTS notification_deliveries (
  id SERIAL PRIMARY KEY,
  notification_id INTEGER NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  recipient TEXT,
  status TEXT NOT NULL,
  details TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text
);
CREATE TABLE IF NOT EXISTS terms (
  id SERIAL PRIMARY KEY,
  label TEXT NOT NULL UNIQUE,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text
);
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP::text
);
CREATE UNIQUE INDEX IF NOT EXISTS roles_unique_scope_idx
  ON roles (role_type, position_name, scope_type, COALESCE(fellowship_id, -1));
CREATE INDEX IF NOT EXISTS members_fellowship_idx ON members (fellowship_id);
CREATE INDEX IF NOT EXISTS members_archived_idx ON members (archived_at);
CREATE INDEX IF NOT EXISTS attendance_records_member_idx ON attendance_records (member_id);
CREATE INDEX IF NOT EXISTS notifications_recipient_idx ON notifications (recipient_user_id, is_read);
`;

module.exports = { POSTGRES_SCHEMA };
