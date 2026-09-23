import { Router } from 'express';
import { nanoid } from 'nanoid';
import db from '../db/index.js';
import { hashPassword, verifyPassword, signAdminToken, requireAdmin } from '../auth.js';
import {
  logEvent,
  recalculateQualification,
  serializeSessionForAdmin,
  serializeTeamForAdmin,
  broadcastSessionState,
  broadcastEvent,
} from '../services/gameService.js';

const router = Router();

// ---------------------------------------------------------------- Admin auth
router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });

  const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(username);
  if (!admin || !verifyPassword(password, admin.password_hash)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  res.json({ token: signAdminToken(admin), username: admin.username });
});

router.use(requireAdmin);

// ---------------------------------------------------------------- Sessions
router.post('/sessions', (req, res) => {
  const {
    durationSeconds = 1200,
    maxQualifiers = 2,
    coordinatorVerification = false,
  } = req.body || {};

  const sessionCode = `BH-${new Date().getFullYear()}-${nanoid(6).toUpperCase()}`;
  const stmt = db.prepare(`
    INSERT INTO game_sessions
      (session_code, status, duration_seconds, max_qualifiers, coordinator_verification)
    VALUES (?, 'WAITING', ?, ?, ?)
  `);
  const info = stmt.run(
    sessionCode,
    durationSeconds,
    maxQualifiers,
    coordinatorVerification ? 1 : 0
  );
  const session = db.prepare('SELECT * FROM game_sessions WHERE id = ?').get(info.lastInsertRowid);
  logEvent(session.id, null, 'SESSION_CREATED', `Game session ${sessionCode} created`);
  res.status(201).json(serializeSessionForAdmin(session));
});

router.get('/sessions', (req, res) => {
  const sessions = db.prepare('SELECT * FROM game_sessions ORDER BY created_at DESC').all();
  res.json(sessions.map(serializeSessionForAdmin));
});

function getSessionOr404(req, res) {
  const session = db.prepare('SELECT * FROM game_sessions WHERE id = ?').get(req.params.id);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return null;
  }
  return session;
}

router.get('/sessions/:id', (req, res) => {
  const session = getSessionOr404(req, res);
  if (!session) return;
  const teams = db.prepare('SELECT * FROM teams WHERE session_id = ?').all(session.id);
  const puzzles = db.prepare('SELECT * FROM puzzles WHERE session_id = ? ORDER BY puzzle_set, sequence_number').all(session.id);
  res.json({
    ...serializeSessionForAdmin(session),
    joinPath: `/join/${session.session_code}`,
    teams: teams.map(serializeTeamForAdmin),
    puzzles,
  });
});

