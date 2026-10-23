import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes, scrypt, timingSafeEqual, createHash, createHmac } from "node:crypto";
import { isIP } from "node:net";
import { promisify } from "node:util";

const derive = promisify(scrypt);
export const token = () => randomBytes(32).toString("base64url");
export const hash = (value) => createHash("sha256").update(value).digest("hex");

// Store equivalent IPv6 spellings and IPv4-mapped IPv6 as one address identity.
export function canonicalIp(value) {
  if (typeof value !== "string") return null;
  const input = value.trim();
  const version = isIP(input);
  if (version === 4) return input;
  if (version !== 6) return null;
  const address = input.split("%")[0];
  let expanded = address.toLowerCase();
  if (expanded.includes(".")) {
    const lastColon = expanded.lastIndexOf(":");
    const octets = expanded.slice(lastColon + 1).split(".").map(Number);
    expanded = `${expanded.slice(0, lastColon + 1)}${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const halves = expanded.split("::");
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const parts = halves.length === 2
    ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right]
    : left;
  const words = parts.map((part) => parseInt(part, 16));
  if (words.slice(0, 5).every((part) => part === 0) && words[5] === 0xffff)
    return [words[6] >> 8, words[6] & 255, words[7] >> 8, words[7] & 255].join(".");
  return words.map((part) => part.toString(16).padStart(4, "0")).join(":");
}

export function addressKey(db, quizId, ip) {
  const address = canonicalIp(ip);
  if (!address) return null;
  const secret = db.prepare("SELECT value FROM private_config WHERE key = 'ip_digest_secret'").get().value;
  return createHmac("sha256", secret).update(`${quizId}\0${address}`).digest("hex");
}

export async function passwordHash(password) {
  const salt = randomBytes(16).toString("hex");
  const key = await derive(password, salt, 64, {
    N: 32768,
    r: 8,
    p: 3,
    maxmem: 64 * 1024 * 1024,
  });
  return `scrypt$32768$8$3$${salt}$${key.toString("hex")}`;
}

export async function passwordMatches(password, stored) {
  try {
    const parts = stored.split("$");
    // Legacy format was used only by early local previews; successful login upgrades it.
    const [algorithm, cost] = parts;
    const legacy = parts.length === 4;
    const salt = parts[legacy ? 2 : 4],
      expected = parts[legacy ? 3 : 5];
    if (
      algorithm !== "scrypt" ||
      cost !== "32768" ||
      (!legacy &&
        (parts.length !== 6 || parts[2] !== "8" || parts[3] !== "3")) ||
      !/^[a-f0-9]{32}$/.test(salt) ||
      !/^[a-f0-9]{128}$/.test(expected)
    )
      return false;
    const key = await derive(password, salt, 64, {
      N: 32768,
      r: 8,
      p: legacy ? 1 : 3,
      maxmem: 64 * 1024 * 1024,
    });
    return timingSafeEqual(key, Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}

export function openDatabase(dataDir) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(resolve(dataDir, "quiz.sqlite"));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS admins (
      id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, admin_id TEXT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
    CREATE TABLE IF NOT EXISTS quizzes (
      id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, doc TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS attempts (
      id TEXT PRIMARY KEY, quiz_id TEXT NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
      browser_hash TEXT NOT NULL, student_id TEXT, identity_key TEXT,
      name TEXT NOT NULL, group_name TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'active',
      started_at TEXT NOT NULL, expires_at TEXT, finished_at TEXT,
      warnings INTEGER NOT NULL DEFAULT 0, last_warning_at TEXT,
      snapshot TEXT NOT NULL, answers TEXT NOT NULL DEFAULT '{}', checked TEXT NOT NULL DEFAULT '{}', result TEXT,
      ip TEXT, user_agent TEXT,
      UNIQUE(quiz_id, browser_hash), UNIQUE(quiz_id, student_id), UNIQUE(quiz_id, identity_key),
      CHECK(status IN ('active','submitted','expired','invalidated'))
    );
    CREATE INDEX IF NOT EXISTS attempts_quiz ON attempts(quiz_id);
    CREATE INDEX IF NOT EXISTS attempts_expiry ON attempts(status,expires_at);
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      attempt_id TEXT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
      event_id TEXT NOT NULL, type TEXT NOT NULL, created_at TEXT NOT NULL,
      counted INTEGER NOT NULL DEFAULT 0,
      metadata TEXT NOT NULL DEFAULT '{}',
      UNIQUE(attempt_id,event_id)
    );
    CREATE TABLE IF NOT EXISTS login_limits (
      key TEXT PRIMARY KEY, failures INTEGER NOT NULL DEFAULT 0,
      window_start INTEGER NOT NULL, blocked_until INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS private_config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS surveys (
      id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, doc TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS survey_responses (
      id TEXT PRIMARY KEY, survey_id TEXT NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
      access_hash TEXT NOT NULL, browser_key TEXT, ip_key TEXT, name TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','submitted','expired')),
      started_at TEXT NOT NULL, expires_at TEXT, finished_at TEXT,
      snapshot TEXT NOT NULL, answers TEXT NOT NULL DEFAULT '{}',
      ip TEXT, user_agent TEXT, collection TEXT NOT NULL DEFAULT '{}',
      last_seen_at TEXT, presence_visibility TEXT, presence_focused INTEGER,
      current_question_id TEXT, last_action TEXT, last_action_at TEXT
    );
    CREATE INDEX IF NOT EXISTS responses_survey ON survey_responses(survey_id);
    CREATE INDEX IF NOT EXISTS responses_access ON survey_responses(survey_id,access_hash);
    CREATE INDEX IF NOT EXISTS responses_browser ON survey_responses(survey_id,browser_key);
    CREATE INDEX IF NOT EXISTS responses_ip ON survey_responses(survey_id,ip_key);
    CREATE INDEX IF NOT EXISTS responses_expiry ON survey_responses(status,expires_at);
    CREATE TABLE IF NOT EXISTS survey_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      response_id TEXT NOT NULL REFERENCES survey_responses(id) ON DELETE CASCADE,
      type TEXT NOT NULL, created_at TEXT NOT NULL, metadata TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS survey_events_response ON survey_events(response_id);
  `);
  // Additive, idempotent migrations preserve existing quizzes and active attempts.
  const attemptColumns = new Set(
    db
      .prepare("PRAGMA table_info(attempts)")
      .all()
      .map((column) => column.name),
  );
  if (!attemptColumns.has("checked"))
    db.exec(
      "ALTER TABLE attempts ADD COLUMN checked TEXT NOT NULL DEFAULT '{}'",
    );
  for (const [name, type] of Object.entries({
    ip_key: "TEXT",
    last_seen_at: "TEXT",
    presence_visibility: "TEXT",
    presence_focused: "INTEGER",
    current_question_id: "TEXT",
    last_action: "TEXT",
    last_action_at: "TEXT",
    retake_granted: "INTEGER NOT NULL DEFAULT 0",
  }))
    if (!attemptColumns.has(name)) db.exec(`ALTER TABLE attempts ADD COLUMN ${name} ${type}`);
  db.exec("CREATE INDEX IF NOT EXISTS attempts_ip_key ON attempts(quiz_id, ip_key)");
  db.exec(`CREATE TABLE IF NOT EXISTS attempt_history (
    id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
    quiz_id TEXT NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
    archived_at TEXT NOT NULL, ip_key TEXT, doc TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS history_ip_key ON attempt_history(quiz_id, ip_key);`);
  const eventColumns = new Set(
    db
      .prepare("PRAGMA table_info(events)")
      .all()
      .map((column) => column.name),
  );
  if (!eventColumns.has("metadata"))
    db.exec(
      "ALTER TABLE events ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}'",
    );
  transaction(db, () => {
    db.prepare("INSERT OR IGNORE INTO private_config(key,value) VALUES('ip_digest_secret',?)").run(token());
    for (const row of db.prepare("SELECT id,quiz_id,ip FROM attempts WHERE ip IS NOT NULL AND ip_key IS NULL").all())
      db.prepare("UPDATE attempts SET ip_key = ? WHERE id = ?").run(addressKey(db, row.quiz_id, row.ip), row.id);
  });
  db.exec("PRAGMA user_version = 5");
  return db;
}

export function transaction(db, callback) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = callback();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function validCredentials(username, password) {
  return (
    typeof username === "string" &&
    /^[a-zA-Z0-9_.-]{3,64}$/.test(username) &&
    typeof password === "string" &&
    password.length >= 12 &&
    password.length <= 128
  );
}
