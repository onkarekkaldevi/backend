import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('FATAL: JWT_SECRET is not set. Set it in backend/.env before starting.');
  process.exit(1);
}

const ADMIN_TOKEN_TTL = '12h';
const TEAM_TOKEN_TTL = '6h';

export function hashPassword(plain) {
  return bcrypt.hashSync(plain, 10);
}

export function verifyPassword(plain, hash) {
  return bcrypt.compareSync(plain, hash);
}

export function signAdminToken(admin) {
  return jwt.sign({ role: 'ADMIN', adminId: admin.id, username: admin.username }, JWT_SECRET, {
    expiresIn: ADMIN_TOKEN_TTL,
  });
}

export function signTeamToken(team) {
  return jwt.sign(
    { role: 'TEAM', teamId: team.id, sessionId: team.session_id, name: team.name },
    JWT_SECRET,
    { expiresIn: TEAM_TOKEN_TTL }
  );
}

function extractToken(req) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) return null;
  return token;
}

// Two separate roles, never conflated (Section 20). Each middleware rejects the wrong role
// outright rather than trying to be lenient about it.
export function requireAdmin(req, res, next) {
  const token = extractToken(req);
  if (!token) return res.status(401).json({ error: 'Missing admin token' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.role !== 'ADMIN') return res.status(403).json({ error: 'Admin access only' });
    req.admin = payload;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired admin token' });
  }
}

export function requireTeam(req, res, next) {
  const token = extractToken(req);
  if (!token) return res.status(401).json({ error: 'Missing team token' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.role !== 'TEAM') return res.status(403).json({ error: 'Team access only' });
    req.team = payload;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired team token' });
  }
}
