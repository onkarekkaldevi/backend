import 'dotenv/config';
import db from './index.js';
import { hashPassword } from '../auth.js';

function seedAdmin() {
  const username = process.env.ADMIN_SEED_USERNAME || 'admin';
  const password = process.env.ADMIN_SEED_PASSWORD;
  if (!password) {
    console.error('Set ADMIN_SEED_PASSWORD in backend/.env before seeding. Refusing to seed a default password.');
    process.exit(1);
  }
  const existing = db.prepare('SELECT * FROM admins WHERE username = ?').get(username);
  if (existing) {
    console.log(`Admin "${username}" already exists — skipping.`);
    return;
  }
  db.prepare('INSERT INTO admins (username, password_hash) VALUES (?, ?)').run(username, hashPassword(password));
  console.log(`Seeded admin account "${username}". Change this password before the live event.`);
}

// ---------------------------------------------------------------------------
// Three parallel Final-Lock puzzle sets (A/B/C), one per team, matched in type,
// difficulty and step-count (spec §11). Each set is the team's 4 chained mini-puzzles.
//
// Each puzzle's `configuration.codeDigits` is the digit-string it contributes to the
// team's final 6-digit code, in sequence_number order (1 -> 4). Across the 4 puzzles in
// a set the codeDigits must total exactly 6 digits. If codeDigits is omitted, the
// puzzle's own `answer` is used instead — so an organizer can always change a puzzle's
// answer (or just its codeDigits) later without touching any other code (spec §2/§9).
// Leading zeros are preserved as strings on purpose (see Set C, puzzle 3) to exercise
// the "leading zero" requirement end-to-end.
//
// The series puzzles are deliberately NOT simple "+N each time" progressions — each one
// needs the solver to notice a recurrence relation (a(n) = f(a(n-1), n)), which takes
// a beat longer to spot than a constant difference/ratio.
// ---------------------------------------------------------------------------
const PUZZLE_SETS = {
  A: [
    {
      type: 'series',
      title: 'The Recurring Pattern',
      question:
        'Study this sequence closely — it is not a simple arithmetic or geometric progression:\n\n' +
        '5, 11, 23, 47, 95, ?\n\n' +
        'Find the rule connecting each term to the one before it, then find the missing term.',
      answer: '191',
      difficulty: 'hard',
      config: {
        hint: 'Look at what happens when you double a term and adjust by a small constant.',
        codeDigits: '91',
      },
    },
    {
      type: 'binary',
      title: 'Binary Multiplication',
      question:
        'Two binary numbers are given:\n\n  A = 1101\u2082\n  B = 011\u2082\n\n' +
        'Compute A \u00d7 B, and express the product in binary. Then add up the individual ' +
        'digits of that binary result (each 0 or 1 counts as itself) — that sum is your answer.',
      answer: '4',
      difficulty: 'hard',
      config: {
        hint: 'Convert A and B to decimal, multiply, then convert the product back to binary before adding up its digits.',
        codeDigits: '4',
      },
    },
    {
      type: 'logic',
      title: 'Trace the Program',
      question:
        'Trace this code by hand — do not guess:\n\n' +
        'a = 2\nb = 5\nfor i in range(3):\n    a, b = b, a + b\nprint(a)\n\n' +
        'What value is printed?',
      answer: '12',
      difficulty: 'hard',
      config: {
        hint: 'The assignment "a, b = b, a + b" updates both at once, using the OLD values of a and b.',
        codeDigits: '12',
      },
    },
    {
      type: 'pattern',
      title: 'Letter-Value Cipher',
      question:
        'Using A=1, B=2, ... Z=26, sum the letter values in the word "ECHO". Then take that ' +
        'sum modulo 10 (the remainder when divided by 10). What is the result?',
      answer: '1',
      difficulty: 'medium',
      config: { hint: 'E=5, C=3, H=8, O=15. Add them, then find the remainder after dividing by 10.', codeDigits: '1' },
    },
  ],
  B: [
    {
      type: 'series',
      title: 'The Recurring Pattern',
      question:
        'This sequence follows a consistent rule linking each term to the one before it — it is ' +
        'not simple addition or multiplication throughout:\n\n4, 9, 19, 39, 79, ?\n\n' +
        'Determine the rule and find the missing term.',
      answer: '159',
      difficulty: 'hard',
      config: {
        hint: 'Try doubling a term and adjusting by a small constant to reach the next one.',
        codeDigits: '59',
      },
    },
    {
      type: 'binary',
      title: 'Binary Subtraction',
      question:
        'Compute 1110\u2082 \u2212 0101\u2082 and express the result in binary. Then add up the individual ' +
        'digits of that binary result (each 0 or 1 counts as itself) — that sum is your answer.',
      answer: '2',
      difficulty: 'hard',
      config: {
        hint: '1110\u2082 = 14, 0101\u2082 = 5. Subtract as decimal, convert the difference back to binary, then add up its digits.',
        codeDigits: '2',
      },
    },
    {
      type: 'logic',
      title: 'Trace the Program',
      question:
        'Trace this code by hand:\n\n' +
        'x = 1\ny = 1\nfor i in range(4):\n    x, y = y, x + 2*y\nprint(y)\n\n' +
        'What value is printed?',
      answer: '41',
      difficulty: 'hard',
      config: {
        hint: 'Each loop, the NEW y depends on the OLD x and OLD y together — write out all 4 iterations on paper.',
        codeDigits: '41',
      },
    },
    {
      type: 'pattern',
      title: 'Letter-Value Cipher',
      question:
        'Using A=1, B=2, ... Z=26, sum the letter values in the word "NOVA". Then take that sum ' +
        'modulo 10. What is the result?',
      answer: '2',
      difficulty: 'medium',
      config: { hint: 'N=14, O=15, V=22, A=1. Add them, then find the remainder after dividing by 10.', codeDigits: '2' },
    },
  ],
  C: [
    {
      type: 'series',
      title: 'The Recurring Pattern',
      question:
        'As before, find the rule linking consecutive terms — it is not constant addition:\n\n' +
        '6, 13, 27, 55, 111, ?\n\nFind the missing term.',
      answer: '223',
      difficulty: 'hard',
      config: {
        hint: 'Doubling a term and adjusting by a small constant gets you to the next one.',
        codeDigits: '23',
      },
    },
    {
      type: 'binary',
      title: 'Binary Addition',
      question:
        'Compute 1011\u2082 + 1101\u2082 and express the result in binary. Then add up the individual ' +
        'digits of that binary result (each 0 or 1 counts as itself) — that sum is your answer.',
      answer: '2',
      difficulty: 'hard',
      config: {
        hint: '1011\u2082 = 11, 1101\u2082 = 13. Add as decimal, convert the sum back to binary, then add up its digits.',
        codeDigits: '2',
      },
    },
    {
      type: 'logic',
      title: 'Trace the Program',
      question:
        'Trace this code by hand — it counts something, it does not print a running value:\n\n' +
        'n = 20\ncount = 0\nwhile n > 1:\n    if n % 2 == 0:\n        n = n // 2\n    else:\n        n = 3 * n + 1\n    count += 1\nprint(count)\n\n' +
        'What value is printed?',
      answer: '7',
      difficulty: 'hard',
      config: {
        hint: 'Write out each value of n step by step until it reaches 1, counting every step.',
        // Deliberately zero-padded to 2 digits to exercise "leading zeros are preserved"
        // end-to-end, even though the puzzle's own answer (7) is a single digit.
        codeDigits: '07',
      },
    },
    {
      type: 'pattern',
      title: 'Letter-Value Cipher',
      question:
        'Using A=1, B=2, ... Z=26, sum the letter values in the word "RAY". Then take that sum ' +
        'modulo 10. What is the result?',
      answer: '4',
      difficulty: 'medium',
      config: { hint: 'R=18, A=1, Y=25. Add them, then find the remainder after dividing by 10.', codeDigits: '4' },
    },
  ],
};

