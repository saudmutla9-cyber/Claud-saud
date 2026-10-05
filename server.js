// FM Challenge — live multiplayer quiz server
// Run: npm install  then  npm start
const express = require('express');
const http = require('http');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const QRCode = require('qrcode');
const { Server } = require('socket.io');
const QUESTIONS = require('./questions');

// ===== Settings =====
const PORT = Number(process.env.PORT) || 3000;
const ADMIN_PIN = process.env.ADMIN_PIN || '2026';   // رمز دخول المتحكم
const MAX_PLAYERS = 30;
const QUESTION_MS = 15000;                            // 15 ثانية لكل سؤال
const REVEAL_MS = 8000;                               // مدة عرض الترتيب قبل السؤال التالي (عند التقدم التلقائي)
const BASE_POINTS = 500;                              // نقاط الإجابة الصحيحة
const SPEED_POINTS = 500;                             // نقاط إضافية حسب السرعة (حد أقصى 1000 للسؤال)

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public'), { index: false }));
app.get('/', (req, res) => res.redirect('/play'));
app.get('/play', (req, res) => res.sendFile(path.join(__dirname, 'public', 'play.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// ===== Join link + QR =====
function lanIp() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const n of list || []) if (n.family === 'IPv4' && !n.internal) return n.address;
  }
  return 'localhost';
}
const JOIN_URL = process.env.PUBLIC_URL
  ? process.env.PUBLIC_URL.replace(/\/$/, '') + '/play'
  : `http://${lanIp()}:${PORT}/play`;
let QR_DATA = '';
QRCode.toDataURL(JOIN_URL, { margin: 1, width: 480, color: { dark: '#16205E', light: '#FFFFFF' } })
  .then(d => { QR_DATA = d; broadcast(); });

// ===== Game state =====
const game = {
  phase: 'lobby',          // lobby | question | reveal | final
  qIndex: -1,
  endsAt: 0,
  nextAt: 0,
  autoAdvance: true,
  timer: null,
  players: new Map()       // token -> { name, score, answers:{[q]:{choice,points,correct}}, socketId, connected }
};

const clearTimer = () => { if (game.timer) clearTimeout(game.timer); game.timer = null; };

function ranked() {
  return [...game.players.values()]
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'ar'));
}
function leaderboard() {
  return ranked().map(p => ({
    name: p.name,
    score: p.score,
    gained: (p.answers[game.qIndex] || {}).points || 0,
    connected: p.connected
  }));
}
function rankOf(player) {
  const list = ranked();
  // نفس النقاط = نفس المركز
  return list.findIndex(p => p.score === player.score) + 1;
}
function publicQuestion() {
  const q = QUESTIONS[game.qIndex];
  if (!q) return null;
  return { index: game.qIndex, total: QUESTIONS.length, ar: q.ar, en: q.en, options: q.options };
}
const answeredCount = () => [...game.players.values()].filter(p => p.answers[game.qIndex]).length;
const showCorrect = () => game.phase === 'reveal';

function baseState() {
  return {
    phase: game.phase,
    serverNow: Date.now(),
    endsAt: game.endsAt,
    nextAt: game.nextAt,
    question: game.phase === 'question' || game.phase === 'reveal' ? publicQuestion() : null,
    correct: showCorrect() ? QUESTIONS[game.qIndex].correct : null,
    total: QUESTIONS.length,
    playerCount: game.players.size
  };
}

function adminState() {
  const dist = [0, 0, 0, 0];
  if (game.qIndex >= 0) for (const p of game.players.values()) {
    const a = p.answers[game.qIndex];
    if (a) dist[a.choice]++;
  }
  return {
    ...baseState(),
    autoAdvance: game.autoAdvance,
    answered: answeredCount(),
    distribution: showCorrect() ? dist : null,
    leaderboard: leaderboard(),
    joinUrl: JOIN_URL,
    qr: QR_DATA,
    maxPlayers: MAX_PLAYERS
  };
}

function playerState(p) {
  const a = p.answers[game.qIndex];
  // أثناء السؤال لا نكشف النقاط المكتسبة حتى لا تُعرف صحة الإجابة قبل الإعلان
  const hidden = game.phase === 'question' && a ? a.points : 0;
  return {
    ...baseState(),
    me: { name: p.name, score: p.score - hidden, rank: rankOf(p) },
    myChoice: a ? a.choice : null,
    result: showCorrect() ? { answered: !!a, correct: !!(a && a.correct), points: a ? a.points : 0 } : null,
    leaderboard: game.phase === 'final' ? leaderboard() : null
  };
}

function broadcast() {
  io.to('admin').emit('state', adminState());
  for (const p of game.players.values()) {
    if (p.connected && p.socketId) io.to(p.socketId).emit('state', playerState(p));
  }
}

// ===== Flow =====
function startQuestion(i) {
  clearTimer();
  game.phase = 'question';
  game.qIndex = i;
  game.endsAt = Date.now() + QUESTION_MS;
  game.nextAt = 0;
  game.timer = setTimeout(endQuestion, QUESTION_MS + 250);
  broadcast();
}

