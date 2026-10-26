'use strict';
/*
 * server.js — 房间服务（服务端权威）
 *
 * 职责：
 *   1. 托管 public/index.html
 *   2. 维护房间：4 位房间码、A/B 两个座位、关卡进度
 *   3. 运行关卡状态机，给每一端裁剪出它该看到的那一半
 *   4. 断线 2 分钟内可凭 token 重连恢复
 *
 * 零依赖：`node server.js` 直接跑。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const { attachWebSocket } = require('./lib/ws');
const { LEVELS } = require('./shared/levels');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = __dirname;
// Render 会自动注入 RENDER_EXTERNAL_URL；本地部署也可以用 PUBLIC_URL 手动指定
const PUBLIC_URL = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// 只暴露这三个文件，避免路径穿越
const STATIC = {
  '/index.html': path.join(ROOT, 'public', 'index.html'),
  '/shared/levels.js': path.join(ROOT, 'shared', 'levels.js'),
};

/* ------------------------------ HTTP ------------------------------ */

const server = http.createServer((req, res) => {
  let p;
  try {
    p = new URL(req.url, 'http://localhost').pathname;
  } catch (e) {
    res.writeHead(400);
    return res.end('bad request');
  }
  if (p === '/') p = '/index.html';
  if (p === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }
  const file = STATIC[p];
  if (!file) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('not found');
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404);
      return res.end('not found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  });
});

/* ------------------------------ 房间 ------------------------------ */

const rooms = new Map();
const now = () => Date.now();

/* 公网部署时的基本防护：房间上限 + 按 IP 限流 */
const MAX_ROOMS = Number(process.env.MAX_ROOMS || 500);
const buckets = new Map();

function allow(key, limit, windowMs) {
  const t = now();
  let b = buckets.get(key);
  if (!b || t > b.reset) {
    b = { n: 0, reset: t + windowMs };
    buckets.set(key, b);
  }
  b.n++;
  return b.n <= limit;
}

function ipOf(conn) {
  const f = String(conn.forwardedFor || '').split(',')[0].trim();
  return f || conn.remoteAddress || 'unknown';
}

function makeCode() {
  let code;
  do {
    code = String(1000 + crypto.randomInt(9000));
  } while (rooms.has(code));
  return code;
}

function createRoom() {
  const room = {
    code: makeCode(),
    sides: { A: null, B: null },
    seq: 0,
    level: 0,
    state: null,
    initial: null,
    solved: false,
    phase: 'play',
    ready: { A: false, B: false },
    ping: { A: null, B: null },
    lastAct: { A: 0, B: 0 },
    restarts: 0,
    actions: 0,
    startedAt: now(),
    endedAt: 0,
    lastActive: now(),
  };
  startLevel(room);
  rooms.set(room.code, room);
  return room;
}

function startLevel(room) {
  const L = LEVELS[room.level];
  room.state = L.init();
  room.initial = JSON.parse(JSON.stringify(room.state));
  room.solved = false;
  room.ready = { A: false, B: false };
  room.ping = { A: null, B: null };
  room.phase = 'play';
}

function payload(room, side, by) {
  const L = LEVELS[Math.min(room.level, LEVELS.length - 1)];
  const other = side === 'A' ? 'B' : 'A';
  return {
    t: 'state',
    seq: room.seq,
    code: room.code,
    side,
    by: by || null,
    phase: room.phase,
    solved: room.solved,
    level: {
      id: L.id,
      chapter: L.chapter,
      index: L.index,
      title: L.title,
      total: LEVELS.length,
    },
    peerOnline: !!(room.sides[other] && room.sides[other].online),
    peerPing: room.ping[other],
    ready: room.ready,
    stats: {
      restarts: room.restarts,
      actions: room.actions,
      elapsed: Math.round(((room.endedAt || now()) - room.startedAt) / 1000),
    },
    view: room.phase === 'end' ? null : L.view(room.state, side),
  };
}

