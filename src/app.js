const os = require("node:os");
const path = require("node:path");
const bcrypt = require("bcryptjs");
const ExcelJS = require("exceljs");
const express = require("express");
const session = require("express-session");
const {
  APPROVAL_STATUSES,
  GENDER_OPTIONS,
  LOVE_FELLOWSHIPS,
  MEMBER_STATUSES,
  MONTHS,
  STUDY_LEVELS,
} = require("./constants");
const { db, initializeDatabase } = require("./database");

initializeDatabase();

const app = express();
const isProduction = process.env.NODE_ENV === "production";
const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_REGISTRATION_ONLY = process.env.PUBLIC_REGISTRATION_ONLY === "true";

app.set("trust proxy", true);

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "..", "views"));
app.use(express.urlencoded({ extended: true }));
app.use(
  session({
    secret: process.env.SESSION_SECRET || "teens-aloud-session-secret",
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
app.use(express.static(path.join(__dirname, "..", "public")));

app.locals.months = MONTHS;

app.use((req, res, next) => {
  const user = req.session.userId
    ? db
        .prepare(
          `
            SELECT users.*, fellowships.name AS fellowship_name, fellowships.slug AS fellowship_slug
            FROM users
            LEFT JOIN fellowships ON fellowships.id = users.fellowship_id
            WHERE users.id = ?
          `
        )
        .get(req.session.userId)
    : null;

  const fellowships = db
    .prepare("SELECT id, name, slug FROM fellowships ORDER BY name")
    .all();
  const courses = db.prepare("SELECT id, name FROM courses ORDER BY name").all();
  const subMinistries = db
    .prepare("SELECT id, name FROM sub_ministries ORDER BY name")
    .all();
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

  const roleCatalogByFellowship = fellowships.reduce((catalog, fellowship) => {
    const fellowshipRoles = roles.filter(
      (role) =>
        role.scope_type === "fellowship" && role.fellowship_id === fellowship.id
    );
    const globalRoles = roles.filter((role) => role.scope_type !== "fellowship");
    catalog[fellowship.id] = [...fellowshipRoles, ...globalRoles];
    return catalog;
  }, {});

  res.locals.currentUser = user;
  res.locals.fellowships = fellowships;
  res.locals.courses = courses;
  res.locals.subMinistries = subMinistries;
  res.locals.allRoles = roles;
  res.locals.memberStatuses = MEMBER_STATUSES;
  res.locals.genderOptions = GENDER_OPTIONS;
  res.locals.studyLevels = STUDY_LEVELS;
  res.locals.roleCatalogByFellowship = roleCatalogByFellowship;
  res.locals.approvalStatuses = APPROVAL_STATUSES;
  res.locals.flash = req.session.flash || null;
  res.locals.formatBirthday = (day, month) => `${MONTHS[month - 1]} ${day}`;
  res.locals.formatDate = (value) =>
    value
      ? new Intl.DateTimeFormat("en-GB", {
          day: "2-digit",
          month: "short",
          year: "numeric",
        }).format(new Date(value))
      : "—";
  res.locals.isManager =
    user && (user.access_role === "super_admin" || user.access_role === "fellowship_admin");
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

function isLocalIp(ipAddress) {
  if (!ipAddress) {
    return false;
  }

  const normalized = ipAddress.replace(/^::ffff:/, "");
  if (normalized === "::1" || normalized === "127.0.0.1" || normalized === "localhost") {
    return true;
  }

  if (normalized.startsWith("10.") || normalized.startsWith("192.168.")) {
    return true;
  }

  if (normalized.startsWith("172.")) {
    const secondOctet = Number(normalized.split(".")[1]);
    return secondOctet >= 16 && secondOctet <= 31;
  }

  return false;
}

function isExternalRestrictedRequest(req) {
  if (!PUBLIC_REGISTRATION_ONLY) {
    return false;
  }

  if (req.path === "/" || req.path === "/register" || req.path === "/health") {
    return false;
  }

  return !isLocalIp(req.ip);
}

function requireAuth(req, res, next) {
  if (!req.currentUser) {
    setFlash(req, "warning", "Please sign in to access the member database.");
    return res.redirect("/login");
  }
  return next();
}

app.use((req, res, next) => {
  if (isExternalRestrictedRequest(req)) {
    return res.status(403).render("pages/forbidden", {
      pageTitle: "Registration Only",
      message:
        "This shared public link is limited to member registration. Please contact an admin for record access.",
    });
  }

  return next();
});

function isSuperAdmin(user) {
  return user && user.access_role === "super_admin";
}

function canManageFellowship(user, fellowshipId) {
  return Boolean(
    user &&
      (user.access_role === "super_admin" ||
        (user.access_role === "fellowship_admin" &&
          Number(user.fellowship_id) === Number(fellowshipId)))
  );
}

function requireManagerForFellowship(req, res, next) {
  if (!req.currentUser) {
    return res.redirect("/login");
  }

  const fellowship = db
    .prepare("SELECT id FROM fellowships WHERE slug = ?")
    .get(req.params.slug);
  if (!fellowship) {
    return res.status(404).render("pages/not-found", { pageTitle: "Not Found" });
  }

  if (!canManageFellowship(req.currentUser, fellowship.id)) {
    setFlash(req, "error", "You do not have access to manage that fellowship.");
    return res.redirect(`/fellowships/${req.params.slug}`);
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
               fellowships.name AS fellowship_name
        FROM members
        JOIN fellowships ON fellowships.id = members.fellowship_id
        WHERE members.approval_status = 'approved'
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
               fellowships.name AS fellowship_name
        FROM members
        JOIN fellowships ON fellowships.id = members.fellowship_id
        WHERE members.approval_status = 'approved'
          AND members.birth_month = ?
        ORDER BY members.birth_day, members.full_name
      `
    )
    .all(month);
}

function detectDuplicateMembers({ fullName, email, phone, memberId }) {
  const conditions = [];
  const params = [];

  if (fullName) {
    conditions.push("LOWER(TRIM(full_name)) = LOWER(TRIM(?))");
    params.push(fullName);
  }
  if (email) {
    conditions.push("LOWER(TRIM(email)) = LOWER(TRIM(?))");
    params.push(email);
  }
  if (phone) {
    conditions.push("REPLACE(phone, ' ', '') = REPLACE(?, ' ', '')");
    params.push(phone);
  }

  if (conditions.length === 0) {
    return [];
  }

  let query = `
    SELECT id, full_name, phone, email
    FROM members
    WHERE (${conditions.join(" OR ")})
  `;

  if (memberId) {
    query += " AND id != ?";
    params.push(memberId);
  }

  return db.prepare(query).all(...params);
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

function parseMemberPayload(body) {
  return {
    fullName: String(body.fullName || "").trim(),
    gender: String(body.gender || "").trim(),
    birthDay: Number(body.birthDay),
    birthMonth: Number(body.birthMonth),
    hostel: String(body.hostel || "").trim(),
    courseId: Number(body.courseId),
    fellowshipId: Number(body.fellowshipId),
    subMinistryId: body.subMinistryId ? Number(body.subMinistryId) : null,
    roleId: body.roleId ? Number(body.roleId) : null,
    phone: String(body.phone || "").trim(),
    email: String(body.email || "").trim(),
    level: String(body.level || "").trim(),
    status: String(body.status || "Active").trim(),
  };
}

function validateMemberPayload(payload) {
  if (
    !payload.fullName ||
    !payload.gender ||
    !payload.birthDay ||
    !payload.birthMonth ||
    !payload.hostel ||
    !payload.courseId ||
    !payload.fellowshipId ||
    !payload.phone ||
    !payload.email ||
    !payload.level ||
    !payload.status
  ) {
    return "Please complete all required fields.";
  }

  if (payload.birthDay < 1 || payload.birthDay > 31) {
    return "Birth day must be between 1 and 31.";
  }

  if (payload.birthMonth < 1 || payload.birthMonth > 12) {
    return "Birth month must be between 1 and 12.";
  }

  if (!validateRoleForFellowship(payload.roleId, payload.fellowshipId)) {
    return "Selected role does not match the chosen Love Fellowship.";
  }

  return null;
}

function logAudit(userId, action, entityType, entityId, details) {
  db.prepare(
    `
      INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details)
      VALUES (?, ?, ?, ?, ?)
    `
  ).run(userId || null, action, entityType, entityId || null, details || null);
}

function buildMembersQuery(filters, currentUser) {
  const conditions = [];
  const params = [];

  if (currentUser && currentUser.access_role === "viewer") {
    conditions.push("members.approval_status = 'approved'");
  }

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
    conditions.push("members.sub_ministry_id = ?");
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

  if (filters.approvalStatus) {
    conditions.push("members.approval_status = ?");
    params.push(filters.approvalStatus);
  }

  if (filters.duplicateOnly) {
    conditions.push("members.duplicate_flag = 1");
  }

  if (currentUser && currentUser.access_role === "fellowship_admin") {
    conditions.push("members.fellowship_id = ?");
    params.push(currentUser.fellowship_id);
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const sql = `
    SELECT members.*,
           courses.name AS course_name,
           fellowships.name AS fellowship_name,
           fellowships.slug AS fellowship_slug,
           sub_ministries.name AS sub_ministry_name,
           roles.display_name AS role_name,
           roles.role_type
    FROM members
    JOIN courses ON courses.id = members.course_id
    JOIN fellowships ON fellowships.id = members.fellowship_id
    LEFT JOIN sub_ministries ON sub_ministries.id = members.sub_ministry_id
    LEFT JOIN roles ON roles.id = members.role_id
    ${whereClause}
    ORDER BY
      CASE members.approval_status
        WHEN 'pending' THEN 0
        WHEN 'approved' THEN 1
        ELSE 2
      END,
      members.full_name
  `;

  return { sql, params };
}

function getMemberWithDetails(memberId) {
  return db
    .prepare(
      `
        SELECT members.*,
               courses.name AS course_name,
               fellowships.name AS fellowship_name,
               fellowships.slug AS fellowship_slug,
               sub_ministries.name AS sub_ministry_name,
               roles.display_name AS role_name,
               roles.role_type
        FROM members
        JOIN courses ON courses.id = members.course_id
        JOIN fellowships ON fellowships.id = members.fellowship_id
        LEFT JOIN sub_ministries ON sub_ministries.id = members.sub_ministry_id
        LEFT JOIN roles ON roles.id = members.role_id
        WHERE members.id = ?
      `
    )
    .get(memberId);
}

function canManageMember(user, member) {
  return Boolean(member && user && canManageFellowship(user, member.fellowship_id));
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
         AND members.approval_status = 'approved'
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

app.get("/", (req, res) => {
  if (req.currentUser) {
    return res.redirect("/dashboard");
  }
  return res.redirect("/login");
});

app.get("/register", requireAuth, (req, res) => {
  res.render("pages/register", {
    pageTitle: "Member Registration",
    member: {
      full_name: "",
      gender: "",
      birth_day: "",
      birth_month: "",
      hostel: "",
      course_id: "",
      fellowship_id: "",
      sub_ministry_id: "",
      role_id: "",
      phone: "",
      email: "",
      level: "",
      status: "Active",
    },
  });
});

app.post("/register", requireAuth, (req, res) => {
  const payload = parseMemberPayload(req.body);
  const validationError = validateMemberPayload(payload);

  if (validationError) {
    setFlash(req, "error", validationError);
    return res.status(422).render("pages/register", {
      pageTitle: "Member Registration",
      member: {
        full_name: payload.fullName,
        gender: payload.gender,
        birth_day: payload.birthDay,
        birth_month: payload.birthMonth,
        hostel: payload.hostel,
        course_id: payload.courseId,
        fellowship_id: payload.fellowshipId,
        sub_ministry_id: payload.subMinistryId,
        role_id: payload.roleId,
        phone: payload.phone,
        email: payload.email,
        level: payload.level,
        status: payload.status,
      },
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
          full_name, gender, birth_day, birth_month, hostel,
          course_id, fellowship_id, sub_ministry_id, role_id,
          phone, email, level, status, approval_status,
          duplicate_flag, duplicate_notes
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
      `
    )
    .run(
      payload.fullName,
      payload.gender,
      payload.birthDay,
      payload.birthMonth,
      payload.hostel,
      payload.courseId,
      payload.fellowshipId,
      payload.subMinistryId,
      payload.roleId,
      payload.phone,
      payload.email,
      payload.level,
      payload.status,
      duplicates.length ? 1 : 0,
      duplicateNotes
    );

  logAudit(null, "member_registered", "member", result.lastInsertRowid, duplicateNotes);
  setFlash(
    req,
    duplicates.length ? "warning" : "success",
    duplicates.length
      ? "Registration saved for review and flagged as a possible duplicate."
      : "Registration submitted successfully. An admin will approve it before it appears in the directory."
  );
  return res.redirect("/register");
});

app.get("/login", (req, res) => {
  res.render("pages/login", { pageTitle: "Login" });
});

app.post("/login", (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  const user = db
    .prepare("SELECT * FROM users WHERE LOWER(email) = ?")
    .get(email);

  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    setFlash(req, "error", "Invalid email or password.");
    return res.redirect("/login");
  }

  req.session.userId = user.id;
  setFlash(req, "success", `Welcome back, ${user.full_name}.`);
  return res.redirect("/dashboard");
});

app.post("/logout", requireAuth, (req, res) => {
  req.session.destroy(() => {
    res.redirect("/login");
  });
});

app.get("/dashboard", requireAuth, (req, res) => {
  const currentWeekStart = getWeekStart();
  const currentWeekEnd = getWeekEnd(currentWeekStart);
  const memberVisibilityCondition =
    req.currentUser.access_role === "fellowship_admin"
      ? "WHERE members.fellowship_id = ? AND members.approval_status = 'approved'"
      : "WHERE members.approval_status = 'approved'";
  const statsParams =
    req.currentUser.access_role === "fellowship_admin"
      ? [req.currentUser.fellowship_id]
      : [];

  const totalMembers = db
    .prepare(`SELECT COUNT(*) AS count FROM members ${memberVisibilityCondition}`)
    .get(...statsParams).count;

  const genderStats = db
    .prepare(
      `
        SELECT gender, COUNT(*) AS count
        FROM members
        ${memberVisibilityCondition}
        GROUP BY gender
        ORDER BY gender
      `
    )
    .all(...statsParams);

  const subMinistryStats = db
    .prepare(
      `
        SELECT COALESCE(sub_ministries.name, 'None') AS name, COUNT(*) AS count
        FROM members
        LEFT JOIN sub_ministries ON sub_ministries.id = members.sub_ministry_id
        ${memberVisibilityCondition}
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
         AND members.approval_status = 'approved'
        ${req.currentUser.access_role === "fellowship_admin" ? "WHERE fellowships.id = ?" : ""}
        GROUP BY fellowships.id, fellowships.name, fellowships.slug
        ORDER BY fellowships.name
      `
    )
    .all(...(req.currentUser.access_role === "fellowship_admin" ? [req.currentUser.fellowship_id] : []));

  const pendingApprovals =
    req.currentUser.access_role === "viewer"
      ? []
      : db
          .prepare(
            `
              SELECT members.id, members.full_name, members.duplicate_flag, fellowships.name AS fellowship_name
              FROM members
              JOIN fellowships ON fellowships.id = members.fellowship_id
              WHERE members.approval_status = 'pending'
              ${
                req.currentUser.access_role === "fellowship_admin"
                  ? "AND members.fellowship_id = ?"
                  : ""
              }
              ORDER BY members.created_at DESC
              LIMIT 8
            `
          )
          .all(
            ...(req.currentUser.access_role === "fellowship_admin"
              ? [req.currentUser.fellowship_id]
              : [])
          );

  const birthdaysThisWeek = getBirthdaysForWindow(6).filter((birthday) =>
    req.currentUser.access_role === "fellowship_admin"
      ? birthday.fellowship_name === req.currentUser.fellowship_name
      : true
  );
  const birthdaysThisMonth = getBirthdaysThisMonth().filter((birthday) =>
    req.currentUser.access_role === "fellowship_admin"
      ? birthday.fellowship_name === req.currentUser.fellowship_name
      : true
  );
  const attendanceSummary = getAttendanceSummaryForWeek(currentWeekStart).filter((item) =>
    req.currentUser.access_role === "fellowship_admin"
      ? Number(req.currentUser.fellowship_id) === Number(item.id)
      : true
  );

  res.render("pages/dashboard", {
    pageTitle: "Dashboard",
    currentWeekStart,
    currentWeekEnd,
    totalMembers,
    genderStats,
    subMinistryStats,
    fellowshipStats,
    pendingApprovals,
    birthdaysThisWeek,
    birthdaysThisMonth,
    attendanceSummary,
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
    approvalStatus: String(req.query.approvalStatus || "").trim(),
    duplicateOnly: req.query.duplicateOnly === "1",
  };

  const { sql, params } = buildMembersQuery(filters, req.currentUser);
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
      approvalStatus: filters.approvalStatus,
      duplicateOnly: filters.duplicateOnly ? "1" : "",
    }),
  });
});

