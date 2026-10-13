const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static('public'));

const MAP = 1600;
const CHARS = {
  gunner:  { name: 'ガンナー',   hp: 100, speed: 2.4, dmg: 12, range: 420, rate: 350,  bs: 12, spread: 0.05, n: 1 },
  shotgun: { name: 'ショット',   hp: 120, speed: 2.2, dmg: 8,  range: 260, rate: 700,  bs: 11, spread: 0.3,  n: 5 },
  sniper:  { name: 'スナイパー', hp: 80,  speed: 2.5, dmg: 40, range: 700, rate: 1100, bs: 20, spread: 0,    n: 1 },
  tank:    { name: 'タンク',     hp: 220, speed: 1.8, dmg: 15, range: 300, rate: 600,  bs: 11, spread: 0.1,  n: 2 },
};
const rooms = {};
const ranking = {}; // name -> {wins, kills}
const rk = (n) => (ranking[n] = ranking[n] || { wins: 0, kills: 0 });
const topRank = () =>
  Object.entries(ranking)
    .map(([n, v]) => ({ n, w: v.wins, k: v.kills }))
    .sort((a, b) => b.w - a.w || b.k - a.k)
    .slice(0, 10);

function mkPlayer(id, name, char, bot) {
  return { id, name, char, bot, x: 800, y: 800, hp: 100, m: 100, alive: false, k: 0, ang: 0, last: 0, wcd: 0,
    input: { dx: 0, dy: 0, angle: 0, shoot: false } };
}
function emitRoom(r) {
  io.to(r.code).emit('room', {
    code: r.code, host: r.host, state: r.state,
    players: Object.values(r.players).filter((p) => !p.bot).map((p) => ({ id: p.id, n: p.name, c: p.char })),
  });
}
function start(r) {
  Object.keys(r.players).forEach((id) => { if (r.players[id].bot) delete r.players[id]; });
  let b = 0;
  const ck = Object.keys(CHARS);
  while (Object.keys(r.players).length < 4) {
    b++;
    r.players['bot' + b] = mkPlayer('bot' + b, 'BOT' + b, ck[Math.floor(Math.random() * ck.length)], true);
  }
  const all = Object.values(r.players);
  all.forEach((p, i) => {
    const a = (i / all.length) * Math.PI * 2;
    p.x = MAP / 2 + Math.cos(a) * 600; p.y = MAP / 2 + Math.sin(a) * 600;
    p.hp = p.m = CHARS[p.char].hp; p.alive = true; p.k = 0;
  });
  r.bullets = []; r.walls = []; r.t = 0; r.zr = 800; r.state = 'play'; r.win = '';
  emitRoom(r);
}
function hurt(r, p, dmg, owner) {
  p.hp -= dmg;
  if (p.hp <= 0 && p.alive) {
    p.alive = false;
    if (owner) { owner.k++; if (!owner.bot) rk(owner.name).kills++; }
  }
}
function botAI(r, p, now) {
  const i = p.input;
  let t = null, bd = 1e9;
  for (const q of Object.values(r.players)) {
    if (q === p || !q.alive) continue;
    const d = Math.hypot(q.x - p.x, q.y - p.y);
    if (d < bd) { bd = d; t = q; }
  }
  const c = CHARS[p.char];
  const cd = Math.hypot(p.x - MAP / 2, p.y - MAP / 2);
  if (cd > r.zr - 60) {
    const a = Math.atan2(MAP / 2 - p.y, MAP / 2 - p.x);
    i.dx = Math.cos(a); i.dy = Math.sin(a);
  } else if (t) {
    const a = Math.atan2(t.y - p.y, t.x - p.x);
    const dir = bd > c.range * 0.6 ? 1 : -0.5;
    i.dx = Math.cos(a) * dir + Math.cos(a + 1.57) * 0.4;
    i.dy = Math.sin(a) * dir + Math.sin(a + 1.57) * 0.4;
  }
  if (t) { i.angle = Math.atan2(t.y - p.y, t.x - p.x); i.shoot = bd < c.range; }
}
function tick(r) {
  const now = Date.now(), dt = 1 / 30;
  const ps = Object.values(r.players);
  if (r.state === 'play') {
    r.t += dt;
    r.zr = Math.max(120, 800 - r.t * 8);
    for (const p of ps) {
      if (!p.alive) continue;
      if (p.bot) botAI(r, p, now);
      const c = CHARS[p.char], i = p.input;
      const len = Math.hypot(i.dx, i.dy) || 1;
      const m = Math.min(1, len);
      p.x += (i.dx / len) * m * c.speed * 2; p.y += (i.dy / len) * m * c.speed * 2;
      p.x = Math.max(20, Math.min(MAP - 20, p.x)); p.y = Math.max(20, Math.min(MAP - 20, p.y));
      for (const w of r.walls) {
        const d = Math.hypot(p.x - w.x, p.y - w.y);
        if (d < 44 && d > 0) { p.x = w.x + ((p.x - w.x) / d) * 44; p.y = w.y + ((p.y - w.y) / d) * 44; }
      }
      p.ang = i.angle;
      if (Math.hypot(p.x - MAP / 2, p.y - MAP / 2) > r.zr) hurt(r, p, 6 * dt, null);
      if (i.shoot && now - p.last > c.rate) {
        p.last = now;
        for (let k = 0; k < c.n; k++) {
          const a = i.angle + (Math.random() - 0.5) * c.spread * 2;
          r.bullets.push({ x: p.x, y: p.y, vx: Math.cos(a) * c.bs, vy: Math.sin(a) * c.bs, o: p.id, d: c.dmg, l: Math.ceil(c.range / c.bs) });
        }
      }
    }
    for (const b of r.bullets) {
      b.x += b.vx; b.y += b.vy; b.l--;
      for (const w of r.walls) if (Math.hypot(b.x - w.x, b.y - w.y) < 28) { w.hp -= b.d; b.l = 0; break; }
      if (b.l <= 0) continue;
      for (const p of ps) {
        if (!p.alive || p.id === b.o) continue;
        if (Math.hypot(b.x - p.x, b.y - p.y) < 20) { hurt(r, p, b.d, r.players[b.o]); b.l = 0; break; }
      }
    }
    r.bullets = r.bullets.filter((b) => b.l > 0);
    r.walls = r.walls.filter((w) => w.hp > 0);
    const al = ps.filter((p) => p.alive);
    if (al.length <= 1 || al.every((p) => p.bot)) {
      r.state = 'over';
      const w = al.sort((a, b) => b.k - a.k)[0];
      r.win = w ? w.name : 'なし';
      if (w && !w.bot) rk(w.name).wins++;
      io.emit('rank', topRank());
      setTimeout(() => { if (rooms[r.code]) { r.state = 'lobby'; emitRoom(r); } }, 4000);
    }
  }
  if (r.state !== 'lobby') {
    io.to(r.code).emit('s', {
      st: r.state, z: Math.round(r.zr), t: Math.round(r.t), win: r.win,
      p: ps.map((p) => ({ id: p.id, n: p.name, x: Math.round(p.x), y: Math.round(p.y), h: Math.round(p.hp), m: p.m, a: p.alive, g: +p.ang.toFixed(2), k: p.k })),
      b: r.bullets.map((b) => [Math.round(b.x), Math.round(b.y)]),
      w: r.walls.map((w) => [w.x, w.y, w.hp]),
    });
  }
}

