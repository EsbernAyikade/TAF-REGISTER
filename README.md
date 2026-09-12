# Teens Aloud Foundation Member System

Server-rendered Express + SQLite application for:

- public/shareable member registration
- authentication-gated member directory
- fellowship pages and dashboards
- birthday highlighting using day + month only
- weekly attendance capture and reporting
- CSV and Excel exports

## Stack

- Node.js
- Express
- EJS templates
- SQLite via `better-sqlite3`
- Session authentication via `express-session`
- Excel export via `exceljs`

## Getting started

```bash
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000).

By default the app now binds to `0.0.0.0`, so anyone who can reach your machine or server on port `3000` can open the website. The full site, including registration, requires login.

## Permanent public website

If you want one normal link that works from any device at any time, you should deploy the app to a hosting provider instead of relying on the temporary tunnel.

This project is now prepared for deployment on Render with a persistent disk and a stable public URL.

Recommended result:

- a hosted URL like `https://your-app-name.onrender.com`
- optional custom domain later, such as `https://members.teensaloud.org`
- login required for the whole site

### Render deployment

1. Push this project to GitHub.
2. Create a new Render Blueprint or Web Service from the repo.
3. Attach a persistent disk mounted at `/var/data`.
4. Set these environment variables:
   - `NODE_ENV=production`
   - `SESSION_SECRET=<your-own-secret>`
   - `DEFAULT_USER_PASSWORD=<change-this>`
   - `DATABASE_PATH=/var/data/teens-aloud.db`
5. Deploy.

After deployment, Render gives you one public URL that works from any device.

### Custom domain

If you own a domain, connect it in your hosting provider's dashboard and point DNS to the deployed app. That part requires access to your domain registrar or DNS provider.

## Share online temporarily

To create a temporary public link for the app:

```bash
npm run share
```

This starts the app and prints a public URL. In this mode:

- anyone with the link can open the app
- registration is available at `/register` after login
- admin login is available at `/login`
- protected pages still require valid login credentials

Keep the command running while the link is in use.

## Seeded accounts

Default password for all seeded users:

```text
12345678
```

Accounts:

- Super Admin: `admin@teensaloud.local`
- Fellowship Admin: `gaza.admin@teensaloud.local`
- Viewer: `viewer@teensaloud.local`

You can override the main super admin credentials with:

- `SUPER_ADMIN_EMAIL`
- `SUPER_ADMIN_PASSWORD`
- `DEFAULT_USER_PASSWORD`
- `SESSION_SECRET`
- `HOST`
- `PORT`
- `PUBLIC_REGISTRATION_ONLY`
- `NODE_ENV`
- `DATABASE_PATH`
- `DATA_DIR`

## Main routes

- `/register` - authenticated registration form
- `/login` - login page
- `/dashboard` - authenticated dashboard
- `/members` - searchable member database
- `/fellowships/:slug` - fellowship-specific page
- `/fellowships/:slug/attendance` - weekly attendance capture
- `/exports/members.csv` - CSV export
- `/exports/members.xlsx` - Excel export

## Notes

- Registration submissions are saved as `pending` until approved by an admin.
- Duplicate detection flags matching name, email, or phone values.
- Branding assets live in [public/images/](/Users/kade/Documents/projectt/public/images).
- The KNUST course list is seeded from [src/constants.js](/Users/kade/Documents/projectt/src/constants.js) and can be adjusted easily if the organization wants a fuller or updated program list.
- For internet-wide access, deploy this Node app to a reachable host or VM and point users to `/login`. On a local machine, people on the same network can use your computer's IP address with port `3000`.
- `npm run share` is intended for temporary public access. For long-term production use, deploy to a proper host and set stronger admin passwords.
