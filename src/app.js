const os = require("node:os");
const path = require("node:path");
const bcrypt = require("bcryptjs");
const ExcelJS = require("exceljs");
const express = require("express");
const session = require("express-session");
const csrf = require("csurf");
const multer = require("multer");
const rateLimit = require("express-rate-limit");
const {
  GENDER_OPTIONS,
  MEMBER_STATUSES,
  MONTHS,
  STUDY_LEVELS,
} = require("./constants");
const {
  areLikelyNameMatches,
  isValidBirthDate,
  normalizeName,
  normalizePhone,
} = require("./domain-utils");
const {
  db,
  initializeDatabase,
  INTERNAL_ACTOR_EMAIL,
  SHARED_ACCESS_PASSWORD_KEY,
} = require("./database");

initializeDatabase();

const app = express();
const isProduction = process.env.NODE_ENV === "production";
const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 3000);
const SESSION_SECRET = process.env.SESSION_SECRET || (isProduction ? null : "dev-only-local-session-secret");
const NEW_MEMBER_WINDOW_DAYS = Number(process.env.NEW_MEMBER_WINDOW_DAYS || 42);
const ARCHIVED_STATUS = "Archived";

if (isProduction && !SESSION_SECRET) {
  throw new Error("SESSION_SECRET is required in production.");
}

function archiveMember(memberId, reason) {
  db.prepare(
    `
      UPDATE members
      SET archived_at = CURRENT_TIMESTAMP,
          archived_reason = ?,
          status = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `
  ).run(reason || null, ARCHIVED_STATUS, memberId);
}

function restoreMember(memberId) {
  db.prepare(
    `
      UPDATE members
      SET archived_at = NULL,
          archived_reason = NULL,
          status = CASE WHEN status = ? THEN 'Active' ELSE status END,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `
  ).run(ARCHIVED_STATUS, memberId);
}

app.set("trust proxy", 1);

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "..", "views"));
app.use(express.urlencoded({ extended: true }));
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: isProduction,
      maxAge: 1000 * 60 * 60 * 12,
    },
  })
);

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: "Too many login attempts. Please wait 15 minutes before trying again.",
  skipSuccessfulRequests: true,
});
const csrfProtection = csrf({ cookie: false });
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
});

// CSRF is applied globally EXCEPT on multipart/form-data routes (currently
// just the CSV import). Those routes must run multer first to parse the
// body, then apply csrfProtection themselves afterwards — if the global
// check ran first, it would inspect req.body._csrf before multer has
// populated req.body at all, and reject every multipart request outright.
const MULTIPART_ROUTES = new Set(["/members/import"]);

app.use((req, res, next) => {
  if (req.method === "POST" && MULTIPART_ROUTES.has(req.path)) {
    return next();
  }
  return csrfProtection(req, res, next);
});
app.use((req, res, next) => {
  res.locals.csrfToken = req.csrfToken ? req.csrfToken() : "";
  next();
});
app.use(express.static(path.join(__dirname, "..", "public")));

app.locals.months = MONTHS;

function getSharedAccessPasswordHash() {
  const setting = db
    .prepare("SELECT value FROM app_settings WHERE key = ?")
    .get(SHARED_ACCESS_PASSWORD_KEY);

  if (!setting) {
    throw new Error("Shared access password has not been initialized.");
  }

  return setting.value;
}

function getInternalActorId() {
  const actor =
    db
      .prepare("SELECT id FROM users WHERE email = ?")
      .get(INTERNAL_ACTOR_EMAIL) ||
    db.prepare("SELECT id FROM users ORDER BY id LIMIT 1").get();

  if (!actor) {
    throw new Error("No internal actor is available for shared-access actions.");
  }

  function getDaysSince(value) {
    if (!value) {
      return Number.POSITIVE_INFINITY;
    }

    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      return Number.POSITIVE_INFINITY;
    }

    return Math.floor((Date.now() - parsed.getTime()) / (1000 * 60 * 60 * 24));
  }

  function isNewMember(joinedAt) {
    const days = getDaysSince(joinedAt);
    return Number.isFinite(days) && days >= 0 && days <= NEW_MEMBER_WINDOW_DAYS;
  }

  return actor.id;
}

app.use((req, res, next) => {
  const user = req.session.isAuthenticated
    ? { actorId: getInternalActorId() }
    : null;

  const fellowships = db
    .prepare("SELECT id, name, slug FROM fellowships ORDER BY name")
    .all();
  const courses = db.prepare("SELECT id, name FROM courses ORDER BY name").all();
  const subMinistries = db
    .prepare("SELECT id, name FROM sub_ministries ORDER BY name")
    .all();
  const hostelSuggestions = db
    .prepare(
      `
        SELECT DISTINCT hostel
        FROM members
        WHERE TRIM(hostel) != ''
        ORDER BY hostel
      `
    )
    .all()
    .map((row) => row.hostel);
  const roles = db
    .prepare(
      `
        SELECT roles.id, roles.role_type, roles.position_name, roles.scope_type, roles.display_name,
               roles.fellowship_id, fellowships.slug AS fellowship_slug
        FROM roles
        LEFT JOIN fellowships ON fellowships.id = roles.fellowship_id
        ORDER BY roles.scope_type, roles.role_type, roles.display_name
      `
    )
    .all();

  const globalRoles = roles.filter((role) => role.scope_type !== "fellowship");
  const roleCatalogByFellowship = fellowships.reduce((catalog, fellowship) => {
    const fellowshipRoles = roles.filter(
      (role) =>
        role.scope_type === "fellowship" && role.fellowship_id === fellowship.id
    );
    catalog[fellowship.id] = [...fellowshipRoles, ...globalRoles];
    return catalog;
  }, {});
  roleCatalogByFellowship[""] = globalRoles;

  res.locals.currentUser = user;
  res.locals.isProduction = isProduction;
  res.locals.currentPath = req.path;
  res.locals.fellowships = fellowships;
  res.locals.courses = courses;
  res.locals.subMinistries = subMinistries;
  res.locals.hostelSuggestions = hostelSuggestions;
  res.locals.allRoles = roles;
  res.locals.memberStatuses = MEMBER_STATUSES;
  res.locals.genderOptions = GENDER_OPTIONS;
  res.locals.studyLevels = STUDY_LEVELS;
  res.locals.roleCatalogByFellowship = roleCatalogByFellowship;
  res.locals.flash = req.session.flash || null;
  res.locals.formatBirthday = (day, month) =>
    day && month ? `${MONTHS[month - 1]} ${day}` : "Not provided";
  res.locals.formatDate = (value) =>
    value
      ? new Intl.DateTimeFormat("en-GB", {
          day: "2-digit",
          month: "short",
          year: "numeric",
        }).format(new Date(value))
      : "—";
  res.locals.isNewMember = isNewMember;
  res.locals.newMemberWindowDays = NEW_MEMBER_WINDOW_DAYS;
  res.locals.isManager = Boolean(user);
  req.currentUser = user;

  delete req.session.flash;
  next();
});

function setFlash(req, type, message) {
  req.session.flash = { type, message };
  if (req.res) {
    req.res.locals.flash = req.session.flash;
  }
}

function requireAuth(req, res, next) {
  if (!req.currentUser) {
    setFlash(req, "warning", "Please sign in to access the member database.");
    return res.redirect("/login");
  }
  return next();
}

function canManageFellowship(user, fellowshipId) {
  return Boolean(user);
}

function requireManagerForFellowship(req, res, next) {
  if (!req.currentUser) {
    return res.redirect("/login");
  }

  const fellowship = db
    .prepare("SELECT id FROM fellowships WHERE slug = ?")
    .get(req.params.slug);
  if (!fellowship) {
    return res.status(404).render("pages/not-found", {
      pageTitle: "Not Found",
      currentUser: req.currentUser || res.locals.currentUser || null,
      currentPath: req.path,
      csrfToken: res.locals.csrfToken || "",
    });
  }

  req.fellowship = fellowship;
  return next();
}

function getWeekStart(dateString) {
  const date = dateString ? new Date(dateString) : new Date();
  const normalized = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = normalized.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  normalized.setUTCDate(normalized.getUTCDate() + diff);
  return normalized.toISOString().slice(0, 10);
}

