'use strict';
/*
 * ws.js — 零依赖的极简 WebSocket 实现（服务端 + 测试客户端）
 *
 * 只支持本项目需要的东西：文本帧、close、ping/pong、分片拼接。
 * 不协商任何扩展（permessage-deflate 等），因此浏览器会发未压缩帧。
 *
 * 之所以自己写：整个项目做到 `node server.js` 即可运行，不需要 npm install。
 */

const crypto = require('crypto');
const http = require('http');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

class Conn extends EventEmitter {
  constructor(socket, isClient) {
    super();
    this.socket = socket;
    this.isClient = !!isClient;
    this.buf = Buffer.alloc(0);
    this.frag = null;
    this.closed = false;
    socket.setNoDelay(true);
    socket.on('data', (d) => this._feed(d));
    socket.on('close', () => this._closed());
    socket.on('error', () => this._closed());
  }

  _closed() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }

  send(str) {
    this._frame(0x1, Buffer.from(String(str), 'utf8'));
  }

  close(code = 1000) {
    if (this.closed) return;
    const p = Buffer.alloc(2);
    p.writeUInt16BE(code, 0);
    this._frame(0x8, p);
    try { this.socket.end(); } catch (e) { /* ignore */ }
    this._closed();
  }

  _frame(op, payload) {
    if (this.closed || this.socket.destroyed) return;
    const len = payload.length;
    let head;
    if (len < 126) {
      head = Buffer.alloc(2);
      head[1] = len;
    } else if (len < 65536) {
      head = Buffer.alloc(4);
      head[1] = 126;
      head.writeUInt16BE(len, 2);
    } else {
      head = Buffer.alloc(10);
      head[1] = 127;
      head.writeBigUInt64BE(BigInt(len), 2);
    }
    head[0] = 0x80 | op;

    let mask = Buffer.alloc(0);
    if (this.isClient) {
      head[1] |= 0x80;
      mask = crypto.randomBytes(4);
      const masked = Buffer.from(payload);
      for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
      payload = masked;
    }
    try {
      this.socket.write(Buffer.concat(mask.length ? [head, mask, payload] : [head, payload]));
    } catch (e) { /* ignore */ }
  }

  _feed(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0;
      const op = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (b.length < 4) return;
        len = b.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (b.length < 10) return;
        len = Number(b.readBigUInt64BE(2));
        off = 10;
      }
      // 公网部署时的基本防护：不接收超大帧
      if (len > 65536) { this.close(1009); return; }
      let mask = null;
      if (masked) {
        if (b.length < off + 4) return;
        mask = b.subarray(off, off + 4);
        off += 4;
      }
      if (b.length < off + len) return;

      let payload = b.subarray(off, off + len);
      if (mask) {
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      }
      this.buf = b.subarray(off + len);
      this._onFrame(op, fin, payload);
    }
  }

  _onFrame(op, fin, payload) {
    if (op === 0x8) { this.close(); return; }
    if (op === 0x9) { this._frame(0xa, payload); return; }
    if (op === 0xa) return;
    if (op === 0x1 || op === 0x0) {
      this.frag = this.frag ? Buffer.concat([this.frag, payload]) : payload;
      if (fin) {
        const s = this.frag.toString('utf8');
        this.frag = null;
        this.emit('message', s);
      }
    }
  }
}

/** 在已有 http.Server 上挂载 /ws 路由 */
function attachWebSocket(server, pathName, onConnection) {
  server.on('upgrade', (req, socket, head) => {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch (e) { socket.destroy(); return; }
    if (url.pathname !== pathName) { socket.destroy(); return; }
    const key = req.headers['sec-websocket-key'];
    const upgrade = String(req.headers.upgrade || '').toLowerCase();
    if (!key || upgrade !== 'websocket') { socket.destroy(); return; }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
    );
    const conn = new Conn(socket, false);
    conn.remoteAddress = socket.remoteAddress;
    conn.forwardedFor = req.headers['x-forwarded-for'] || '';
    onConnection(conn);
    // 极少数客户端会在握手包里就带上第一帧，补喂给解析器
    if (head && head.length) conn._feed(head);
  });
}

/** 测试用客户端：返回 Promise<Conn> */
function connect(wsUrl) {
  const u = new URL(wsUrl);
  const key = crypto.randomBytes(16).toString('base64');
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: u.hostname,
      port: u.port || 80,
      path: u.pathname + (u.search || ''),
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13',
      },
    });
    req.on('upgrade', (res, socket) => resolve(new Conn(socket, true)));
    req.on('error', reject);
    req.on('response', () => reject(new Error('server refused upgrade')));
    req.end();
  });
}

module.exports = { attachWebSocket, connect };
