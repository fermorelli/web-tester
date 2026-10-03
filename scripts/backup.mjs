import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

const [source, destination] = process.argv.slice(2);
if (!source || !destination) throw new Error("Usage: node scripts/backup.mjs <database-path> <new-backup-path>");
const sourcePath = resolve(source);
const destinationPath = resolve(destination);
if (!existsSync(sourcePath)) throw new Error("The source database does not exist.");
if (existsSync(destinationPath)) throw new Error("The backup destination already exists. Choose a new filename.");
mkdirSync(dirname(destinationPath), { recursive: true });
const database = new DatabaseSync(sourcePath, { readOnly: true });
try {
  await backup(database, destinationPath);
  console.log(`SQLite backup saved to ${destinationPath}`);
} finally { database.close(); }
