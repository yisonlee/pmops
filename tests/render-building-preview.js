/* 生成 1.26.0「商铺管理 → 楼栋管理」离线预览（桌面 1180px + 手机 390px 真 iframe）
   用法：node tests/render-building-preview.js http://localhost:5107 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const API = process.argv[2] || 'http://localhost:5107';
const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'pack/app/www/index.html'), 'utf8');
const CSS = (HTML.match(/<style>([\s\S]*?)<\/style>/) || [, ''])[1];
const SHELL = (HTML.match(/<div class="app">[\s\S]*?<\/div>\s*<div class="nav-backdrop"[^>]*><\/div>/) || [, ''])[0];

function fakeEl() {
  return {
    _html: '',
    set innerHTML(v) { this._html = String(v); },
    get innerHTML() { return this._html; },
    textContent: '', style: {}, dataset: {}, value: '', files: [],
    classList: { toggle() {}, contains() { return false; }, add() {}, remove() {} },
    appendChild() {}, remove() {}, querySelector() { return null; },
    querySelectorAll() { return []; }, addEventListener() {},
    setSelectionRange() {}, focus() {}, closest() { return null; }, click() {},
    setAttribute() {}, removeAttribute() {}, getAttribute() { return null; }
  };
}
const nodes = {};
global.document = {
  querySelector(s) { return nodes[s] || (nodes[s] = fakeEl()); },
  getElementById(id) { return nodes['#' + id] || (nodes['#' + id] = fakeEl()); },
  querySelectorAll() { return []; },
  createElement() { return fakeEl(); },
  addEventListener() {},
  body: { style: {}, classList: { add() {}, remove() {}, toggle() {} }, appendChild() {}, removeChild() {} }
};
global.window = { addEventListener() {} };
global.location = { pathname: '/app/pmops/' };
global.echarts = { init() { return { setOption() {}, dispose() {}, resize() {} }; } };
const ls = {};
global.localStorage = {
  getItem: (k) => (k in ls ? ls[k] : null),
  setItem: (k, v) => { ls[k] = String(v); }, removeItem: (k) => { delete ls[k]; }
};
const realFetch = global.fetch;
let cookieJar = '';
async function fetchJar(u, o) {
  o = o || {};
  o.headers = Object.assign({}, o.headers);
  if (cookieJar) o.headers.Cookie = cookieJar;
  const r = await realFetch(u, o);
  const sc = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [];
  if (sc.length) cookieJar = sc.map((c) => c.split(';')[0]).join('; ');
  return r;
}
global.fetch = (u, o) => fetchJar(API + u, o);

/* iframe 内极简交互：只演示抽屉开关与弹窗关闭，业务按钮在离线快照里不动作 */
const IFRAME_JS = `
document.addEventListener('click',function(e){
  var t=e.target&&e.target.closest?e.target.closest('[data-act]'):null;
  if(!t)return;var a=t.getAttribute('data-act');
  if(a==='navToggle'){document.body.classList.add('nav-open');}
  else if(a==='closeNav'||a==='nav'){document.body.classList.remove('nav-open');}
  else if(a==='closeModal'||a==='closeLight'){var m=document.getElementById('modalRoot');if(m)m.innerHTML='';}
});`;

