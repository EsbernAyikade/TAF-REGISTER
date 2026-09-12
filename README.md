# Teens Aloud Foundation Member System

Server-rendered Express + SQLite application for:

- public member registration with approval gating
- authenticated member directory and dashboard
- fellowship pages and attendance tracking
- birthday and leadership summaries using day + month only
- CSV and Excel exports

## Stack

- Node.js
- Express
- EJS templates
- SQLite via `better-sqlite3`
- Session authentication via `express-session`
- Excel export via `exceljs`
- CSRF and rate limiting for public registration and login security

## Getting started

```bash
cp .env.example .env
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000).

The app binds to `0.0.0.0` for local and hosted deployment. `/register` is public, but database access remains protected behind login. The protected admin pages and member data require valid credentials.

## Production and hosting

This project is prepared for deployment on Render with a persistent disk and a stable public URL.

Recommended result:

- a hosted URL like `https://your-app-name.onrender.com`
- optional custom domain later, such as `https://members.teensaloud.org`
- public registration at `/register`
- login required for the admin dashboard and member database

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

The Render blueprint in this repo is configured to mount the database disk at `/var/data` and back up the SQLite file in a daily cron job.

### Custom domain

If you own a domain, connect it in your hosting provider's dashboard and point DNS to the deployed app. That part requires access to your domain registrar or DNS provider.

## Seeded accounts

The seeded users are created with strong default passwords stored in environment variables. In development, the example defaults are used if the environment is not configured.

Accounts:

- Super Admin: `admin@teensaloud.local`
- Fellowship Admin: `gaza.admin@teensaloud.local`
- Viewer: `viewer@teensaloud.local`

You can override these via:

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
 
Important: `SESSION_SECRET` must be set in production or the app will fail to start.

## Main routes

- `/register` - public registration form
- `/login` - login page
- `/dashboard` - authenticated dashboard
- `/members` - searchable member database
- `/fellowships/:slug` - fellowship-specific page
- `/fellowships/:slug/attendance` - weekly attendance capture
- `/exports/members.csv` - CSV export
- `/exports/members.xlsx` - Excel export

## Notes

- Registration submissions are saved as `pending` until approved by an admin.
- Duplicate detection now normalizes phone numbers and performs a fuzzy name check for likely duplicates.
- Protected pages and actions use CSRF protection and rate limits.
- Branding assets live in [public/images/](/Users/kade/Documents/projectt/public/images).
- The KNUST course list is seeded from [src/constants.js](/Users/kade/Documents/projectt/src/constants.js) and can be adjusted as the organization needs a fuller or updated program list.
- For internet-wide access, deploy this Node app to a reachable host or VM and point users to the public registration route. On a local machine, people on the same network can use your computer's IP address with port `3000`.
For long-term production use, deploy to a proper host and keep admin passwords strong and unique.
