import db from '../db/index.js';

// ---- Server-authoritative timer (Section 15.1) -----------------------------
// remaining = duration_seconds - (server_now() - game_start_time) + total_paused_seconds
// Computed fresh on every read. Clients only ever display this; they never decide it.
export function computeRemainingSeconds(session) {
  if (!session.started_at) return session.duration_seconds;

  const startMs = Date.parse(session.started_at + 'Z');
  const pausedSeconds = session.total_paused_seconds || 0;

  let elapsedMs;
  if (session.status === 'PAUSED' && session.paused_at) {
    const pausedAtMs = Date.parse(session.paused_at + 'Z');
    elapsedMs = pausedAtMs - startMs;
  } else {
    elapsedMs = Date.now() - startMs;
  }

  const elapsedSeconds = Math.floor(elapsedMs / 1000) - pausedSeconds;
  const remaining = session.duration_seconds - elapsedSeconds;
  return Math.max(0, remaining);
}

export function isTeamTimeExpired(session) {
  if (session.status !== 'LIVE' && session.status !== 'PAUSED') return false;
  return computeRemainingSeconds(session) <= 0;
}

// ---- Event log (Section 19) -------------------------------------------------
export function logEvent(sessionId, teamId, eventType, message, metadata = {}) {
  const stmt = db.prepare(
    `INSERT INTO game_events (session_id, team_id, event_type, message, metadata)
     VALUES (?, ?, ?, ?, ?)`
  );
  const info = stmt.run(sessionId, teamId ?? null, eventType, message, JSON.stringify(metadata));
  return db.prepare('SELECT * FROM game_events WHERE id = ?').get(info.lastInsertRowid);
}

// ---- Qualification (Section 16) ---------------------------------------------
// First N teams to escape qualify, ranked strictly by recorded escape timestamp.
// Non-qualifiers are never force-ended; they simply keep their EASCAPED status, unqualified.
export function recalculateQualification(sessionId) {
  const session = db.prepare('SELECT * FROM game_sessions WHERE id = ?').get(sessionId);
  const maxQualifiers = session.max_qualifiers;

  const escapedTeams = db
    .prepare(
      `SELECT * FROM teams WHERE session_id = ? AND escaped_at IS NOT NULL ORDER BY escaped_at ASC`
    )
    .all(sessionId);

  const update = db.prepare('UPDATE teams SET qualified = ?, qualified_rank = ? WHERE id = ?');
  escapedTeams.forEach((team, idx) => {
    const qualified = idx < maxQualifiers ? 1 : 0;
    const rank = qualified ? idx + 1 : null;
    update.run(qualified, rank, team.id);
  });
}

// ---- Final 6-digit code, derived from the 4 mini-puzzles --------------------
// The code is NEVER stored — it is recomputed on every check from each completed
// mini-puzzle's `configuration.codeDigits` (falling back to the puzzle's own `answer`
// if codeDigits isn't set). This means changing a mini-puzzle's answer or codeDigits
// in the Puzzle Manager immediately changes the resulting final code for every team on
// that puzzle set, with nothing else to keep in sync.
//
// Returns { code, valid, reason } where `valid` is false if the four segments don't add
// up to exactly 6 digits (a misconfiguration the organizer needs to fix), so a team can
// never accidentally be given an unsolvable/mismatched lock.
export function computeFinalCode(teamId) {
  const rows = db
    .prepare(
      `SELECT tp.sequence_number, tp.status, p.answer, p.configuration FROM team_puzzles tp
       JOIN puzzles p ON p.id = tp.puzzle_id
       WHERE tp.team_id = ? ORDER BY tp.sequence_number ASC`
    )
    .all(teamId);

  if (rows.length !== 4) {
    return { code: null, valid: false, reason: `Expected 4 mini-puzzles, found ${rows.length}.` };
  }

  let code = '';
  for (const row of rows) {
    const config = JSON.parse(row.configuration || '{}');
    const segment = String(config.codeDigits ?? row.answer ?? '').trim();
    if (!/^\d+$/.test(segment)) {
      return { code: null, valid: false, reason: `Puzzle ${row.sequence_number} has no valid numeric codeDigits/answer.` };
    }
    code += segment;
  }

  if (code.length !== 6) {
    return { code: null, valid: false, reason: `Mini-puzzle segments total ${code.length} digits, expected exactly 6.` };
  }

  return { code, valid: true, reason: null };
}

// ---- Serializers -------------------------------------------------------------
// Team-facing view: never leaks other teams' data, correct answers, or the final code.
export function serializeSessionForTeam(session) {
  return {
    sessionCode: session.session_code,
    status: session.status,
    durationSeconds: session.duration_seconds,
    remainingSeconds: computeRemainingSeconds(session),
    coordinatorVerification: !!session.coordinator_verification,
  };
}

