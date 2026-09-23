import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { Server } from 'socket.io';

import adminRoutes from './routes/admin.js';
import teamRoutes from './routes/team.js';
import { registerSocketHandlers } from './socket.js';
import db from './db/index.js';

const PORT = process.env.PORT || 4000;
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:5173';
const allowedOrigins = CORS_ORIGIN.split(',').map((origin) => origin.trim()).filter(Boolean);

const app = express();
app.use(cors({ origin: allowedOrigins }));
app.use(express.json());

app.get('/api/health', (req, res) => res.json({ ok: true, service: 'brainhunt-backend' }));

app.use('/api/admin', adminRoutes);
app.use('/api/team', teamRoutes);

// Fallback error handler so an unexpected error doesn't leak a stack trace to the client.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: allowedOrigins } });
app.locals.io = io;
registerSocketHandlers(io);

// Server-side safety net: periodically check every LIVE session for teams whose time
// has run out, so a team can't dodge the timer just by never calling GET /state.
setInterval(() => {
  const liveSessions = db.prepare(`SELECT * FROM game_sessions WHERE status = 'LIVE'`).all();
  for (const session of liveSessions) {
    // gameService.isTeamTimeExpired is per-session; lock any SOLVING team whose time is up.
    import('./services/gameService.js').then(({ isTeamTimeExpired, broadcastSessionState }) => {
      if (isTeamTimeExpired(session)) {
        const changed = db
          .prepare(`UPDATE teams SET status = 'LOCKED_OUT' WHERE session_id = ? AND status = 'SOLVING'`)
          .run(session.id);
        if (changed.changes > 0) broadcastSessionState(io, session.id);
      }
    });
  }
}, 5000);

httpServer.listen(PORT, () => {
  console.log(`Brain Hunt backend listening on http://localhost:${PORT}`);
});
