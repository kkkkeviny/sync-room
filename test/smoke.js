'use strict';
/*
 * 端到端冒烟测试：真的起一个 server，用两个 WebSocket 客户端把三关打通。
 * 运行：node test/smoke.js
 */

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const { connect } = require('../lib/ws');

const PORT = Number(process.env.TEST_PORT || 8099);
const BASE = 'http://127.0.0.1:' + PORT;
const WSURL = 'ws://127.0.0.1:' + PORT + '/ws';

let A = null;
let B = null;

function assert(cond, msg) {
  if (!cond) throw new Error('断言失败: ' + msg);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function waitHealth() {
  return new Promise((resolve, reject) => {
    let tries = 0;
    const tick = () => {
      const req = http.get(BASE + '/healthz', (res) => {
        res.resume();
        if (res.statusCode === 200) return resolve();
        retry();
      });
      req.on('error', retry);
      req.setTimeout(600, () => { req.destroy(); });
    };
    const retry = () => {
      if (++tries > 60) return reject(new Error('server 启动超时'));
      setTimeout(tick, 100);
    };
    tick();
  });
}

function makeClient() {
  return connect(WSURL).then((conn) => {
    const buf = [];
    const waiters = [];
    const c = { last: null, lastSeq: 0, conn };

    conn.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw); } catch (e) { return; }
      if (m && m.t === 'state') {
        c.last = m;
        if (typeof m.seq === 'number') c.lastSeq = m.seq;
      }
      for (let i = 0; i < waiters.length; i++) {
        if (waiters[i].pred(m)) {
          const w = waiters.splice(i, 1)[0];
          clearTimeout(w.timer);
          w.resolve(m);
          return;
        }
      }
      buf.push(m);
    });

    c.send = (o) => conn.send(JSON.stringify(o));

    c.waitFor = (pred, ms) => new Promise((resolve, reject) => {
      for (let i = 0; i < buf.length; i++) {
        if (pred(buf[i])) {
          const m = buf.splice(i, 1)[0];
          return resolve(m);
        }
      }
      const w = { pred, resolve };
      w.timer = setTimeout(() => {
        const k = waiters.indexOf(w);
        if (k >= 0) waiters.splice(k, 1);
        reject(new Error('等待消息超时'));
      }, ms || 6000);
      waiters.push(w);
    });

    c.close = () => conn.close();
    return c;
  });
}

/** 发一个动作，并等两端都收到新的 state（用同一 seq 对齐，避免一端慢半拍） */
async function act(c, a) {
  const target = Math.max(A.lastSeq, B.lastSeq) + 1;
  const wa = A.waitFor((m) => m.t === 'state' && m.seq >= target);
  const wb = B.waitFor((m) => m.t === 'state' && m.seq >= target);
  c.send({ t: 'action', a });
  await Promise.all([wa, wb]);
}

async function readyBoth(nextLevelId) {
  const target = Math.max(A.lastSeq, B.lastSeq) + 1;
  const wa = A.waitFor((m) => m.t === 'state' && m.seq >= target);
  const wb = B.waitFor((m) => m.t === 'state' && m.seq >= target);
  A.send({ t: 'ready' });
  B.send({ t: 'ready' });
  await Promise.all([wa, wb]);
  if (nextLevelId) {
    await Promise.all([
      A.waitFor((m) => m.t === 'state' && m.level.id === nextLevelId),
      B.waitFor((m) => m.t === 'state' && m.level.id === nextLevelId),
    ]);
  }
}

