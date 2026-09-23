import { Router } from 'express';
import db from '../db/index.js';
import { verifyPassword, signTeamToken, requireTeam } from '../auth.js';
import {
  logEvent,
  recalculateQualification,
  computeRemainingSeconds,
  isTeamTimeExpired,
  computeFinalCode,
  serializeSessionForTeam,
  serializeTeamPuzzleForTeam,
  serializeFinalCodeForTeam,
  broadcastSessionState,
  broadcastEvent,
} from '../services/gameService.js';

const router = Router();

// The team name sent by the client is untrusted input — always re-verified against the
// session + password combination on the backend before anything is issued (Section 10).
router.post('/login', (req, res) => {
  const { sessionCode, teamName, password } = req.body || {};
  if (!sessionCode || !teamName || !password) {
    return res.status(400).json({ error: 'sessionCode, teamName and password required' });
  }

  const session = db.prepare('SELECT * FROM game_sessions WHERE session_code = ?').get(sessionCode);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const team = db.prepare('SELECT * FROM teams WHERE session_id = ? AND name = ?').get(session.id, teamName);
  if (!team || !verifyPassword(password, team.password_hash)) {
    return res.status(401).json({ error: 'Invalid team name or password' });
  }

  db.prepare(`UPDATE teams SET connected = 1, status = CASE WHEN status = 'NOT_JOINED' THEN 'WAITING' ELSE status END WHERE id = ?`).run(team.id);
  const evt = logEvent(session.id, team.id, 'TEAM_CONNECTED', `Team "${team.name}" connected`);
  broadcastSessionState(req.app.locals.io, session.id);
  broadcastEvent(req.app.locals.io, session.session_code, evt);

  res.json({ token: signTeamToken(team), sessionCode: session.session_code, teamName: team.name });
});

router.use(requireTeam);

function loadContext(req) {
  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(req.team.teamId);
  const session = db.prepare('SELECT * FROM game_sessions WHERE id = ?').get(req.team.sessionId);
  return { team, session };
}

router.get('/state', (req, res) => {
  const { team, session } = loadContext(req);
  if (!team || !session) return res.status(404).json({ error: 'Team or session not found' });

  if (isTeamTimeExpired(session) && team.status === 'SOLVING') {
    db.prepare(`UPDATE teams SET status = 'LOCKED_OUT' WHERE id = ?`).run(team.id);
    team.status = 'LOCKED_OUT';
  }

  const teamPuzzles = db
    .prepare(
      `SELECT tp.*, p.puzzle_type, p.title, p.question, p.configuration FROM team_puzzles tp
       JOIN puzzles p ON p.id = tp.puzzle_id
       WHERE tp.team_id = ? ORDER BY tp.sequence_number`
    )
    .all(team.id);

  const finalCode = db.prepare('SELECT * FROM final_codes WHERE team_id = ?').get(team.id);

  res.json({
    session: serializeSessionForTeam(session),
    team: {
      name: team.name,
      status: team.status,
      qualified: !!team.qualified,
      escapedAt: team.escaped_at,
    },
    puzzles: teamPuzzles.map((tp) =>
      serializeTeamPuzzleForTeam(tp, { puzzle_type: tp.puzzle_type, title: tp.title, question: tp.question, configuration: tp.configuration }, !!session.debug_mode)
    ),
    finalCode: finalCode ? serializeFinalCodeForTeam(team.id, finalCode, !!session.debug_mode) : null,
  });
});

// ---- Answer validation (Section 23): client may pre-validate for UX (e.g. "must be
// 6 digits") but the pass/fail decision that actually advances the game is always here.
router.post('/puzzles/:sequence/submit', (req, res) => {
  const { team, session } = loadContext(req);
  if (!team || !session) return res.status(404).json({ error: 'Team or session not found' });
  if (session.status !== 'LIVE') return res.status(409).json({ error: 'Game is not live' });
  if (isTeamTimeExpired(session)) return res.status(409).json({ error: 'Time has expired' });

  const sequence = Number(req.params.sequence);
  const { answer } = req.body || {};

  const tp = db
    .prepare(
      `SELECT tp.*, p.answer as correct_answer, p.title FROM team_puzzles tp
       JOIN puzzles p ON p.id = tp.puzzle_id
       WHERE tp.team_id = ? AND tp.sequence_number = ?`
    )
    .get(team.id, sequence);
  if (!tp) return res.status(404).json({ error: 'Puzzle not found for this team' });
  if (tp.status === 'COMPLETE') return res.status(409).json({ error: 'Already completed' });
  if (tp.status === 'LOCKED') return res.status(409).json({ error: 'Previous puzzle not yet complete' });
  if (tp.status === 'PENDING_COORDINATOR') return res.status(409).json({ error: 'Waiting for coordinator confirmation' });

  db.prepare('UPDATE team_puzzles SET attempts = attempts + 1 WHERE id = ?').run(tp.id);

  const normalize = (v) => String(v ?? '').trim().toLowerCase().replace(/\s+/g, '');
  const correct = normalize(answer) === normalize(tp.correct_answer);

  if (!correct) {
    const evt = logEvent(session.id, team.id, 'PUZZLE_ATTEMPT_FAILED', `Team "${team.name}" submitted an incorrect answer for puzzle ${sequence}`);
    broadcastEvent(req.app.locals.io, session.session_code, evt);
    broadcastSessionState(req.app.locals.io, session.id);
    return res.json({ correct: false });
  }

  if (session.coordinator_verification) {
    db.prepare(`UPDATE team_puzzles SET status = 'PENDING_COORDINATOR' WHERE id = ?`).run(tp.id);
  } else {
    db.prepare(`UPDATE team_puzzles SET status = 'COMPLETE', completed_at = datetime('now') WHERE id = ?`).run(tp.id);
    const next = db.prepare('SELECT * FROM team_puzzles WHERE team_id = ? AND sequence_number = ?').get(team.id, sequence + 1);
    if (next) {
      db.prepare(`UPDATE team_puzzles SET status = 'ACTIVE', started_at = datetime('now') WHERE id = ?`).run(next.id);
    } else {
      db.prepare('UPDATE final_codes SET unlocked = 1 WHERE team_id = ?').run(team.id);
    }
  }

  const evt = logEvent(
    session.id,
    team.id,
    'PUZZLE_SOLVED',
    `Team "${team.name}" solved puzzle ${sequence}${session.coordinator_verification ? ' — awaiting coordinator confirmation' : ''}`
  );
  broadcastEvent(req.app.locals.io, session.session_code, evt);
  broadcastSessionState(req.app.locals.io, session.id);

  res.json({ correct: true, pendingCoordinator: !!session.coordinator_verification });
});