export function serializeTeamPuzzleForTeam(tp, puzzle, debugMode) {
  const config = JSON.parse(puzzle.configuration || '{}');
  const out = {
    sequenceNumber: tp.sequence_number,
    status: tp.status,
    attempts: tp.attempts,
    puzzleType: puzzle.puzzle_type,
    title: puzzle.title,
    question: puzzle.question,
    hint: config.hint || null,
  };
  if (debugMode) out.debugAnswer = puzzle.answer; // rehearsal-only escape hatch (Section 25)
  return out;
}

// Team-facing final-lock view: intentionally minimal. No digits, no attempt count, no
// attempts-remaining — there is no limit to show. Only whether the lock is unlocked yet.
export function serializeFinalCodeForTeam(teamId, fc, debugMode) {
  const out = { unlocked: !!fc.unlocked };
  if (debugMode) {
    const result = computeFinalCode(teamId);
    out.debugCode = result.valid ? result.code : `(misconfigured: ${result.reason})`;
  }
  return out;
}

// Admin-facing view: full visibility, including the authoritative final code (Section 13.2).
export function serializeTeamForAdmin(team) {
  const session = db.prepare('SELECT * FROM game_sessions WHERE id = ?').get(team.session_id);
  const teamPuzzles = db
    .prepare(
      `SELECT tp.*, p.title, p.puzzle_type FROM team_puzzles tp
       JOIN puzzles p ON p.id = tp.puzzle_id
       WHERE tp.team_id = ? ORDER BY tp.sequence_number ASC`
    )
    .all(team.id);
  const finalCode = db.prepare('SELECT * FROM final_codes WHERE team_id = ?').get(team.id);
  const completed = teamPuzzles.filter((tp) => tp.status === 'COMPLETE').length;

  return {
    id: team.id,
    name: team.name,
    puzzleSet: team.puzzle_set,
    connected: !!team.connected,
    status: team.status,
    escapedAt: team.escaped_at,
    qualified: !!team.qualified,
    qualifiedRank: team.qualified_rank,
    progress: { completed, total: teamPuzzles.length },
    puzzles: teamPuzzles.map((tp) => ({
      teamPuzzleId: tp.id,
      sequenceNumber: tp.sequence_number,
      title: tp.title,
      puzzleType: tp.puzzle_type,
      status: tp.status,
      attempts: tp.attempts,
      startedAt: tp.started_at,
      completedAt: tp.completed_at,
    })),
    finalCode: finalCode
      ? {
          ...computeFinalCode(team.id), // { code, valid, reason } — organizer-facing, computed live
          attemptsUsed: finalCode.attempts_used, // informational only, never a limit
          unlocked: !!finalCode.unlocked,
        }
      : null,
    remainingSeconds: computeRemainingSeconds(session),
  };
}

export function serializeSessionForAdmin(session) {
  const teams = db.prepare('SELECT * FROM teams WHERE session_id = ?').all(session.id);
  return {
    id: session.id,
    sessionCode: session.session_code,
    status: session.status,
    durationSeconds: session.duration_seconds,
    remainingSeconds: computeRemainingSeconds(session),
    maxQualifiers: session.max_qualifiers,
    coordinatorVerification: !!session.coordinator_verification,
    debugMode: !!session.debug_mode,
    isActiveConfig: !!session.is_active_config,
    startedAt: session.started_at,
    pausedAt: session.paused_at,
    teamsConnected: teams.filter((t) => t.connected).length,
    teamsTotal: teams.length,
  };
}

// ---- Realtime broadcast helper ------------------------------------------------
// Every device — Admin and every Team — subscribes to the same session room, so any
// change is reflected everywhere immediately with no manual refresh (Section 7/8/17).
export function broadcastSessionState(io, sessionId) {
  const session = db.prepare('SELECT * FROM game_sessions WHERE id = ?').get(sessionId);
  if (!session) return;
  const room = `session:${session.session_code}`;

  io.to(room).emit('session:update', serializeSessionForTeam(session));

  const teams = db.prepare('SELECT * FROM teams WHERE session_id = ?').all(sessionId);
  io.to(`admin:${session.session_code}`).emit(
    'admin:teams',
    teams.map(serializeTeamForAdmin)
  );
  io.to(`admin:${session.session_code}`).emit('admin:session', serializeSessionForAdmin(session));
}

export function broadcastEvent(io, sessionCode, event) {
  io.to(`admin:${sessionCode}`).emit('admin:event', event);
}