// Draft vs Active config guard (Section 14 box): editing a LIVE session's config
// requires the caller to pass force:true, so a round can never be silently broken.
router.patch('/sessions/:id', (req, res) => {
  const session = getSessionOr404(req, res);
  if (!session) return;

  const isLive = session.status === 'LIVE' || session.status === 'PAUSED';
  if (isLive && !req.body?.force) {
    return res.status(409).json({
      error: 'Session is live. Pass force:true to confirm you want to edit a live configuration.',
    });
  }

  const fields = {
    duration_seconds: req.body.durationSeconds,
    max_qualifiers: req.body.maxQualifiers,
    coordinator_verification:
      req.body.coordinatorVerification === undefined ? undefined : req.body.coordinatorVerification ? 1 : 0,
    debug_mode: req.body.debugMode === undefined ? undefined : req.body.debugMode ? 1 : 0,
  };
  const sets = [];
  const values = [];
  for (const [col, val] of Object.entries(fields)) {
    if (val !== undefined) {
      sets.push(`${col} = ?`);
      values.push(val);
    }
  }
  if (sets.length) {
    values.push(session.id);
    db.prepare(`UPDATE game_sessions SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }
  const updated = db.prepare('SELECT * FROM game_sessions WHERE id = ?').get(session.id);
  logEvent(session.id, null, 'CONFIG_UPDATED', 'Admin updated session configuration', req.body);
  broadcastSessionState(req.app.locals.io, session.id);
  res.json(serializeSessionForAdmin(updated));
});

// ------------------------------------------------------------ Game controls
router.post('/sessions/:id/start', (req, res) => {
  const session = getSessionOr404(req, res);
  if (!session) return;

  const teams = db.prepare('SELECT * FROM teams WHERE session_id = ?').all(session.id);
  const notConnected = teams.filter((t) => !t.connected);
  if (notConnected.length && !req.body?.startAnyway) {
    return res.status(409).json({
      error: 'Not all teams are connected',
      notConnected: notConnected.map((t) => t.name),
      requiresConfirmation: true,
    });
  }

  db.prepare(
    `UPDATE game_sessions SET status = 'LIVE', started_at = datetime('now'), total_paused_seconds = 0, paused_at = NULL WHERE id = ?`
  ).run(session.id);
  db.prepare(`UPDATE teams SET status = 'SOLVING' WHERE session_id = ?`).run(session.id);

  // Unlock each team's first puzzle in the chain.
  const firstPuzzles = db
    .prepare(`SELECT tp.* FROM team_puzzles tp JOIN teams t ON t.id = tp.team_id WHERE t.session_id = ? AND tp.sequence_number = 1`)
    .all(session.id);
  const activate = db.prepare(`UPDATE team_puzzles SET status = 'ACTIVE', started_at = datetime('now') WHERE id = ?`);
  firstPuzzles.forEach((tp) => activate.run(tp.id));

  const evt = logEvent(session.id, null, 'GAME_STARTED', 'Game started');
  const updated = db.prepare('SELECT * FROM game_sessions WHERE id = ?').get(session.id);
  broadcastSessionState(req.app.locals.io, session.id);
  broadcastEvent(req.app.locals.io, session.session_code, evt);
  req.app.locals.io.to(`session:${session.session_code}`).emit('game:started');
  res.json(serializeSessionForAdmin(updated));
});

router.post('/sessions/:id/pause', (req, res) => {
  const session = getSessionOr404(req, res);
  if (!session) return;
  if (session.status !== 'LIVE') return res.status(409).json({ error: 'Game is not live' });

  db.prepare(`UPDATE game_sessions SET status = 'PAUSED', paused_at = datetime('now') WHERE id = ?`).run(session.id);
  const evt = logEvent(session.id, null, 'GAME_PAUSED', 'Game paused by organizer');
  broadcastSessionState(req.app.locals.io, session.id);
  broadcastEvent(req.app.locals.io, session.session_code, evt);
  res.json(serializeSessionForAdmin(db.prepare('SELECT * FROM game_sessions WHERE id = ?').get(session.id)));
});

router.post('/sessions/:id/resume', (req, res) => {
  const session = getSessionOr404(req, res);
  if (!session) return;
  if (session.status !== 'PAUSED') return res.status(409).json({ error: 'Game is not paused' });

  const pausedForSeconds = Math.floor((Date.now() - Date.parse(session.paused_at + 'Z')) / 1000);
  db.prepare(
    `UPDATE game_sessions SET status = 'LIVE', paused_at = NULL, total_paused_seconds = total_paused_seconds + ? WHERE id = ?`
  ).run(pausedForSeconds, session.id);
  const evt = logEvent(session.id, null, 'GAME_RESUMED', 'Game resumed by organizer');
  broadcastSessionState(req.app.locals.io, session.id);
  broadcastEvent(req.app.locals.io, session.session_code, evt);
  res.json(serializeSessionForAdmin(db.prepare('SELECT * FROM game_sessions WHERE id = ?').get(session.id)));
});

router.post('/sessions/:id/reset', (req, res) => {
  const session = getSessionOr404(req, res);
  if (!session) return;
  if (!req.body?.confirm) return res.status(400).json({ error: 'Reset requires confirm:true' });

  db.prepare(
    `UPDATE game_sessions SET status = 'WAITING', started_at = NULL, paused_at = NULL, total_paused_seconds = 0 WHERE id = ?`
  ).run(session.id);
  db.prepare(`UPDATE teams SET status = 'WAITING', escaped_at = NULL, qualified = 0, qualified_rank = NULL WHERE session_id = ?`).run(session.id);
  db.prepare(
    `UPDATE team_puzzles SET status = 'LOCKED', attempts = 0, started_at = NULL, completed_at = NULL, unlock_token = NULL
     WHERE team_id IN (SELECT id FROM teams WHERE session_id = ?)`
  ).run(session.id);
  db.prepare(
    `UPDATE final_codes SET attempts_used = 0, unlocked = 0
     WHERE team_id IN (SELECT id FROM teams WHERE session_id = ?)`
  ).run(session.id);

  const evt = logEvent(session.id, null, 'GAME_RESET', 'Game reset by organizer — all team progress cleared');
  broadcastSessionState(req.app.locals.io, session.id);
  broadcastEvent(req.app.locals.io, session.session_code, evt);
  req.app.locals.io.to(`session:${session.session_code}`).emit('game:reset');
  res.json(serializeSessionForAdmin(db.prepare('SELECT * FROM game_sessions WHERE id = ?').get(session.id)));
});

router.post('/sessions/:id/end', (req, res) => {
  const session = getSessionOr404(req, res);
  if (!session) return;
  db.prepare(`UPDATE game_sessions SET status = 'COMPLETED' WHERE id = ?`).run(session.id);
  const evt = logEvent(session.id, null, 'SESSION_ENDED', 'Session archived/ended by organizer');
  broadcastSessionState(req.app.locals.io, session.id);
  broadcastEvent(req.app.locals.io, session.session_code, evt);
  res.json(serializeSessionForAdmin(db.prepare('SELECT * FROM game_sessions WHERE id = ?').get(session.id)));
});

// ------------------------------------------------------------------- Teams
router.post('/sessions/:id/teams', (req, res) => {
  const session = getSessionOr404(req, res);
  if (!session) return;
  const { name, password, puzzleSet = 'A' } = req.body || {};
  if (!name || !password) return res.status(400).json({ error: 'name and password required' });

  const dup = db.prepare('SELECT id FROM teams WHERE session_id = ? AND password_hash IS NOT NULL').all(session.id);
  // Enforce unique plaintext passwords per session (spec Section 6) before hashing.
  const existing = db.prepare('SELECT * FROM teams WHERE session_id = ?').all(session.id);
  for (const t of existing) {
    if (verifyPassword(password, t.password_hash)) {
      return res.status(409).json({ error: 'Password must be unique within this session' });
    }
  }

  try {
    const info = db
      .prepare('INSERT INTO teams (session_id, name, password_hash, puzzle_set) VALUES (?, ?, ?, ?)')
      .run(session.id, name, hashPassword(password), puzzleSet);
    const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(info.lastInsertRowid);

    // Wire up the team's puzzle chain from the puzzles already defined for this set.
    const puzzles = db
      .prepare('SELECT * FROM puzzles WHERE session_id = ? AND puzzle_set = ? ORDER BY sequence_number')
      .all(session.id, puzzleSet);
    const insertTp = db.prepare(
      'INSERT INTO team_puzzles (team_id, puzzle_id, sequence_number, status) VALUES (?, ?, ?, ?)'
    );
    puzzles.forEach((p) => insertTp.run(team.id, p.id, p.sequence_number, 'LOCKED'));

    // The Final Lock row: no code/digits stored — see gameService.computeFinalCode.
    db.prepare('INSERT INTO final_codes (team_id, attempts_used, unlocked) VALUES (?, 0, 0)').run(team.id);

    logEvent(session.id, team.id, 'TEAM_CREATED', `Team "${name}" created`);
    broadcastSessionState(req.app.locals.io, session.id);
    res.status(201).json(serializeTeamForAdmin(team));
  } catch (e) {
    if (String(e).includes('UNIQUE')) return res.status(409).json({ error: 'Team name already exists in this session' });
    throw e;
  }
});

function getTeamOr404(req, res) {
  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(req.params.teamId);
  if (!team) {
    res.status(404).json({ error: 'Team not found' });
    return null;
  }
  return team;
}

router.patch('/teams/:teamId', (req, res) => {
  const team = getTeamOr404(req, res);
  if (!team) return;
  const { name, puzzleSet } = req.body || {};
  const sets = [];
  const values = [];
  if (name) { sets.push('name = ?'); values.push(name); }
  if (puzzleSet) { sets.push('puzzle_set = ?'); values.push(puzzleSet); }
  if (sets.length) {
    values.push(team.id);
    db.prepare(`UPDATE teams SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }
  const updated = db.prepare('SELECT * FROM teams WHERE id = ?').get(team.id);
  logEvent(team.session_id, team.id, 'TEAM_UPDATED', `Team "${updated.name}" updated`);
  broadcastSessionState(req.app.locals.io, team.session_id);
  res.json(serializeTeamForAdmin(updated));
});

router.post('/teams/:teamId/reset-password', (req, res) => {
  const team = getTeamOr404(req, res);
  if (!team) return;
  const { password } = req.body || {};
  if (!password) return res.status(400).json({ error: 'password required' });
  db.prepare('UPDATE teams SET password_hash = ? WHERE id = ?').run(hashPassword(password), team.id);
  logEvent(team.session_id, team.id, 'PASSWORD_RESET', `Password reset for team "${team.name}"`);
  res.json({ ok: true });
});

router.delete('/teams/:teamId', (req, res) => {
  const team = getTeamOr404(req, res);
  if (!team) return;
  db.prepare('DELETE FROM teams WHERE id = ?').run(team.id);
  logEvent(team.session_id, null, 'TEAM_DELETED', `Team "${team.name}" deleted`);
  broadcastSessionState(req.app.locals.io, team.session_id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- Puzzles
router.post('/sessions/:id/puzzles', (req, res) => {
  const session = getSessionOr404(req, res);
  if (!session) return;
  const { puzzleSet, sequenceNumber, puzzleType, title, question, answer, difficulty = 'medium', configuration = {} } =
    req.body || {};
  if (!puzzleSet || !sequenceNumber || !puzzleType || !title || !question || !answer) {
    return res.status(400).json({ error: 'puzzleSet, sequenceNumber, puzzleType, title, question, answer required' });
  }
  const info = db
    .prepare(
      `INSERT INTO puzzles (session_id, puzzle_set, sequence_number, puzzle_type, title, question, answer, difficulty, configuration)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(session.id, puzzleSet, sequenceNumber, puzzleType, title, question, String(answer), difficulty, JSON.stringify(configuration));
  const puzzle = db.prepare('SELECT * FROM puzzles WHERE id = ?').get(info.lastInsertRowid);
  logEvent(session.id, null, 'PUZZLE_CREATED', `Puzzle "${title}" added to set ${puzzleSet}`);
  res.status(201).json(puzzle);
});

router.patch('/puzzles/:puzzleId', (req, res) => {
  const puzzle = db.prepare('SELECT * FROM puzzles WHERE id = ?').get(req.params.puzzleId);
  if (!puzzle) return res.status(404).json({ error: 'Puzzle not found' });

  const session = db.prepare('SELECT * FROM game_sessions WHERE id = ?').get(puzzle.session_id);
  const isLive = session.status === 'LIVE' || session.status === 'PAUSED';
  if (isLive && !req.body?.force) {
    return res.status(409).json({ error: 'Session is live. Pass force:true to edit a live puzzle.' });
  }

  const fields = {
    title: req.body.title,
    question: req.body.question,
    answer: req.body.answer !== undefined ? String(req.body.answer) : undefined,
    difficulty: req.body.difficulty,
    configuration: req.body.configuration !== undefined ? JSON.stringify(req.body.configuration) : undefined,
  };
  const sets = [];
  const values = [];
  for (const [col, val] of Object.entries(fields)) {
    if (val !== undefined) { sets.push(`${col} = ?`); values.push(val); }
  }
  if (sets.length) {
    values.push(puzzle.id);
    db.prepare(`UPDATE puzzles SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }
  const updated = db.prepare('SELECT * FROM puzzles WHERE id = ?').get(puzzle.id);
  logEvent(puzzle.session_id, null, 'PUZZLE_UPDATED', `Puzzle "${updated.title}" updated`);
  res.json(updated);
});

// ------------------------------------------------------------- Final codes
// There is no manual "set the final code" endpoint anymore: the correct 6-digit code
// is always derived live from the team's 4 mini-puzzles (see gameService.computeFinalCode).
// To change a team's final code, edit the mini-puzzles' answers or `configuration.codeDigits`
// via PATCH /puzzles/:puzzleId above — the same Puzzle Manager the organizer already uses.
// GET /sessions/:id already returns each team's computed code + validity for organizer review.

// ------------------------------------------------------- Coordinator confirm
// Section 26: when coordinator verification is ON, a puzzle a team has answered correctly
// sits PENDING_COORDINATOR until a human confirms it here, which issues the unlock token.
router.post('/team-puzzles/:id/confirm', (req, res) => {
  const tp = db.prepare('SELECT * FROM team_puzzles WHERE id = ?').get(req.params.id);
  if (!tp) return res.status(404).json({ error: 'team_puzzle not found' });
  if (tp.status !== 'PENDING_COORDINATOR') {
    return res.status(409).json({ error: 'This puzzle is not awaiting coordinator confirmation' });
  }
  const token = nanoid(8).toUpperCase();
  db.prepare(`UPDATE team_puzzles SET status = 'COMPLETE', completed_at = datetime('now'), unlock_token = ? WHERE id = ?`).run(
    token, tp.id
  );
  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(tp.team_id);

  advanceNextPuzzleOrFinalCode(team, tp.sequence_number);

  const evt = logEvent(team.session_id, team.id, 'COORDINATOR_CONFIRMED', `Coordinator confirmed puzzle ${tp.sequence_number} for "${team.name}"`);
  broadcastSessionState(req.app.locals.io, team.session_id);
  broadcastEvent(req.app.locals.io, (db.prepare('SELECT session_code FROM game_sessions WHERE id = ?').get(team.session_id)).session_code, evt);
  res.json({ ok: true, unlockToken: token });
});

function advanceNextPuzzleOrFinalCode(team, completedSequence) {
  const next = db
    .prepare('SELECT * FROM team_puzzles WHERE team_id = ? AND sequence_number = ?')
    .get(team.id, completedSequence + 1);
  if (next) {
    db.prepare(`UPDATE team_puzzles SET status = 'ACTIVE', started_at = datetime('now') WHERE id = ?`).run(next.id);
  } else {
    // That was the last puzzle — unlock the final six-digit code entry.
    db.prepare('UPDATE final_codes SET unlocked = 1 WHERE team_id = ?').run(team.id);
  }
}

// ------------------------------------------------------------------- Events
router.get('/sessions/:id/events', (req, res) => {
  const session = getSessionOr404(req, res);
  if (!session) return;
  const events = db
    .prepare('SELECT * FROM game_events WHERE session_id = ? ORDER BY timestamp DESC LIMIT 500')
    .all(session.id);
  res.json(events);
});

export default router;