function broadcast(room, by) {
  room.seq++;
  for (const side of ['A', 'B']) {
    const s = room.sides[side];
    if (s && s.online && s.conn) {
      try {
        s.conn.send(JSON.stringify(payload(room, side, by)));
      } catch (e) { /* ignore */ }
    }
  }
  room.lastActive = now();
}

function advance(room) {
  room.level++;
  if (room.level >= LEVELS.length) {
    room.phase = 'end';
    room.endedAt = now();
    room.solved = true;
    broadcast(room);
    return;
  }
  startLevel(room);
  broadcast(room);
}

/* ---------------------------- 连接处理 ---------------------------- */

function seat(room, sideKey, conn) {
  const token = crypto.randomBytes(9).toString('base64url');
  room.sides[sideKey] = { token, conn, online: true };
  return token;
}

function leaveRoom(sess) {
  const room = sess.room;
  if (!room) return;
  const s = room.sides[sess.side];
  if (s && s.conn === sess.conn) {
    s.conn = null;
    s.online = false;
  }
  sess.room = null;
  sess.side = null;
  broadcast(room);
}

attachWebSocket(server, '/ws', (conn) => {
  const sess = { conn, room: null, side: null };
  const reply = (o) => {
    try { conn.send(JSON.stringify(o)); } catch (e) { /* ignore */ }
  };

  conn.on('close', () => leaveRoom(sess));

  conn.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;

    switch (m.t) {
      /* ---- 建房 ---- */
      case 'create': {
        if (sess.room) leaveRoom(sess);
        if (rooms.size >= MAX_ROOMS) return reply({ t: 'error', msg: '服务器房间已满，稍后再试' });
        if (!allow('c:' + ipOf(conn), 12, 10 * 60 * 1000)) {
          return reply({ t: 'error', msg: '创建太频繁，休息一下再试' });
        }
        const room = createRoom();
        const token = seat(room, 'A', conn);
        sess.room = room;
        sess.side = 'A';
        reply({ t: 'room', code: room.code, side: 'A', token });
        broadcast(room);
        break;
      }

      /* ---- 加入 ---- */
      case 'join': {
        if (sess.room) return;
        if (!allow('j:' + ipOf(conn), 40, 10 * 60 * 1000)) {
          return reply({ t: 'error', msg: '尝试太频繁，休息一下再试' });
        }
        const code = String(m.code || '').replace(/\D/g, '').slice(0, 4);
        const room = rooms.get(code);
        if (!room) return reply({ t: 'error', msg: '房间码不存在' });
        if (room.sides.B && room.sides.B.online) return reply({ t: 'error', msg: '这个房间已经坐满了' });
        const token = seat(room, 'B', conn);
        sess.room = room;
        sess.side = 'B';
        reply({ t: 'room', code, side: 'B', token });
        broadcast(room);
        break;
      }

      /* ---- 断线重连 ---- */
      case 'resume': {
        if (sess.room) return;
        const room = rooms.get(String(m.code || ''));
        const sideKey = m.side === 'B' ? 'B' : 'A';
        const s = room && room.sides[sideKey];
        if (!s || !m.token || s.token !== m.token) {
          return reply({ t: 'error', msg: '房间已失效', fatal: true });
        }
        if (s.conn && s.conn !== conn) {
          try { s.conn.socket.destroy(); } catch (e) { /* ignore */ }
        }
        s.conn = conn;
        s.online = true;
        sess.room = room;
        sess.side = sideKey;
        reply({ t: 'room', code: room.code, side: sideKey, token: s.token });
        broadcast(room);
        break;
      }

      /* ---- 游戏动作 ---- */
      case 'action': {
        const room = sess.room;
        if (!room || room.phase !== 'play' || room.solved) return;
        const A = room.sides.A;
        const B = room.sides.B;
        if (!A || !A.online || !B || !B.online) return;
        const a = m.a;
        if (!a || typeof a.t !== 'string') return;

        room.actions++;
        const L = LEVELS[room.level];
        if (!L.act(room.state, sess.side, a)) return;

        room.lastAct[sess.side] = now();
        room.ping[sess.side] = null;

        if (L.isSolved(room.state)) {
          room.solved = true;
          room.ready = { A: false, B: false };
        }
        broadcast(room, sess.side);
        break;
      }

      /* ---- 快速指引（把对方视线拉到我说的那个东西上）---- */
      case 'ping': {
        const room = sess.room;
        if (!room || room.phase !== 'play') return;
        room.ping[sess.side] = { i: m.i | 0, at: now() };
        broadcast(room);
        break;
      }

      /* ---- 三个快捷信号 ---- */
      case 'signal': {
        const room = sess.room;
        if (!room) return;
        const kind = String(m.kind || '').slice(0, 8);
        const other = sess.side === 'A' ? 'B' : 'A';
        const s = room.sides[other];
        if (s && s.online && s.conn) {
          try {
            s.conn.send(JSON.stringify({ t: 'signal', from: sess.side, kind }));
          } catch (e) { /* ignore */ }
        }
        break;
      }

      /* ---- 过关后两人都按继续才进下一关 ---- */
      case 'ready': {
        const room = sess.room;
        if (!room || !room.solved || room.phase !== 'play') return;
        room.ready[sess.side] = true;
        if (room.ready.A && room.ready.B) advance(room);
        else broadcast(room);
        break;
      }

      /* ---- 重置本机关（不扣任何东西）---- */
      case 'restart': {
        const room = sess.room;
        if (!room || room.phase !== 'play') return;
        room.state = JSON.parse(JSON.stringify(room.initial));
        room.solved = false;
        room.ready = { A: false, B: false };
        room.restarts++;
        broadcast(room);
        break;
      }

      case 'leave': {
        leaveRoom(sess);
        break;
      }

      default:
        break;
    }
  });
});

