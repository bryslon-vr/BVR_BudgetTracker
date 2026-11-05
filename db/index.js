const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

// DB_PATH can be set in .env. Tests use ':memory:' so they never touch real data.
const dbPath = process.env.DB_PATH || path.join(__dirname, 'budget.sqlite');

const db = new Database(dbPath);
db.pragma('foreign_keys = ON'); // SQLite ignores foreign keys unless this is on

// Create the tables automatically the first time the app starts
const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

module.exports = db;