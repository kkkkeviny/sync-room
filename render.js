'use strict';
/*
 * 渲染冒烟测试：没有浏览器也能验证客户端绘制路径不报错。
 * 用假 canvas 跑 demo 模式的三关 × 两端。
 * 运行：node test/render.js
 */

const { runClient } = require('./fake-dom');

let failed = 0;

for (const level of ['1-1', '1-2', '1-3']) {
  for (const side of ['A', 'B']) {
    const search = '?demo=' + level + (side === 'B' ? '&side=B' : '');
    try {
      const r = runClient(search);
      const ok = r.frames > 0 && r.calls.fillText > 0 && r.calls.stroke > 0;
      if (!ok) throw new Error('绘制调用不足');
      if (r.ws) throw new Error('预览模式不该连接服务器');
      console.log(
        '· ' + level + ' ' + side + ' 端  帧=' + r.frames +
        ' 文本=' + r.calls.fillText + ' 描边=' + r.calls.stroke + ' 填充=' + r.calls.fill
      );
    } catch (e) {
      failed++;
      console.error('× ' + level + ' ' + side + ' 端: ' + e.message);
      if (e.stack) console.error(e.stack.split('\n').slice(0, 4).join('\n'));
    }
  }
}

if (failed) {
  console.error('\n渲染测试失败 ' + failed + ' 项');
  process.exit(1);
}
console.log('\n渲染路径全部通过 ✓');
