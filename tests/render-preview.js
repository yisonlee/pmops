/* 生成「系统设置 / 关于应用」静态预览页
   用法：node tests/render-preview.js http://localhost:5107 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const API = process.argv[2] || 'http://localhost:5107';
const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'pack/app/www/index.html'), 'utf8');
const CSS = (HTML.match(/<style>([\s\S]*?)<\/style>/) || [, ''])[1];

function fakeEl() {
  return {
    _html: '',
    set innerHTML(v) { this._html = String(v); },
    get innerHTML() { return this._html; },
    textContent: '', style: {}, dataset: {}, value: '', files: [],
    classList: { toggle() {}, contains() { return false; }, add() {}, remove() {} },
    appendChild() {}, remove() {}, querySelector() { return null; },
    querySelectorAll() { return []; }, addEventListener() {},
    setSelectionRange() {}, focus() {}, closest() { return null; }, click() {}
  };
}

const nodes = {};
global.document = {
  querySelector(s) { return nodes[s] || (nodes[s] = fakeEl()); },
  getElementById(id) { return nodes['#' + id] || (nodes['#' + id] = fakeEl()); },
  querySelectorAll() { return []; },
  createElement() { return fakeEl(); },
  addEventListener() {},
  body: { style: {}, appendChild() {}, removeChild() {} }
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

(async () => {
  // 登录后再拉数据
  await fetchJar(API + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' })
  });
  const code = fs.readFileSync(path.join(__dirname, 'inline.js'), 'utf8')
    + '\nglobalThis.__t = { S, render, showLogin, loadUsers, loadAudit };';
  vm.runInThisContext(code, { filename: 'inline.js' });
  const S = globalThis.__t.S;
  const render = globalThis.__t.render;
  await new Promise((r) => setTimeout(r, 900));

  const grab = async (view, wait) => {
    S.view = view;
    render();
    await new Promise((r) => setTimeout(r, wait || 300));
    return document.querySelector('#view').innerHTML;
  };

  const settings = await grab('settings', 200);

  // 用户 / 日志的表格是异步填充的：先取数，再重渲染一次，让内容进入快照
  const grabFilled = async (view, loader) => {
    S.view = view;
    render();
    await loader();
    await new Promise((r) => setTimeout(r, 100));
    S.view = view;
    render();
    await new Promise((r) => setTimeout(r, 150));
    return document.querySelector('#view').innerHTML;
  };
  const users = await grabFilled('users', () => __t.loadUsers());
  const audit = await grabFilled('audit', () => __t.loadAudit());

  // 登录页：单独渲染到 #loginRoot
  showLogin('');
  await new Promise((r) => setTimeout(r, 100));
  const loginHtml = document.querySelector('#loginRoot').innerHTML;
  document.querySelector('#loginRoot').innerHTML = '';

  // 「关于」的运行信息是异步填充的，等它落地后再拼进静态快照
  S.view = 'about';
  render();
  const aboutShell = document.querySelector('#view').innerHTML;
  let aboutBody = '';
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    aboutBody = document.querySelector('#aboutBody').innerHTML;
    if (aboutBody && !/class="loading"/.test(aboutBody)) break;
  }
  const about = aboutShell.replace(/<div id="aboutBody">[\s\S]*$/, '<div id="aboutBody">' + aboutBody + '</div>');

  const page = (title, sub, body) => `
    <section class="pv">
      <div class="pv-head"><h1>${title}</h1><p>${sub}</p></div>
      <div class="view">${body}</div>
    </section>`;

  const out = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>物业工程管理 v1.26.0 · 用户 / 日志 / 设置 / 关于预览</title>
<style>${CSS}
  body{background:var(--bg)}
  .pv{border-bottom:8px solid #e8edf5}
  .pv-head{padding:18px 26px 0}
  .pv-head h1{margin:0;font-size:19px;font-weight:650;letter-spacing:-.2px}
  .pv-head p{margin:2px 0 0;font-size:12.5px;color:var(--muted)}
  .pv .view{padding-top:18px}
</style></head>
<body>
${page('登录首页', '应用开启后需先登录（初始管理员 admin）', `<div style="min-height:420px;display:flex;align-items:center;justify-content:center;background:var(--bg)">${loginHtml}</div>`)}
${page('用户管理', '账号、角色与登录控制（仅管理员）', users)}
${page('操作日志', '登录与关键操作的留痕记录', audit)}
${page('系统设置', '项目信息、计费默认值、到期提醒与显示偏好', settings)}
${page('关于应用', '版本信息、运行环境、数据规模与更新日志', about)}
</body></html>`;

  const dest = path.join(ROOT, 'preview-1.26.0.html');
  fs.writeFileSync(dest, out, 'utf8');
  console.log('written', dest, out.length, 'bytes');
})();