function getWeekEnd(weekStart) {
  const end = new Date(`${weekStart}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 6);
  return end.toISOString().slice(0, 10);
}

function getWeekLabel(weekStart, weekEnd) {
  const start = new Date(`${weekStart}T00:00:00Z`);
  const end = new Date(`${weekEnd}T00:00:00Z`);
  const formatter = new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
  });
  return `${formatter.format(start)} - ${formatter.format(end)}`;
}

function getBirthdaysForWindow(daySpan) {
  const members = db
    .prepare(
      `
        SELECT members.id, members.full_name, members.birth_day, members.birth_month,
               COALESCE(fellowships.name, 'No Fellowship') AS fellowship_name
        FROM members
        LEFT JOIN fellowships ON fellowships.id = members.fellowship_id
        WHERE members.birth_day IS NOT NULL
          AND members.birth_month IS NOT NULL
        ORDER BY members.birth_month, members.birth_day, members.full_name
      `
    )
    .all();

  const today = new Date();
  return members
    .map((member) => {
      const birthdayThisYear = new Date(
        today.getFullYear(),
        member.birth_month - 1,
        member.birth_day
      );
      if (birthdayThisYear < new Date(today.getFullYear(), today.getMonth(), today.getDate())) {
        birthdayThisYear.setFullYear(today.getFullYear() + 1);
      }
      const diffDays = Math.ceil(
        (birthdayThisYear - new Date(today.getFullYear(), today.getMonth(), today.getDate())) /
          (1000 * 60 * 60 * 24)
      );
      return { ...member, diffDays };
    })
    .filter((member) => member.diffDays >= 0 && member.diffDays <= daySpan)
    .sort((a, b) => a.diffDays - b.diffDays || a.full_name.localeCompare(b.full_name));
}

function getBirthdaysThisMonth() {
  const month = new Date().getMonth() + 1;
  return db
    .prepare(
      `
        SELECT members.id, members.full_name, members.birth_day, members.birth_month,
               COALESCE(fellowships.name, 'No Fellowship') AS fellowship_name
        FROM members
        LEFT JOIN fellowships ON fellowships.id = members.fellowship_id
        WHERE members.birth_month = ?
        ORDER BY members.birth_day, members.full_name
      `
    )
    .all(month);
}

function detectDuplicateMembers({ fullName, email, phone, memberId }) {
  const normalizedName = String(fullName || "").trim();
  const normalizedEmail = String(email || "").trim().toLowerCase();
  const normalizedPhone = normalizePhone(phone);

  const rows = db
    .prepare(
      `
        SELECT id, full_name, phone, email, fellowship_id
        FROM members
        WHERE 1 = 1
      `
    )
    .all();

  return rows.filter((row) => {
    if (memberId && Number(row.id) === Number(memberId)) {
      return false;
    }

    const rowName = String(row.full_name || "").trim();
    const rowEmail = String(row.email || "").trim().toLowerCase();
    const rowPhone = normalizePhone(row.phone);

    const exactNameMatch =
      normalizedName && rowName && normalizeName(rowName) === normalizeName(normalizedName);
    const exactEmailMatch = normalizedEmail && rowEmail && rowEmail === normalizedEmail;
    const exactPhoneMatch = normalizedPhone && rowPhone && rowPhone === normalizedPhone;
    const fuzzyNameMatch =
      normalizedName &&
      rowName &&
      areLikelyNameMatches(rowName, normalizedName) &&
      Math.abs(String(row.full_name).length - String(normalizedName).length) < 6;

    return exactNameMatch || exactEmailMatch || exactPhoneMatch || fuzzyNameMatch;
  });
}

function validateRoleForFellowship(roleId, fellowshipId) {
  if (!roleId) {
    return true;
  }

  const role = db
    .prepare("SELECT fellowship_id, scope_type FROM roles WHERE id = ?")
    .get(roleId);

  if (!role) {
    return false;
  }

  if (role.scope_type === "fellowship") {
    return Number(role.fellowship_id) === Number(fellowshipId);
  }

  return true;
}

function getRoleDetails(roleId) {
  if (!roleId) {
    return null;
  }

  return db
    .prepare("SELECT id, scope_type, fellowship_id FROM roles WHERE id = ?")
    .get(roleId);
}

function parseCsvLine(line) {
  const cells = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const currentChar = line[index];
    if (currentChar === '"') {
      if (inQuotes && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (currentChar === "," && !inQuotes) {
      cells.push(current.trim());
      current = "";
      continue;
    }

    current += currentChar;
  }

  cells.push(current.trim());
  return cells;
}

function parseMemberPayload(body) {
  const rawSubMinistryIds = Array.isArray(body.subMinistryIds)
    ? body.subMinistryIds
    : body.subMinistryIds
      ? [body.subMinistryIds]
      : [];

  return {
    fullName: String(body.fullName || "").trim(),
    gender: String(body.gender || "").trim(),
    birthDay: body.birthDay ? Number(body.birthDay) : null,
    birthMonth: body.birthMonth ? Number(body.birthMonth) : null,
    hostel: String(body.hostel || "").trim(),
    roomNo: String(body.roomNo || "").trim(),
    courseId: body.courseId ? Number(body.courseId) : null,
    fellowshipId:
      body.fellowshipId && Number.isFinite(Number(body.fellowshipId)) && Number(body.fellowshipId) > 0
        ? Number(body.fellowshipId)
        : null,
    subMinistryIds: rawSubMinistryIds
      .flatMap((value) => String(value).split(","))
      .map((value) => Number(String(value).trim()))
      .filter((value) => Number.isFinite(value) && value > 0),
    subMinistryId: body.subMinistryId ? Number(body.subMinistryId) : null,
    roleId: body.roleId ? Number(body.roleId) : null,
    phone: String(body.phone || "").trim(),
    email: String(body.email || "").trim(),
    level: String(body.level || "").trim(),
    status: String(body.status || "Active").trim(),
  };
}

// Only a name is always required. Love Fellowship is required for regular
// members and fellowship-scoped roles, but RD/CD can be saved without one.
// Real attendance registers (paper books digitized into spreadsheets, like
// the bulk-import files fellowships actually keep) very often lack a phone
// number, birthday, hostel, or course for a given member — that's a
// data-quality reality, not something the app should block on. Anything else
// provided is validated for correctness (a birthday, if given, must be a real
// day/month combination), but nothing else is mandatory.
function validateMemberPayload(payload) {
  if (!payload.fullName) {
    return "A full name is required.";
  }

  const selectedRole = getRoleDetails(payload.roleId);
  if (payload.roleId && !selectedRole) {
    return "Please choose a valid role.";
  }

  if (!payload.fellowshipId && (!selectedRole || selectedRole.scope_type === "fellowship")) {
    return "Love Fellowship is required unless the selected role is RD or CD.";
  }

  if (payload.birthDay && payload.birthMonth && !isValidBirthDate(payload.birthDay, payload.birthMonth)) {
    return "Please enter a valid birth day and month.";
  }

  if ((payload.birthDay && !payload.birthMonth) || (!payload.birthDay && payload.birthMonth)) {
    return "Please provide both a birth day and a birth month, or leave both blank.";
  }

  if (payload.roleId && !validateRoleForFellowship(payload.roleId, payload.fellowshipId)) {
    return "Selected role does not match the chosen Love Fellowship.";
  }

  return null;
}

function getMemberSubMinistryIds(memberId) {
  const ids = db
    .prepare(
      `
        SELECT sub_ministry_id
        FROM member_sub_ministries
        WHERE member_id = ?
        ORDER BY sub_ministry_id
      `
    )
    .all(memberId)
    .map((row) => Number(row.sub_ministry_id));

  if (ids.length > 0) {
    return ids;
  }

  function parseBulkIds(rawIds) {
    if (Array.isArray(rawIds)) {
      return rawIds.map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0);
    }
    if (!rawIds) {
      return [];
    }
    return [Number(rawIds)].filter((id) => Number.isFinite(id) && id > 0);
  }

  const legacy = db
    .prepare("SELECT sub_ministry_id FROM members WHERE id = ? AND sub_ministry_id IS NOT NULL")
    .get(memberId);

  return legacy && legacy.sub_ministry_id ? [Number(legacy.sub_ministry_id)] : [];
}

function setMemberSubMinistries(memberId, subMinistryIds) {
  const normalizedIds = [...new Set(subMinistryIds.filter((id) => Number.isFinite(id) && id > 0))];

  db.prepare("DELETE FROM member_sub_ministries WHERE member_id = ?").run(memberId);

  if (normalizedIds.length > 0) {
    const insertLink = db.prepare(
      "INSERT INTO member_sub_ministries (member_id, sub_ministry_id) VALUES (?, ?)"
    );
    normalizedIds.forEach((subMinistryId) => insertLink.run(memberId, subMinistryId));
  }

  const primaryId = normalizedIds.length === 1 ? normalizedIds[0] : null;
  db.prepare("UPDATE members SET sub_ministry_id = ? WHERE id = ?").run(primaryId, memberId);
}

function formatBirthdayForExport(birthDay, birthMonth) {
  return birthDay && birthMonth ? `${birthDay}/${birthMonth}` : "";
}

function logAudit(userId, action, entityType, entityId, details) {
  db.prepare(
    `
      INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details)
      VALUES (?, ?, ?, ?, ?)
    `
  ).run(userId || null, action, entityType, entityId || null, details || null);
}

function buildAttendanceInsights(attendanceHistory) {
  const ordered = [...attendanceHistory].sort((a, b) => a.week_start.localeCompare(b.week_start));

  if (ordered.length === 0) {
    return {
      longestAttendanceStreak: 0,
      longestAbsenceStreak: 0,
      firstWeek: null,
      mostRecentWeek: null,
      attendanceRate: 0,
      monthGroups: [],
    };
  }

  const monthGroups = new Map();
  ordered.forEach((entry) => {
    const monthKey = new Date(`${entry.week_start}T00:00:00Z`).toISOString().slice(0, 7);
    const label = new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric" }).format(
      new Date(`${monthKey}-01T00:00:00Z`)
    );
    if (!monthGroups.has(monthKey)) {
      monthGroups.set(monthKey, { label, entries: [] });
    }
    monthGroups.get(monthKey).entries.push(entry);
  });

  let currentAttendance = 0;
  let bestAttendance = 0;
  let currentAbsence = 0;
  let bestAbsence = 0;

  ordered.forEach((entry) => {
    if (entry.present === 1) {
      currentAttendance += 1;
      currentAbsence = 0;
      bestAttendance = Math.max(bestAttendance, currentAttendance);
    } else if (entry.present === 0) {
      currentAbsence += 1;
      currentAttendance = 0;
      bestAbsence = Math.max(bestAbsence, currentAbsence);
    } else {
      currentAttendance = 0;
      currentAbsence = 0;
    }
  });

  const totalWeeks = ordered.length;
  const attendedWeeks = ordered.filter((entry) => entry.present === 1).length;
  const attendanceRate = totalWeeks ? Math.round((attendedWeeks / totalWeeks) * 100) : 0;

  return {
    longestAttendanceStreak: bestAttendance,
    longestAbsenceStreak: bestAbsence,
    firstWeek: ordered[0].week_start,
    mostRecentWeek: ordered[ordered.length - 1].week_start,
    attendanceRate,
    monthGroups: Array.from(monthGroups.values()).map((group) => ({
      ...group,
      entries: [...group.entries].sort((a, b) => a.week_start.localeCompare(b.week_start)),
    })),
  };
}

function buildMembersQuery(filters) {
  const conditions = [];
  const params = [];

  if (filters.search) {
    conditions.push(
      "(LOWER(members.full_name) LIKE ? OR LOWER(members.hostel) LIKE ? OR LOWER(members.phone) LIKE ? OR LOWER(members.email) LIKE ?)"
    );
    const term = `%${filters.search.toLowerCase()}%`;
    params.push(term, term, term, term);
  }

  if (filters.fellowshipId) {
    conditions.push("members.fellowship_id = ?");
    params.push(filters.fellowshipId);
  }

  if (filters.subMinistryId) {
    conditions.push("EXISTS (SELECT 1 FROM member_sub_ministries WHERE member_sub_ministries.member_id = members.id AND member_sub_ministries.sub_ministry_id = ?)");
    params.push(filters.subMinistryId);
  }

  if (filters.roleId) {
    conditions.push("members.role_id = ?");
    params.push(filters.roleId);
  }

  if (filters.gender) {
    conditions.push("members.gender = ?");
    params.push(filters.gender);
  }

  if (filters.courseId) {
    conditions.push("members.course_id = ?");
    params.push(filters.courseId);
  }

  if (filters.level) {
    conditions.push("members.level = ?");
    params.push(filters.level);
  }

  if (filters.hostel) {
    conditions.push("LOWER(members.hostel) LIKE ?");
    params.push(`%${filters.hostel.toLowerCase()}%`);
  }

  if (filters.status) {
    conditions.push("members.status = ?");
    params.push(filters.status);
  }

  if (!filters.includeArchived) {
    conditions.push("members.archived_at IS NULL");
  }

  if (filters.duplicateOnly) {
    conditions.push("members.duplicate_flag = 1");
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const sql = `
    SELECT members.*,
           courses.name AS course_name,
           COALESCE(fellowships.name, 'No Fellowship') AS fellowship_name,
           fellowships.slug AS fellowship_slug,
           COALESCE(
             (
               SELECT GROUP_CONCAT(sub_ministries.name, ', ')
               FROM member_sub_ministries
               JOIN sub_ministries ON sub_ministries.id = member_sub_ministries.sub_ministry_id
               WHERE member_sub_ministries.member_id = members.id
               ORDER BY sub_ministries.name
             ),
             (
               SELECT sub_ministries.name
               FROM sub_ministries
               WHERE sub_ministries.id = members.sub_ministry_id
             )
           ) AS sub_ministry_name,
           roles.display_name AS role_name,
           roles.role_type
    FROM members
    LEFT JOIN courses ON courses.id = members.course_id
    LEFT JOIN fellowships ON fellowships.id = members.fellowship_id
    LEFT JOIN roles ON roles.id = members.role_id
    ${whereClause}
    ORDER BY members.full_name
  `;

  return { sql, params };
}

function getMemberWithDetails(memberId) {
  return db
    .prepare(
      `
        SELECT members.*,
               courses.name AS course_name,
               COALESCE(fellowships.name, 'No Fellowship') AS fellowship_name,
               fellowships.slug AS fellowship_slug,
               COALESCE(
                 (
                   SELECT GROUP_CONCAT(sub_ministries.name, ', ')
                   FROM member_sub_ministries
                   JOIN sub_ministries ON sub_ministries.id = member_sub_ministries.sub_ministry_id
                   WHERE member_sub_ministries.member_id = members.id
                   ORDER BY sub_ministries.name
                 ),
                 (
                   SELECT sub_ministries.name
                   FROM sub_ministries
                   WHERE sub_ministries.id = members.sub_ministry_id
                 )
               ) AS sub_ministry_name,
               roles.display_name AS role_name,
               roles.role_type
        FROM members
        LEFT JOIN courses ON courses.id = members.course_id
        LEFT JOIN fellowships ON fellowships.id = members.fellowship_id
        LEFT JOIN roles ON roles.id = members.role_id
        WHERE members.id = ?
      `
    )
    .get(memberId);
}

function canManageMember(user, member) {
  return Boolean(member && user);
}

function serializeFilters(query) {
  const params = new URLSearchParams();
  Object.entries(query).forEach(([key, value]) => {
    if (value) {
      params.set(key, value);
    }
  });
  return params.toString();
}

function getAttendanceSummaryForWeek(weekStart) {
  return db
    .prepare(
      `
        SELECT fellowships.id,
               fellowships.name,
               fellowships.slug,
               COUNT(DISTINCT members.id) AS member_total,
               COALESCE(SUM(CASE WHEN attendance_records.present = 1 THEN 1 ELSE 0 END), 0) AS present_total
        FROM fellowships
        LEFT JOIN members
          ON members.fellowship_id = fellowships.id
         AND members.status = 'Active'
        LEFT JOIN attendance_sessions
          ON attendance_sessions.fellowship_id = fellowships.id
         AND attendance_sessions.week_start = ?
        LEFT JOIN attendance_records
          ON attendance_records.attendance_session_id = attendance_sessions.id
         AND attendance_records.member_id = members.id
        GROUP BY fellowships.id, fellowships.name, fellowships.slug
        ORDER BY fellowships.name
      `
    )
    .all(weekStart)
    .map((row) => ({
      ...row,
      rate: row.member_total ? Math.round((row.present_total / row.member_total) * 100) : 0,
      headline: `${row.present_total} member${row.present_total === 1 ? "" : "s"} attended ${row.name} this week`,
    }));
}

function getCurrentAbsenceStreak(memberId, fellowshipId) {
  if (!memberId || !fellowshipId) {
    return { streak: 0, mostRecentWeek: null };
  }

  const history = db
    .prepare(
      `
        SELECT attendance_sessions.week_start, attendance_records.present
        FROM attendance_sessions
        LEFT JOIN attendance_records
          ON attendance_records.attendance_session_id = attendance_sessions.id
         AND attendance_records.member_id = ?
        WHERE attendance_sessions.fellowship_id = ?
        ORDER BY attendance_sessions.week_start DESC
      `
    )
    .all(memberId, fellowshipId);

  let streak = 0;
  for (const entry of history) {
    if (Number(entry.present) === 1) {
      break;
    }
    streak += 1;
  }

  return {
    streak,
    mostRecentWeek: history.length > 0 ? history[0].week_start : null,
  };
}

function getGoingQuietMembers({ minStreak = 3, fellowshipId = null } = {}) {
  const query = fellowshipId
    ? `
        SELECT members.id, members.full_name, members.joined_at, members.fellowship_id,
               fellowships.name AS fellowship_name, fellowships.slug AS fellowship_slug
        FROM members
        JOIN fellowships ON fellowships.id = members.fellowship_id
        WHERE members.status = 'Active' AND members.fellowship_id = ?
        ORDER BY members.full_name
      `
    : `
        SELECT members.id, members.full_name, members.joined_at, members.fellowship_id,
               COALESCE(fellowships.name, 'No Fellowship') AS fellowship_name,
               fellowships.slug AS fellowship_slug
        FROM members
        LEFT JOIN fellowships ON fellowships.id = members.fellowship_id
        WHERE members.status = 'Active'
        ORDER BY members.full_name
      `;

  const members = fellowshipId
    ? db.prepare(query).all(fellowshipId)
    : db.prepare(query).all();

  return members
    .map((member) => {
      const absence = getCurrentAbsenceStreak(member.id, member.fellowship_id);
      return {
        ...member,
        absenceStreak: absence.streak,
        mostRecentWeek: absence.mostRecentWeek,
      };
    })
    .filter((member) => member.absenceStreak >= minStreak)
    .sort(
      (a, b) =>
        b.absenceStreak - a.absenceStreak ||
        String(a.fellowship_name).localeCompare(String(b.fellowship_name)) ||
        a.full_name.localeCompare(b.full_name)
    );
}

function getNewMembersForOnboarding() {
  return db
    .prepare(
      `
        SELECT members.id, members.full_name, members.joined_at,
               COALESCE(fellowships.name, 'No Fellowship') AS fellowship_name,
               fellowships.slug AS fellowship_slug
        FROM members
        LEFT JOIN fellowships ON fellowships.id = members.fellowship_id
        WHERE members.status = 'Active'
        ORDER BY members.joined_at DESC
      `
    )
    .all()
    .map((member) => ({
      ...member,
      daysSinceJoined: getDaysSince(member.joined_at),
    }))
    .filter((member) => member.daysSinceJoined >= 0 && member.daysSinceJoined <= NEW_MEMBER_WINDOW_DAYS)
    .sort((a, b) => a.daysSinceJoined - b.daysSinceJoined);
}

function getLatestAwayListForFellowship(fellowshipId) {
  const latestSession = db
    .prepare(
      `
        SELECT id, week_start, week_end
        FROM attendance_sessions
        WHERE fellowship_id = ?
        ORDER BY week_start DESC
        LIMIT 1
      `
    )
    .get(fellowshipId);

  if (!latestSession) {
    return { session: null, absentMembers: [] };
  }

  const absentMembers = db
    .prepare(
      `
        SELECT members.id, members.full_name, members.phone, members.hostel, members.room_no
        FROM attendance_records
        JOIN members ON members.id = attendance_records.member_id
        WHERE attendance_records.attendance_session_id = ?
          AND attendance_records.present = 0
        ORDER BY members.full_name
      `
    )
    .all(latestSession.id);

  return { session: latestSession, absentMembers };
}

app.get("/", (req, res) => {
  return res.redirect(req.currentUser ? "/dashboard" : "/login");
});

const BLANK_MEMBER = {
  full_name: "",
  gender: "",
  birth_day: "",
  birth_month: "",
  hostel: "",
  room_no: "",
  course_id: "",
  fellowship_id: "",
  sub_ministry_id: "",
  role_id: "",
  phone: "",
  email: "",
  level: "",
  status: "Active",
};

// There is no public/member-facing registration in this app — every member
// record is entered by an authenticated admin, either one at a time here or
// in bulk via /members/import. Old bookmarks to the previous public
// "/register" link still resolve sensibly instead of 404ing.
app.get("/register", (req, res) => {
  return res.redirect(req.currentUser ? "/members/new" : "/login");
});

app.get("/members/new", requireAuth, (req, res) => {
  res.render("pages/register", {
    pageTitle: "Add Member",
    mode: "admin",
    member: BLANK_MEMBER,
    csrfToken: res.locals.csrfToken,
  });
});

app.post("/members/new", requireAuth, (req, res) => {
  const payload = parseMemberPayload(req.body);
  const validationError = validateMemberPayload(payload);

  if (validationError) {
    setFlash(req, "error", validationError);
    return res.status(422).render("pages/register", {
      pageTitle: "Add Member",
      mode: "admin",
      member: {
        full_name: payload.fullName,
        gender: payload.gender,
        birth_day: payload.birthDay,
        birth_month: payload.birthMonth,
        hostel: payload.hostel,
        room_no: payload.roomNo,
        course_id: payload.courseId,
        fellowship_id: payload.fellowshipId,
        sub_ministry_id: payload.subMinistryId,
        role_id: payload.roleId,
        phone: payload.phone,
        email: payload.email,
        level: payload.level,
        status: payload.status,
      },
      csrfToken: res.locals.csrfToken,
    });
  }

  const duplicates = detectDuplicateMembers(payload);
  const duplicateNotes = duplicates.length
    ? duplicates
        .map((item) => `${item.full_name} (${item.email}, ${item.phone})`)
        .join("; ")
    : null;

  const result = db
    .prepare(
      `
        INSERT INTO members (
          full_name, gender, birth_day, birth_month, hostel, room_no,
          course_id, fellowship_id, sub_ministry_id, role_id,
          phone, email, level, status, approval_status,
          duplicate_flag, duplicate_notes
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', ?, ?)
      `
    )
    .run(
      payload.fullName,
      payload.gender || null,
      payload.birthDay,
      payload.birthMonth,
      payload.hostel || null,
      payload.roomNo || null,
      payload.courseId,
      payload.fellowshipId,
      payload.subMinistryIds.length === 1 ? payload.subMinistryIds[0] : null,
      payload.roleId,
      payload.phone || null,
      payload.email || null,
      payload.level || null,
      payload.status,
      duplicates.length ? 1 : 0,
      duplicateNotes
    );

  if (payload.subMinistryIds.length > 0) {
    setMemberSubMinistries(result.lastInsertRowid, payload.subMinistryIds);
  }

  logAudit(null, "member_added", "member", result.lastInsertRowid, duplicateNotes);

  setFlash(
    req,
    duplicates.length ? "warning" : "success",
    duplicates.length
      ? `${payload.fullName} was added but flagged as a possible duplicate — please review.`
      : `${payload.fullName} was added.`
  );
  return res.redirect("/members/new");
});

app.get("/login", (req, res) => {
  if (req.currentUser) {
    return res.redirect("/dashboard");
  }

  res.render("pages/login", {
    pageTitle: "Login",
    csrfToken: res.locals.csrfToken,
  });
});

app.post("/login", loginLimiter, (req, res) => {
  const password = String(req.body.password || "");

  if (!bcrypt.compareSync(password, getSharedAccessPasswordHash())) {
    setFlash(req, "error", "Invalid password.");
    return res.redirect("/login");
  }

  req.session.isAuthenticated = true;
  logAudit(null, "login", "session", null, "Shared password login");
  setFlash(req, "success", "Welcome back.");
  return res.redirect("/dashboard");
});

app.get("/settings", requireAuth, (req, res) => {
  res.render("pages/settings", {
    pageTitle: "Settings",
    csrfToken: res.locals.csrfToken,
  });
});

app.get("/account/change-password", requireAuth, (req, res) => {
  res.render("pages/change-password", {
    pageTitle: "Change Access Password",
    csrfToken: res.locals.csrfToken,
  });
});

app.post("/account/change-password", requireAuth, (req, res) => {
  const password = String(req.body.password || "");
  const confirm = String(req.body.confirmPassword || "");

  if (!password || password.length < 8) {
    setFlash(req, "error", "Password must be at least 8 characters.");
    return res.redirect("/account/change-password");
  }

  if (password !== confirm) {
    setFlash(req, "error", "Passwords do not match.");
    return res.redirect("/account/change-password");
  }

  db.prepare(
    `
      UPDATE app_settings
      SET value = ?, updated_at = CURRENT_TIMESTAMP
      WHERE key = ?
    `
  ).run(bcrypt.hashSync(password, 10), SHARED_ACCESS_PASSWORD_KEY);

  logAudit(null, "access_password_changed", "setting", null, null);
  setFlash(req, "success", "The access password has been updated.");
  return res.redirect("/dashboard");
});

app.post("/logout", requireAuth, (req, res) => {
  logAudit(null, "logout", "session", null, "Shared password logout");
  req.session.destroy(() => {
    res.redirect("/login");
  });
});

app.get("/dashboard", requireAuth, (req, res) => {
  const currentWeekStart = getWeekStart();
  const currentWeekEnd = getWeekEnd(currentWeekStart);
  const memberVisibilityCondition = "WHERE 1 = 1";
  const statsParams = [];

  const totalMembers = db
    .prepare(`SELECT COUNT(*) AS count FROM members ${memberVisibilityCondition} AND archived_at IS NULL`)
    .get(...statsParams).count;

  const genderStats = db
    .prepare(
      `
        SELECT COALESCE(NULLIF(gender, ''), 'Unspecified') AS gender, COUNT(*) AS count
        FROM members
        ${memberVisibilityCondition} AND archived_at IS NULL
        GROUP BY COALESCE(NULLIF(gender, ''), 'Unspecified')
        ORDER BY count DESC, gender
      `
    )
    .all(...statsParams);

  const subMinistryStats = db
    .prepare(
      `
        WITH member_sub_ministry_counts AS (
          SELECT member_sub_ministries.sub_ministry_id, COUNT(*) AS count
          FROM member_sub_ministries
          JOIN members ON members.id = member_sub_ministries.member_id
          ${memberVisibilityCondition.replace('WHERE 1 = 1', 'WHERE 1 = 1')} AND members.archived_at IS NULL
          GROUP BY member_sub_ministries.sub_ministry_id

          UNION ALL

          SELECT members.sub_ministry_id AS sub_ministry_id, COUNT(*) AS count
          FROM members
          WHERE members.sub_ministry_id IS NOT NULL
            AND members.archived_at IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM member_sub_ministries WHERE member_sub_ministries.member_id = members.id
            )
          GROUP BY members.sub_ministry_id
        )
        SELECT COALESCE(sub_ministries.name, 'None') AS name, SUM(member_sub_ministry_counts.count) AS count
        FROM member_sub_ministry_counts
        LEFT JOIN sub_ministries ON sub_ministries.id = member_sub_ministry_counts.sub_ministry_id
        GROUP BY COALESCE(sub_ministries.name, 'None')
        ORDER BY count DESC, name
      `
    )
    .all(...statsParams);

  const fellowshipStats = db
    .prepare(
      `
        SELECT fellowships.name, fellowships.slug, COUNT(members.id) AS count
        FROM fellowships
        LEFT JOIN members
          ON members.fellowship_id = fellowships.id
         AND members.archived_at IS NULL
        WHERE 1 = 1
        GROUP BY fellowships.id, fellowships.name, fellowships.slug
        ORDER BY fellowships.name
      `
    )
    .all();

  const birthdaysThisWeek = getBirthdaysForWindow(6);
  const birthdaysThisMonth = getBirthdaysThisMonth();
  const attendanceSummary = getAttendanceSummaryForWeek(currentWeekStart);
  const totalAttendanceThisWeek = attendanceSummary.reduce(
    (sum, item) => sum + item.present_total,
    0
  );
  const goingQuietMembers = getGoingQuietMembers({ minStreak: 3 });
  const newOnboardingMembers = getNewMembersForOnboarding();
  const awayThisWeekSummary = db
    .prepare("SELECT id, name, slug FROM fellowships ORDER BY name")
    .all()
    .map((fellowship) => {
      const away = getLatestAwayListForFellowship(fellowship.id);
      return {
        ...fellowship,
        weekStart: away.session ? away.session.week_start : null,
        weekEnd: away.session ? away.session.week_end : null,
        absentCount: away.absentMembers.length,
      };
    });

  res.render("pages/dashboard", {
    pageTitle: "Dashboard",
    currentWeekStart,
    currentWeekEnd,
    totalMembers,
    genderStats,
    subMinistryStats,
    fellowshipStats,
    birthdaysThisWeek,
    birthdaysThisMonth,
    attendanceSummary,
    totalAttendanceThisWeek,
    goingQuietMembers,
    newOnboardingMembers,
    awayThisWeekSummary,
    weekLabel: getWeekLabel,
  });
});

app.get("/members", requireAuth, (req, res) => {
  const filters = {
    search: String(req.query.search || "").trim(),
    fellowshipId: req.query.fellowshipId ? Number(req.query.fellowshipId) : null,
    subMinistryId: req.query.subMinistryId ? Number(req.query.subMinistryId) : null,
    roleId: req.query.roleId ? Number(req.query.roleId) : null,
    gender: String(req.query.gender || "").trim(),
    courseId: req.query.courseId ? Number(req.query.courseId) : null,
    level: String(req.query.level || "").trim(),
    hostel: String(req.query.hostel || "").trim(),
    status: String(req.query.status || "").trim(),
    duplicateOnly: req.query.duplicateOnly === "1",
    includeArchived: req.query.includeArchived === "1",
  };

  const { sql, params } = buildMembersQuery(filters);
  const members = db.prepare(sql).all(...params);

  res.render("pages/members", {
    pageTitle: "Member Directory",
    members,
    filters,
    querystring: serializeFilters({
      search: filters.search,
      fellowshipId: filters.fellowshipId,
      subMinistryId: filters.subMinistryId,
      roleId: filters.roleId,
      gender: filters.gender,
      courseId: filters.courseId,
      level: filters.level,
      hostel: filters.hostel,
      status: filters.status,
      duplicateOnly: filters.duplicateOnly ? "1" : "",
      includeArchived: filters.includeArchived ? "1" : "",
    }),
    csrfToken: res.locals.csrfToken,
  });
});

app.post("/members/bulk-edit", requireAuth, (req, res) => {
  const selectedIds = [...new Set(parseBulkIds(req.body.memberIds))];
  if (selectedIds.length === 0) {
    setFlash(req, "warning", "Select at least one member before bulk editing.");
    return res.redirect("/members");
  }

  const action = String(req.body.action || "").trim();
  const value = String(req.body.value || "").trim();
  if (!action) {
    setFlash(req, "error", "Choose a bulk action.");
    return res.redirect("/members");
  }

  const placeholders = selectedIds.map(() => "?").join(",");
  const members = db
    .prepare(`SELECT id, full_name FROM members WHERE id IN (${placeholders})`)
    .all(...selectedIds);
  if (members.length === 0) {
    setFlash(req, "error", "No valid members were selected.");
    return res.redirect("/members");
  }

  if (action === "fellowship") {
    const fellowshipId = Number(value);
    if (!Number.isFinite(fellowshipId) || fellowshipId <= 0) {
      setFlash(req, "error", "Select a valid fellowship.");
      return res.redirect("/members");
    }

    db.transaction(() => {
      members.forEach((member) => {
        db.prepare(
          "UPDATE members SET fellowship_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
        ).run(fellowshipId, member.id);
      });
    })();
  } else if (action === "status") {
    if (!MEMBER_STATUSES.includes(value)) {
      setFlash(req, "error", "Select a valid status.");
      return res.redirect("/members");
    }
    db.prepare(
      `UPDATE members SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`
    ).run(value, ...selectedIds);
  } else if (action === "level") {
    if (!value) {
      setFlash(req, "error", "Select a level.");
      return res.redirect("/members");
    }
    db.prepare(
      `UPDATE members SET level = ?, updated_at = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`
    ).run(value, ...selectedIds);
  } else if (action === "subMinistry") {
    const subMinistryId = Number(value);
    if (!Number.isFinite(subMinistryId) || subMinistryId <= 0) {
      setFlash(req, "error", "Select a valid sub-ministry.");
      return res.redirect("/members");
    }
    db.transaction(() => {
      members.forEach((member) => {
        setMemberSubMinistries(member.id, [subMinistryId]);
      });
    })();
  } else {
    setFlash(req, "error", "Unsupported bulk action.");
    return res.redirect("/members");
  }

  logAudit(null, "members_bulk_edited", "member", null, `${action}:${value}; count=${members.length}`);
  setFlash(req, "success", `Bulk update applied to ${members.length} member(s).`);
  return res.redirect("/members");
});

function addDaysToIsoDate(isoDate, days) {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

// Matches an incoming register row to an existing member within the same
// fellowship, so uploading the same fellowship's register again next month
// updates the same people instead of creating duplicates. Prefers an exact
// phone match (most reliable), falling back to fuzzy name matching.
function findExistingMemberInFellowship(fellowshipId, fullName, phone) {
  const candidates = db
    .prepare("SELECT id, full_name, phone FROM members WHERE fellowship_id = ?")
    .all(fellowshipId);

  const normalizedPhone = normalizePhone(phone);
  if (normalizedPhone) {
    const phoneMatch = candidates.find((row) => normalizePhone(row.phone) === normalizedPhone);
    if (phoneMatch) {
      return phoneMatch;
    }
  }

  return candidates.find((row) => areLikelyNameMatches(row.full_name, fullName)) || null;
}

function parseDayMonth(value) {
  if (value instanceof Date) {
    return {
      day: value.getUTCDate(),
      month: value.getUTCMonth() + 1,
    };
  }

  const text = String(value || "").trim();
  if (!text) {
    return { day: null, month: null };
  }

  const isoMatch = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (isoMatch) {
    const day = Number(isoMatch[3]);
    const month = Number(isoMatch[2]);
    return isValidBirthDate(day, month) ? { day, month } : { day: null, month: null };
  }

  const match = text.match(/^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?/);
  if (!match) {
    return { day: null, month: null };
  }

  const day = Number(match[1]);
  const month = Number(match[2]);
  return isValidBirthDate(day, month) ? { day, month } : { day: null, month: null };
}

function isExcelUpload(file) {
  if (!file) {
    return false;
  }

  const originalName = String(file.originalname || "");
  const mimeType = String(file.mimetype || "").toLowerCase();
  return /\.(xlsx|xls|xlsm)$/i.test(originalName) || mimeType.includes("excel") || mimeType.includes("spreadsheet");
}

function normalizeWorkbookCell(value) {
  if (value === null || value === undefined) {
    return "";
  }

  if (typeof value === "number") {
    return Number.isInteger(value) ? String(value) : String(value).replace(/\.0+$/, "");
  }

  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }

  return String(value).trim();
}

function parseWeekNumberFromLabel(value) {
  const cleaned = normalizeWorkbookCell(value)
    .replace(/[\uFEFF]/g, "")
    .replace(/\s+/g, "")
    .toUpperCase();

  if (!cleaned) {
    return null;
  }

  const match = cleaned.match(/^(?:W(?:EEK)?|WK)?(\d+)(?:\.0+)?$/) || cleaned.match(/^(\d+)(?:\.0+)?$/);
  return match ? Number(match[1] || match[0]) : null;
}

function normalizeHeaderKey(value) {
  return normalizeWorkbookCell(value)
    .replace(/[\uFEFF]/g, "")
    .replace(/[^A-Z0-9]+/gi, "")
    .toUpperCase();
}

function levelFromYear(value) {
  const year = Number(String(value || "").trim());
  if (!year || year < 1 || year > 6) {
    return "";
  }
  return String(year * 100);
}

// Reads a real fellowship attendance register (the kind kept as a monthly
// Excel sheet): a title row, a header row naming NAME/NUMBER/HOSTEL/ROOM
// NO./BIRTHDAY/SUBMINISTRY/YEAR, followed by one numbered column per meeting
// week. Any mark in a week's column counts as present; a blank counts as
// absent — but only for weeks where at least one person has a mark, since a
// fully blank column means that week hasn't happened yet.
async function parseAttendanceRegisterWorkbook(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);

  const sheet =
    workbook.worksheets.find((candidate) => candidate && candidate.rowCount > 0) || workbook.worksheets[0];
  if (!sheet) {
    throw new Error("The workbook has no sheets.");
  }

  const columns = {};
  const weekColumns = [];
  let headerRowNumber = null;

  for (let rowNumber = 1; rowNumber <= Math.min(sheet.rowCount, 20); rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const cellTexts = [];
    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      cellTexts[colNumber] = normalizeWorkbookCell(cell.value);
    });

    const normalizedHeaders = cellTexts
      .filter((text) => text)
      .map((text) => normalizeHeaderKey(text));

    const headerText = normalizedHeaders.join(" ");
    const hasNameHeader = normalizedHeaders.some((header) =>
      ["NAME", "FULLNAME", "MEMBERNAME", "MEMBERSNAME", "NAMEOFMEMBER", "FULLNAMES"].includes(header)
    );

    if (headerText && hasNameHeader) {
      headerRowNumber = rowNumber;
      cellTexts.forEach((text, colNumber) => {
        if (!text) return;
        const normalized = normalizeHeaderKey(text);

        if (["NAME", "FULLNAME", "MEMBERNAME", "MEMBERSNAME", "NAMEOFMEMBER", "FULLNAMES"].includes(normalized)) {
          columns.name = colNumber;
        } else if (["PHONE", "PHONENUMBER", "MOBILENUMBER", "MOBILE", "NUMBER", "CONTACTNUMBER", "TEL"].includes(normalized)) {
          columns.phone = colNumber;
        } else if (["GENDER", "SEX"].includes(normalized)) {
          columns.gender = colNumber;
        } else if (["COURSE", "COURSEOFSTUDY", "PROGRAM", "PROGRAMME"].includes(normalized)) {
          columns.course = colNumber;
        } else if (["EMAIL", "EMAILADDRESS"].includes(normalized)) {
          columns.email = colNumber;
        } else if (normalized === "HOSTEL") {
          columns.hostel = colNumber;
        } else if (normalized.startsWith("ROOM") || normalized === "ROOMNO" || normalized === "ROOMNUMBER") {
          columns.roomNo = colNumber;
        } else if (["BIRTHDAY", "DATEOFBIRTH", "DOB"].includes(normalized)) {
          columns.birthday = colNumber;
        } else if (
          normalized.startsWith("SUBMIN") ||
          normalized.includes("MINISTRY") ||
          normalized === "MINISTRY"
        ) {
          columns.subMinistry = colNumber;
        } else if (["YEAR", "LEVEL", "ACADEMICYEAR", "STUDYYEAR"].includes(normalized)) {
          columns.year = colNumber;
        } else {
          const weekNumber = parseWeekNumberFromLabel(text);
          if (weekNumber) {
            weekColumns.push({ column: colNumber, weekNumber });
          }
        }
      });
      break;
    }
  }

  if (headerRowNumber === null || !columns.name) {
    throw new Error("Couldn't find a header row with a NAME column in this file.");
  }

  const dataRows = [];
  for (let rowNumber = headerRowNumber + 1; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const name = normalizeWorkbookCell(row.getCell(columns.name).value);
    if (!name) continue;

    const weeks = {};
    weekColumns.forEach(({ column, weekNumber }) => {
      const raw = row.getCell(column).value;
      const value = normalizeWorkbookCell(raw);
      weeks[weekNumber] = value !== "" && value !== null && value !== undefined;
    });

    dataRows.push({
      rowNumber,
      name,
      gender: columns.gender ? normalizeWorkbookCell(row.getCell(columns.gender).value) : "",
      phone: columns.phone ? normalizeWorkbookCell(row.getCell(columns.phone).value) : "",
      email: columns.email ? normalizeWorkbookCell(row.getCell(columns.email).value) : "",
      hostel: columns.hostel ? normalizeWorkbookCell(row.getCell(columns.hostel).value) : "",
      roomNo: columns.roomNo ? normalizeWorkbookCell(row.getCell(columns.roomNo).value) : "",
      birthday: columns.birthday ? row.getCell(columns.birthday).value : null,
      subMinistry: columns.subMinistry ? normalizeWorkbookCell(row.getCell(columns.subMinistry).value) : "",
      year: columns.year ? row.getCell(columns.year).value : null,
      course: columns.course ? normalizeWorkbookCell(row.getCell(columns.course).value) : "",
      weeks,
    });
  }

  const activeWeekNumbers = weekColumns
    .map((w) => w.weekNumber)
    .filter((weekNumber) => dataRows.some((row) => row.weeks[weekNumber]))
    .sort((a, b) => a - b);

  return { dataRows, activeWeekNumbers };
}

app.get("/members/import", requireAuth, (req, res) => {
  res.render("pages/import-members", {
    pageTitle: "Bulk Import",
    csrfToken: res.locals.csrfToken,
    results: null,
  });
});

app.post("/members/import", requireAuth, upload.single("importFile"), csrfProtection, async (req, res) => {
  if (!req.file) {
    setFlash(req, "error", "Please choose a file to import.");
    return res.redirect("/members/import");
  }

  const isExcel = isExcelUpload(req.file);

  // --- Path 1: a fellowship attendance register (.xlsx), with weekly marks ---
  if (isExcel) {
    const fellowshipId = Number(req.body.fellowshipId || 0);
    const weekOneStartInput = String(req.body.weekOneStart || "").trim();

    if (!fellowshipId) {
      setFlash(req, "error", "Please choose a Love Fellowship before uploading a register or member list.");
      return res.redirect("/members/import");
    }

    let parsed;
    try {
      parsed = await parseAttendanceRegisterWorkbook(req.file.buffer);
    } catch (error) {
      setFlash(req, "error", `Could not read that file: ${error.message}`);
      return res.redirect("/members/import");
    }

    if (parsed.activeWeekNumbers.length === 0) {
      const inserted = [];
      const flaggedDuplicates = [];
      const skipped = [];

      parsed.dataRows.forEach((row) => {
        const fullName = String(row.name || "").trim();
        if (!fullName) {
          return;
        }

        const { day, month } = parseDayMonth(row.birthday);
        const level = levelFromYear(row.year);
        const subMinistryNames = row.subMinistry
          ? String(row.subMinistry)
              .split(/[;,/]/)
              .map((value) => value.trim())
              .filter(Boolean)
          : [];
        const subMinistryIds = subMinistryNames
          .map((name) => db.prepare("SELECT id FROM sub_ministries WHERE LOWER(name) = LOWER(?)").get(name))
          .filter(Boolean)
          .map((rowEntry) => rowEntry.id);

        const memberPayload = {
          fullName,
          gender: String(row.gender || "").trim(),
          birthDay: day,
          birthMonth: month,
          hostel: row.hostel || "",
          courseId: null,
          fellowshipId,
          subMinistryIds,
          roleId: null,
          phone: row.phone || "",
          email: row.email || "",
          level,
          status: "Active",
        };

        const validationError = validateMemberPayload(memberPayload);
        if (validationError) {
          skipped.push({ line: row.rowNumber, name: fullName, reason: validationError });
          return;
        }

        const duplicates = detectDuplicateMembers(memberPayload);
        const existingMember = findExistingMemberInFellowship(fellowshipId, fullName, row.phone || "");

        if (existingMember) {
          db.prepare(
            `
              UPDATE members SET
                full_name = ?,
                gender = COALESCE(NULLIF(?, ''), gender),
                birth_day = COALESCE(birth_day, ?),
                birth_month = COALESCE(birth_month, ?),
                hostel = COALESCE(NULLIF(hostel, ''), ?),
                room_no = COALESCE(NULLIF(room_no, ''), ?),
                course_id = COALESCE(course_id, ?),
                phone = COALESCE(NULLIF(phone, ''), ?),
                email = COALESCE(NULLIF(email, ''), ?),
                level = COALESCE(NULLIF(level, ''), ?),
                status = COALESCE(NULLIF(status, ''), 'Active'),
                updated_at = CURRENT_TIMESTAMP
              WHERE id = ?
            `
          ).run(
            fullName,
            memberPayload.gender || null,
            day,
            month,
            row.hostel || null,
            row.roomNo || null,
            null,
            row.phone || null,
            row.email || null,
            level || null,
            existingMember.id
          );
          if (subMinistryIds.length > 0) {
            setMemberSubMinistries(existingMember.id, subMinistryIds);
          }
          if (duplicates.length) {
            flaggedDuplicates.push(fullName);
          } else {
            inserted.push(fullName);
          }
          return;
        }

        const result = db
          .prepare(
            `
              INSERT INTO members (
                full_name, gender, birth_day, birth_month, hostel, room_no,
                course_id, fellowship_id, sub_ministry_id, phone, email, level,
                status, approval_status, duplicate_flag, duplicate_notes
              )
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Active', 'approved', ?, ?)
            `
          )
          .run(
            fullName,
            memberPayload.gender || null,
            day,
            month,
            row.hostel || null,
            row.roomNo || null,
            null,
            fellowshipId,
            subMinistryIds.length === 1 ? subMinistryIds[0] : null,
            row.phone || null,
            row.email || null,
            level || null,
            duplicates.length ? 1 : 0,
            duplicates.length ? duplicates.map((duplicate) => duplicate.full_name).join("; ") : null
          );

        if (subMinistryIds.length > 0) {
          setMemberSubMinistries(result.lastInsertRowid, subMinistryIds);
        }

        if (duplicates.length) {
          flaggedDuplicates.push(fullName);
        } else {
          inserted.push(fullName);
        }
      });

      const totalProcessed = inserted.length + flaggedDuplicates.length;
      logAudit(null, "members_imported", "member", null, `${totalProcessed} imported, ${skipped.length} skipped`);
      setFlash(
        req,
        skipped.length > 0 ? "warning" : "success",
        `Member list imported: ${totalProcessed} record(s) added, ${skipped.length} skipped.`
      );

      return res.render("pages/import-members", {
        pageTitle: "Bulk Import",
        csrfToken: res.locals.csrfToken,
        results: {
          type: "register",
          membersCreated: inserted.length,
          membersMatched: flaggedDuplicates.length,
          weeksImported: 0,
          attendanceMarksRecorded: 0,
          skipped,
          attendanceNote: "Member details only — no attendance columns found in this file.",
        },
      });
    }

    if (!weekOneStartInput) {
      setFlash(req, "error", "Please choose the date of Week 1 before uploading a weekly attendance register.");
      return res.redirect("/members/import");
    }

    const weekOneStart = getWeekStart(weekOneStartInput);
    let membersCreated = 0;
    let membersMatched = 0;
    let attendanceMarksRecorded = 0;
    const skipped = [];

    const sessionIdByWeekNumber = {};
    parsed.activeWeekNumbers.forEach((weekNumber) => {
      const weekStart = addDaysToIsoDate(weekOneStart, 7 * (weekNumber - 1));
      const weekEnd = getWeekEnd(weekStart);
      db.prepare(
        `
          INSERT INTO attendance_sessions (fellowship_id, week_start, week_end, recorded_by_user_id)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(fellowship_id, week_start)
          DO UPDATE SET week_end = excluded.week_end, updated_at = CURRENT_TIMESTAMP
        `
      ).run(fellowshipId, weekStart, weekEnd, req.currentUser.actorId);
      const session = db
        .prepare("SELECT id FROM attendance_sessions WHERE fellowship_id = ? AND week_start = ?")
        .get(fellowshipId, weekStart);
      sessionIdByWeekNumber[weekNumber] = session.id;
    });

    const upsertAttendance = db.prepare(
      `
        INSERT INTO attendance_records (attendance_session_id, member_id, present)
        VALUES (?, ?, ?)
        ON CONFLICT(attendance_session_id, member_id)
        DO UPDATE SET present = excluded.present, marked_at = CURRENT_TIMESTAMP
      `
    );

    parsed.dataRows.forEach((row) => {
      const { day, month } = parseDayMonth(row.birthday);
      const level = levelFromYear(row.year);
      const subMinistryNames = row.subMinistry
        ? String(row.subMinistry)
            .split(/[;,/]/)
            .map((value) => value.trim())
            .filter(Boolean)
        : [];
      const subMinistryIds = subMinistryNames
        .map((name) => db.prepare("SELECT id FROM sub_ministries WHERE LOWER(name) = LOWER(?)").get(name))
        .filter(Boolean)
        .map((rowEntry) => rowEntry.id);

      let member = findExistingMemberInFellowship(fellowshipId, row.name, row.phone);

      if (member) {
        db.prepare(
          `
            UPDATE members SET
              hostel = COALESCE(NULLIF(hostel, ''), ?),
              room_no = COALESCE(NULLIF(room_no, ''), ?),
              birth_day = COALESCE(birth_day, ?),
              birth_month = COALESCE(birth_month, ?),
              level = COALESCE(NULLIF(level, ''), ?),
              phone = COALESCE(NULLIF(phone, ''), ?),
              updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `
        ).run(row.hostel || null, row.roomNo || null, day, month, level || null, row.phone || null, member.id);
        if (subMinistryIds.length > 0) {
          setMemberSubMinistries(member.id, subMinistryIds);
        }
        membersMatched += 1;
      } else {
        const result = db
          .prepare(
            `
              INSERT INTO members (
                full_name, hostel, room_no, birth_day, birth_month, level,
                sub_ministry_id, fellowship_id, phone, status, approval_status
              )
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Active', 'approved')
            `
          )
          .run(
            row.name,
            row.hostel || null,
            row.roomNo || null,
            day,
            month,
            level || null,
            subMinistryIds.length === 1 ? subMinistryIds[0] : null,
            fellowshipId,
            row.phone || null
          );
        member = { id: result.lastInsertRowid };
        if (subMinistryIds.length > 0) {
          setMemberSubMinistries(member.id, subMinistryIds);
        }
        membersCreated += 1;
      }

      parsed.activeWeekNumbers.forEach((weekNumber) => {
        upsertAttendance.run(sessionIdByWeekNumber[weekNumber], member.id, row.weeks[weekNumber] ? 1 : 0);
        attendanceMarksRecorded += 1;
      });
    });

    logAudit(
      null,
      "attendance_register_imported",
      "fellowship",
      fellowshipId,
      `${membersCreated} created, ${membersMatched} matched, ${parsed.activeWeekNumbers.length} week(s), ${attendanceMarksRecorded} marks`
    );

    setFlash(
      req,
      "success",
      `Register imported: ${membersCreated} new member(s), ${membersMatched} matched to existing records, ${parsed.activeWeekNumbers.length} week(s) of attendance recorded.`
    );

    return res.render("pages/import-members", {
      pageTitle: "Bulk Import",
      csrfToken: res.locals.csrfToken,
      results: {
        type: "register",
        membersCreated,
        membersMatched,
        weeksImported: parsed.activeWeekNumbers.length,
        attendanceMarksRecorded,
        skipped,
      },
    });
  }

  // --- Path 2: a plain member-list CSV (no attendance columns) ---
  const fileText = req.file.buffer.toString("utf8");
  const rows = fileText.split(/\r?\n/).filter((row) => row.trim().length > 0);
  if (rows.length < 2) {
    setFlash(req, "error", "The CSV file is empty or missing data.");
    return res.redirect("/members/import");
  }

  const headers = parseCsvLine(rows[0]).map((header) => header.toLowerCase().replace(/[^a-z0-9]+/g, ""));
  const inserted = [];
  const flaggedDuplicates = [];
  const skipped = [];

  for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
    const lineNumber = rowIndex + 1;
    const values = parseCsvLine(rows[rowIndex]);
    const row = Object.fromEntries(headers.map((header, index) => [header, values[index] || ""]));
    const memberPayload = {
      fullName: row.fullname || row.name || row.membername,
      gender: row.gender,
      birthDay: row.birthday ? Number(row.birthday.split("/")[0]) : row.birthdayday ? Number(row.birthdayday) : null,
      birthMonth: row.birthday ? Number(row.birthday.split("/")[1]) : row.birthmonth ? Number(row.birthmonth) : null,
      hostel: row.hostel,
      courseId: row.courseid || row.course ? Number(row.courseid || row.course) : null,
      fellowshipId: Number(row.fellowshipid || row.lovefellowship || "0"),
      subMinistryId: row.subministryid ? Number(row.subministryid) : null,
      roleId: row.roleid ? Number(row.roleid) : null,
      phone: row.phone,
      email: row.email,
      level: row.level,
      status: row.status || "Active",
    };

    const rowLabel = memberPayload.fullName || `Row ${lineNumber}`;

    if (!memberPayload.fullName || !memberPayload.fellowshipId) {
      skipped.push({ line: lineNumber, name: rowLabel, reason: "Missing a required field (name or fellowship)." });
      continue;
    }

    const validationError = validateMemberPayload(memberPayload);
    if (validationError) {
      skipped.push({ line: lineNumber, name: rowLabel, reason: validationError });
      continue;
    }

    const duplicates = detectDuplicateMembers(memberPayload);
    db.prepare(
      `
        INSERT INTO members (
          full_name, gender, birth_day, birth_month, hostel,
          course_id, fellowship_id, sub_ministry_id, role_id,
          phone, email, level, status, approval_status,
          duplicate_flag, duplicate_notes
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', ?, ?)
      `
    ).run(
      memberPayload.fullName,
      memberPayload.gender || null,
      memberPayload.birthDay,
      memberPayload.birthMonth,
      memberPayload.hostel || null,
      memberPayload.courseId,
      memberPayload.fellowshipId,
      memberPayload.subMinistryId,
      memberPayload.roleId,
      memberPayload.phone || null,
      memberPayload.email || null,
      memberPayload.level || null,
      memberPayload.status,
      duplicates.length ? 1 : 0,
      duplicates.length ? duplicates.map((duplicate) => duplicate.full_name).join("; ") : null
    );

    if (duplicates.length) {
      flaggedDuplicates.push(rowLabel);
    } else {
      inserted.push(rowLabel);
    }
  }

  logAudit(
    null,
    "members_imported",
    "member",
    null,
    `${inserted.length + flaggedDuplicates.length} inserted, ${skipped.length} skipped`
  );

  const totalProcessed = inserted.length + flaggedDuplicates.length;
  setFlash(
    req,
    skipped.length > 0 ? "warning" : "success",
    `Import complete: ${totalProcessed} member(s) added, ${skipped.length} row(s) skipped.`
  );

  return res.render("pages/import-members", {
    pageTitle: "Bulk Import",
    csrfToken: res.locals.csrfToken,
    results: { type: "members", inserted, flaggedDuplicates, skipped },
  });
});

app.get("/members/:id", requireAuth, (req, res) => {
  const member = getMemberWithDetails(Number(req.params.id));
  if (!member) {
    return res.status(404).render("pages/not-found", {
      pageTitle: "Member Not Found",
      currentUser: req.currentUser || res.locals.currentUser || null,
      currentPath: req.path,
      csrfToken: res.locals.csrfToken || "",
    });
  }

  const attendanceStats = db
    .prepare(
      `
        SELECT
          COUNT(attendance_sessions.id) AS total_weeks,
          COALESCE(SUM(CASE WHEN attendance_records.present = 1 THEN 1 ELSE 0 END), 0) AS attended_weeks
        FROM attendance_sessions
        LEFT JOIN attendance_records
          ON attendance_records.attendance_session_id = attendance_sessions.id
         AND attendance_records.member_id = ?
        WHERE attendance_sessions.fellowship_id = ?
      `
    )
    .get(member.id, member.fellowship_id);

  const attendanceHistory = db
    .prepare(
      `
        SELECT attendance_sessions.week_start, attendance_sessions.week_end, attendance_records.present
        FROM attendance_sessions
        LEFT JOIN attendance_records
          ON attendance_records.attendance_session_id = attendance_sessions.id
         AND attendance_records.member_id = ?
        WHERE attendance_sessions.fellowship_id = ?
        ORDER BY attendance_sessions.week_start ASC
      `
    )
    .all(member.id, member.fellowship_id);

  const transferHistory = db
    .prepare(
      `
        SELECT member_fellowship_transfers.*,
               from_fellowship.name AS from_fellowship_name,
               to_fellowship.name AS to_fellowship_name
        FROM member_fellowship_transfers
        LEFT JOIN fellowships AS from_fellowship ON from_fellowship.id = member_fellowship_transfers.from_fellowship_id
        LEFT JOIN fellowships AS to_fellowship ON to_fellowship.id = member_fellowship_transfers.to_fellowship_id
        WHERE member_fellowship_transfers.member_id = ?
        ORDER BY member_fellowship_transfers.created_at DESC
      `
    )
    .all(member.id);

  const attendanceByFellowship = db
    .prepare(
      `
        SELECT
          attendance_sessions.fellowship_id,
          COALESCE(fellowships.name, 'No Fellowship') AS fellowship_name,
          attendance_sessions.week_start,
          attendance_sessions.week_end,
          attendance_records.present
        FROM attendance_sessions
        LEFT JOIN attendance_records
          ON attendance_records.attendance_session_id = attendance_sessions.id
         AND attendance_records.member_id = ?
        LEFT JOIN fellowships ON fellowships.id = attendance_sessions.fellowship_id
        WHERE attendance_sessions.fellowship_id IN (
          SELECT DISTINCT COALESCE(to_fellowship_id, from_fellowship_id)
          FROM member_fellowship_transfers
          WHERE member_id = ?
          UNION
          SELECT COALESCE(?, attendance_sessions.fellowship_id)
        )
        ORDER BY fellowship_name, attendance_sessions.week_start ASC
      `
    )
    .all(member.id, member.id, member.fellowship_id);

  const rate = attendanceStats.total_weeks
    ? Math.round((attendanceStats.attended_weeks / attendanceStats.total_weeks) * 100)
    : 0;

  const attendanceInsights = buildAttendanceInsights(attendanceHistory);

  res.render("pages/member-detail", {
    pageTitle: member.full_name,
    member,
    attendanceStats: {
      ...attendanceStats,
      missed_weeks: attendanceStats.total_weeks - attendanceStats.attended_weeks,
      rate,
      longest_attendance_streak: attendanceInsights.longestAttendanceStreak,
      longest_absence_streak: attendanceInsights.longestAbsenceStreak,
      first_week: attendanceInsights.firstWeek,
      most_recent_week: attendanceInsights.mostRecentWeek,
      attendance_rate: attendanceInsights.attendanceRate,
    },
    attendanceHistory,
    attendanceByFellowship,
    transferHistory,
    attendanceGroups: attendanceInsights.monthGroups,
    canManage: canManageMember(req.currentUser, member),
    weekLabel: getWeekLabel,
    isNew: isNewMember(member.joined_at),
    daysSinceJoined: getDaysSince(member.joined_at),
  });
});

app.get("/members/:id/edit", requireAuth, (req, res) => {
  const member = getMemberWithDetails(Number(req.params.id));
  if (!member) {
    return res.status(404).render("pages/not-found", {
      pageTitle: "Member Not Found",
      currentUser: req.currentUser || res.locals.currentUser || null,
      currentPath: req.path,
      csrfToken: res.locals.csrfToken || "",
    });

    app.post("/members/:id/merge", requireAuth, (req, res) => {
      const winnerId = Number(req.params.id);
      const loserId = Number(req.body.duplicateMemberId);
      if (!Number.isFinite(loserId) || loserId <= 0 || loserId === winnerId) {
        setFlash(req, "error", "Select a valid duplicate record to merge.");
        return res.redirect(`/members/${winnerId}`);
      }

      const winner = getMemberWithDetails(winnerId);
      const loser = getMemberWithDetails(loserId);
      if (!winner || !loser) {
        setFlash(req, "error", "One of the selected records could not be found.");
        return res.redirect(`/members/${winnerId}`);
      }

      db.transaction(() => {
        const sessions = db
          .prepare(
            `
              SELECT attendance_records.attendance_session_id, attendance_records.present
              FROM attendance_records
              WHERE attendance_records.member_id = ?
            `
          )
          .all(loserId);

        const upsert = db.prepare(
          `
            INSERT INTO attendance_records (attendance_session_id, member_id, present)
            VALUES (?, ?, ?)
            ON CONFLICT(attendance_session_id, member_id)
            DO UPDATE SET
              present = MAX(attendance_records.present, excluded.present),
              marked_at = CURRENT_TIMESTAMP
          `
        );
        sessions.forEach((row) => upsert.run(row.attendance_session_id, winnerId, row.present));

        db.prepare("DELETE FROM member_sub_ministries WHERE member_id = ?").run(loserId);
        db.prepare("DELETE FROM attendance_records WHERE member_id = ?").run(loserId);
        db.prepare("DELETE FROM member_fellowship_transfers WHERE member_id = ?").run(loserId);
        db.prepare("DELETE FROM members WHERE id = ?").run(loserId);

        const refreshedDuplicates = detectDuplicateMembers({
          fullName: winner.full_name,
          email: winner.email,
          phone: winner.phone,
          memberId: winnerId,
        });
        const duplicateNotes = refreshedDuplicates.length
          ? refreshedDuplicates.map((item) => `${item.full_name} (${item.email}, ${item.phone})`).join("; ")
          : null;
        db.prepare(
          "UPDATE members SET duplicate_flag = ?, duplicate_notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
        ).run(refreshedDuplicates.length ? 1 : 0, duplicateNotes, winnerId);
      })();

      logAudit(null, "member_merged", "member", winnerId, `Merged ${loser.full_name} (${loserId}) into ${winner.full_name} (${winnerId})`);
      setFlash(req, "success", `Merged ${loser.full_name} into ${winner.full_name}. Attendance history was preserved.`);
      return res.redirect(`/members/${winnerId}`);
    });
  }

  if (!canManageMember(req.currentUser, member)) {
    return res.status(403).render("pages/forbidden", {
      pageTitle: "Access Denied",
      currentUser: req.currentUser || res.locals.currentUser || null,
      currentPath: req.path,
      csrfToken: res.locals.csrfToken || "",
    });
  }

  res.render("pages/edit-member", {
    pageTitle: `Edit ${member.full_name}`,
    member,
  });
});

app.post("/members/:id/transfer", requireAuth, (req, res) => {
  const member = getMemberWithDetails(Number(req.params.id));
  if (!member) {
    return res.status(404).render("pages/not-found", {
      pageTitle: "Member Not Found",
      currentUser: req.currentUser || res.locals.currentUser || null,
      currentPath: req.path,
      csrfToken: res.locals.csrfToken || "",
    });

    app.post("/members/:id/archive", requireAuth, (req, res) => {
      const member = getMemberWithDetails(Number(req.params.id));
      if (!member) {
        setFlash(req, "error", "Member not found.");
        return res.redirect("/members");
      }

      archiveMember(member.id, String(req.body.reason || "").trim());
      logAudit(null, "member_archived", "member", member.id, member.full_name);
      setFlash(req, "success", `${member.full_name} was archived.`);
      return res.redirect("/members");
    });

    app.post("/members/:id/restore", requireAuth, (req, res) => {
      const member = getMemberWithDetails(Number(req.params.id));
      if (!member) {
        setFlash(req, "error", "Member not found.");
        return res.redirect("/members?includeArchived=1");
      }

      restoreMember(member.id);
      logAudit(null, "member_restored", "member", member.id, member.full_name);
      setFlash(req, "success", `${member.full_name} was restored.`);
      return res.redirect("/members?includeArchived=1");
    });
  }

  const toFellowshipId = Number(req.body.toFellowshipId);
  const notes = String(req.body.notes || "").trim();
  if (!Number.isFinite(toFellowshipId) || toFellowshipId <= 0) {
    setFlash(req, "error", "Select the destination fellowship.");
    return res.redirect(`/members/${member.id}`);
  }

  if (Number(member.fellowship_id) === toFellowshipId) {
    setFlash(req, "warning", "Member is already in that fellowship.");
    return res.redirect(`/members/${member.id}`);
  }

  const destination = db.prepare("SELECT id, name FROM fellowships WHERE id = ?").get(toFellowshipId);
  if (!destination) {
    setFlash(req, "error", "Destination fellowship not found.");
    return res.redirect(`/members/${member.id}`);
  }

  const oldFellowshipId = member.fellowship_id || null;
  db.transaction(() => {
    db.prepare(
      "UPDATE members SET fellowship_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
    ).run(toFellowshipId, member.id);
    db.prepare(
      `
        INSERT INTO member_fellowship_transfers (
          member_id, from_fellowship_id, to_fellowship_id, transferred_by_user_id, notes
        ) VALUES (?, ?, ?, ?, ?)
      `
    ).run(member.id, oldFellowshipId, toFellowshipId, req.currentUser.actorId, notes || null);
  })();

  logAudit(null, "member_transferred", "member", member.id, `${member.fellowship_name || "No Fellowship"} -> ${destination.name}`);
  setFlash(req, "success", `${member.full_name} moved to ${destination.name}. Attendance history is preserved and shown by fellowship segment.`);
  return res.redirect(`/members/${member.id}`);
});

app.post("/members/:id/edit", requireAuth, (req, res) => {
  const existingMember = getMemberWithDetails(Number(req.params.id));
  if (!existingMember) {
    return res.status(404).render("pages/not-found", {
      pageTitle: "Member Not Found",
      currentUser: req.currentUser || res.locals.currentUser || null,
      currentPath: req.path,
      csrfToken: res.locals.csrfToken || "",
    });
  }

  if (!canManageMember(req.currentUser, existingMember)) {
    return res.status(403).render("pages/forbidden", {
      pageTitle: "Access Denied",
      currentUser: req.currentUser || res.locals.currentUser || null,
      currentPath: req.path,
      csrfToken: res.locals.csrfToken || "",
    });
  }

  const payload = parseMemberPayload(req.body);
  const validationError = validateMemberPayload(payload);
  if (validationError) {
    setFlash(req, "error", validationError);
    return res.redirect(`/members/${existingMember.id}/edit`);
  }

  const duplicates = detectDuplicateMembers({ ...payload, memberId: existingMember.id });
  const duplicateNotes = duplicates.length
    ? duplicates
        .map((item) => `${item.full_name} (${item.email}, ${item.phone})`)
        .join("; ")
    : null;

  db.prepare(
    `
      UPDATE members
      SET full_name = ?, gender = ?, birth_day = ?, birth_month = ?, hostel = ?, room_no = ?,
          course_id = ?, fellowship_id = ?, sub_ministry_id = ?, role_id = ?,
          phone = ?, email = ?, level = ?, status = ?, duplicate_flag = ?,
          duplicate_notes = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `
  ).run(
    payload.fullName,
    payload.gender || null,
    payload.birthDay,
    payload.birthMonth,
    payload.hostel || null,
    payload.roomNo || null,
    payload.courseId,
    payload.fellowshipId,
    payload.subMinistryIds.length === 1 ? payload.subMinistryIds[0] : null,
    payload.roleId,
    payload.phone || null,
    payload.email || null,
    payload.level || null,
    payload.status,
    duplicates.length ? 1 : 0,
    duplicateNotes,
    existingMember.id
  );

  setMemberSubMinistries(existingMember.id, payload.subMinistryIds);

  logAudit(
    null,
    "member_updated",
    "member",
    existingMember.id,
    duplicateNotes
  );
  setFlash(req, "success", "Member record updated.");
  return res.redirect(`/members/${existingMember.id}`);
});

app.get("/fellowships", requireAuth, (_req, res) => {
  const currentWeekStart = getWeekStart();
  const attendanceByFellowship = new Map(
    getAttendanceSummaryForWeek(currentWeekStart).map((item) => [Number(item.id), item])
  );
  const fellowships = db
    .prepare("SELECT id, name, slug FROM fellowships ORDER BY name")
    .all()
    .map((fellowship) => ({
      ...fellowship,
      attendance: attendanceByFellowship.get(Number(fellowship.id)) || null,
      memberCount: db
        .prepare("SELECT COUNT(*) AS count FROM members WHERE fellowship_id = ? AND archived_at IS NULL")
        .get(fellowship.id).count,
    }));

  res.render("pages/fellowships", {
    pageTitle: "Fellowships",
    fellowships,
  });
});

app.get("/fellowships/:slug", requireAuth, (req, res) => {
  const fellowship = db
    .prepare("SELECT id, name, slug FROM fellowships WHERE slug = ?")
    .get(req.params.slug);
  if (!fellowship) {
    return res.status(404).render("pages/not-found", {
      pageTitle: "Fellowship Not Found",
      currentUser: req.currentUser || res.locals.currentUser || null,
      currentPath: req.path,
      csrfToken: res.locals.csrfToken || "",
    });

    app.get("/leadership", requireAuth, (req, res) => {
      const search = String(req.query.search || "").trim().toLowerCase();
      const leaders = db
        .prepare(
          `
            SELECT members.id, members.full_name, roles.display_name AS role_name, roles.role_type,
                   COALESCE(fellowships.name, 'No Fellowship') AS fellowship_name,
                   fellowships.slug AS fellowship_slug
            FROM members
            JOIN roles ON roles.id = members.role_id
            LEFT JOIN fellowships ON fellowships.id = members.fellowship_id
            WHERE members.archived_at IS NULL
              AND roles.role_type IN ('Executive','Rep','Director')
            ORDER BY fellowship_name, roles.role_type, role_name, members.full_name
          `
        )
        .all()
        .filter((row) => !search || row.full_name.toLowerCase().includes(search) || row.role_name.toLowerCase().includes(search));

      res.render("pages/leadership", {
        pageTitle: "Leadership Directory",
        leaders,
        search,
      });
    });
  }

  const members = db
    .prepare(
      `
        SELECT members.*, courses.name AS course_name, sub_ministries.name AS sub_ministry_name,
               roles.display_name AS role_name, roles.role_type
        FROM members
        LEFT JOIN courses ON courses.id = members.course_id
        LEFT JOIN sub_ministries ON sub_ministries.id = members.sub_ministry_id
        LEFT JOIN roles ON roles.id = members.role_id
        WHERE members.fellowship_id = ?
          AND members.archived_at IS NULL
        ORDER BY
          CASE roles.role_type
            WHEN 'Executive' THEN 0
            WHEN 'Director' THEN 1
            WHEN 'Rep' THEN 2
            ELSE 3
          END,
          members.full_name
      `
    )
    .all(fellowship.id);

  const leaders = {
    executives: members.filter((member) => member.role_type === "Executive"),
    directors: members.filter((member) => member.role_type === "Director"),
    reps: members.filter((member) => member.role_type === "Rep"),
  };

  const fellowshipSubMinistryRows = db
    .prepare(
      `
        SELECT sub_ministries.name, COUNT(*) AS count
        FROM member_sub_ministries
        JOIN sub_ministries ON sub_ministries.id = member_sub_ministries.sub_ministry_id
        JOIN members ON members.id = member_sub_ministries.member_id
        WHERE members.fellowship_id = ?
          AND members.archived_at IS NULL
        GROUP BY sub_ministries.id, sub_ministries.name

        UNION ALL

        SELECT sub_ministries.name, COUNT(*) AS count
        FROM members
        JOIN sub_ministries ON sub_ministries.id = members.sub_ministry_id
        WHERE members.fellowship_id = ?
          AND members.archived_at IS NULL
          AND members.sub_ministry_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM member_sub_ministries WHERE member_sub_ministries.member_id = members.id
          )
        GROUP BY sub_ministries.id, sub_ministries.name
      `
    )
    .all(fellowship.id, fellowship.id);

  const subMinistryCounts = new Map(
    fellowshipSubMinistryRows.map((row) => [row.name, Number(row.count)])
  );

  const stats = {
    totalMembers: members.length,
    maleMembers: members.filter((member) => member.gender === "Male").length,
    femaleMembers: members.filter((member) => member.gender === "Female").length,
    unspecifiedGenderMembers: members.filter((member) => member.gender !== "Male" && member.gender !== "Female").length,
    choirMembers: subMinistryCounts.get("Aloud Choir") || 0,
    creativeMembers: subMinistryCounts.get("Aloud Creative") || 0,
    eyeMembers: subMinistryCounts.get("The Eye") || 0,
    taf01Members: subMinistryCounts.get("TAF 01") || 0,
  };

  const currentWeekStart = getWeekStart();
  const currentWeekEnd = getWeekEnd(currentWeekStart);
  const attendanceHeadline = getAttendanceSummaryForWeek(currentWeekStart).find(
    (item) => Number(item.id) === Number(fellowship.id)
  );

  const trend = db
    .prepare(
      `
        SELECT attendance_sessions.week_start, attendance_sessions.week_end,
               COALESCE(SUM(CASE WHEN attendance_records.present = 1 THEN 1 ELSE 0 END), 0) AS present_total
        FROM attendance_sessions
        LEFT JOIN attendance_records
          ON attendance_records.attendance_session_id = attendance_sessions.id
        WHERE attendance_sessions.fellowship_id = ?
        GROUP BY attendance_sessions.id, attendance_sessions.week_start, attendance_sessions.week_end
        ORDER BY attendance_sessions.week_start DESC
        LIMIT 10
      `
    )
    .all(fellowship.id)
    .map((row) => ({
      ...row,
      label: getWeekLabel(row.week_start, row.week_end),
      percentage: stats.totalMembers
        ? Math.round((row.present_total / stats.totalMembers) * 100)
        : 0,
    }));
  const goingQuietMembers = getGoingQuietMembers({
    minStreak: 3,
    fellowshipId: fellowship.id,
  });
  const awayThisWeek = getLatestAwayListForFellowship(fellowship.id);

  res.render("pages/fellowship", {
    pageTitle: fellowship.name,
    fellowship,
    members,
    leaders,
    stats,
    currentWeekStart,
    currentWeekEnd,
    attendanceHeadline,
    trend,
    goingQuietMembers,
    awayThisWeek,
    weekLabel: getWeekLabel,
    canManage: canManageFellowship(req.currentUser, fellowship.id),
  });
});

app.get(
  "/fellowships/:slug/away-this-week",
  requireAuth,
  requireManagerForFellowship,
  (req, res) => {
    const fellowship = db
      .prepare("SELECT id, name, slug FROM fellowships WHERE slug = ?")
      .get(req.params.slug);

    const awayThisWeek = getLatestAwayListForFellowship(fellowship.id);

    res.render("pages/away-this-week", {
      pageTitle: `${fellowship.name} Away This Week`,
      fellowship,
      session: awayThisWeek.session,
      absentMembers: awayThisWeek.absentMembers,
      weekLabel: getWeekLabel,
    });
  }
);

app.get(
  "/fellowships/:slug/away-this-week/print",
  requireAuth,
  requireManagerForFellowship,
  (req, res) => {
    const fellowship = db
      .prepare("SELECT id, name, slug FROM fellowships WHERE slug = ?")
      .get(req.params.slug);
    const awayThisWeek = getLatestAwayListForFellowship(fellowship.id);

    res.render("pages/away-this-week-print", {
      pageTitle: `${fellowship.name} Away This Week (Print)`,
      fellowship,
      session: awayThisWeek.session,
      absentMembers: awayThisWeek.absentMembers,
      weekLabel: getWeekLabel,
      generatedAt: new Date().toISOString(),
    });
  }
);

app.get(
  "/fellowships/:slug/attendance",
  requireAuth,
  requireManagerForFellowship,
  (req, res) => {
    const fellowship = db
      .prepare("SELECT id, name, slug FROM fellowships WHERE slug = ?")
      .get(req.params.slug);
    const weekStart = getWeekStart(String(req.query.weekStart || ""));
    const weekEnd = getWeekEnd(weekStart);
    const terms = db.prepare("SELECT id, label, start_date, end_date FROM terms ORDER BY start_date DESC").all();
    const selectedTermId = req.query.termId ? Number(req.query.termId) : null;
    const selectedTerm = selectedTermId
      ? terms.find((term) => Number(term.id) === selectedTermId) || null
      : null;

    const members = db
      .prepare(
        `
          SELECT id, full_name, role_id
          FROM members
          WHERE fellowship_id = ?
            AND status = 'Active'
          ORDER BY full_name
        `
      )
      .all(fellowship.id);

    const sessionRow = db
      .prepare(
        `
          SELECT id FROM attendance_sessions
          WHERE fellowship_id = ? AND week_start = ?
        `
      )
      .get(fellowship.id, weekStart);

    const markedLookup = new Map();
    if (sessionRow) {
      db.prepare(
        `
          SELECT member_id, present
          FROM attendance_records
          WHERE attendance_session_id = ?
        `
      )
        .all(sessionRow.id)
        .forEach((record) => {
          markedLookup.set(record.member_id, Boolean(record.present));
        });
    }

    const historyQuery = selectedTerm
      ? `
          SELECT attendance_sessions.week_start, attendance_sessions.week_end,
                 COALESCE(SUM(CASE WHEN attendance_records.present = 1 THEN 1 ELSE 0 END), 0) AS present_total
          FROM attendance_sessions
          LEFT JOIN attendance_records
            ON attendance_records.attendance_session_id = attendance_sessions.id
          WHERE attendance_sessions.fellowship_id = ?
            AND attendance_sessions.week_start >= ?
            AND attendance_sessions.week_start <= ?
          GROUP BY attendance_sessions.id, attendance_sessions.week_start, attendance_sessions.week_end
          ORDER BY attendance_sessions.week_start DESC
          LIMIT 12
        `
      : `
          SELECT attendance_sessions.week_start, attendance_sessions.week_end,
                 COALESCE(SUM(CASE WHEN attendance_records.present = 1 THEN 1 ELSE 0 END), 0) AS present_total
          FROM attendance_sessions
          LEFT JOIN attendance_records
            ON attendance_records.attendance_session_id = attendance_sessions.id
          WHERE attendance_sessions.fellowship_id = ?
          GROUP BY attendance_sessions.id, attendance_sessions.week_start, attendance_sessions.week_end
          ORDER BY attendance_sessions.week_start DESC
          LIMIT 12
        `;

    const history = db
      .prepare(historyQuery)
      .all(...(selectedTerm ? [fellowship.id, selectedTerm.start_date, selectedTerm.end_date] : [fellowship.id]))
      .map((row) => ({
        ...row,
        label: getWeekLabel(row.week_start, row.week_end),
        percentage: members.length
          ? Math.round((row.present_total / members.length) * 100)
          : 0,
      }));

    res.render("pages/attendance", {
      pageTitle: `${fellowship.name} Attendance`,
      fellowship,
      members,
      markedLookup,
      weekStart,
      weekEnd,
      weekLabel: getWeekLabel(weekStart, weekEnd),
      history,
      terms,
      selectedTermId,
    });
  }
);

app.post(
  "/fellowships/:slug/attendance",
  requireAuth,
  requireManagerForFellowship,
  (req, res) => {
    const fellowship = db
      .prepare("SELECT id, name, slug FROM fellowships WHERE slug = ?")
      .get(req.params.slug);
    const weekStart = getWeekStart(String(req.body.weekStart || ""));
    const weekEnd = getWeekEnd(weekStart);
    const selectedIds = new Set(
      Array.isArray(req.body.presentMemberIds)
        ? req.body.presentMemberIds.map((id) => Number(id))
        : req.body.presentMemberIds
        ? [Number(req.body.presentMemberIds)]
        : []
    );

    app.get("/terms", requireAuth, (req, res) => {
      const terms = db
        .prepare("SELECT id, label, start_date, end_date, created_at FROM terms ORDER BY start_date DESC")
        .all();
      res.render("pages/terms", {
        pageTitle: "Terms",
        terms,
        csrfToken: res.locals.csrfToken,
      });
    });

    app.post("/terms", requireAuth, (req, res) => {
      const label = String(req.body.label || "").trim();
      const startDate = String(req.body.startDate || "").trim();
      const endDate = String(req.body.endDate || "").trim();
      if (!label || !startDate || !endDate || endDate < startDate) {
        setFlash(req, "error", "Enter a valid term label, start date, and end date.");
        return res.redirect("/terms");
      }

      db.prepare(
        "INSERT INTO terms (label, start_date, end_date) VALUES (?, ?, ?)"
      ).run(label, startDate, endDate);
      logAudit(null, "term_created", "term", null, label);
      setFlash(req, "success", `Term ${label} added.`);
      return res.redirect("/terms");
    });

    const activeMembers = db
      .prepare(
        `
          SELECT id
          FROM members
          WHERE fellowship_id = ?
            AND status = 'Active'
        `
      )
      .all(fellowship.id);

    const transaction = db.transaction(() => {
      db.prepare(
        `
          INSERT INTO attendance_sessions (fellowship_id, week_start, week_end, recorded_by_user_id)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(fellowship_id, week_start)
          DO UPDATE SET
            week_end = excluded.week_end,
            recorded_by_user_id = excluded.recorded_by_user_id,
            updated_at = CURRENT_TIMESTAMP
        `
      ).run(fellowship.id, weekStart, weekEnd, req.currentUser.actorId);

      const sessionRow = db
        .prepare(
          `
            SELECT id FROM attendance_sessions
            WHERE fellowship_id = ? AND week_start = ?
          `
        )
        .get(fellowship.id, weekStart);

      const upsertRecord = db.prepare(
        `
          INSERT INTO attendance_records (attendance_session_id, member_id, present)
          VALUES (?, ?, ?)
          ON CONFLICT(attendance_session_id, member_id)
          DO UPDATE SET
            present = excluded.present,
            marked_at = CURRENT_TIMESTAMP
        `
      );

      activeMembers.forEach((member) => {
        upsertRecord.run(sessionRow.id, member.id, selectedIds.has(member.id) ? 1 : 0);
      });
    });

    transaction();
    logAudit(
      null,
      "attendance_updated",
      "attendance_session",
      null,
      `${fellowship.name} ${weekStart}`
    );
    setFlash(req, "success", `Attendance saved for ${fellowship.name} (${weekStart}).`);
    return res.redirect(`/fellowships/${fellowship.slug}/attendance?weekStart=${weekStart}`);
  }
);

app.get("/exports/members.csv", requireAuth, (req, res) => {
  const filters = {
    search: String(req.query.search || "").trim(),
    fellowshipId: req.query.fellowshipId ? Number(req.query.fellowshipId) : null,
    subMinistryId: req.query.subMinistryId ? Number(req.query.subMinistryId) : null,
    roleId: req.query.roleId ? Number(req.query.roleId) : null,
    gender: String(req.query.gender || "").trim(),
    courseId: req.query.courseId ? Number(req.query.courseId) : null,
    level: String(req.query.level || "").trim(),
    hostel: String(req.query.hostel || "").trim(),
    status: String(req.query.status || "").trim(),
    duplicateOnly: req.query.duplicateOnly === "1",
    includeArchived: req.query.includeArchived === "1",
  };

  const { sql, params } = buildMembersQuery(filters);
  const members = db.prepare(sql).all(...params);
  logAudit(null, "members_exported_csv", "export", null, JSON.stringify(filters));
  const header = [
    "Full Name",
    "Gender",
    "Birthday",
    "Hostel",
    "Course",
    "Love Fellowship",
    "Sub-ministry",
    "Role",
    "Phone",
    "Email",
    "Level",
    "Status",
    "Joined At",
  ];
  const rows = members.map((member) => [
    member.full_name,
    member.gender,
    formatBirthdayForExport(member.birth_day, member.birth_month),
    member.hostel,
    member.course_name,
    member.fellowship_name,
    member.sub_ministry_name || "None",
    member.role_name || "Regular Member",
    member.phone,
    member.email,
    member.level,
    member.status,
    member.joined_at,
  ]);

  const escapeCell = (value) =>
    `"${String(value ?? "").replaceAll('"', '""')}"`;
  const csv = [header, ...rows].map((row) => row.map(escapeCell).join(",")).join("\n");

  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", 'attachment; filename="teens-aloud-members.csv"');
  return res.send(csv);
});