app.get("/members/:id", requireAuth, (req, res) => {
  const member = getMemberWithDetails(Number(req.params.id));
  if (!member) {
    return res.status(404).render("pages/not-found", { pageTitle: "Member Not Found" });
  }

  if (req.currentUser.access_role === "viewer" && member.approval_status !== "approved") {
    return res.status(403).render("pages/forbidden", { pageTitle: "Access Denied" });
  }

  if (
    req.currentUser.access_role === "fellowship_admin" &&
    Number(req.currentUser.fellowship_id) !== Number(member.fellowship_id)
  ) {
    return res.status(403).render("pages/forbidden", { pageTitle: "Access Denied" });
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
        ORDER BY attendance_sessions.week_start DESC
        LIMIT 12
      `
    )
    .all(member.id, member.fellowship_id);

  const rate = attendanceStats.total_weeks
    ? Math.round((attendanceStats.attended_weeks / attendanceStats.total_weeks) * 100)
    : 0;

  res.render("pages/member-detail", {
    pageTitle: member.full_name,
    member,
    attendanceStats: {
      ...attendanceStats,
      missed_weeks: attendanceStats.total_weeks - attendanceStats.attended_weeks,
      rate,
    },
    attendanceHistory,
    canManage: canManageMember(req.currentUser, member),
    weekLabel: getWeekLabel,
  });
});

app.get("/members/:id/edit", requireAuth, (req, res) => {
  const member = getMemberWithDetails(Number(req.params.id));
  if (!member) {
    return res.status(404).render("pages/not-found", { pageTitle: "Member Not Found" });
  }

  if (!canManageMember(req.currentUser, member)) {
    return res.status(403).render("pages/forbidden", { pageTitle: "Access Denied" });
  }

  res.render("pages/edit-member", {
    pageTitle: `Edit ${member.full_name}`,
    member,
  });
});

app.post("/members/:id/edit", requireAuth, (req, res) => {
  const existingMember = getMemberWithDetails(Number(req.params.id));
  if (!existingMember) {
    return res.status(404).render("pages/not-found", { pageTitle: "Member Not Found" });
  }

  if (!canManageMember(req.currentUser, existingMember)) {
    return res.status(403).render("pages/forbidden", { pageTitle: "Access Denied" });
  }

  const payload = parseMemberPayload(req.body);
  const validationError = validateMemberPayload(payload);
  if (validationError) {
    setFlash(req, "error", validationError);
    return res.redirect(`/members/${existingMember.id}/edit`);
  }

  if (
    req.currentUser.access_role === "fellowship_admin" &&
    Number(payload.fellowshipId) !== Number(req.currentUser.fellowship_id)
  ) {
    setFlash(req, "error", "Fellowship admins can only manage members in their own fellowship.");
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
      SET full_name = ?, gender = ?, birth_day = ?, birth_month = ?, hostel = ?,
          course_id = ?, fellowship_id = ?, sub_ministry_id = ?, role_id = ?,
          phone = ?, email = ?, level = ?, status = ?, duplicate_flag = ?,
          duplicate_notes = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `
  ).run(
    payload.fullName,
    payload.gender,
    payload.birthDay,
    payload.birthMonth,
    payload.hostel,
    payload.courseId,
    payload.fellowshipId,
    payload.subMinistryId,
    payload.roleId,
    payload.phone,
    payload.email,
    payload.level,
    payload.status,
    duplicates.length ? 1 : 0,
    duplicateNotes,
    existingMember.id
  );

  logAudit(
    req.currentUser.id,
    "member_updated",
    "member",
    existingMember.id,
    duplicateNotes
  );
  setFlash(req, "success", "Member record updated.");
  return res.redirect(`/members/${existingMember.id}`);
});