// ---- Optional coordinator unlock-token submission (Section 26) ----
router.post('/unlock-token/submit', (req, res) => {
  const { team } = loadContext(req);
  const { token, sequence } = req.body || {};
  const tp = db.prepare('SELECT * FROM team_puzzles WHERE team_id = ? AND sequence_number = ?').get(team.id, sequence);
  if (!tp || tp.unlock_token !== token) return res.status(401).json({ error: 'Invalid unlock token' });
  res.json({ ok: true });
});

// ---- Final Lock: the 6-digit code derived from the 4 mini-puzzles ----------
// UNLIMITED ATTEMPTS BY DESIGN: there is no attempt counter, cooldown, or lockout
// anywhere in this route. A team can submit as many incorrect codes as they want —
// attempts_used is written purely as an organizer-facing stat and never read back to
// gate anything here.
router.post('/final-code/submit', (req, res) => {
  const { team, session } = loadContext(req);
  if (!team || !session) return res.status(404).json({ error: 'Team or session not found' });
  if (session.status !== 'LIVE') return res.status(409).json({ error: 'Game is not live' });
  if (isTeamTimeExpired(session)) return res.status(409).json({ error: 'Time has expired' });
  if (team.status === 'ESCAPED') return res.status(409).json({ error: 'This team has already escaped' });

  const finalCode = db.prepare('SELECT * FROM final_codes WHERE team_id = ?').get(team.id);
  if (!finalCode || !finalCode.unlocked) {
    return res.status(409).json({ error: 'Solve all 4 mini-puzzles first to unlock the Final Lock.' });
  }

  // Format validation happens here, server-side, independent of whatever the frontend
  // already restricts the input to. Sent as a string so leading zeros are preserved —
  // "001234" must never be coerced into the number 1234.
  const raw = req.body?.code;
  const submitted = String(raw ?? '').trim();
  if (!/^\d{6}$/.test(submitted)) {
    return res.status(400).json({ error: 'Invalid code — enter exactly 6 digits.', correct: false });
  }

  const { code: correctCode, valid, reason } = computeFinalCode(team.id);
  if (!valid) {
    // Organizer misconfiguration (mini-puzzle codeDigits don't total 6 digits) — tell the
    // team something sane happened rather than silently rejecting every code forever.
    logEvent(session.id, team.id, 'FINAL_CODE_MISCONFIGURED', `Final code for team "${team.name}" is misconfigured: ${reason}`);
    return res.status(500).json({ error: 'This session\u2019s final code is misconfigured. Please tell the organizer.' });
  }

  // Increment the informational counter only — never checked or enforced anywhere.
  db.prepare('UPDATE final_codes SET attempts_used = attempts_used + 1 WHERE team_id = ?').run(team.id);

  if (submitted !== correctCode) {
    const evt = logEvent(session.id, team.id, 'FINAL_CODE_FAILED', `Team "${team.name}" entered an incorrect final code`);
    broadcastEvent(req.app.locals.io, session.session_code, evt);
    broadcastSessionState(req.app.locals.io, session.id);
    return res.json({ correct: false, message: '\u274c Incorrect code. Check the four mini-puzzle results and try again.' });
  }

  db.prepare(`UPDATE teams SET status = 'ESCAPED', escaped_at = datetime('now') WHERE id = ?`).run(team.id);
  recalculateQualification(session.id);

  const updatedTeam = db.prepare('SELECT * FROM teams WHERE id = ?').get(team.id);
  const evt = logEvent(
    session.id, team.id, 'TEAM_ESCAPED',
    `Team "${team.name}" escaped${updatedTeam.qualified ? ` — QUALIFIED (#${updatedTeam.qualified_rank})` : ''}`
  );
  broadcastEvent(req.app.locals.io, session.session_code, evt);
  broadcastSessionState(req.app.locals.io, session.id);

  res.json({
    correct: true,
    escapeTimeSeconds: computeRemainingSeconds(session) >= 0 ? session.duration_seconds - computeRemainingSeconds(session) : null,
    qualified: !!updatedTeam.qualified,
    qualifiedRank: updatedTeam.qualified_rank,
  });
});

export default router;
