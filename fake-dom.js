'use strict';
/*
 * 测试用的假浏览器环境：假 DOM + 假 canvas + 假 WebSocket。
 * 只覆盖客户端实际用到的那部分 API。
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const src = html.match(/<script>([\s\S]*?)<\/script>/)[1];

function makeCtx() {
  const calls = { fillText: 0, stroke: 0, fill: 0, arc: 0 };
  const target = {
    createRadialGradient: () => ({ addColorStop() {} }),
    createLinearGradient: () => ({ addColorStop() {} }),
    measureText: () => ({ width: 10 }),
    fillText: () => { calls.fillText++; },
    stroke: () => { calls.stroke++; },
    fill: () => { calls.fill++; },
    arc: () => { calls.arc++; },
  };
  const ctx = new Proxy(target, {
    get(t, p) {
      if (p in t) return t[p];
      return () => {};
    },
    set(t, p, v) { t[p] = v; return true; },
  });
  ctx.__calls = calls;
  return ctx;
}

function makeElement(sel, attrs) {
  const classes = new Set();
  return {
    _sel: sel,
    _attrs: attrs || {},
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      toggle: (c) => (classes.has(c) ? classes.delete(c) : classes.add(c)),
      contains: (c) => classes.has(c),
    },
    style: {},
    textContent: '',
    disabled: false,
    value: '',
    width: 300,
    height: 430,
    addEventListener() {},
    getAttribute(k) { return this._attrs[k]; },
    setAttribute() {},
    getContext() { return this._ctx || (this._ctx = makeCtx()); },
    getBoundingClientRect() { return { left: 0, top: 0, width: 390, height: 844 }; },
    toDataURL() { return 'data:image/png;base64,'; },
    focus() {},
    click() {},
  };
}

class FakeWS {
  constructor(url) {
    this.url = url;
    this.readyState = 1;
    this.sent = [];
    FakeWS.last = this;
    // 脚本同步执行完后才会触发 onopen，模拟真实握手
    queueMicrotask(() => { if (this.onopen) this.onopen(); });
  }
  send(raw) { this.sent.push(JSON.parse(raw)); }
  close() { this.readyState = 3; if (this.onclose) this.onclose(); }
}

/** 跑一次客户端；返回绘制调用、发出的 WS 消息等 */
function runClient(search) {
  const cache = new Map();
  const signals = ['see', 'wait', 'ok'].map((k) => makeElement('.sig', { 'data-k': k }));
  const history = {
    replaced: 0,
    replaceState() { this.replaced++; },
  };

  const document = {
    querySelector(sel) {
      if (!cache.has(sel)) cache.set(sel, makeElement(sel));
      return cache.get(sel);
    },
    querySelectorAll(sel) {
      return sel === '.sig' ? signals : [];
    },
    addEventListener() {},
    createElement() { return makeElement('a'); },
  };

  let frames = 0;
  const MAX = 3;
  FakeWS.last = null;

  const sandbox = {
    console,
    document,
    history,
    location: {
      search,
      protocol: 'http:',
      host: '127.0.0.1:8090',
      hostname: '127.0.0.1',
      origin: 'http://127.0.0.1:8090',
      pathname: '/',
    },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: {},
    URLSearchParams,
    performance,
    setTimeout: () => 0,
    clearTimeout: () => {},
    requestAnimationFrame(cb) {
      if (frames++ < MAX) cb(performance.now() + frames * 16);
    },
    WebSocket: FakeWS,
  };
  sandbox.window = {
    innerWidth: 390,
    innerHeight: 844,
    devicePixelRatio: 2,
    addEventListener() {},
  };
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'client.js' });

  const cv = document.querySelector('#cv');
  return {
    calls: cv._ctx.__calls,
    frames,
    document,
    history,
    ws: FakeWS.last,
    flush: async () => { await Promise.resolve(); await Promise.resolve(); },
  };
}

module.exports = { runClient, FakeWS };