/* --------------------- 时间型判定（同时按住） --------------------- */

setInterval(() => {
  const t = now();
  for (const room of rooms.values()) {
    if (room.phase !== 'play' || room.solved) continue;
    const L = LEVELS[room.level];
    if (!L.tick) continue;
    const holding = room.state.hold && (room.state.hold.A || room.state.hold.B);
    if (L.tick(room.state, t)) {
      room.solved = true;
      room.ready = { A: false, B: false };
      broadcast(room);
    } else if (holding) {
      broadcast(room);
    }
  }
}, 100);

/* --------------------- 心跳（穿过代理/NAT 的长连接） --------------------- */

// 有些代理/移动网络会回收 60–100 秒没有数据的长连接，
// 房间内每 25 秒发一帧空消息，客户端忽略即可。
setInterval(() => {
  for (const room of rooms.values()) {
    for (const side of ['A', 'B']) {
      const s = room.sides[side];
      if (s && s.online && s.conn) {
        try { s.conn.send('{"t":"ka"}'); } catch (e) { /* ignore */ }
      }
    }
  }
}, 25000);

/* --------------------------- 过期清理 --------------------------- */

setInterval(() => {
  const t = now();
  for (const [code, room] of rooms) {
    const a = room.sides.A;
    const b = room.sides.B;
    const live = (a && a.online) || (b && b.online);
    if (!live && t - room.lastActive > 120000) rooms.delete(code);
  }
  for (const [key, b] of buckets) {
    if (t > b.reset) buckets.delete(key);
  }
}, 15000);

/* ----------------------------- 启动 ----------------------------- */

server.listen(PORT, HOST, () => {
  const lines = [`同频 server  listening  :${PORT}`];
  lines.push(`  本机       http://localhost:${PORT}`);
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const ni of nets[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) {
        lines.push(`  同一个 WiFi http://${ni.address}:${PORT}   (${name})`);
      }
    }
  }
  if (PUBLIC_URL) {
    lines.push(`  异地联机    ${PUBLIC_URL}`);
  } else {
    lines.push('  异地联机    需要把服务放到公网，见 DEPLOY.md');
  }
  console.log(lines.join('\n'));
});