function endQuestion() {
  if (game.phase !== 'question') return;
  clearTimer();
  game.phase = 'reveal';
  game.endsAt = Date.now();
  scheduleNext();
  broadcast();
}

function scheduleNext() {
  clearTimer();
  if (game.phase === 'reveal' && game.autoAdvance) {
    game.nextAt = Date.now() + REVEAL_MS;
    game.timer = setTimeout(next, REVEAL_MS);
  } else {
    game.nextAt = 0;
  }
}

function next() {
  clearTimer();
  if (game.qIndex + 1 < QUESTIONS.length) startQuestion(game.qIndex + 1);
  else { game.phase = 'final'; game.nextAt = 0; broadcast(); }
}

function resetGame(clearPlayers) {
  clearTimer();
  Object.assign(game, { phase: 'lobby', qIndex: -1, endsAt: 0, nextAt: 0 });
  if (clearPlayers) {
    for (const p of game.players.values()) if (p.socketId) io.to(p.socketId).emit('kicked');
    game.players.clear();
  } else {
    for (const p of game.players.values()) { p.score = 0; p.answers = {}; }
  }
  broadcast();
}

// ===== Sockets =====
function attach(socket, token) {
  const p = game.players.get(token);
  p.socketId = socket.id;
  p.connected = true;
  socket.data.token = token;
  socket.emit('state', playerState(p));
  io.to('admin').emit('state', adminState());
}

io.on('connection', socket => {
  // ---- Player ----
  socket.on('player:resume', ({ token } = {}, cb = () => {}) => {
    if (token && game.players.has(token)) { attach(socket, token); cb({ ok: true, name: game.players.get(token).name }); }
    else cb({ ok: false });
  });

  socket.on('player:join', ({ name } = {}, cb = () => {}) => {
    name = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 24);
    if (!name) return cb({ ok: false, error: 'اكتب اسمك أولاً · Please enter your name' });
    if (game.players.size >= MAX_PLAYERS) return cb({ ok: false, error: 'اكتمل عدد اللاعبين · The game is full' });
    const taken = [...game.players.values()].some(p => p.name.toLowerCase() === name.toLowerCase());
    if (taken) return cb({ ok: false, error: 'الاسم مستخدم، جرّب اسماً آخر · Name already taken' });
    const token = crypto.randomUUID();
    game.players.set(token, { name, score: 0, answers: {}, socketId: null, connected: false });
    attach(socket, token);
    cb({ ok: true, token, name });
  });

  socket.on('player:answer', ({ choice } = {}) => {
    const p = game.players.get(socket.data.token);
    if (!p || game.phase !== 'question' || p.answers[game.qIndex]) return;
    if (![0, 1, 2, 3].includes(choice)) return;
    const remaining = Math.max(0, game.endsAt - Date.now());
    if (remaining <= 0) return;
    const correct = choice === QUESTIONS[game.qIndex].correct;
    const points = correct ? Math.round(BASE_POINTS + SPEED_POINTS * (remaining / QUESTION_MS)) : 0;
    p.answers[game.qIndex] = { choice, correct, points };
    p.score += points;
    socket.emit('state', playerState(p));
    io.to('admin').emit('state', adminState());
    // إذا أجاب جميع اللاعبين المتصلين ينتهي السؤال مبكراً
    const online = [...game.players.values()].filter(x => x.connected);
    if (online.length && online.every(x => x.answers[game.qIndex])) setTimeout(endQuestion, 700);
  });

  // ---- Admin ----
  socket.on('admin:auth', ({ pin } = {}, cb = () => {}) => {
    if (String(pin) !== ADMIN_PIN) return cb({ ok: false });
    socket.data.isAdmin = true;
    socket.join('admin');
    cb({ ok: true });
    socket.emit('state', adminState());
  });

  const adminOnly = fn => (...args) => { if (socket.data.isAdmin) fn(...args); };
  socket.on('admin:start', adminOnly(() => {
    if (game.phase !== 'lobby' || game.players.size === 0) return;
    startQuestion(0);
  }));
  socket.on('admin:next', adminOnly(() => {
    if (game.phase === 'question') endQuestion();
    else if (game.phase === 'reveal') next();
  }));
  socket.on('admin:auto', adminOnly(({ on } = {}) => {
    game.autoAdvance = !!on;
    if (game.phase === 'reveal') scheduleNext();
    broadcast();
  }));
  socket.on('admin:reset', adminOnly(({ clearPlayers } = {}) => resetGame(!!clearPlayers)));
  socket.on('admin:kick', adminOnly(({ name } = {}) => {
    for (const [t, p] of game.players) if (p.name === name) {
      if (p.socketId) io.to(p.socketId).emit('kicked');
      game.players.delete(t);
    }
    broadcast();
  }));

  socket.on('disconnect', () => {
    const p = game.players.get(socket.data.token);
    if (p && p.socketId === socket.id) { p.connected = false; io.to('admin').emit('state', adminState()); }
  });
});

server.listen(PORT, () => {
  console.log('\n  FM Challenge is running');
  console.log(`  Players (QR link): ${JOIN_URL}`);
  console.log(`  Admin screen:      http://localhost:${PORT}/admin   (PIN: ${ADMIN_PIN})\n`);
});