io.on('connection', (sock) => {
  sock.emit('chars', CHARS);
  sock.emit('rank', topRank());
  let room = null;
  sock.on('join', ({ code, name, char }) => {
    code = String(code || '').toUpperCase().slice(0, 6);
    if (!code) return;
    if (!rooms[code]) rooms[code] = { code, host: sock.id, players: {}, bullets: [], walls: [], state: 'lobby', t: 0, zr: 800, win: '' };
    const r = rooms[code];
    if (Object.values(r.players).filter((p) => !p.bot).length >= 8) return sock.emit('chat', { n: 'システム', t: '部屋がいっぱいです' });
    room = r;
    sock.join(code);
    const p = mkPlayer(sock.id, String(name || 'ゲスト').slice(0, 8), CHARS[char] ? char : 'gunner', false);
    r.players[sock.id] = p;
    emitRoom(r);
    io.to(code).emit('chat', { n: 'システム', t: p.name + ' が参加' });
  });
  sock.on('char', (c) => {
    if (room && room.state === 'lobby' && CHARS[c] && room.players[sock.id]) { room.players[sock.id].char = c; emitRoom(room); }
  });
  sock.on('start', () => { if (room && room.host === sock.id && room.state === 'lobby') start(room); });
  sock.on('input', (i) => {
    const p = room && room.players[sock.id];
    if (!p || !i) return;
    p.input = { dx: +i.dx || 0, dy: +i.dy || 0, angle: +i.angle || 0, shoot: !!i.shoot };
  });
  sock.on('build', () => {
    const p = room && room.players[sock.id];
    const now = Date.now();
    if (!p || !p.alive || room.state !== 'play' || now - p.wcd < 800 || room.walls.length > 60) return;
    p.wcd = now;
    room.walls.push({ x: Math.round(p.x + Math.cos(p.ang) * 55), y: Math.round(p.y + Math.sin(p.ang) * 55), hp: 80 });
  });
  sock.on('chat', (t) => {
    const p = room && room.players[sock.id];
    if (p && t) io.to(room.code).emit('chat', { n: p.name, t: String(t).slice(0, 60) });
  });
  sock.on('disconnect', () => {
    if (!room) return;
    delete room.players[sock.id];
    const hs = Object.values(room.players).filter((p) => !p.bot);
    if (!hs.length) { delete rooms[room.code]; return; }
    if (room.host === sock.id) room.host = hs[0].id;
    emitRoom(room);
  });
});

setInterval(() => Object.values(rooms).forEach(tick), 33);
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('listening ' + PORT));
