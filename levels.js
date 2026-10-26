'use strict';
/*
 * levels.js — 三关的状态机（服务端权威）
 *
 * 每关实现四个函数：
 *   init()            生成初始状态（含随机数，随机值只存在服务端）
 *   view(state, side) 给某一端裁剪出「只能看到的那一半」
 *   act(state, side, a) 校验并执行一个动作，返回是否合法
 *   isSolved(state)   是否通关
 *   tick(state, now)  可选：有时间型判定时由服务端 10Hz 调用
 *
 * 关键：状态里同时存着两个人的秘密，view() 负责把它们分开。
 */

const rnd = (n) => Math.floor(Math.random() * n);
const clone = (o) => JSON.parse(JSON.stringify(o));

/* ------------------------------------------------------------------ *
 * 1-1 三盏灯
 * A 看见「每盏灯需要什么形状」，B 看见「旋钮现在是什么形状」。
 * B 转动旋钮，A 决定什么时候点亮；点亮后只有 A 能看到对错。
 * ------------------------------------------------------------------ */
const L11 = {
  id: '1-1',
  chapter: 1,
  index: 1,
  title: '三盏灯',
  init() {
    const req = [rnd(3), rnd(3), rnd(3)];
    const cur = [rnd(3), rnd(3), rnd(3)];
    if (req.every((v, i) => v === cur[i])) cur[0] = (cur[0] + 1) % 3;
    return { req, cur, checked: null, lightAt: 0 };
  },
  view(s, side) {
    if (side === 'A') {
      return { req: s.req.slice(), checked: s.checked ? s.checked.slice() : null };
    }
    return { cur: s.cur.slice() };
  },
  act(s, side, a) {
    if (side === 'B' && a.t === 'cycle') {
      const i = a.i | 0;
      if (i < 0 || i > 2) return false;
      s.cur[i] = (s.cur[i] + 1) % 3;
      s.checked = null;
      return true;
    }
    if (side === 'A' && a.t === 'light') {
      s.checked = s.req.map((v, i) => v === s.cur[i]);
      s.lightAt = Date.now();
      return true;
    }
    return false;
  },
  isSolved(s) {
    return !!(s.checked && s.checked.length === 3 && s.checked.every(Boolean));
  },
};

/* ------------------------------------------------------------------ *
 * 1-2 四面镜
 * A 看见整张光路图、目标格、以及光现在走到哪；B 只看见四面镜子的角度。
 * A 还能切换两个光源，B 旋转镜子。光碰到目标格即通关。
 * ------------------------------------------------------------------ */
const COLS = 7;
const ROWS = 9;
const DX = [1, 0, -1, 0];
const DY = [0, 1, 0, -1];
// 反射表：'/' 与 '\' 各自把四个方向映射到新方向（0右 1下 2左 3上）
const REFLECT = { '/': [3, 2, 1, 0], '\\': [1, 0, 3, 2] };

function trace(s) {
  let c = 0;
  let r = s.src === 0 ? 2 : 6;
  let d = 0;
  const path = [[c, r]];
  for (let n = 0; n < 300; n++) {
    const m = s.mirrors.find((mm) => mm.c === c && mm.r === r);
    if (m) d = REFLECT[m.a][d];
    c += DX[d];
    r += DY[d];
    if (c < 0 || c >= COLS || r < 0 || r >= ROWS) break;
    path.push([c, r]);
    if (c === s.target.c && r === s.target.r) return { path, hit: true };
  }
  return { path, hit: false };
}

const L12 = {
  id: '1-2',
  chapter: 1,
  index: 2,
  title: '四面镜',
  init() {
    return {
      mirrors: [
        { i: 1, c: 2, r: 2, a: '/' },
        { i: 2, c: 2, r: 6, a: '/' },
        { i: 3, c: 4, r: 6, a: '\\' },
        { i: 4, c: 4, r: 2, a: '\\' },
      ],
      src: 0,
      target: { c: 6, r: 2 },
    };
  },
  view(s, side) {
    const tr = trace(s);
    if (side === 'A') {
      // A 看得到光路、目标、节点位置，但看不到镜面朝向
      return {
        target: s.target,
        src: s.src,
        mirrors: s.mirrors.map((m) => ({ i: m.i, c: m.c, r: m.r })),
        path: tr.path,
        hit: tr.hit,
      };
    }
    return {
      src: s.src,
      mirrors: s.mirrors.map((m) => ({ i: m.i, a: m.a })),
    };
  },
  act(s, side, a) {
    if (side === 'B' && a.t === 'turn') {
      const m = s.mirrors.find((mm) => mm.i === (a.i | 0));
      if (!m) return false;
      m.a = m.a === '/' ? '\\' : '/';
      return true;
    }
    if (side === 'A' && a.t === 'source') {
      const v = a.s | 0;
      if (v !== 0 && v !== 1) return false;
      if (s.src === v) return false;
      s.src = v;
      return true;
    }
    return false;
  },
  isSolved(s) {
    return trace(s).hit;
  },
};

/* ------------------------------------------------------------------ *
 * 1-3 同频
 * 三个转子，A 控制 1、3，B 控制 2；但转 2 会同时带动 1 和 3。
 * A 看见目标序列，B 看不见；B 看见全部当前值，A 只看见自己那两个。
 * 数值对齐后，两人同时按住 2 秒才通关。
 * ------------------------------------------------------------------ */
const L13 = {
  id: '1-3',
  chapter: 1,
  index: 3,
  title: '同频',
  init() {
    const target = [rnd(3), rnd(3), rnd(3)];
    const cur = [rnd(3), rnd(3), rnd(3)];
    if (cur.every((v, i) => v === target[i])) cur[0] = (cur[0] + 1) % 3;
    return { target, cur, hold: { A: false, B: false }, holdMs: 0, lastTick: Date.now() };
  },
  view(s, side) {
    if (side === 'A') {
      return {
        target: s.target.slice(),
        own: [s.cur[0], s.cur[2]],
        hold: { A: s.hold.A, B: s.hold.B },
        holdMs: s.holdMs,
      };
    }
    return {
      cur: s.cur.slice(),
      hold: { A: s.hold.A, B: s.hold.B },
      holdMs: s.holdMs,
    };
  },
  act(s, side, a) {
    if (a.t === 'hold') {
      s.hold[side] = !!a.on;
      if (!s.hold[side]) s.holdMs = 0;
      return true;
    }
    if (a.t === 'turn') {
      const i = a.i | 0;
      if (i < 0 || i > 2) return false;
      const owns = side === 'A' ? i === 0 || i === 2 : i === 1;
      if (!owns) return false;
      s.cur[i] = (s.cur[i] + 1) % 3;
      if (i === 1) {
        // 齿轮联动：转 2 会带动 1 和 3
        s.cur[0] = (s.cur[0] + 1) % 3;
        s.cur[2] = (s.cur[2] + 1) % 3;
      }
      s.holdMs = 0;
      return true;
    }
    return false;
  },
  tick(s, now) {
    const dt = Math.min(now - s.lastTick, 250);
    s.lastTick = now;
    const match = s.cur.every((v, i) => v === s.target[i]);
    if (s.hold.A && s.hold.B && match) s.holdMs += dt;
    else s.holdMs = 0;
    return s.holdMs >= 2000;
  },
  isSolved(s) {
    return s.holdMs >= 2000;
  },
};

const LEVELS = [L11, L12, L13];

module.exports = { LEVELS, _internals: { trace, clone } };
