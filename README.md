# Teens Aloud Foundation Member System

Server-rendered Express + SQLite application for:

- an admin-only member directory and dashboard
- fellowship pages and weekly attendance tracking, including a full present/absent history per member
- bulk import of a fellowship's real weekly attendance register (Excel), or a plain member-list CSV
- birthday and leadership summaries using day + month only
- CSV and Excel exports

## Stack

- Node.js
- Express
- EJS templates
- SQLite via `better-sqlite3`
- Session authentication via `express-session`
- Excel import/export via `exceljs`
- CSRF protection and login rate limiting

## Getting started

```bash
cp .env.example .env
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000). You'll be redirected straight to `/login`.

The app binds to `0.0.0.0` for local and hosted deployment. Every page other than `/login` and `/health` requires an authenticated session.

## Authentication

This app uses one shared password for the whole team:

- the login page only asks for that password
- anyone with the password gets full access to members, attendance, import, and export
- the password can be changed inside the app at `/account/change-password`

For safety, the password is stored as a bcrypt hash in the database after first boot. `SHARED_ACCESS_PASSWORD` is only used to initialize a fresh database, so changing the env var later does not overwrite an in-app password change. For older deployments that have not added `SHARED_ACCESS_PASSWORD` yet, the app will temporarily fall back to `SUPER_ADMIN_PASSWORD` during startup so the service can still boot while you migrate the env var name.

Because access is shared, audit logs still record what happened, but no longer identify which individual person performed the action.

## Production and hosting

This project is prepared for deployment on Render with a persistent disk and a stable public URL.

### Render deployment

1. Push this project to GitHub.
2. Create a new Render Web Service from the repo.
3. Ensure the service includes a persistent disk mounted at `/var/data`.
4. Set these environment variables:
   - `NODE_ENV=production`
   - `SESSION_SECRET=<a-long-random-secret>`
   - `SHARED_ACCESS_PASSWORD=<strong-shared-password>`
   - `DATABASE_PATH=/var/data/teens-aloud.db`
   - `DATA_DIR=/var/data`
5. Deploy.

The Render blueprint in this repo is configured to mount the database disk at `/var/data` and back up the SQLite file in a daily cron job. The app refuses to start in production if `SESSION_SECRET` is missing, or if neither `SHARED_ACCESS_PASSWORD` nor the legacy `SUPER_ADMIN_PASSWORD` is set.

## Main routes

All routes below require login except `/login` and `/health`.

- `/login` - shared-password login page
- `/dashboard` - dashboard with member, attendance, and birthday summaries
- `/members` - searchable member database
- `/members/new` - add a member manually
- `/members/import` - bulk import
- `/members/:id` - member profile, including full attendance history
- `/fellowships` - fellowship hub page
- `/fellowships/:slug` - fellowship-specific page
- `/fellowships/:slug/attendance` - weekly attendance capture
- `/exports/members.csv` / `/exports/members.xlsx` - exports

## Bulk import

`/members/import` supports two formats:

**1. A fellowship's real weekly attendance register (.xlsx)** — the kind of spreadsheet a fellowship already keeps: a header row with a `NAME` column, and optional `NUMBER`, `HOSTEL`, `ROOM NO.`, `BIRTHDAY` (DD/MM), `SUBMINISTRY`, and `YEAR` columns, followed by one numbered column per meeting week. Any mark in a week's column (e.g. `O` or `/`) counts as present for that week; a blank counts as absent. A week column that's entirely blank across every row is treated as "hasn't happened yet" and skipped.

When importing a register:

- Select the Love Fellowship the register belongs to and the calendar date of "Week 1."
- Members are matched to existing records in that fellowship by phone number first, then by fuzzy name match.
- A brand new member found in the register is created automatically.
- Missing fields (no course, no birthday, no phone, etc.) are simply left blank — only a name and fellowship are required.

**2. A plain member-list CSV** — one row per member, no attendance columns. Expected columns: full name, love fellowship, and optionally gender, birthday, hostel, course, phone, email, level, status.

## Notes

- There is no public registration page. Every member is added by an authenticated admin, either individually (`/members/new`) or in bulk (`/members/import`).
- Only a full name and a Love Fellowship are required on any member record — gender, birthday, hostel, room number, course, phone, email, and level are all optional.
- A member's profile page (`/members/:id`) shows their attendance history for their fellowship's most recent weeks, explicitly marking each week Present or Absent.
- Duplicate detection normalizes phone numbers and performs a fuzzy name check for likely duplicates when adding members individually.
- Protected pages and actions use CSRF protection and login rate limiting.
- Branding assets live in [public/images/](/Users/kade/Documents/projectt/public/images).
- The KNUST course list is seeded from [constants.js](/Users/kade/Documents/projectt/src/constants.js) and can be adjusted as the organization needs a fuller or updated program list.
