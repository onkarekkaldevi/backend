-- Brain Hunt Round 2 schema (Section 21 of the build spec)
-- SQLite dialect (drop-in equivalent to the Postgres schema described in the spec;
-- swap this file + db/index.js for a Postgres client without touching route/service code).

CREATE TABLE IF NOT EXISTS admins (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS game_sessions (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  session_code            TEXT UNIQUE NOT NULL,
  status                  TEXT NOT NULL DEFAULT 'WAITING', -- WAITING | READY | LIVE | PAUSED | COMPLETED
  duration_seconds        INTEGER NOT NULL DEFAULT 1200,   -- 20 minutes, configurable
  max_qualifiers          INTEGER NOT NULL DEFAULT 2,
  coordinator_verification INTEGER NOT NULL DEFAULT 0, -- boolean 0/1
  debug_mode              INTEGER NOT NULL DEFAULT 0,   -- reveals hidden info to teams, rehearsal only
  is_active_config        INTEGER NOT NULL DEFAULT 0,   -- 0 = draft, 1 = active/live config (Section 14)
  started_at              TEXT,
  paused_at               TEXT,
  total_paused_seconds    INTEGER NOT NULL DEFAULT 0,
  created_at              TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS teams (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    INTEGER NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  puzzle_set    TEXT NOT NULL DEFAULT 'A',   -- which puzzle set (A/B/C/...) this team solves
  connected     INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'NOT_JOINED', -- NOT_JOINED | WAITING | SOLVING | ESCAPED | LOCKED_OUT
  escaped_at    TEXT,
  qualified     INTEGER NOT NULL DEFAULT 0,
  qualified_rank INTEGER,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(session_id, name)
);

CREATE TABLE IF NOT EXISTS puzzles (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    INTEGER NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
  puzzle_set    TEXT NOT NULL,               -- A / B / C ...
  sequence_number INTEGER NOT NULL,          -- 1-4, chain order
  puzzle_type   TEXT NOT NULL,               -- series | binary | logic | pattern
  title         TEXT NOT NULL,
  question      TEXT NOT NULL,
  answer        TEXT NOT NULL,
  difficulty    TEXT NOT NULL DEFAULT 'medium',
  -- JSON: { hint, codeDigits }. codeDigits is this puzzle's contribution (as a digit
  -- string, leading zeros allowed) to the team's final 6-digit code, in sequence_number
  -- order. If omitted, the puzzle's own `answer` is used instead, so changing a puzzle's
  -- answer automatically changes the final code (Final Puzzle spec, Section 2/9).
  configuration TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(session_id, puzzle_set, sequence_number)
);

CREATE TABLE IF NOT EXISTS team_puzzles (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id         INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  puzzle_id       INTEGER NOT NULL REFERENCES puzzles(id) ON DELETE CASCADE,
  sequence_number INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'LOCKED', -- LOCKED | ACTIVE | PENDING_COORDINATOR | COMPLETE
  attempts        INTEGER NOT NULL DEFAULT 0,
  started_at      TEXT,
  completed_at    TEXT,
  unlock_token    TEXT, -- issued by coordinator when verification is required
  UNIQUE(team_id, puzzle_id)
);

-- The Final Lock: no correct/incorrect code is ever stored here. The correct code is
-- always computed fresh from the team's 4 completed mini-puzzles (see
-- gameService.computeFinalCode). This row only tracks whether the lock is unlocked yet
-- and a non-blocking attempt counter kept purely for the organizer's own stats.
-- IMPORTANT: attempts_used is NEVER enforced as a limit anywhere in the code — there is
-- no maximum, no lockout, and no cooldown. Unlimited incorrect submissions are allowed.
CREATE TABLE IF NOT EXISTS final_codes (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id        INTEGER UNIQUE NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  attempts_used  INTEGER NOT NULL DEFAULT 0, -- informational only, never a limit
  unlocked       INTEGER NOT NULL DEFAULT 0  -- becomes 1 once all 4 mini-puzzles are complete
);

CREATE TABLE IF NOT EXISTS game_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
  team_id    INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  message    TEXT NOT NULL,
  metadata   TEXT NOT NULL DEFAULT '{}',
  timestamp  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_teams_session ON teams(session_id);
CREATE INDEX IF NOT EXISTS idx_puzzles_session_set ON puzzles(session_id, puzzle_set);
CREATE INDEX IF NOT EXISTS idx_team_puzzles_team ON team_puzzles(team_id);
CREATE INDEX IF NOT EXISTS idx_events_session ON game_events(session_id, timestamp);
