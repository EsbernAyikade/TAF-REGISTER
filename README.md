# Teens Aloud Foundation Member System

Server-rendered Express + SQLite application for:

- an admin-only member directory and dashboard — **there is no public or member-facing page**; every record is entered by an authenticated admin, one at a time or in bulk
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

Open [http://localhost:3000](http://localhost:3000). You'll be redirected straight to `/login` — there is no public landing page.

The app binds to `0.0.0.0` for local and hosted deployment. Every page other than `/login` and `/health` requires an authenticated session.

## Production and hosting

This project is prepared for deployment on Render with a persistent disk and a stable public URL.

### Render deployment

1. Push this project to GitHub.
2. Create a new Render Web Service from the repo.
3. Ensure the service includes a persistent disk mounted at `/var/data`.
4. Set these environment variables:
  - `NODE_ENV=production`
  - `SESSION_SECRET=<a-long-random-secret>`
  - `DEFAULT_USER_PASSWORD=<strong-admin-default>`
  - `SUPER_ADMIN_PASSWORD=<strong-super-admin-password>`
  - `FELLOWSHIP_ADMIN_PASSWORD=<strong-fellowship-admin-password>`
  - `VIEWER_PASSWORD=<strong-viewer-password>`
  - `DATABASE_PATH=/var/data/teens-aloud.db`
  - `DATA_DIR=/var/data`
5. Deploy.

The Render blueprint in this repo is configured to mount the database disk at `/var/data` and back up the SQLite file in a daily cron job. Every seeded account's password is **required** in production — the app refuses to start if any of `DEFAULT_USER_PASSWORD`/`SUPER_ADMIN_PASSWORD`, `FELLOWSHIP_ADMIN_PASSWORD`, or `VIEWER_PASSWORD` is missing.

### Custom domain

If you own a domain, connect it in your hosting provider's dashboard and point DNS to the deployed app. That part requires access to your domain registrar or DNS provider.

## Seeded accounts

Accounts:

- Super Admin: `admin@teensaloud.local`
- Fellowship Admin: `gaza.admin@teensaloud.local`
- Viewer: `viewer@teensaloud.local`

Every seeded account must change its password on first login. You can override the seed emails/passwords via:

- `SUPER_ADMIN_EMAIL`
- `SUPER_ADMIN_PASSWORD`
- `DEFAULT_USER_PASSWORD`
- `FELLOWSHIP_ADMIN_PASSWORD`
- `VIEWER_PASSWORD`
- `SESSION_SECRET`
- `HOST`
- `PORT`
- `NODE_ENV`
- `DATABASE_PATH`
- `DATA_DIR`

Important: `SESSION_SECRET` and all four password variables must be set in production or the app will refuse to start.

## Main routes

All routes below require login except `/login` and `/health`.

- `/login` - login page
- `/dashboard` - dashboard with member/attendance/birthday summaries
- `/members` - searchable member database
- `/members/new` - add a member manually
- `/members/import` - bulk import (weekly attendance register or plain CSV — see below)
- `/members/:id` - member profile, including full attendance history
- `/fellowships/:slug` - fellowship-specific page
- `/fellowships/:slug/attendance` - weekly attendance capture
- `/exports/members.csv` / `/exports/members.xlsx` - exports

## Bulk import

`/members/import` (super admin only) supports two formats:

**1. A fellowship's real weekly attendance register (.xlsx)** — the kind of spreadsheet a fellowship already keeps: a header row with a `NAME` column, and optional `NUMBER`, `HOSTEL`, `ROOM NO.`, `BIRTHDAY` (DD/MM), `SUBMINISTRY`, and `YEAR` columns, followed by one numbered column per meeting week. Any mark in a week's column (e.g. `O` or `/`) counts as present for that week; a blank counts as absent. A week column that's entirely blank across every row is treated as "hasn't happened yet" and skipped.

When importing a register:
- Select the Love Fellowship the register belongs to and the calendar date of "Week 1."
- Members are matched to existing records in that fellowship by phone number first, then by fuzzy name match — so uploading the same fellowship's register again next month **updates** the same people instead of creating duplicates, and backfills any attendance weeks it doesn't already have.
- A brand new member found in the register is created automatically (no approval step — admin-entered/imported data is trusted).
- Missing fields (no course, no birthday, no phone, etc.) are simply left blank — only a name and fellowship are ever required, matching how these registers are actually kept.

**2. A plain member-list CSV** — one row per member, no attendance columns. Expected columns: full name, love fellowship, and optionally gender, birthday, hostel, course, phone, email, level, status.

## Notes

- There is no public registration page. Every member is added by an authenticated admin, either individually (`/members/new`) or in bulk (`/members/import`).
- Only a full name and a Love Fellowship are required on any member record — gender, birthday, hostel, room number, course, phone, email, and level are all optional, matching real attendance-register data quality.
- A member's profile page (`/members/:id`) shows their attendance history for their fellowship's most recent weeks, explicitly marking each week Present or Absent — not just an aggregate rate.
- Duplicate detection normalizes phone numbers and performs a fuzzy name check for likely duplicates when adding members individually.
- Protected pages and actions use CSRF protection and login rate limiting.
- Branding assets live in [public/images/](public/images).
- The KNUST course list is seeded from [src/constants.js](src/constants.js) and can be adjusted as the organization needs a fuller or updated program list.
- For long-term production use, deploy to a proper host (see Render deployment above) and keep admin passwords strong and unique.
