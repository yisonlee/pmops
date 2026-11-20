/* 生成「商铺档案打印稿」静态预览（等价于点打印后送给打印机的文档）
   用法：node tests/render-print-preview.js http://localhost:5107 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const API = process.argv[2] || 'http://localhost:5107';
const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'pack/app/www/index.html'), 'utf8');
const STYLES = [...HTML.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]);

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
  // 打印文档会复制当前页面的样式表
  querySelectorAll(sel) { return sel === 'style' ? STYLES.map((t) => ({ textContent: t })) : []; },
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
  await fetchJar(API + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' })
  });
  const code = fs.readFileSync(path.join(__dirname, 'inline.js'), 'utf8')
    + '\nglobalThis.__t = { S, printDocHtml, shopDetailInner, shopDetailData };';
  vm.runInThisContext(code, { filename: 'inline.js' });
  const t = globalThis.__t;
  await new Promise((r) => setTimeout(r, 1000));

  const shops = (t.S.data && t.S.data.shops) || [];
  if (!shops.length) throw new Error('没有商铺数据，无法生成打印预览');
  // 挑一间有抄表/账单记录的商铺，预览效果最完整
  const target = shops.find((s) => t.S.data.bills.some((b) => b.shop_id === s.id)) || shops[0];

  const out = t.printDocHtml(target.id);
  if (!out) throw new Error('打印文档生成失败');
  const dest = path.join(ROOT, 'preview-print-1.26.0.html');
  fs.writeFileSync(dest, out, 'utf8');
  console.log('shop:', target.name, '| bytes:', out.length);
  console.log('written', dest);
})();