app.post("/members/:id/approve", requireAuth, (req, res) => {
  const member = getMemberWithDetails(Number(req.params.id));
  if (!member) {
    return res.status(404).render("pages/not-found", { pageTitle: "Member Not Found" });
  }
  if (!canManageMember(req.currentUser, member)) {
    return res.status(403).render("pages/forbidden", { pageTitle: "Access Denied" });
  }

  db.prepare(
    `
      UPDATE members
      SET approval_status = 'approved', approved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `
  ).run(member.id);
  logAudit(req.currentUser.id, "member_approved", "member", member.id, null);
  setFlash(req, "success", `${member.full_name} has been approved.`);
  return res.redirect(req.get("referer") || "/members");
});

app.post("/members/:id/reject", requireAuth, (req, res) => {
  const member = getMemberWithDetails(Number(req.params.id));
  if (!member) {
    return res.status(404).render("pages/not-found", { pageTitle: "Member Not Found" });
  }
  if (!canManageMember(req.currentUser, member)) {
    return res.status(403).render("pages/forbidden", { pageTitle: "Access Denied" });
  }

  db.prepare(
    `
      UPDATE members
      SET approval_status = 'rejected', updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `
  ).run(member.id);
  logAudit(req.currentUser.id, "member_rejected", "member", member.id, null);
  setFlash(req, "warning", `${member.full_name} was marked as rejected.`);
  return res.redirect(req.get("referer") || "/members");
});