function seedDemoSession() {
  const code = `BH-${new Date().getFullYear()}-DEMO`;
  let session = db.prepare('SELECT * FROM game_sessions WHERE session_code = ?').get(code);
  if (session) {
    console.log(`Demo session ${code} already exists — skipping.`);
    return;
  }

  const info = db
    .prepare(
      `INSERT INTO game_sessions (session_code, status, duration_seconds, max_qualifiers, coordinator_verification)
       VALUES (?, 'WAITING', 1200, 2, 0)`
    )
    .run(code);
  session = db.prepare('SELECT * FROM game_sessions WHERE id = ?').get(info.lastInsertRowid);

  const insertPuzzle = db.prepare(
    `INSERT INTO puzzles (session_id, puzzle_set, sequence_number, puzzle_type, title, question, answer, difficulty, configuration)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const [set, puzzles] of Object.entries(PUZZLE_SETS)) {
    // Sanity-check each set's codeDigits total exactly 6 digits before writing anything.
    const total = puzzles.reduce((sum, p) => sum + String(p.config.codeDigits ?? p.answer).length, 0);
    if (total !== 6) {
      throw new Error(`Puzzle set ${set} codeDigits total ${total} digits, expected exactly 6.`);
    }
    puzzles.forEach((p, idx) => {
      insertPuzzle.run(session.id, set, idx + 1, p.type, p.title, p.question, p.answer, p.difficulty, JSON.stringify(p.config));
    });
  }

  const insertTeam = db.prepare('INSERT INTO teams (session_id, name, password_hash, puzzle_set) VALUES (?, ?, ?, ?)');
  const insertTp = db.prepare('INSERT INTO team_puzzles (team_id, puzzle_id, sequence_number, status) VALUES (?, ?, ?, ?)');
  const insertFinalCode = db.prepare('INSERT INTO final_codes (team_id, attempts_used, unlocked) VALUES (?, 0, 0)');

  const demoTeams = [
    { name: 'Team 1', password: 'demo-pass-1', set: 'A' },
    { name: 'Team 2', password: 'demo-pass-2', set: 'B' },
    { name: 'Team 3', password: 'demo-pass-3', set: 'C' },
  ];

  for (const t of demoTeams) {
    const teamInfo = insertTeam.run(session.id, t.name, hashPassword(t.password), t.set);
    const teamId = teamInfo.lastInsertRowid;
    const puzzles = db.prepare('SELECT * FROM puzzles WHERE session_id = ? AND puzzle_set = ? ORDER BY sequence_number').all(session.id, t.set);
    puzzles.forEach((p) => insertTp.run(teamId, p.id, p.sequence_number, 'LOCKED'));
    insertFinalCode.run(teamId);
  }

  console.log(`Seeded demo session ${code} with 3 teams (passwords: demo-pass-1/2/3).`);
  console.log('Final codes are computed from each puzzle set\u2019s codeDigits — Team 1 (Set A) = 914121, Team 2 (Set B) = 592412, Team 3 (Set C) = 232074.');
}

seedAdmin();
seedDemoSession();
console.log('Seeding complete.');
