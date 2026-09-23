import jwt from 'jsonwebtoken';
import db from './db/index.js';
import { logEvent, broadcastSessionState, broadcastEvent } from './services/gameService.js';

const JWT_SECRET = process.env.JWT_SECRET;

// Every device — Admin and every Team — connects to the same live session so that any
// change the Admin makes is reflected everywhere immediately (Section 7/17). No device
// is ever the authority on time, correctness or game state; sockets only carry pushes
// of state that was already decided by the REST endpoints above.
export function registerSocketHandlers(io) {
  io.on('connection', (socket) => {
    socket.on('auth:admin', ({ token, sessionCode }) => {
      try {
        const payload = jwt.verify(token, JWT_SECRET);
        if (payload.role !== 'ADMIN') return socket.emit('auth:error', 'Not an admin token');
        socket.join(`admin:${sessionCode}`);
        socket.join(`session:${sessionCode}`);
        socket.emit('auth:ok', { role: 'ADMIN' });
      } catch {
        socket.emit('auth:error', 'Invalid admin token');
      }
    });

    socket.on('auth:team', ({ token }) => {
      try {
        const payload = jwt.verify(token, JWT_SECRET);
        if (payload.role !== 'TEAM') return socket.emit('auth:error', 'Not a team token');
        const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(payload.teamId);
        const session = db.prepare('SELECT * FROM game_sessions WHERE id = ?').get(payload.sessionId);
        if (!team || !session) return socket.emit('auth:error', 'Team/session not found');

        socket.data.teamId = team.id;
        socket.data.sessionCode = session.session_code;
        socket.join(`session:${session.session_code}`);

        db.prepare('UPDATE teams SET connected = 1 WHERE id = ?').run(team.id);
        const evt = logEvent(session.id, team.id, 'TEAM_SOCKET_CONNECTED', `Team "${team.name}" is now live-connected`);
        broadcastSessionState(io, session.id);
        broadcastEvent(io, session.session_code, evt);
        socket.emit('auth:ok', { role: 'TEAM' });
      } catch {
        socket.emit('auth:error', 'Invalid team token');
      }
    });

    socket.on('disconnect', () => {
      const { teamId, sessionCode } = socket.data || {};
      if (!teamId) return;

      // Only mark disconnected if no other socket for this team is still around
      // (a team could have two tabs/devices open).
      const stillConnected = [...(io.sockets.adapter.rooms.get(`session:${sessionCode}`) || [])].some((id) => {
        const s = io.sockets.sockets.get(id);
        return s && s.data?.teamId === teamId && s.id !== socket.id;
      });
      if (stillConnected) return;

      const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(teamId);
      if (!team) return;
      db.prepare('UPDATE teams SET connected = 0 WHERE id = ?').run(teamId);
      const evt = logEvent(team.session_id, team.id, 'TEAM_DISCONNECTED', `Team "${team.name}" disconnected`);
      broadcastSessionState(io, team.session_id);
      broadcastEvent(io, sessionCode, evt);
    });
  });
}
