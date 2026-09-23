import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Uses Node's built-in node:sqlite module (stable/experimental in Node 22.5+) instead
// of better-sqlite3, so there is nothing to compile — this works out of the box on
// Termux/Android, ARM boards, and any environment without a native build toolchain.
let DatabaseSync;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch (e) {
  console.error(
    '\nFATAL: node:sqlite is not available in this Node build.\n' +
    'You need Node 22.5+ (Node 24+ recommended, no flag needed).\n' +
    'If you are on Node 22.5-23.x, try: node --experimental-sqlite src/server.js\n'
  );
  process.exit(1);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', '..', 'brainhunt.db');

const raw = new DatabaseSync(DB_PATH);
raw.exec('PRAGMA journal_mode = WAL');
raw.exec('PRAGMA foreign_keys = ON');

const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8');
raw.exec(schema);

// Thin wrapper so the rest of the codebase (written against better-sqlite3's API)
// works unchanged: db.prepare(sql).run/get/all(...params), db.exec(sql).
function normalizeRow(row) {
  if (!row) return row;
  for (const key of Object.keys(row)) {
    if (typeof row[key] === 'bigint') row[key] = Number(row[key]);
  }
  return row;
}

function wrapStatement(stmt) {
  return {
    run: (...params) => {
      const info = stmt.run(...params);
      return {
        changes: Number(info.changes),
        lastInsertRowid: Number(info.lastInsertRowid),
      };
    },
    get: (...params) => normalizeRow(stmt.get(...params)),
    all: (...params) => (stmt.all(...params) || []).map(normalizeRow),
  };
}

export const db = {
  prepare: (sql) => wrapStatement(raw.prepare(sql)),
  exec: (sql) => raw.exec(sql),
};

export default db;