async function main() {
  await waitHealth();
  console.log('· server 已启动');

  A = await makeClient();
  A.send({ t: 'create' });
  const room = await A.waitFor((m) => m.t === 'room');
  assert(room.code && room.code.length === 4, '房间码是 4 位');
  const tokenA = room.token;
  console.log('· 房间码 ' + room.code);

  B = await makeClient();
  B.send({ t: 'join', code: room.code });
  const sb0 = await B.waitFor((m) => m.t === 'state' && m.peerOnline);
  let sa = await A.waitFor((m) => m.t === 'state' && m.peerOnline);

  /* ---------- 断线重连 ---------- */
  const seqB = B.lastSeq;
  A.conn.close();
  await B.waitFor((m) => m.t === 'state' && m.seq > seqB && !m.peerOnline, 5000);
  const A2 = await makeClient();
  A2.send({ t: 'resume', code: room.code, side: 'A', token: tokenA });
  await A2.waitFor((m) => m.t === 'state' && m.peerOnline);
  A = A2;
  sa = A.last;
  console.log('· 断线重连正常');

  /* ---------- 1-1 ---------- */
  assert(sa.level.id === '1-1', '当前是 1-1');
  assert(!('cur' in sa.view), 'A 看不到旋钮');
  assert(!('req' in sb0.view), 'B 看不到需求');
  console.log('· 1-1 视野分离正确');

  for (let i = 0; i < 3; i++) {
    let guard = 0;
    while (B.last.view.cur[i] !== A.last.view.req[i]) {
      if (guard++ > 6) throw new Error('1-1 旋钮对齐失败');
      await act(B, { t: 'cycle', i });
    }
  }
  await act(A, { t: 'light' });
  assert(A.last.solved, '1-1 通关');
  console.log('· 1-1 通关');

  await readyBoth('1-2');
  assert(A.last.level.id === '1-2', '进入 1-2');
  assert(!('path' in B.last.view), 'B 看不到光路');
  assert(!('target' in B.last.view), 'B 看不到目标');
  assert(!('a' in A.last.view.mirrors[0]), 'A 看不到镜面朝向');
  console.log('· 1-2 视野分离正确');

  /* ---------- 1-2：穷举 16 种镜子组合 ---------- */
  let solved = A.last.solved;
  for (let mask = 0; mask < 16 && !solved; mask++) {
    for (let k = 0; k < 4; k++) {
      const want = ((mask >> k) & 1) ? '\\' : '/';
      const cur = B.last.view.mirrors[k].a;
      if (cur !== want) {
        await act(B, { t: 'turn', i: k + 1 });
        if (A.last.solved) { solved = true; break; }
      }
    }
  }
  assert(solved, '1-2 通关');
  console.log('· 1-2 通关');

  await readyBoth('1-3');
  assert(A.last.level.id === '1-3', '进入 1-3');
  assert(!('target' in B.last.view), '1-3：B 看不到目标');
  assert(!('cur' in A.last.view), '1-3：A 看不到全部当前值');
  console.log('· 1-3 视野分离正确');

  /* ---------- 1-3 ---------- */
  const target = A.last.view.target;
  let guard = 0;
  while (B.last.view.cur[1] !== target[1]) {
    if (guard++ > 6) throw new Error('转子 2 对齐失败');
    await act(B, { t: 'turn', i: 1 });
  }
  for (const idx of [0, 2]) {
    guard = 0;
    while (A.last.view.own[idx === 0 ? 0 : 1] !== target[idx]) {
      if (guard++ > 6) throw new Error('转子 ' + idx + ' 对齐失败');
      await act(A, { t: 'turn', i: idx });
    }
  }

  A.send({ t: 'action', a: { t: 'hold', on: true } });
  B.send({ t: 'action', a: { t: 'hold', on: true } });
  const done = await A.waitFor((m) => m.t === 'state' && m.solved, 8000);
  assert(done.solved, '1-3 同时按住通关');
  console.log('· 1-3 通关（同时按住 2 秒）');

  /* ---------- 章节结束 ---------- */
  await readyBoth();
  const endA = await A.waitFor((m) => m.t === 'state' && m.phase === 'end', 6000);
  const endB = await B.waitFor((m) => m.t === 'state' && m.phase === 'end', 6000);
  assert(endA.view === null && endB.view === null, '结束后不下发视图');
  assert(endA.stats.elapsed >= 0, '有计时统计');
  console.log('· 第一章完成，用时 ' + endA.stats.elapsed + 's');

  A.close();
  B.close();
  await sleep(100);
  console.log('\n全部通过 ✓');
}

(async () => {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT), HOST: '127.0.0.1' }),
    stdio: 'ignore',
  });

  let failed = false;
  try {
    await main();
  } catch (e) {
    failed = true;
    console.error('\n测试失败：' + e.message);
  } finally {
    try { child.kill(); } catch (e) { /* ignore */ }
  }
  process.exit(failed ? 1 : 0);
})();
