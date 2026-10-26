'use strict';
/*
 * 邀请链接测试：?code=1234 打开后必须自动发出 join，并清理 URL。
 * 运行：node test/deeplink.js
 */

const { runClient } = require('./fake-dom');

function assert(cond, msg) {
  if (!cond) throw new Error('断言失败: ' + msg);
}

(async () => {
  let failed = 0;

  // 1. 合法邀请链接 → 自动 join
  try {
    const r = runClient('?code=1234');
    await r.flush();
    assert(r.ws, '应该发起 WebSocket 连接');
    assert(r.ws.url.indexOf('/ws') > 0, '连的是 /ws');
    const join = r.ws.sent.filter((m) => m.t === 'join');
    assert(join.length === 1, '应该只发一次 join');
    assert(join[0].code === '1234', '房间码应是 1234');
    assert(r.history.replaced === 1, '应清理地址栏里的 ?code');
    console.log('· 邀请链接自动进房 ✓');
  } catch (e) {
    failed++;
    console.error('× 邀请链接: ' + e.message);
  }

  // 2. 不合法邀请码 → 不自动 join
  try {
    const r = runClient('?code=12');
    await r.flush();
    assert(r.ws, '仍应连接服务器');
    assert(r.ws.sent.filter((m) => m.t === 'join').length === 0, '不足 4 位不该 join');
    console.log('· 无效邀请码被忽略 ✓');
  } catch (e) {
    failed++;
    console.error('× 无效邀请码: ' + e.message);
  }

  // 3. 预览模式 → 不连接服务器
  try {
    const r = runClient('?demo=1-2');
    await r.flush();
    assert(!r.ws, '预览模式不该建立连接');
    console.log('· 预览模式不联网 ✓');
  } catch (e) {
    failed++;
    console.error('× 预览模式: ' + e.message);
  }

  if (failed) {
    console.error('\n邀请链接测试失败 ' + failed + ' 项');
    process.exit(1);
  }
  console.log('\n邀请链接全部通过 ✓');
  process.exit(0);
})();