const attr = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function frame(w, h, title, note, inner) {
  const doc = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title><style>${CSS}
  .dchart,.chart{display:flex;align-items:center;justify-content:center;background:repeating-linear-gradient(135deg,#f8fafc,#f8fafc 10px,#f1f5f9 10px,#f1f5f9 20px)}
  .dchart::before,.chart::before{content:"图表区域 · 连接服务端后渲染";color:#94a3b8;font-size:11px}
</style></head><body>${inner}<script>${IFRAME_JS}<\/script></body></html>`;
  return `<figure class="pane" style="--w:${w}px;--h:${h}px">
    <figcaption><b>${title}</b><span>${note}</span></figcaption>
    <div class="screen"><iframe width="${w}" height="${h}" frameborder="0" srcdoc="${attr(doc)}"></iframe></div>
  </figure>`;
}

(async () => {
  await fetchJar(API + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' })
  });
  const code = fs.readFileSync(path.join(__dirname, 'inline.js'), 'utf8')
    + '\nglobalThis.__t = { S, render, renderNav, topAction, renderUserChip, openBuildingDetail, TITLES };';
  vm.runInThisContext(code, { filename: 'inline.js' });
  const t = globalThis.__t;
  await new Promise((r) => setTimeout(r, 900));

  // 1.26.0：商铺管理 → 楼栋管理子页
  t.S.view = 'shops';
  t.S.shopTab = 'buildings';
  t.S.shopBuilding = 'all';
  t.render();
  await new Promise((r) => setTimeout(r, 250));
  const body = document.querySelector('#view').innerHTML;
  const actions = document.querySelector('#topActions').innerHTML;
  const nav = document.querySelector('#nav').innerHTML;
  const title = (t.TITLES.shops || {}).title || '商铺管理';
  const sub = (t.TITLES.shops || {}).sub || '';

  // 楼栋详情弹窗：用台账第一条生成真实弹窗结构
  const first = (t.S.data.buildings || [])[0];
  if (first) t.openBuildingDetail(first.id);
  const modal = document.querySelector('#modalRoot').innerHTML;
  document.querySelector('#modalRoot').innerHTML = '';

  const shellFor = (modalHtml) => {
    const shell = SHELL
      .replace(/<nav class="nav" id="nav"><\/nav>/, () => `<nav class="nav" id="nav">${nav}</nav>`)
      .replace(/<h1 id="viewTitle">[\s\S]*?<\/h1>/, () => `<h1 id="viewTitle">${title}</h1>`)
      .replace(/<p id="viewSub"><\/p>/, () => `<p id="viewSub">${sub}</p>`)
      .replace(/<div class="topbar-actions" id="topActions"><\/div>/, () => `<div class="topbar-actions" id="topActions">${actions}</div>`)
      .replace(/<div class="view" id="view">[\s\S]*?<\/div>\s*<\/main>/, () => `<div class="view" id="view">${body}</div></main>`)
      .replace(/<div class="user-chip" id="userChip" style="display:none"><\/div>/,
        () => '<div class="user-chip" id="userChip" style="display:flex"><span class="u-name">系统管理员</span><span class="u-role">管理员</span><button class="u-out" data-act="logout" title="退出登录"><svg viewBox="0 0 24 24"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9"/></svg></button></div>')
      .replace(/<span id="devVer">[^<]*<\/span>/, () => '<span id="devVer">v1.26.0</span>');
    return shell + `<div id="modalRoot">${modalHtml || ''}</div><div id="lightRoot"></div>`;
  };

  const frames = [
    frame(1180, 900, '楼栋管理 · 桌面', '子页切换 / 整体指标带 / 楼栋卡片汇总 / 出租率进度条', shellFor('')),
    frame(1180, 900, '楼栋详情弹窗', '楼栋信息 / 汇总指标 / 所属商铺清单 / 图纸附件区', shellFor(modal)),
    frame(390, 780, '楼栋管理 · 手机', '390px 视口：卡片单列、指标两列、筛选横滑', shellFor(''))
  ].join('\n');

  const count = (t.S.data.buildings || []).length;
  const out = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>物业工程管理 v1.26.0 · 楼栋管理预览</title>
<style>
  body{margin:0;padding:24px;background:#eef2f7;color:#0f172a;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
  .hd{max-width:1500px;margin:0 auto 18px}
  .hd h1{margin:0;font-size:20px;font-weight:680}
  .hd p{margin:6px 0 0;font-size:12.5px;color:#64748b;line-height:1.8}
  .hd code{background:#fff;border:1px solid #e2e8f0;border-radius:4px;padding:1px 5px;font-size:11.5px}
  .row{max-width:1500px;margin:0 auto;display:flex;gap:22px;flex-wrap:wrap;align-items:flex-start}
  .pane{margin:0;background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:14px;box-shadow:0 8px 24px rgba(15,23,42,.07)}
  .pane figcaption{display:flex;flex-direction:column;gap:3px;margin-bottom:10px;font-size:13px}
  .pane figcaption span{font-size:11.5px;color:#94a3b8}
  .screen{width:var(--w);height:var(--h);border:8px solid #1e293b;border-radius:14px;overflow:hidden;background:#fff;
    max-width:100%;box-sizing:content-box}
  .screen iframe{display:block;width:var(--w);height:var(--h);border:0;max-width:100%}
</style></head>
<body>
<div class="hd">
  <h1>物业工程管理 v1.26.0 · 楼栋管理预览</h1>
  <p>三个画面都是真实 <code>iframe</code>：桌面版展示「商铺列表 / 楼栋管理」子页、整体指标与 ${count} 栋楼的汇总卡片；楼栋详情弹窗含所属商铺清单与图纸附件区；
  手机版按 390px 视口让媒体查询真实生效，卡片自动单列、指标两列。<br>
  此为离线数据快照：业务按钮、导出与打印需连接服务端；弹窗可点「关闭」收起，手机画面可点汉堡按钮展开抽屉。</p>
</div>
<div class="row">${frames}</div>
</body></html>`;

  const dest = path.join(ROOT, 'preview-buildings-1.26.0.html');
  fs.writeFileSync(dest, out, 'utf8');
  console.log('written', dest, out.length, 'bytes', '| buildings', count);
})();
