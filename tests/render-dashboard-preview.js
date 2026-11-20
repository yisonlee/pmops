/* 生成「可视化驾驶舱」离线可交互预览页
   用法：node tests/render-dashboard-preview.js http://127.0.0.1:5132
   说明：内联真实业务数据快照 + ECharts + 应用脚本，页面内可直接切换
   分析维度 / 时间范围 / 楼栋并点击图表下钻；导出与打印需连接服务端。 */
const fs = require('fs');
const path = require('path');

const API = process.argv[2] || 'http://localhost:5107';
const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'pack/app/www/index.html'), 'utf8');
const CSS = (HTML.match(/<style>([\s\S]*?)<\/style>/) || [, ''])[1];
/* 内联脚本里的打印模板含有 </body></html> 字面量，必须取最后一个 </body>；
   且正文只有一整段内联脚本，贪心剥离到最后一个 </script> 才不会留下脚本残片。 */
let BODY = HTML.slice(HTML.indexOf('<body>') + 6, HTML.lastIndexOf('</body>'));
BODY = BODY.replace(/<script[\s\S]*<\/script>/g, '')
  .replace('<h1 id="viewTitle">运营概览</h1>', '<h1 id="viewTitle">可视化驾驶舱</h1>')
  .replace('<h1 id="viewTitle">可视化分析</h1>', '<h1 id="viewTitle">可视化驾驶舱</h1>');
const INLINE = fs.readFileSync(path.join(__dirname, 'inline.js'), 'utf8');
const ECHARTS = fs.readFileSync(path.join(ROOT, 'pack/app/www/echarts.min.js'), 'utf8');
/** 避免内联内容里的 </script 提前闭合宿主脚本块 */
const safe = (s) => String(s).replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');

(async () => {
  const login = await fetch(API + '/app/pmops/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' })
  });
  const cookies = (typeof login.headers.getSetCookie === 'function' ? login.headers.getSetCookie() : [])
    .map((c) => c.split(';')[0]).join('; ');
  if (!cookies) throw new Error('登录失败：未取得会话 Cookie');
  const bootRes = await fetch(API + '/app/pmops/api/bootstrap', { headers: { Cookie: cookies } });
  const bootJson = await bootRes.json();
  if (!bootJson.ok) throw new Error('bootstrap 读取失败');
  const boot = bootJson.data;

  const stub = `
window.__BOOTSTRAP__ = ${safe(JSON.stringify(boot))};
window.__PREVIEW__ = true;
window.fetch = function (u) {
  var p = String(u || '');
  var data = p.indexOf('/bootstrap') >= 0 ? window.__BOOTSTRAP__
    : p.indexOf('/about') >= 0 ? { app: { version: '1.26.0', build: '2026-11-10' }, store: {}, lan: {} }
    : (p.indexOf('/users') >= 0 || p.indexOf('/audit_logs') >= 0) ? { rows: [], stats: {}, data: [] }
    : {};
  return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve({ ok: true, data: data }); } });
};
/* 预览固定落在可视化驾驶舱，不受浏览器里「上次模块」记忆影响 */
try { localStorage.removeItem('pmops_last_view'); } catch (e) {}
`;

  const out = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>物业工程管理 v1.26.0 · 可视化驾驶舱离线预览</title>
<style>${CSS}
  .pv-banner{position:fixed;left:50%;transform:translateX(-50%);bottom:12px;z-index:300;
    background:#0f172a;color:#fff;font-size:11.5px;padding:7px 15px;border-radius:99px;
    box-shadow:0 8px 24px rgba(15,23,42,.26);opacity:.94;pointer-events:none;white-space:nowrap;max-width:94vw;overflow:hidden;text-overflow:ellipsis}
  @media(max-width:820px){.pv-banner{font-size:10px;bottom:6px}}
</style></head>
<body>
<div class="pv-banner">v1.26.0 离线预览 · 演示数据快照 · 可点击「分析维度」切换、点击图表下钻 · 导出 / 打印需连接服务端</div>
${BODY}
<script>${safe(ECHARTS)}</script>
<script>${stub}</script>
<script>${safe(INLINE)}</script>
</body></html>`;
  const dest = path.join(ROOT, 'preview-dashboard-1.26.0.html');
  fs.writeFileSync(dest, out, 'utf8');
  console.log('written', dest, out.length, 'bytes');
})();
