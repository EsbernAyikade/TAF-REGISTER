const fs = require("node:fs");
const path = require("node:path");

const databasePath = process.env.DATABASE_PATH || path.join(__dirname, "..", "data", "teens-aloud.db");
const backupRoot = path.join(__dirname, "..", "backups");
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupFile = path.join(backupRoot, `teens-aloud-${timestamp}.db`);

fs.mkdirSync(backupRoot, { recursive: true });

if (!fs.existsSync(databasePath)) {
  console.warn(`No database file found at ${databasePath}; nothing to back up.`);
  process.exit(0);
}

fs.copyFileSync(databasePath, backupFile);
console.log(`Database backup created at ${backupFile}`);