app.get("/exports/members.xlsx", requireAuth, async (req, res, next) => {
  try {
    const filters = {
      search: String(req.query.search || "").trim(),
      fellowshipId: req.query.fellowshipId ? Number(req.query.fellowshipId) : null,
      subMinistryId: req.query.subMinistryId ? Number(req.query.subMinistryId) : null,
      roleId: req.query.roleId ? Number(req.query.roleId) : null,
      gender: String(req.query.gender || "").trim(),
      courseId: req.query.courseId ? Number(req.query.courseId) : null,
      level: String(req.query.level || "").trim(),
      hostel: String(req.query.hostel || "").trim(),
      status: String(req.query.status || "").trim(),
      duplicateOnly: req.query.duplicateOnly === "1",
      includeArchived: req.query.includeArchived === "1",
    };

    const { sql, params } = buildMembersQuery(filters);
    const members = db.prepare(sql).all(...params);
    logAudit(null, "members_exported_xlsx", "export", null, JSON.stringify(filters));

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Members");
    sheet.columns = [
      { header: "Full Name", key: "full_name", width: 28 },
      { header: "Gender", key: "gender", width: 12 },
      { header: "Birthday", key: "birthday", width: 14 },
      { header: "Hostel", key: "hostel", width: 20 },
      { header: "Course", key: "course_name", width: 32 },
      { header: "Love Fellowship", key: "fellowship_name", width: 28 },
      { header: "Sub-ministry", key: "sub_ministry_name", width: 18 },
      { header: "Role", key: "role_name", width: 24 },
      { header: "Phone", key: "phone", width: 18 },
      { header: "Email", key: "email", width: 26 },
      { header: "Level", key: "level", width: 10 },
      { header: "Status", key: "status", width: 12 },
      { header: "Joined At", key: "joined_at", width: 22 },
    ];

    members.forEach((member) => {
      sheet.addRow({
        ...member,
        birthday: formatBirthdayForExport(member.birth_day, member.birth_month),
        sub_ministry_name: member.sub_ministry_name || "None",
        role_name: member.role_name || "Regular Member",
      });

      app.get("/fellowships/:slug/register-print", requireAuth, requireManagerForFellowship, (req, res) => {
        const fellowship = db
          .prepare("SELECT id, name, slug FROM fellowships WHERE slug = ?")
          .get(req.params.slug);
        const members = db
          .prepare(
            `
              SELECT full_name, hostel, room_no
              FROM members
              WHERE fellowship_id = ? AND archived_at IS NULL
              ORDER BY full_name
            `
          )
          .all(fellowship.id);
        const weekColumns = Array.from({ length: 8 }, (_, index) => `Week ${index + 1}`);
        res.render("pages/register-print", {
          pageTitle: `${fellowship.name} Register`,
          fellowship,
          members,
          weekColumns,
        });
      });

      app.post("/courses/:id/duration", requireAuth, (req, res) => {
        const years = Number(req.body.durationYears);
        if (!Number.isFinite(years) || years < 1 || years > 8) {
          setFlash(req, "error", "Course duration must be between 1 and 8 years.");
          return res.redirect("/settings");
        }
        db.prepare("UPDATE courses SET duration_years = ? WHERE id = ?").run(years, Number(req.params.id));
        setFlash(req, "success", "Course duration updated.");
        return res.redirect("/settings");
      });

      app.get("/members/promotions/preview", requireAuth, (req, res) => {
        const members = db
          .prepare(
            `
              SELECT members.id, members.full_name, members.level, courses.id AS course_id,
                     courses.name AS course_name, courses.duration_years
              FROM members
              LEFT JOIN courses ON courses.id = members.course_id
              WHERE members.archived_at IS NULL
              ORDER BY members.full_name
            `
          )
          .all();

        const promotable = [];
        const flagged = [];
        members.forEach((member) => {
          const currentLevel = Number(member.level);
          if (!Number.isFinite(currentLevel) || currentLevel < 100) {
            flagged.push({ ...member, reason: "Missing or invalid current level" });
            return;
          }
          if (!member.duration_years) {
            flagged.push({ ...member, reason: "Course duration not set" });
            return;
          }
          const terminalLevel = Number(member.duration_years) * 100;
          if (currentLevel >= terminalLevel) {
            flagged.push({ ...member, reason: `At terminal level ${terminalLevel}` });
            return;
          }
          promotable.push({ ...member, nextLevel: currentLevel + 100 });
        });

        res.render("pages/promotion-preview", {
          pageTitle: "Annual Level Promotion Preview",
          promotable,
          flagged,
          csrfToken: res.locals.csrfToken,
        });
      });

      app.post("/members/promotions/apply", requireAuth, (req, res) => {
        const promotions = db
          .prepare(
            `
              SELECT members.id, members.level, courses.duration_years
              FROM members
              LEFT JOIN courses ON courses.id = members.course_id
              WHERE members.archived_at IS NULL
            `
          )
          .all();

        const update = db.prepare("UPDATE members SET level = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?");
        let promotedCount = 0;
        db.transaction(() => {
          promotions.forEach((member) => {
            const level = Number(member.level);
            if (!Number.isFinite(level) || !member.duration_years) {
              return;
            }
            const terminal = Number(member.duration_years) * 100;
            if (level < terminal) {
              update.run(level + 100, member.id);
              promotedCount += 1;
            }
          });
        })();

        logAudit(null, "annual_promotion_applied", "member", null, `promoted=${promotedCount}`);
        setFlash(req, "success", `Annual promotion applied to ${promotedCount} member(s).`);
        return res.redirect("/members/promotions/preview");
      });

      app.get("/settings/backup/download", requireAuth, (req, res) => {
        const now = new Date().toISOString().replace(/[:.]/g, "-");
        const backupDir = path.join(__dirname, "..", "db-backups");
        if (!fs.existsSync(backupDir)) {
          fs.mkdirSync(backupDir, { recursive: true });
        }
        const backupPath = path.join(backupDir, `manual-backup-${now}.db`);
        db.pragma("wal_checkpoint(FULL)");
        fs.copyFileSync(path.resolve(process.env.DATABASE_PATH || "./data/teens-aloud.db"), backupPath);
        logAudit(null, "backup_downloaded", "backup", null, backupPath);
        return res.download(backupPath, `teens-aloud-backup-${now}.db`);
      });
    });

    sheet.getRow(1).font = { bold: true };
    const buffer = await workbook.xlsx.writeBuffer();

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="teens-aloud-members.xlsx"'
    );
    return res.send(Buffer.from(buffer));
  } catch (error) {
    return next(error);
  }
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.use((req, res) => {
  res.status(404).render("pages/not-found", {
    pageTitle: "Not Found",
    currentUser: req.currentUser || res.locals.currentUser || null,
    currentPath: req.path,
    csrfToken: res.locals.csrfToken || "",
  });
});

app.use((error, req, res, _next) => {
  console.error(error);
  setFlash(req, "error", "Something went wrong while processing your request.");
  res.status(500).render("pages/error", {
    pageTitle: "Server Error",
    currentUser: req.currentUser || res.locals.currentUser || null,
    currentPath: req.path,
    csrfToken: res.locals.csrfToken || "",
  });
});

app.listen(PORT, HOST, () => {
  const networkUrls = Object.values(os.networkInterfaces())
    .flat()
    .filter((detail) => detail && detail.family === "IPv4" && !detail.internal)
    .map((detail) => `http://${detail.address}:${PORT}`);

  console.log(`Teens Aloud Foundation app running on http://localhost:${PORT}`);
  console.log(`Public binding enabled on ${HOST}:${PORT}`);
  if (networkUrls.length > 0) {
    console.log(`Reach it on your network via: ${networkUrls.join(", ")}`);
  }
});