app.get("/fellowships/:slug", requireAuth, (req, res) => {
  const fellowship = db
    .prepare("SELECT id, name, slug FROM fellowships WHERE slug = ?")
    .get(req.params.slug);
  if (!fellowship) {
    return res.status(404).render("pages/not-found", { pageTitle: "Fellowship Not Found" });
  }

  if (
    req.currentUser.access_role === "fellowship_admin" &&
    Number(req.currentUser.fellowship_id) !== Number(fellowship.id)
  ) {
    return res.status(403).render("pages/forbidden", { pageTitle: "Access Denied" });
  }

  const members = db
    .prepare(
      `
        SELECT members.*, courses.name AS course_name, sub_ministries.name AS sub_ministry_name,
               roles.display_name AS role_name, roles.role_type
        FROM members
        JOIN courses ON courses.id = members.course_id
        LEFT JOIN sub_ministries ON sub_ministries.id = members.sub_ministry_id
        LEFT JOIN roles ON roles.id = members.role_id
        WHERE members.fellowship_id = ?
          AND members.approval_status = 'approved'
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

  const stats = {
    totalMembers: members.length,
    maleMembers: members.filter((member) => member.gender === "Male").length,
    femaleMembers: members.filter((member) => member.gender === "Female").length,
    choirMembers: members.filter(
      (member) => member.sub_ministry_name === "Aloud Choir"
    ).length,
    creativeMembers: members.filter(
      (member) => member.sub_ministry_name === "Aloud Creative"
    ).length,
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
    canManage: canManageFellowship(req.currentUser, fellowship.id),
  });
});

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

    const members = db
      .prepare(
        `
          SELECT id, full_name, role_id
          FROM members
          WHERE fellowship_id = ?
            AND approval_status = 'approved'
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

    const history = db
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
          LIMIT 12
        `
      )
      .all(fellowship.id)
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

    const activeMembers = db
      .prepare(
        `
          SELECT id
          FROM members
          WHERE fellowship_id = ?
            AND approval_status = 'approved'
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
      ).run(fellowship.id, weekStart, weekEnd, req.currentUser.id);

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
      req.currentUser.id,
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
    approvalStatus:
      req.currentUser.access_role === "viewer"
        ? "approved"
        : String(req.query.approvalStatus || "approved").trim(),
    duplicateOnly: req.query.duplicateOnly === "1",
  };

  const { sql, params } = buildMembersQuery(filters, req.currentUser);
  const members = db.prepare(sql).all(...params);
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
    "Approval Status",
    "Joined At",
  ];
  const rows = members.map((member) => [
    member.full_name,
    member.gender,
    `${member.birth_day}/${member.birth_month}`,
    member.hostel,
    member.course_name,
    member.fellowship_name,
    member.sub_ministry_name || "None",
    member.role_name || "Regular Member",
    member.phone,
    member.email,
    member.level,
    member.status,
    member.approval_status,
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
      approvalStatus:
        req.currentUser.access_role === "viewer"
          ? "approved"
          : String(req.query.approvalStatus || "approved").trim(),
      duplicateOnly: req.query.duplicateOnly === "1",
    };

    const { sql, params } = buildMembersQuery(filters, req.currentUser);
    const members = db.prepare(sql).all(...params);

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
      { header: "Approval Status", key: "approval_status", width: 16 },
      { header: "Joined At", key: "joined_at", width: 22 },
    ];

    members.forEach((member) => {
      sheet.addRow({
        ...member,
        birthday: `${member.birth_day}/${member.birth_month}`,
        sub_ministry_name: member.sub_ministry_name || "None",
        role_name: member.role_name || "Regular Member",
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
  res.json({ ok: true, publicRegistrationOnly: PUBLIC_REGISTRATION_ONLY });
});

app.use((req, res) => {
  res.status(404).render("pages/not-found", { pageTitle: "Not Found" });
});

app.use((error, req, res, _next) => {
  console.error(error);
  setFlash(req, "error", "Something went wrong while processing your request.");
  res.status(500).render("pages/error", { pageTitle: "Server Error" });
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
  if (PUBLIC_REGISTRATION_ONLY) {
    console.log("External public access is restricted to /register.");
  }
});
