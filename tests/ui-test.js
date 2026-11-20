/* 列表 / 方块视图 + 附件（缩略图）的桩测试
   用法：node ui-test.js <inline.js> <API 根地址>
   例：node ui-test.js /tmp/inline.js http://localhost:5107 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const INLINE = process.argv[2] || path.join(__dirname, '..', 'inline.js');
const BASE = process.argv[3] || 'http://localhost:5107';

const nodes = {};
function fakeEl() {
  return {
    _html: '',
    set innerHTML(v) { this._html = String(v); },
    get innerHTML() { return this._html; },
    textContent: '', style: {}, dataset: {}, value: '', files: [],
    classList: { toggle() {}, contains() { return false; }, add() {}, remove() {} },
    appendChild() {}, remove() {}, querySelector() { return null; },
    querySelectorAll(sel) { return (this.__all && this.__all[sel]) || []; },
    addEventListener() {},
    setSelectionRange() {}, focus() {}, closest() { return null; }, click() {},
    setAttribute(k, v) { (this.__attrs || (this.__attrs = {}))[k] = String(v); },
    removeAttribute(k) { if (this.__attrs) delete this.__attrs[k]; },
    getAttribute(k) { return this.__attrs && k in this.__attrs ? this.__attrs[k] : null; }
  };
}

let clickHandler = null;
const docListeners = {};
// 1.23.0：允许单项断言临时注入 DOM 节点，验证附件面板 / 缩略图区的原地重绘
let queryAllOverride = null;
// 1.25.0：body 类名集合，用于验证移动端抽屉开关
const bodyClasses = new Set();
global.document = {
  querySelector(s) { return nodes[s] || (nodes[s] = fakeEl()); },
  getElementById(id) { return nodes['#' + id] || (nodes['#' + id] = fakeEl()); },
  querySelectorAll(sel) { return queryAllOverride ? (queryAllOverride(sel) || []) : []; },
  createElement() { return fakeEl(); },
  addEventListener(type, fn) { docListeners[type] = fn; if (type === 'click') clickHandler = fn; },
  body: {
    style: {},
    classList: {
      add(c) { bodyClasses.add(c); },
      remove(c) { bodyClasses.delete(c); },
      contains(c) { return bodyClasses.has(c); },
      toggle(c, on) {
        const next = on === undefined ? !bodyClasses.has(c) : !!on;
        if (next) bodyClasses.add(c); else bodyClasses.delete(c);
        return next;
      }
    },
    appendChild() {}, removeChild() {}
  }
};
global.window = { addEventListener() {} };
global.location = { pathname: '/app/pmops/' };
global.echarts = { init() { return { setOption() {}, dispose() {}, resize() {} }; } };

const ls = {};
global.localStorage = {
  getItem: (k) => (k in ls ? ls[k] : null),
  setItem: (k, v) => { ls[k] = String(v); },
  removeItem: (k) => { delete ls[k]; }
};

const realFetch = global.fetch;

/* 会话 Cookie 罐：登录后自动携带 */
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
const jsonInit = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
async function login(username, password) {
  return fetchJar(BASE + '/api/auth/login', jsonInit('POST', { username, password }));
}
global.fetch = (u, o) => fetchJar(BASE + u, o);

/* ---------- 准备：清空已有附件并造几条 ---------- */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQMAAAD+wSzIAAAABlBMVEX///+/v7+jQ3Y5AAAADklEQVQI12P4AIX8EAgALgAD/aNpbtEAAAAASUVORK5CYII=',
  'base64'
);
async function seedAttachments() {
  const boot = await (await fetchJar(BASE + '/api/bootstrap')).json();
  const d = boot.data;
  for (const a of d.attachments || []) {
    await fetchJar(`${BASE}/api/attachments/${a.id}`, { method: 'DELETE' });
  }
  const put = async (entity, id, name, mime, buf) => {
    const r = await fetchJar(`${BASE}/api/attachments?entity=${entity}&id=${id}&name=${encodeURIComponent(name)}`, {
      method: 'POST', headers: { 'Content-Type': mime }, body: buf
    });
    if (!r.ok) throw new Error('上传失败 ' + name + ' ' + r.status);
  };
  const c = d.contracts[0];
  const eq = d.equipments[0];
  const plan = d.payment_plans.find((p) => p.contract_id === c.id) || d.payment_plans[0];
  const shop = d.shops[0];
  await put('contracts', c.id, '合同扫描件.png', 'image/png', PNG);
  await put('contracts', c.id, '验收单.pdf', 'application/pdf', Buffer.from('%PDF-1.4 demo'));
  await put('equipments', eq.id, '设备铭牌.png', 'image/png', PNG);
  await put('payment_plans', plan.id, '付款凭证.png', 'image/png', PNG);
  await put('shops', shop.id, '商铺现场照片.png', 'image/png', PNG);
  return { contractId: c.id, eqId: eq.id, planId: plan.id, shopId: shop.id };
}

let fail = 0;
const check = (ok, label, extra) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!ok) fail++;
};

(async () => {
  /* ---------- 登录与鉴权 ---------- */
  const denied = await realFetch(BASE + '/api/bootstrap');
  check(denied.status === 401, '未登录访问接口被拒绝', String(denied.status));

  const bad = await login('admin', 'wrong-password');
  check(bad.status === 401, '错误密码被拒绝');

  const good = await login('admin', 'admin123');
  check(good.status === 200, '初始管理员可登录');
  const gj = await good.json();
  check(gj.data && gj.data.username === 'admin' && gj.data.role === 'admin', '登录返回账号信息');
  check(gj.data.password_is_default === true, '标记正在使用初始密码');

  /* ---------- 1.16.0：项目信息空白出厂 ---------- */
  const v116Defaults = await (await fetchJar(BASE + '/api/settings')).json();
  check(v116Defaults.ok === true && v116Defaults.defaults && v116Defaults.defaults.org_name === ''
    && v116Defaults.defaults.project_name === '' && v116Defaults.defaults.manager === ''
    && v116Defaults.defaults.phone === '' && v116Defaults.defaults.address === '',
    '项目信息五项空白出厂，不再预置单位名称', JSON.stringify(v116Defaults.defaults && v116Defaults.defaults.org_name));
  check(v116Defaults.data.org_name === '' && v116Defaults.data.project_name === '',
    '全新数据库项目信息实际值也是空白', JSON.stringify(v116Defaults.data.org_name));

  /* ---------- 建操作员 / 只读账号 ---------- */
  const opRes = await fetchJar(BASE + '/api/users', jsonInit('POST',
    { username: 'op01', name: '运维小王', role: 'operator', password: 'op123456' }));
  check(opRes.status === 200, '管理员可新建操作员');
  const vRes = await fetchJar(BASE + '/api/users', jsonInit('POST',
    { username: 'viewer01', name: '访客', role: 'viewer', password: 'vw123456' }));
  check(vRes.status === 200, '管理员可新建只读账号');

  /* 只读账号：保存自己的会话，验证禁止写入 */
  const adminCookie = cookieJar;
  cookieJar = '';
  await login('viewer01', 'vw123456');
  const viewerCookie = cookieJar;
  cookieJar = adminCookie;
  const vWrite = await realFetch(BASE + '/api/shops', Object.assign(
    { headers: { Cookie: viewerCookie, 'Content-Type': 'application/json' } },
    { method: 'POST', body: JSON.stringify({ name: '越权商铺', area: 1, rent_price: 1 }) }));
  check(vWrite.status === 403, '只读账号禁止写入', String(vWrite.status));
  const vUsers = await realFetch(BASE + '/api/users', { headers: { Cookie: viewerCookie } });
  check(vUsers.status === 403, '非管理员不能访问用户管理');
  const opUsers = await realFetch(BASE + '/api/users', {
    method: 'POST', headers: { Cookie: viewerCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'hack', password: '123456' })
  });
  check(opUsers.status === 403, '只读账号不能创建用户');

  const ids = await seedAttachments();

  let code = fs.readFileSync(INLINE, 'utf8');
  code += `
globalThis.__t = { S, render, attsOf, viewShops, viewContracts, viewEquipments, viewPayments,
  contractForm, eqForm, shopForm, openPlanForm, openPayForm, openContractDetail, openEqDetail, openAttPreview,
  attachPanelHtml, thumbsHtml, uploadAttachments, deleteAttachment, openAttList,
  printContractHtml, printContract, openLightbox, closeLightbox, printHtmlDoc,
  viewSettings, viewAbout, aboutBodyHtml, saveSettingsUI, resetSettingsUI, maintainWarn, addDays, today,
  shopDetailData, shopDetailInner, printDocHtml, printShop, openShopDetail, printEqHtml, closeModal, TITLES, renderNav,
  shopMonthly, shopUnitPrice, syncShopRentFields,
  matchQuery, searchBox, shopUnpaid, moneyShort, exportExcel, SEARCH_BINDINGS,
  PLAN_TEMPLATES, PLAN_TRIGGERS, newPlanRow, planDraftEdit, planDraftTotals, planDraftAction,
  planDraftSpecs, planDraftHtml, planSummaryHtml, renderPlanBuilder, openPlanBuilder, savePlanBuilder,
  showLogin, doLogin, doLogout, loadUsers, loadAudit, viewUsers, viewAudit, userForm, usersTableHtml, auditBodyHtml,
  DASH_RANGES, dashMonthKeys, dashMetrics, dashHero, dashKpiGrid, dashKpiCard, dashRiskList, dashProjList,
  dashDrillHtml, setDashDrill, dashGo, dashDrillCard, viewOverview, viewDashboard, viewCockpit,
  cockpitSection, cockpitTabKey, cockpitTabHtml, dashStatStrip, COCKPIT_TABS, COCKPIT_VIEW,
  normalizeView, LEGACY_VIEW_ALIAS, MODULE_VIEWS, MOD_META,
  mountCharts, mountDashboardCharts, mountCockpitCharts, dashChart, disposeCharts, dashMonthAxis, dashValueAxis,
  openReadingForm, openBillForm, deleteReading, deleteBill, payBill, shopPieData, shopClassChips,
  modalDragTarget, beginModalDrag, moveModalDrag, endModalDrag, resetModalDrag, modalDragApply, MODAL_DRAG,
  dragActive, dragFlush, dragClamp, dragSuppressClick, captureDrag, DRAG_THRESHOLD, RAF, CAF,
  SETTING_KEYS, CHANGELOG,
  openEqLogForm, deleteEqLog, openEqMaintainForm, eqLogFields, eqMaintainInfo, eqMaintainKey,
  eqMaintainPill, logMaintainPill, MAINTAIN_STATUS, EQ_LOG_TYPES, refresh,
  SHOP_WORK_TYPES, SHOP_WORK_STATUS, shopWorkStatus, shopWorkProgress, shopWorkLogs,
  shopWorkPill, workBar, shopWorkCard, shopWorkTimeline, shopWorksHtml,
  shopWorkFields, openShopWorkForm, deleteShopWorkLog, openShopWorkStatusForm,
  ARCHIVE_CAT, ARCHIVE_STATUS, ARCHIVE_SECURITY, ARCHIVE_ENTITY, ARCHIVE_LOG_TYPE,
  archiveAll, archiveLogsOf, entityName, archiveExpiryInfo, viewArchives, openArchiveDetail,
  archiveFields, archiveForm, archiveLogFields, openArchiveLogForm, deleteArchiveLog,
  printArchiveHtml, printArchive, printRecordDoc,
  WH_CAT, WH_ITEM_STATUS, WH_RECORD_TYPE, whAll, whValue, whLowStock, whRecords,
  viewWarehouse, openWhDetail, whFields, whForm, whRecordFields, openWhRecordForm,
  deleteWhRecord, printWhItemHtml, printWhItem,
  ATT_ACCEPT, CAD_EXTS, ATT_ACCEPT_ARCHIVE, isCadFile, attachAccept, attachHint,
  overlayKindOf, rememberOverlayPress, handleOverlayClick, modalFormSignature, modalHasUnsaved,
  shopRepairScope, SHOP_STATUS_KEYS, normalizeShopStatus,
  PREVIEW_EXT, attPreviewKind, attPreviewable, attPreviewTag, attTableHtml, switchAttSheet,
  attPreviewBase, exportParams, openExportPreview, topAction,
  attGalleryHtml, attListBodyHtml, ATTACH_ENTITY_LABEL, attachSignature,
  applyAttachments, mergeAttachmentRow, fetchAttachments,
  rerenderAttachPanels, rerenderAttGalleries, syncAttListHeader, syncAttachUI, syncAttachData,
  OO_OFFICE_EXTS, OO_SETTING_KEYS, ooReady, ooSupports, attBuiltinKind,
  openOfficePreview, loadOoScript, destroyOoEditor, testOoServerUI,
  MOBILE_MAX, isMobileLayout, setNavOpen, toggleNav, closeNav, dragEventAllowed,
  resizeCharts, syncNavOnResize, onViewportChange, setView, openModal, openLightbox,
  BUILDING_STATUS, SHOP_TABS, buildingRows, buildingNames, buildingOptions,
  unregisteredBuildings, buildingStats, shopTabBar, buildingChipsHtml,
  viewBuildings, buildingForm, openBuildingDetail, quickCreateBuildings };
`;
  vm.runInThisContext(code, { filename: 'inline.js' });
  const t = globalThis.__t;
  await new Promise((r) => setTimeout(r, 1000));

  const S = t.S;
  check(!!S.data, 'bootstrap 已加载');
  check(Array.isArray(S.data.attachments) && S.data.attachments.length === 5, '附件随快照下发', String((S.data.attachments || []).length));

  const view = () => document.querySelector('#view').innerHTML;
  const modal = () => document.querySelector('#modalRoot').innerHTML;
  const lightbox = () => document.querySelector('#lightRoot').innerHTML;
  const renderView = (v) => { S.view = v; t.render(); return view(); };
  const click = async (dataset) => {
    const btn = { dataset, closest: (sel) => (sel === '[data-act]' ? btn : null) };
    await clickHandler({ target: btn });
  };

  /* ---------- 三个模块：列表 / 方块 ---------- */
  const cases = [
    { key: 'contracts', listRows: S.data.contracts.length, label: '合同',
      listTag: /<table>/, cardTag: /class="ecard/, seg: 1 },
    { key: 'equipments', listRows: S.data.equipments.length, label: '设备',
      listTag: /<table>/, cardTag: /class="ecard/, seg: 1 },
    { key: 'payments', listRows: S.data.payment_plans.length, label: '付款台账',
      listTag: /<table>/, cardTag: /class="ecard/, seg: 1 }
  ];

  for (const c of cases) {
    S.mode = {};
    const listHtml = renderView(c.key);
    check(c.listTag.test(listHtml), `${c.label} 列表模式渲染表格`);
    check(!/class="ecard/.test(listHtml), `${c.label} 列表模式无卡片`);
    check((listHtml.match(/data-act="mode"/g) || []).length === 2, `${c.label} 有列表/方块切换`);
    check(new RegExp(`data-view="${c.key}"`).test(listHtml), `${c.label} 切换控件绑定本模块`);

    S.mode = { [c.key]: 'card' };
    const cardHtml = renderView(c.key);
    const cards = (cardHtml.match(/class="ecard/g) || []).length;
    check(cards === c.listRows, `${c.label} 方块模式卡片数正确`, `${cards}/${c.listRows}`);
    check(!/<table>/.test(cardHtml), `${c.label} 方块模式无表格`);
    check(!/undefined|NaN|\[object Object\]/.test(cardHtml), `${c.label} 方块模式无 undefined/NaN`);
  }

  /* ---------- 附件缩略图 ---------- */
  /* 1.9.1 起：方块卡片不再显示缩略图，缩略图只在详情 / 编辑弹窗中展示 */
  S.mode = { contracts: 'card', equipments: 'card', payments: 'card' };
  const ct = renderView('contracts');
  check(!/class="thumb"/.test(ct) && !/<img src="\/app\/pmops\/api\/attachments\/\d+\/raw"/.test(ct), '合同方块卡片不再显示缩略图');
  check(!/thumbs-none/.test(ct), '合同方块卡片无缩略图占位');
  check(!/class="thumb"/.test(renderView('equipments')), '设备方块卡片不再显示缩略图');
  check(!/class="thumb"/.test(renderView('payments')), '付款方块卡片不再显示缩略图');
  S.mode = { shops: 'card' };
  check(!/class="thumb"/.test(renderView('shops')) && !/<img src="\/app\/pmops\/api\/attachments\/\d+\/raw"/.test(renderView('shops')), '商铺方块卡片不再显示照片缩略图');
  S.mode = {};

  /* ---------- 列表模式附件计数 ---------- */
  S.mode = {};
  check(/附件 2/.test(renderView('contracts')), '合同列表显示附件数量', '合同有 2 个附件');
  check(/附件 1/.test(renderView('equipments')), '设备列表显示附件数量');

  /* ---------- 编辑表单里能上传 ---------- */
  S.mode = {};
  t.contractForm(ids.contractId);
  let m = modal();
  check(/data-attach-input/.test(m), '合同编辑表单含上传控件');
  check(/attach-panel" data-entity="contracts"/.test(m), '合同附件面板绑定 contracts');
  check((m.match(/class="att"/g) || []).length === 2, '合同附件面板列出 2 个附件');

  t.eqForm(ids.eqId);
  m = modal();
  check(/attach-panel" data-entity="equipments"/.test(m) && (m.match(/class="att"/g) || []).length === 1, '设备编辑表单列出附件');

  t.openPlanForm(null, ids.planId);
  m = modal();
  check(/attach-panel" data-entity="payment_plans"/.test(m), '付款节点编辑表单含附件面板');
  check(/编辑付款节点/.test(m), '付款节点进入编辑模式');
  check(/data-k="ratio"/.test(m) && /data-k="due_date"/.test(m), '付款节点可编辑比例与日期');
  check(/data-k="amount"/.test(m) && /自动计算/.test(m), '付款节点支持手动输入金额自动计算比例');

  // 追加模式：默认金额 = 合同总额 × 默认比例(10%)
  const planContract = S.data.contracts.find((x) => x.id === ids.contractId) || S.data.contracts[0];
  const expectAmt = Math.round((Number(planContract.amount) || 0) * 10) / 100;
  t.openPlanForm(planContract.id);
  m = modal();
  check(new RegExp(`data-k="amount"[^>]*value="${expectAmt}"`).test(m),
    '追加付款节点默认金额按比例带入', String(expectAmt));
  check(/合同总额/.test(m) && /占合同比例/.test(m), '付款节点表单显示金额 ⇄ 比例联动说明');

  /* ---------- 详情弹窗里能看/传 ---------- */
  t.openContractDetail(ids.contractId);
  m = modal();
  check(/attach-panel" data-entity="contracts"/.test(m), '合同详情含附件面板');
  check((m.match(/class="att"/g) || []).length === 2, '合同详情展示 2 个附件缩略图');

  t.openEqDetail(ids.eqId);
  m = modal();
  check(/attach-panel" data-entity="equipments"/.test(m), '设备详情含附件面板');

  /* ---------- 预览与删除入口（预览在独立二层，不覆盖详情弹窗） ---------- */
  const att = S.data.attachments.find((a) => /^image\//.test(a.mime));
  t.openAttPreview(att.id);
  m = lightbox();
  check(/<img src="\/app\/pmops\/api\/attachments\/\d+\/raw"/.test(m), '附件预览显示大图');
  check(/下载原文件/.test(m), '附件预览提供下载');
  check(/download=""/.test(m) || /download=/.test(m), '下载链接可用');
  check(/data-act="closeLight"/.test(m), '附件预览使用独立关闭按钮');

  // 预览是在详情弹窗之上打开的：关闭预览后详情必须还在
  check(/attach-panel/.test(modal()), '预览打开时详情弹窗仍保留');
  await click({ act: 'closeLight' });
  check(lightbox() === '', '关闭预览后二层清空');
  check(/attach-panel/.test(modal()), '关闭预览后详情弹窗原样保留（BUG 修复）');

  // +N 完整附件列表同样走二层
  t.openAttList('contracts', ids.contractId);
  check(/attach-panel/.test(lightbox()), '完整附件列表在二层打开');
  await click({ act: 'closeLight' });
  check(/attach-panel/.test(modal()), '关闭附件列表后详情弹窗仍在');

  /* ---------- 1.10.0：编辑回退 / 商铺租金总额 / 设备打印 / 版本同步 ---------- */
  // 1) 从详情页打开编辑表单，关闭编辑应退回详情页（BUG 修复）
  const shopIdEarly = S.data.shops[0].id;
  t.openShopDetail(shopIdEarly);
  const shopDetailHtml = modal();
  check(/商铺档案/.test(shopDetailHtml), '商铺详情打开');
  t.shopForm(shopIdEarly);
  check(/编辑商铺/.test(modal()) && modal() !== shopDetailHtml, '详情页上打开编辑表单');
  t.closeModal();
  check(modal() === shopDetailHtml, '关闭编辑表单退回商铺详情页（BUG 修复）');
  t.closeModal();
  check(modal() === '' || !/商铺档案/.test(modal()), '再次关闭才真正清空弹窗');

  // 同样验证设备详情 → 编辑 → 取消 → 退回详情
  t.openEqDetail(ids.eqId);
  const eqDetailHtml = modal();
  t.eqForm(ids.eqId);
  check(/编辑设备/.test(modal()), '设备详情页上打开编辑表单');
  t.closeModal();
  check(modal() === eqDetailHtml, '关闭设备编辑退回详情页');

  // 2) 商铺编辑表单含「月租金总金额」手动输入
  t.shopForm(shopIdEarly);
  m = modal();
  check(/data-k="rent_total"/.test(m) && /月租金总金额/.test(m), '商铺编辑含月租金总金额字段');
  check(/留空则按/.test(m), '租金总额留空自动计算的提示');
  t.closeModal();

  /* ---------- 1.10.1：手动租金总额 → 自动反算租金单价 ---------- */
  check(t.shopUnitPrice({ area: 100, rent_total: 12000, rent_price: 80 }) === 120,
    '手动总额 12000 / 100㎡ 反算单价 120');
  check(t.shopUnitPrice({ area: 88, rent_total: 10000, rent_price: 80 }) === 113.64,
    '反算单价保留两位小数');
  check(t.shopUnitPrice({ area: 100, rent_total: 0, rent_price: 80 }) === 80,
    '总额留空沿用原单价（自动模式）');
  check(t.shopUnitPrice({ area: 0, rent_total: 12000, rent_price: 80 }) === 80,
    '面积为 0 时回退原单价');
  check(t.shopMonthly({ area: 100, rent_total: 12000, rent_price: 80 }) === 12000,
    '月租金仍以手动总额为准');

  // 表单字段与联动提示
  t.shopForm(shopIdEarly);
  m = modal();
  check(/id="rentCalcHint"/.test(m) && /手动输入整月租金总金额，自动计算租金单价/.test(m),
    '商铺表单含单价实时反算提示');
  check(/填写月租金总金额后会自动反算/.test(m), '单价字段说明自动反算');
  t.closeModal();

  // 真实模拟 DOM 输入事件，验证三字段联动
  const formNode = document.querySelector('.modal-body form');
  const origQS = formNode.querySelector;
  const mk = (v) => ({
    value: v, textContent: '', _h: {},
    addEventListener(t, fn) { (this._h[t] = this._h[t] || []).push(fn); },
    fire(t) { (this._h[t] || []).forEach((fn) => fn()); }
  });
  const els = { area: mk('100'), rent_price: mk('80'), rent_total: mk(''), hint: mk('') };
  formNode.querySelector = (sel) => {
    const k = (sel.match(/data-k="([^"]+)"/) || [])[1];
    if (k && els[k]) return els[k];
    if (sel === '#rentCalcHint') return els.hint;
    return null;
  };
  t.shopForm(shopIdEarly); // onMounted 绑定联动
  els.rent_total.value = '12000'; els.rent_total.fire('input');
  check(els.rent_price.value === '120', '输入月租金总额 12000 自动反算单价 120');
  check(/已按手动总额反算单价 120/.test(els.hint.textContent), '表单实时提示反算结果');
  els.area.value = '200'; els.area.fire('input');
  check(els.rent_price.value === '60', '改面积 200㎡ 自动重算单价 60');
  els.rent_price.value = '70'; els.rent_price.fire('input');
  check(els.rent_total.value === '14000', '改单价 70 自动同步总额 14000');
  els.rent_total.value = ''; els.rent_total.fire('input');
  els.rent_price.value = '90'; els.rent_price.fire('input');
  check(els.rent_total.value === '', '总额留空保持自动计算模式');
  formNode.querySelector = origQS;
  t.closeModal();

  // 卡片 / 列表 / 详情 / 打印档案显示反算后的单价
  const shop0 = S.data.shops[0];
  const rentBak = { area: shop0.area, rent_price: shop0.rent_price, rent_total: shop0.rent_total };
  const modeBak = S.mode.shops, queryBak = S.shopQuery, statusBak = S.shopStatus;
  shop0.area = 100; shop0.rent_price = 80; shop0.rent_total = 12000;
  S.shopQuery = ''; S.shopStatus = 'all';
  S.mode.shops = 'card';
  check(/class="v">120<small>元\/㎡/.test(t.viewShops()), '方块卡片显示反算单价 120');
  S.mode.shops = 'list';
  check(/<td class="num">120 元\/㎡<\/td>/.test(t.viewShops()), '商铺列表显示反算单价 120');
  const shopDetail = t.shopDetailInner(t.shopDetailData(shop0.id));
  check(/租金单价<\/div><div class="v">120 元\/㎡\/月/.test(shopDetail), '商铺详情显示反算单价 120');
  const shopPrint = t.printDocHtml(shop0.id);
  check(/租金单价<\/div><div class="v">120 元\/㎡\/月/.test(shopPrint), '商铺打印档案显示反算单价 120');
  Object.assign(shop0, rentBak);
  S.mode.shops = modeBak; S.shopQuery = queryBak; S.shopStatus = statusBak;

  // 3) 设备打印档案
  t.openEqDetail(ids.eqId);
  check(/data-act="printEq"/.test(modal()), '设备详情提供打印按钮');
  const pe = t.printEqHtml(ids.eqId);
  check(/^<!DOCTYPE html>/.test(pe.trim()), '设备打印为独立 HTML');
  check(/设备档案/.test(pe) && /@page\{size:A4/.test(pe), '设备打印含表头与 A4 设置');
  check(/巡检 \/ 维修/.test(pe) && /<table>/.test(pe), '设备打印含维保记录表');
  check(/print-sign/.test(pe) && /制表人/.test(pe), '设备打印含签字栏');
  check(/<base href=/.test(pe), '设备打印注入 base 修复图片路径');
  check(!/undefined|NaN|\[object Object\]/.test(pe), '设备打印无 undefined/NaN');
  t.closeModal();

  // 4) 侧栏版本号与服务端同步
  const dv = document.querySelector('#devVer');
  const serverVer = S.data.meta && S.data.meta.app && S.data.meta.app.version;
  check(!!serverVer, 'bootstrap 带回服务端版本号', String(serverVer));
  check(dv && dv.textContent === 'v' + serverVer, '侧栏版本号随服务端实时同步', dv && dv.textContent);

  /* ---------- 1.11.0：自定义付款计划 ---------- */
  t.openContractDetail(ids.contractId);
  check(/data-act="planBuilder"/.test(modal()), '合同详情提供「自定义付款计划」入口');
  await click({ act: 'planBuilder', id: String(ids.contractId) });
  const pb = modal();
  check(/自定义付款计划/.test(pb) && /class="pb-table"/.test(pb), '打开自定义付款计划编辑器');
  check(/id="pbSummary"/.test(pb) && /合同总额/.test(pb) && /待分配金额|超出合同总额/.test(pb), '编辑器显示金额汇总');
  check(/data-act="planAdd"/.test(pb) && /data-act="planEven"/.test(pb) && /data-act="planTpl"/.test(pb)
    && /data-act="planClear"/.test(pb), '编辑器提供添加 / 均分 / 模板 / 清空工具');
  check(/data-act="planSave"/.test(pb), '编辑器提供保存按钮');
  check(/data-pk="amount"/.test(pb) && /data-pk="ratio"/.test(pb), '逐期可编辑金额与比例');
  check(/data-pk="trigger_type"/.test(pb) && /data-pk="due_date"/.test(pb), '逐期可编辑触发方式与应付日期');
  check(/data-act="planUp"/.test(pb) && /data-act="planDown"/.test(pb) && /data-act="planDel"/.test(pb),
    '逐期提供上移 / 下移 / 删除');

  // 事件链路：工具按钮真实生效
  const pbCount = S.planDraft.rows.length;
  await click({ act: 'planAdd' });
  check(S.planDraft.rows.length === pbCount + 1, '点击「添加一期」走事件链路生效');
  await click({ act: 'planTpl', k: 'half' });
  check(S.planDraft.rows.some((r) => r.name === '首付款'), '点击套用模板走事件链路生效');
  check(/自定义付款计划/.test(modal()), '编辑器重绘后仍停留在本层');
  t.closeModal(); // 回退到合同详情
  check(/合同档案|付款计划/.test(modal()), '关闭编辑器退回合同详情');
  t.closeModal();

  // 纯函数：金额 ⇄ 比例、汇总、行操作、已付节点保护
  const draft = { contractId: null, title: '测试合同', total: 100000, endDate: '2026-12-31', rows: [
    { id: null, name: '首付款', amount: '30000', ratio: '30', trigger_type: 'sign',
      trigger_value: '', due_date: '', remark: '', locked: false }
  ] };
  const sync1 = t.planDraftEdit(draft, 0, 'amount', '25000');
  check(sync1 && sync1.k === 'ratio' && sync1.v === '25', '输入金额自动换算比例');
  const sync2 = t.planDraftEdit(draft, 0, 'ratio', '40');
  check(sync2 && sync2.k === 'amount' && sync2.v === '40000', '输入比例自动换算金额');
  check(t.planDraftTotals(draft).amount === 40000 && t.planDraftTotals(draft).left === 60000,
    '汇总计算合计与待分配金额');
  t.planDraftAction(draft, 'planAdd');
  check(draft.rows.length === 2 && draft.rows[1].name === '第2期', '可添加一期');
  t.planDraftAction(draft, 'planEven');
  check(t.planDraftTotals(draft).amount === 100000, '按剩余金额均分后合计等于合同总额');
  t.planDraftAction(draft, 'planUp', 1);
  check(draft.rows[0].name === '第2期', '可上移期次');
  t.planDraftAction(draft, 'planDel', 1);
  check(draft.rows.length === 1, '可删除期次');
  t.planDraftAction(draft, 'planTpl', null, 'standard');
  check(draft.rows.length === 4 && t.planDraftTotals(draft).ratio === 100,
    '套用标准四期模板后比例合计 100%');
  t.planDraftAction(draft, 'planClear');
  check(draft.rows.length === 0, '可清空未付节点');
  const sp = t.planDraftSpecs({ rows: [{ id: 5, name: 'x', amount: '1234.567', ratio: '12.3',
    trigger_type: 'progress', trigger_value: '50', due_date: '2026-12-01', remark: 'r', locked: false }] });
  check(sp.length === 1 && sp[0].id === 5 && sp[0].seq === 1 && sp[0].amount === 1234.57,
    '草稿转换为接口规格（金额保留两位）');
  const lockedDraft = { total: 100000, rows: [
    { id: 7, name: '已付', amount: '20000', ratio: '20', trigger_type: 'date', locked: true },
    { id: null, name: '待付', amount: '10000', ratio: '10', trigger_type: 'date', locked: false }
  ] };
  check(t.planDraftAction(lockedDraft, 'planDel', 0) === false, '已付款节点不可删除');
  check(t.planDraftEdit(lockedDraft, 0, 'amount', '99999') === null, '已付款节点金额不可修改');
  t.planDraftAction(lockedDraft, 'planClear');
  check(lockedDraft.rows.length === 1 && lockedDraft.rows[0].locked, '清空时保留已付款节点');
  t.planDraftAction(lockedDraft, 'planAdd');
  t.planDraftAction(lockedDraft, 'planEven');
  check(t.planDraftTotals(lockedDraft).amount === 100000, '均分时已付款金额计入、剩余再分配');

  // 新建合同入口与草稿回退
  S.pendingPlans = null;
  t.contractForm();
  m = modal();
  check(/data-act="planBuilderNew"/.test(m) && /id="planPendingInfo"/.test(m),
    '新建合同表单提供自定义计划入口');
  check(/自定义付款计划（自行编排/.test(m), '模板下拉含「自定义付款计划」选项');
  await click({ act: 'planBuilderNew' });
  check(/自定义付款计划/.test(modal()) && !S.pendingPlans, '从新建合同打开编辑器');
  S.planDraft.rows = [{ id: null, name: '自定义首期', amount: '60000', ratio: '60',
    trigger_type: 'sign', trigger_value: '', due_date: '', remark: '', locked: false }];
  S.planDraft.total = 100000;
  await t.savePlanBuilder();
  check(S.pendingPlans && S.pendingPlans.length === 1 && S.pendingPlans[0].name === '自定义首期',
    '保存草稿写入 pendingPlans');
  check(/新增工程合同/.test(modal()), '保存后回退到合同表单');
  check(typeof S.formSubmit === 'function', '回退后合同表单提交函数仍可用（回退机制修复）');
  t.closeModal();
  S.pendingPlans = null;

  /* ---------- 切换模式走真实事件链路 ---------- */
  S.mode = {};
  S.view = 'contracts';
  await click({ act: 'mode', view: 'contracts', mode: 'card' });
  check(S.mode.contracts === 'card', '点击切换后当前模块为方块');
  check(JSON.parse(ls['pmops_view_mode'] || '{}').contracts === 'card', '偏好写入 localStorage');
  check(S.mode.equipments === undefined, '其他模块模式互不影响');

  t.render();
  check(/class="ecard/.test(view()), '切换后立即渲染卡片');
  await click({ act: 'mode', view: 'contracts', mode: 'list' });
  check(S.mode.contracts === 'list', '可切回列表');

  /* ---------- 打开附件列表弹窗（独立二层，不占用详情层） ---------- */
  await click({ act: 'attList', entity: 'contracts', id: String(ids.contractId) });
  check(/图片 \/ 附件/.test(lightbox()) && /attach-panel/.test(lightbox()), '附件总览在二层窗口打开');
  await click({ act: 'closeLight' });

  /* ---------- 从前端真实走一次上传 ---------- */
  const before = S.data.attachments.length;
  const f = new File([PNG], 'ui-upload.png', { type: 'image/png' });
  await t.uploadAttachments('contracts', ids.contractId, [f], null);
  check(S.data.attachments.length === before + 1, '前端上传成功后快照刷新', `${before} -> ${S.data.attachments.length}`);
  check(attsOf('contracts', ids.contractId).length === 3, '新附件归属正确');

  /* ---------- 从前端删除 ---------- */
  const added = S.data.attachments.find((a) => a.name === 'ui-upload.png');
  t.deleteAttachment(added.id);
  check(/删除附件/.test(modal()), '删除附件前有二次确认');
  await click({ act: 'confirmOk' });
  check(S.data.attachments.length === before, '确认后删除并同步快照', String(S.data.attachments.length));

  /* ---------- 设置 / 关于 ---------- */
  S.mode = {};
  const setHtml = renderView('settings');
  check(/项目信息/.test(setHtml) && /计费与提醒/.test(setHtml), '设置页含项目信息与计费分区');
  check(/data-k="org_name"/.test(setHtml) && /data-k="pay_remind_days"/.test(setHtml)
    && /data-k="default_view"/.test(setHtml) && /data-k="default_mode"/.test(setHtml), '设置字段渲染完整');
  check(/data-act="saveSettings"/.test(setHtml) && /data-act="backup"/.test(setHtml), '设置页提供保存与备份入口');
  check(/功能模块/.test(setHtml) && /mod-list/.test(setHtml) && /可视化驾驶舱/.test(setHtml)
    && !/运营概览/.test(setHtml) && !/可视化面板/.test(setHtml), '设置页模块清单合并为单一可视化驾驶舱');
  check(/局域网访问/.test(setHtml) && /:3340/.test(setHtml), '设置页显示局域网访问地址');
  check(S.settings && typeof S.settings.water_price === 'number', 'bootstrap 下发设置项');

  const navHtml = (() => { S.view = 'dashboard'; t.render(); return document.querySelector('#nav').innerHTML; })();
  check(/data-view="settings"/.test(navHtml) && /data-view="about"/.test(navHtml), '侧边导航含设置与关于');

  S.settings.project_name = '测试园区';
  t.render();
  check(document.querySelector('#brandName').textContent === '测试园区', '侧栏显示项目名称');
  S.settings.project_name = '';

  // 保养预警阈值真正参与判断
  const future = t.addDays(t.today(), 5);
  S.settings.maintain_remind_days = 0;
  check(t.maintainWarn({ next_maintain: future, status: 'normal' }) === false, '提前 0 天时未到期不预警');
  S.settings.maintain_remind_days = 10;
  check(t.maintainWarn({ next_maintain: future, status: 'normal' }) === true, '提前 10 天时进入预警窗口');
  check(t.maintainWarn({ next_maintain: future, status: 'stopped' }) === false, '停用设备不预警');

  const aboutHtml = renderView('about');
  check(/v\d+\.\d+\.\d+/.test(aboutHtml) && /id="aboutBody"/.test(aboutHtml), '关于页含版本与信息容器');
  await new Promise((r) => setTimeout(r, 600));
  const ab = document.querySelector('#aboutBody').innerHTML;
  check(/运行环境/.test(ab) && /数据规模/.test(ab) && /更新日志/.test(ab) && /技术说明/.test(ab), '关于页异步加载四个区块');
  check(!/<h3>功能模块<\/h3>/.test(ab), '功能模块已从关于页移除');
  check(!/undefined|NaN|\[object Object\]/.test(ab), '关于页无 undefined/NaN');
  check(/局域网访问/.test(ab) && /3340/.test(ab), '关于页展示局域网访问地址');

  /* ---------- 保存设置走真实事件链路 ---------- */
  renderView('settings');
  const viewEl = document.querySelector('#view');
  viewEl.__all = {
    '[data-k]': [
      { dataset: { k: 'org_name' }, value: '测试物业公司' },
      { dataset: { k: 'water_price' }, value: '4.8' },
      { dataset: { k: 'pay_remind_days' }, value: '5' }
    ]
  };
  await click({ act: 'saveSettings' });
  delete viewEl.__all;
  check(S.settings.org_name === '测试物业公司' && Number(S.settings.water_price) === 4.8,
    '保存设置经接口落库并回写状态', `${S.settings.org_name} / ${S.settings.water_price}`);
  check(Number(S.settings.pay_remind_days) === 5, '提醒天数保存生效');

  /* ---------- 1.16.0：清空项目信息必须真的落库（旧版回退默认值 BUG 回归） ---------- */
  check(t.SETTING_KEYS.length === 15 && t.SETTING_KEYS.indexOf('q') < 0
    && t.SETTING_KEYS.indexOf('org_name') === 0, '设置保存按字段白名单提交（15 项，含 OnlyOffice 四项，排除搜索框）');
  renderView('settings');
  const v116View = document.querySelector('#view');
  v116View.__all = {
    '[data-k]': [
      { dataset: { k: 'org_name' }, value: '' },
      { dataset: { k: 'project_name' }, value: '' },
      { dataset: { k: 'manager' }, value: '' },
      { dataset: { k: 'phone' }, value: '' },
      { dataset: { k: 'address' }, value: '' },
      { dataset: { k: 'water_price' }, value: '' },
      { dataset: { k: 'pay_remind_days' }, value: '' },
      { dataset: { k: 'q' }, value: '不应被提交' }
    ]
  };
  await click({ act: 'saveSettings' });
  delete v116View.__all;
  check(S.settings.org_name === '' && S.settings.project_name === '',
    '清空项目信息后前端状态为空', JSON.stringify(S.settings.org_name));
  const v116AfterClear = await (await fetchJar(BASE + '/api/settings')).json();
  check(v116AfterClear.data.org_name === '' && v116AfterClear.data.project_name === ''
    && v116AfterClear.data.manager === '' && v116AfterClear.data.phone === '' && v116AfterClear.data.address === '',
    '清空后回读仍为空（修复保存后又被默认值覆盖的 BUG）', JSON.stringify(v116AfterClear.data.org_name));
  check(Number(v116AfterClear.data.water_price) === 4.2 && Number(v116AfterClear.data.pay_remind_days) === 7,
    '清空数值项恢复该项出厂默认值', `${v116AfterClear.data.water_price} / ${v116AfterClear.data.pay_remind_days}`);
  const v116Boot = await (await fetchJar(BASE + '/api/bootstrap')).json();
  check(v116Boot.data.settings.org_name === '', 'bootstrap 快照与设置落库值一致');
  const v116RePut = await (await fetchJar(BASE + '/api/settings', jsonInit('PUT', { org_name: '复填物业', project_name: '' }))).json();
  check(v116RePut.data.org_name === '复填物业' && v116RePut.data.project_name === '',
    '再次修改公司名称可正常保存，其余空白项保持空白');
  const v116ReGet = await (await fetchJar(BASE + '/api/settings')).json();
  check(v116ReGet.data.org_name === '复填物业', '修改后的公司名称刷新后仍在');
  // 还原为空白，避免影响后续打印抬头断言
  await fetchJar(BASE + '/api/settings', jsonInit('PUT', { org_name: '', project_name: '' }));
  S.settings.org_name = ''; S.settings.project_name = '';
  check(t.CHANGELOG[0].v === '1.26.0' && t.CHANGELOG[0].cur === true
    && t.CHANGELOG[0].items.some(x => /楼栋管理/.test(x))
    && t.CHANGELOG[1].v === '1.25.0' && t.CHANGELOG[1].cur !== true,
    '更新日志当前版本为 1.26.0 且含楼栋管理条目，1.25.0 转为历史');

  /* ---------- 1.5.0：模块改名 / 侧栏 / 打印 / 局域网 ---------- */
  check(!/id="storeInfo"/.test(code) && !/storeInfo/.test(code), '侧栏不再显示数据引擎与数据库文件名');
  check(t.TITLES.contracts.title === '项目合同管理', '合同模块更名为项目合同管理', t.TITLES.contracts.title);
  check(t.TITLES.payments.title === '项目付款台帐', '付款模块更名为项目付款台帐', t.TITLES.payments.title);

  S.view = 'contracts';
  t.render();
  check(document.querySelector('#viewTitle').textContent === '项目合同管理', '页面标题同步改名');
  const navHtml2 = document.querySelector('#nav').innerHTML;
  check(/项目合同管理/.test(navHtml2) && /项目付款台帐/.test(navHtml2), '导航文案同步改名');

  // 商铺详情 + 打印文档
  const shopId = S.data.shops[0].id;
  t.openShopDetail(shopId);
  m = modal();
  check(/data-act="printShop"/.test(m), '商铺详情提供打印按钮');
  check(/打印档案/.test(m), '打印按钮文案正确');
  check(/attach-panel/.test(m) && /thumbs/.test(m), '商铺详情含附件面板与缩略图区');
  check(t.attsOf('shops', shopId).length > 0, '商铺附件可上传并读取');

  const shopFormHtml = (() => { t.shopForm(shopId); return modal(); })();
  check(/attach-panel/.test(shopFormHtml), '商铺编辑表单含附件上传面板');

  const ph = t.printDocHtml(shopId);
  const shopName = S.data.shops[0].name;
  check(/^<!DOCTYPE html>/.test(ph.trim()), '打印文档为独立 HTML');
  check(ph.includes(shopName), '打印文档含商铺名称', shopName);
  check(/商铺档案/.test(ph) && /@page\{size:A4/.test(ph), '打印文档含表头与 A4 页面设置');
  check(/class="print-doc"/.test(ph), '打印文档套用打印样式作用域');
  check(/现场图片/.test(ph), '打印稿含现场图片区（有附件时）');
  check(!/class="attach-panel/.test(ph), '打印稿不含上传面板');
  check(/<base href=/.test(ph), '打印文档注入 base 修复相对图片路径');
  check(/<table>/.test(ph) && /class="kv"/.test(ph) && /mini-stats/.test(ph), '打印保留表格与统计块排版');
  check(/\[data-act\]\{display:none/.test(ph), '打印隐藏操作按钮');
  check(!/undefined|NaN|\[object Object\]/.test(ph), '打印文档无 undefined/NaN');
  check(/制表人/.test(ph) && /打印时间/.test(ph), '打印含签字栏与打印时间');

  let printErr = '';
  try { t.printShop(shopId); } catch (e) { printErr = e.message; }
  check(!printErr, '打印入口调用不抛异常', printErr);

  /* ---------- 1.8.0：项目合同打印 ---------- */
  const cName = S.data.contracts.find((x) => x.id === ids.contractId).name;
  const pc = t.printContractHtml(ids.contractId);
  check(/^<!DOCTYPE html>/.test(pc.trim()), '合同打印文档为独立 HTML');
  check(/项目合同档案/.test(pc) && pc.includes(cName), '合同打印含抬头与合同名称', cName);
  check(/付款计划/.test(pc) && /施工进度/.test(pc) && /付款流水/.test(pc), '合同打印含三大区块');
  check(/class="kv"/.test(pc) && /mini-stats/.test(pc) && /制表人/.test(pc), '合同打印保留排版与签字栏');
  check(!/class="attach-panel/.test(pc), '合同打印不含上传面板（缩略图的 viewAtt 已被打印 CSS 隐藏）');
  check(!/undefined|NaN|\[object Object\]/.test(pc), '合同打印无 undefined/NaN');
  check(/<base href=/.test(pc), '合同打印注入 base 修复相对图片路径');
  // 详情弹窗含打印按钮
  t.openContractDetail(ids.contractId);
  m = modal();
  check(/data-act="printContract"/.test(m) && /打印合同/.test(m), '合同详情提供打印按钮');
  let pcErr = '';
  try { t.printContract(ids.contractId); } catch (e) { pcErr = e.message; }
  check(!pcErr, '合同打印入口调用不抛异常', pcErr);

  /* ---------- 1.6.0：登录态 / 用户管理 / 操作日志 / 侧栏 ---------- */
  check(!!S.auth && S.auth.username === 'admin' && S.auth.role === 'admin', 'bootstrap 带回当前登录用户');
  t.render();
  check(/u-name/.test(document.querySelector('#userChip').innerHTML) && /管理员/.test(document.querySelector('#userChip').innerHTML), '顶栏显示用户与角色');
  const navHtml3 = (() => { S.view = 'dashboard'; t.render(); return document.querySelector('#nav').innerHTML; })();
  check(/data-view="users"/.test(navHtml3) && /data-view="audit"/.test(navHtml3), '管理员导航含用户管理与操作日志');

  // 用户管理视图
  S.view = 'users';
  t.render();
  check(/账号总数/.test(view()) && /id="usersBody"/.test(view()), '用户管理页渲染统计与表格容器');
  await t.loadUsers();
  const ub = document.querySelector('#usersBody').innerHTML;
  check(/op01/.test(ub) && /运维小王/.test(ub), '用户表格列出新建账号');
  check(/role-pill/.test(ub) && /最近登录/.test(ub), '用户表格含角色与最近登录');

  t.userForm();
  m = modal();
  check(/新增用户/.test(m) && /data-k="role"/.test(m) && /data-k="password"/.test(m), '新增用户表单渲染完整');
  closeModal();

  // 操作日志视图
  S.view = 'audit';
  t.render();
  await t.loadAudit();
  const ab2 = document.querySelector('#auditBody').innerHTML;
  check(/今日操作/.test(ab2) && /data-audit-filter="user"/.test(ab2), '操作日志页渲染统计与筛选');
  check(/登录/.test(ab2) && /新增用户/.test(ab2), '日志留痕：登录与新增用户已被记录');
  check(/act-pill/.test(ab2), '动作标签渲染');

  // 侧栏署名居中（静态结构）；版本号改为动态渲染，不再写死
  const shell = fs.readFileSync(path.join(__dirname, '..', 'pack/app/www/index.html'), 'utf8');
  check(/dev-foot/.test(shell) && /开发者 <b>无冰咖啡糖<\/b><br><span id="devVer">/.test(shell), '开发者署名移至侧栏底部（版本号动态化）');
  check(!/v1\.8\.0<\/div>/.test(shell), '侧栏不再写死版本号');

  /* ---------- 1.12.0：三模块即时搜索 + 商铺欠费统计 ---------- */
  const searchBak = { eq: S.eqQuery, contract: S.contractQuery, pay: S.payQuery, shop: S.shopQuery };
  const shopStBak = S.shopStatus, ctStBak = S.contractStatus, eqCatBak = S.eqCat;
  const billsBak = S.data.bills.slice();
  S.eqQuery = ''; S.contractQuery = ''; S.payQuery = ''; S.shopQuery = '';
  S.shopStatus = 'all'; S.contractStatus = 'all'; S.eqCat = 'all'; S.mode = {};

  check(/id="eqSearch"/.test(renderView('equipments')) && /搜索设备 \/ 编号 \/ 位置 \/ 品牌/.test(view()),
    '设备管理工具栏含搜索框');
  check(/id="contractSearch"/.test(renderView('contracts')) && /搜索合同 \/ 编号 \/ 施工方/.test(view()),
    '项目合同管理工具栏含搜索框');
  check(/id="paySearch"/.test(renderView('payments')) && /搜索付款节点 \/ 合同 \/ 施工方/.test(view()),
    '项目付款台帐工具栏含搜索框');
  check(/id="shopSearch"/.test(renderView('shops')) && /搜索商铺 \/ 租户/.test(view()), '商铺管理搜索框保持原样');
  check(t.matchQuery('', ['消防泵']) && t.matchQuery(' 泵 ', ['消防泵']) && !t.matchQuery('zzz', ['消防泵']),
    '匹配函数：空词不过滤 / 去空格 / 未命中返回 false');
  check(Object.keys(t.SEARCH_BINDINGS).length === 6
    && t.SEARCH_BINDINGS.archiveSearch === 'archiveQuery'
    && t.SEARCH_BINDINGS.whSearch === 'warehouseQuery',
    '六个搜索框统一绑定输入事件（含档案 / 仓库）');

  const eq0 = S.data.equipments[0], ct0 = S.data.contracts[0], plan0 = S.data.payment_plans[0];
  const ctOfPlan = S.data.contracts.find(c => c.id === plan0.contract_id) || {};
  S.eqQuery = eq0.name;
  check(/data-act="eq"/.test(t.viewEquipments()), '设备按名称搜索有结果');
  S.eqQuery = eq0.code || eq0.name;
  check(/data-act="eq"/.test(t.viewEquipments()), '设备按编号搜索有结果');
  S.eqQuery = eq0.location || eq0.name;
  S.eqCat = eq0.category;
  check(/data-act="eq"/.test(t.viewEquipments()), '设备搜索与分类筛选叠加生效');
  S.eqQuery = 'ZZZ不存在的设备ZZZ'; S.eqCat = 'all';
  check(/没有匹配的设备/.test(t.viewEquipments()), '设备无结果显示专用空提示');
  S.eqQuery = '';

  S.contractQuery = ct0.contractor || ct0.name;
  check(/data-act="contract"/.test(t.viewContracts()), '合同按施工方搜索有结果');
  S.contractQuery = ct0.contract_no || ct0.name;
  check(/data-act="contract"/.test(t.viewContracts()), '合同按编号搜索有结果');
  S.contractQuery = 'ZZZ不存在的合同ZZZ';
  check(/没有匹配的合同/.test(t.viewContracts()), '合同无结果显示专用空提示');
  S.contractQuery = '';

  S.payQuery = plan0.name;
  check(/data-act="editPlan"/.test(t.viewPayments()), '付款节点按名称搜索有结果');
  S.payQuery = ctOfPlan.name || plan0.name;
  check(/data-act="editPlan"/.test(t.viewPayments()), '付款节点可按所属合同名搜索');
  S.payQuery = 'ZZZ不存在的节点ZZZ';
  check(/没有匹配的付款节点/.test(t.viewPayments()), '付款台帐无结果显示专用空提示');
  S.payQuery = '';

  // 商铺欠费：内存造一条未收款账单，避免依赖种子账单状态
  const shopA = S.data.shops[0];
  S.data.bills.push({ id: 990001, shop_id: shopA.id, period: '2026-10', total: 3600, status: 'unpaid' });
  check(t.shopUnpaid(shopA.id) >= 3600, '欠费合计包含未收款账单');
  S.mode.shops = 'list';
  const shopBar = t.viewShops();
  check(/data-k="arrears"/.test(shopBar) && /欠费/.test(shopBar), '商铺状态统计栏新增欠费项');
  check(shopBar.indexOf('data-k="maintenance"') < shopBar.indexOf('data-k="arrears"'), '欠费项紧跟在维修之后');
  const expectSum = S.data.shops.reduce((n, s) => n + t.shopUnpaid(s.id), 0);
  check(shopBar.includes(`欠费<b>${t.moneyShort(expectSum)}</b>`), '欠费项显示欠费总额', t.moneyShort(expectSum));
  check(/共 \d+ 间商铺欠费/.test(shopBar), '欠费项提示欠费商铺数');
  check(/chip warn/.test(shopBar), '欠费金额标红提醒');

  S.shopStatus = 'arrears';
  const arHtml = t.viewShops();
  const noDebt = S.data.shops.filter(s => t.shopUnpaid(s.id) <= 0);
  check(arHtml.includes(shopA.name), '欠费筛选显示欠费商铺');
  check(noDebt.every(s => !arHtml.includes(`data-id="${s.id}"`)), '欠费筛选隐藏无欠费商铺');
  await click({ act: 'shopStatus', k: 'arrears' });
  check(S.shopStatus === 'arrears', '点击欠费统计项可切换筛选');
  await click({ act: 'shopStatus', k: 'all' });
  check(S.shopStatus === 'all', '欠费筛选可切回全部');
  check(/维修 \d+ \/ 欠费 \d+ 间/.test(renderView('dashboard')), '概览统计栏在维修后显示欠费');

  const inputHandler = docListeners['input'];
  check(typeof inputHandler === 'function', '全局输入监听已注册');
  inputHandler({ target: { id: 'eqSearch', value: '泵', selectionStart: 1 } });
  check(S.eqQuery === '泵', '设备搜索输入即时更新状态');
  inputHandler({ target: { id: 'contractSearch', value: '改造', selectionStart: 2 } });
  check(S.contractQuery === '改造', '合同搜索输入即时更新状态');
  inputHandler({ target: { id: 'paySearch', value: '尾款', selectionStart: 2 } });
  check(S.payQuery === '尾款', '付款搜索输入即时更新状态');
  inputHandler({ target: { id: 'shopSearch', value: 'A栋', selectionStart: 2 } });
  check(S.shopQuery === 'A栋', '商铺搜索仍走统一绑定');
  await new Promise(r => setTimeout(r, 260)); // 等防抖渲染完成，避免影响后续断言

  S.eqQuery = searchBak.eq; S.contractQuery = searchBak.contract;
  S.payQuery = searchBak.pay; S.shopQuery = searchBak.shop;
  S.shopStatus = shopStBak; S.contractStatus = ctStBak; S.eqCat = eqCatBak;
  S.data.bills = billsBak; S.mode = {};

  /* ---------- 1.13.0：概览 / 可视化面板重新设计 + 现有数据联动 ---------- */
  const ovApi = await (await fetchJar(BASE + '/api/overview')).json();
  check(ovApi.ok && !!ovApi.data.billing && typeof ovApi.data.billing.collectRate === 'number',
    '服务端概览新增账单收缴率等指标', JSON.stringify(ovApi.data.billing));
  check(!!ovApi.data.maintenance && typeof ovApi.data.maintenance.costTotal === 'number',
    '服务端概览新增维保费用指标');

  const m0 = t.dashMetrics();
  check(m0.months.length === 6, '默认时间范围为近 6 个月');
  check(m0.shops.total === S.data.shops.length, '驾驶舱商铺总数关联商铺档案');
  check(m0.shops.rented === S.data.shops.filter(s => s.status === 'rented').length, '在租数关联商铺状态');
  const expectRent = S.data.shops.filter(s => s.status === 'rented').reduce((n, s) => n + t.shopMonthly(s), 0);
  check(Math.abs(m0.shops.monthlyRent - expectRent) < 0.02, '在租月租金按现有租金字段派生',
    `${m0.shops.monthlyRent} vs ${expectRent}`);
  const expectArrears = S.data.shops.reduce((n, s) => n + t.shopUnpaid(s.id), 0);
  check(Math.abs(m0.shops.arrearsSum - expectArrears) < 0.02, '欠费金额关联未收款账单', String(expectArrears));
  check(m0.billing.count === S.data.bills.length, '账单收缴率关联账单表');
  check(m0.cashflow.length === 6 && m0.utility.length === 6, '收支 / 水电趋势按时间范围生成');
  check(m0.byBuilding.reduce((n, b) => n + b.total, 0) === S.data.shops.length, '楼栋汇总覆盖全部商铺');
  check(m0.risk.length > 0 && m0.risk.every(r => r.type && r.title), '风险清单全部来自真实业务记录');

  // 业务数据变更后，指标即时联动
  const probeShop = S.data.shops[0];
  S.data.bills.push({ id: 990101, shop_id: probeShop.id, period: '2026-10', total: 1234, status: 'unpaid' });
  const m1 = t.dashMetrics();
  check(m1.shops.arrearsSum - m0.shops.arrearsSum >= 1233.9, '新增未收款账单后欠费指标即时变化');
  check(m1.billing.unpaidCount === m0.billing.unpaidCount + 1, '未收款账单笔数同步');
  S.data.bills.pop();

  S.dashRange = '12';
  check(t.dashMetrics().months.length === 12, '近 12 个月范围生成 12 个账期');
  S.dashRange = 'ytd';
  check(t.dashMetrics().months.length === new Date().getMonth() + 1, '本年度范围只含当年已过月份');
  S.dashRange = '6';
  const b0 = m0.byBuilding[0];
  S.dashBuilding = b0.name;
  const mb = t.dashMetrics();
  const bShopIds = S.data.shops.filter(s => (s.building || '未标注') === b0.name).map(s => s.id);
  check(mb.shops.total === b0.total, '楼栋筛选后商铺指标按该楼栋重算');
  check(mb.raw.bills.every(b => bShopIds.includes(b.shop_id)), '楼栋筛选后账单按商铺归属过滤');
  check(mb.equipments.total === m0.equipments.total, '设备指标保持全项目口径');
  S.dashBuilding = 'all';

  S.cockpitTab = 'overview';
  const ovHtml = renderView('dashboard');
  check(/dash-hero/.test(ovHtml) && /dk-grid/.test(ovHtml), '驾驶舱采用经营快照与 KPI 新布局');
  check(/id="chartCash"/.test(ovHtml) && /id="chartEq"/.test(ovHtml), '经营总览保留收支与资产结构图表');
  check(/id="dashDrill"/.test(ovHtml) && /风险与待办/.test(ovHtml), '驾驶舱含风险清单与明细下钻区');
  check(/维修 \d+ \/ 欠费 \d+ 间/.test(ovHtml), '驾驶舱仍显示维修 / 欠费统计');
  check(/dash-stat/.test(ovHtml) && /data-act="dashTab"/.test(ovHtml), '合并后含紧凑指标带与维度切换');
  // 1.17.0：四个分析维度各自挂载自己的图表，首屏不再堆满十余张图
  const tabCases = [
    ['overview', ['chartCash', 'chartEq']],
    ['assets', ['dbShop', 'dbRent', 'chartEq', 'dbContract']],
    ['finance', ['chartCash', 'dbBill', 'dbUtil', 'dbDue']],
    ['engineering', ['dbEq', 'dbPay', 'dbContract']]
  ];
  for (const [tab, ids] of tabCases) {
    S.cockpitTab = tab;
    const html = renderView('dashboard');
    ids.forEach(id => check(html.includes(`id="${id}"`), `驾驶舱 ${tab} 分区图表 ${id} 已挂载`));
    check(html.includes(`data-act="dashTab" data-k="${tab}"`), `驾驶舱 ${tab} 分区按钮存在`);
  }
  S.cockpitTab = 'overview';
  const dbHtml = renderView('dashboard');
  check(!/id="dbCash"/.test(dbHtml) && !/id="dbShop"/.test(dbHtml), '合并后首屏不重复渲染其它分区图表');
  check(/data-act="dashRange"/.test(dbHtml) && /data-act="dashBuilding"/.test(dbHtml), '驾驶舱提供时间 / 楼栋联动');
  check(/data-act="dashGo"/.test(dbHtml), 'KPI 卡可跳转业务台账');

  await click({ act: 'dashRange', k: '12' });
  check(S.dashRange === '12' && /class="active" data-act="dashRange" data-k="12"/.test(view()), '点击时间范围可切换并重绘');
  await click({ act: 'dashRange', k: '6' });
  await click({ act: 'dashGo', view: 'shops', filter: 'arrears' });
  check(S.view === 'shops' && S.shopStatus === 'arrears', 'KPI 跳转商铺并自动带欠费筛选');
  S.view = 'dashboard'; S.shopStatus = 'all'; S.dashDrill = null; t.render();
  await click({ act: 'dashDrill', type: 'month', k: t.dashMetrics().months[5] });
  check(!!S.dashDrill && S.dashDrill.type === 'month', '图表下钻写入状态');
  check(/drill-head/.test(view()) && /经营明细下钻/.test(view()), '下钻区渲染明细表头');
  await click({ act: 'dashClear' });
  check(S.dashDrill === null && /点击上方图表/.test(view()), '清除下钻回到提示态');
  await click({ act: 'dashDrill', type: 'arrears', k: '' });
  check(S.dashDrill.type === 'arrears' && /欠费商铺/.test(view()), '风险条目联动欠费商铺明细');
  await click({ act: 'dashClear' });
  S.dashRange = '6'; S.dashBuilding = 'all'; S.dashDrill = null;

  /* ---------- 1.14.0：弹窗拖动 / 抄表账单可编辑 / 资产类目对齐 ---------- */
  // 弹窗结构：一层详情窗与二层预览窗都带拖动把手与提示
  document.querySelector('#modalRoot').innerHTML = '';
  S.modalReturn = null; S.formSubmit = null;
  t.openShopDetail(S.data.shops[0].id);
  check(/drag-handle/.test(modal()) && /按住标题栏可拖动/.test(modal()), '详情窗标题栏可按住拖动');
  t.openAttPreview(S.data.attachments[0].id);
  check(/drag-handle/.test(lightbox()) && /按住标题栏可拖动/.test(lightbox()), '图片 / 附件预览窗同样可拖动');
  t.closeLightbox();
  check(/attach-panel|商铺档案/.test(modal()), '拖动层关闭后详情窗保持不动');
  t.closeModal();

  // 拖动核心逻辑：阈值、位移、边界、接续、松开、复位
  const dragBox = {
    dataset: {}, style: {}, added: false,
    classList: { add() { dragBox.added = true; }, remove() { dragBox.added = false; } },
    getBoundingClientRect: () => ({ left: 300, top: 120 })
  };
  t.beginModalDrag(dragBox, 300, 120);
  check(t.moveModalDrag(301, 121) === null, '小于 3px 的移动视为普通点击');
  const tf = t.moveModalDrag(360, 170);
  check(tf === 'translate(60px, 50px)' && dragBox.style.transform === tf, '按住拖动后窗口产生位移');
  check(dragBox.dataset.dragX === '60' && dragBox.dataset.dragY === '50' && dragBox.added, '位移写入窗口状态并进入拖动样式');
  t.beginModalDrag(dragBox, 360, 170);
  check(t.moveModalDrag(370, 185) === 'translate(70px, 65px)', '二次拖动从当前位置接续');
  t.endModalDrag();
  check(t.moveModalDrag(500, 300) === null && !dragBox.added, '松开鼠标后停止拖动');
  global.window.innerWidth = 1000; global.window.innerHeight = 700;
  t.beginModalDrag(dragBox, 100, 100);
  const clamped = t.moveModalDrag(9000, 9000);
  check(/translate\(/.test(clamped) && dragBox.added, '大幅拖动仍被限制在可视范围', clamped);
  t.endModalDrag();
  global.window.innerWidth = undefined; global.window.innerHeight = undefined;
  t.resetModalDrag(dragBox);
  check(!dragBox.style.transform && !dragBox.dataset.dragX, '关闭 / 回退弹窗后位移复位');
  check(typeof docListeners['mousedown'] === 'function' && typeof docListeners['mousemove'] === 'function'
    && typeof docListeners['mouseup'] === 'function', '按下 / 移动 / 松开监听均已注册');
  const INTERACTIVE = 'button, a, input, select, textarea, label, .modal-close';
  const mkTgt = (arr, cls) => ({ className: cls || 'modal-body', closest: (sel) => arr.includes(sel) ? dragBox : null });
  check(t.modalDragTarget(mkTgt(['.modal-head', '.modal'])) === dragBox, '标题栏是拖动把手');
  check(t.modalDragTarget(mkTgt(['.modal-body', '.modal'], 'sect-title')) === dragBox, '内容区空白处也可拖动');
  check(t.modalDragTarget(mkTgt([INTERACTIVE, '.modal-head', '.modal'])) === null, '按钮 / 输入等交互元素不触发拖动');

  /* ---------- 1.16.0：拖动体验优化 ---------- */
  check(t.RAF === null && t.DRAG_THRESHOLD === 3,
    '无逐帧刷新环境自动降级为同步，位移阈值保持 3px');
  check(/setPointerCapture/.test(code) && /lostpointercapture/.test(code),
    '启用指针捕获并监听丢失事件，指针移出弹窗仍跟手');
  check(/requestAnimationFrame/.test(code) && /dragFlush/.test(code), '拖动位移按帧批量刷新');
  check(/style\.animation = 'none'/.test(code), '起拖冻结出场动画，避免首次移动跳位');
  check(/modal-dragging/.test(code) && /user-select:none/.test(fs.readFileSync(path.join(__dirname, '..', 'pack/app/www/index.html'), 'utf8')),
    '拖动时全窗统一光标并禁止选中文字');
  check(/dblclick/.test(code) && /双击回正/.test(code), '双击标题栏回正与提示文案');
  check(typeof docListeners['dblclick'] === 'function' && typeof docListeners['dragstart'] === 'function',
    '双击回正与原生图片拖拽拦截监听已注册');
  const textTgt = {
    className: 'sect-title',
    closest: (sel) => (sel === '.modal-body' || sel === '.modal' || /^p, li, td/.test(sel)) ? dragBox : null
  };
  check(t.modalDragTarget(textTgt) === null, '内容区表格 / 正文文本不再误触发拖动');
  check(t.dragSuppressClick() === false, '正常点击不被吞掉');
  t.MODAL_DRAG.suppressClick = true;
  check(t.dragSuppressClick() === true && t.dragSuppressClick() === false,
    '拖动结束后只抑制紧接着的一次点击');
  t.beginModalDrag(dragBox, 200, 200);
  t.moveModalDrag(260, 240);
  t.endModalDrag({ type: 'mouseup' });
  check(t.MODAL_DRAG.suppressClick === true, '真实松开拖动后标记抑制补发点击（避免落在遮罩上误关）');
  t.MODAL_DRAG.suppressClick = false;
  let captured = null;
  t.captureDrag({ setPointerCapture: (id) => { captured = id; } }, 7);
  check(captured === 7, '指针捕获绑定到当前弹窗');
  Object.assign(t.MODAL_DRAG, { bw: 620, bh: 420, ox: 200, oy: 100 });
  global.window.innerWidth = 1000; global.window.innerHeight = 700;
  const [cx, cy] = t.dragClamp(9999, 9999);
  check(cx === 640 && cy === 556, '边界按弹窗真实尺寸计算，标题栏始终可见', `${cx}/${cy}`);
  global.window.innerWidth = undefined; global.window.innerHeight = undefined;
  dragBox.style.animation = 'none';
  t.resetModalDrag(dragBox);
  check(!dragBox.style.animation && !dragBox.style.transform, '复位时解除冻结动画并清零位移');

  // 商铺详情：抄表与账单逐条可编辑；打印档案仍为纯数据
  const shopWithRec = S.data.shops.find(x => S.data.readings.some(r => r.shop_id === x.id)
    && S.data.bills.some(b => b.shop_id === x.id));
  const detailHtml = t.shopDetailInner(t.shopDetailData(shopWithRec.id));
  check(/data-act="editReading"/.test(detailHtml) && /data-act="delReading"/.test(detailHtml), '水电抄表表格提供逐条编辑 / 删除');
  check(/data-act="editBill"/.test(detailHtml) && /data-act="delBill"/.test(detailHtml), '费用账单表格提供逐条编辑 / 删除');
  const printHtml = t.shopDetailInner(t.shopDetailData(shopWithRec.id), { print: true });
  check(!/data-act="editReading"/.test(printHtml) && !/data-act="editBill"/.test(printHtml), '打印档案不含编辑操作列');
  check(!/class="work-panel"/.test(printHtml) && !/装修进度记录/.test(printHtml),
    '1.21.0：打印版商铺主体不含装修 / 维修工程区块');
  const rd = S.data.readings.find(r => r.shop_id === shopWithRec.id);
  const bl = S.data.bills.find(b => b.shop_id === shopWithRec.id);
  t.openReadingForm(null, rd.id);
  check(/编辑水电抄表/.test(modal()) && /data-k="water_price"/.test(modal()) && /保存修改/.test(modal()),
    '抄表编辑表单带入原记录并提供单价字段');
  await click({ act: 'closeModal' });
  t.openBillForm(null, bl.id);
  check(/编辑费用账单/.test(modal()) && /billTotalPreview/.test(modal()) && /data-k="status"/.test(modal())
    && /data-k="rent_amount"/.test(modal()), '账单编辑表单含各项金额、收款状态与实时合计');
  await click({ act: 'closeModal' });
  t.openReadingForm(shopWithRec.id);
  check(/录入水电抄表/.test(modal()) && /保存抄表/.test(modal()), '录入新抄表入口保持可用');
  await click({ act: 'closeModal' });
  t.openBillForm(shopWithRec.id);
  check(/生成月度账单/.test(modal()), '生成新账单入口保持可用');
  await click({ act: 'closeModal' });
  await click({ act: 'delReading', id: String(rd.id) });
  check(/删除水电抄表/.test(modal()), '删除抄表前有二次确认');
  await click({ act: 'closeModal' });
  await click({ act: 'delBill', id: String(bl.id) });
  check(/删除费用账单/.test(modal()), '删除账单前有二次确认');
  await click({ act: 'closeModal' });

  // 服务端：用独立账期造记录，验证编辑重算 / 同步 / 校验 / 删除，最后清理回原状
  const apiShop = S.data.shops[0];
  const TP = '2020-01';
  const postR = await fetchJar(`${BASE}/api/shops/${apiShop.id}/readings`, jsonInit('POST', {
    period: TP, read_date: '2020-01-05', water_prev: 10, water_curr: 20, elec_prev: 100, elec_curr: 150
  }));
  const rdNew = (await postR.json()).data;
  check(postR.status === 200 && rdNew && rdNew.water_usage === 10, '新增抄表自动计算用量');
  const postB = await fetchJar(`${BASE}/api/shops/${apiShop.id}/bills`, jsonInit('POST', { period: TP, other_amount: 5 }));
  const blNew = (await postB.json()).data;
  check(postB.status === 200 && blNew && Math.abs(blNew.water_amount - rdNew.water_fee) < 0.01,
    '生成账单自动带出抄表水电费');
  const putR = await fetchJar(`${BASE}/api/readings/${rdNew.id}`, jsonInit('PUT', { water_curr: 30, elec_curr: 200 }));
  const putRj = await putR.json();
  const putRd = putRj.data;
  check(putR.status === 200 && putRd.water_usage === 20 && putRd.elec_usage === 100,
    '编辑抄表自动重算用水 / 用电量', JSON.stringify(putRd && [putRd.water_usage, putRd.elec_usage]));
  check(putRj.synced === 1, '抄表编辑同步同账期未收款账单', String(putRj.synced));
  const billAfter = (await (await fetchJar(`${BASE}/api/bills/${blNew.id}`)).json()).data;
  check(Math.abs(billAfter.water_amount - putRd.water_fee) < 0.01
    && Math.abs(billAfter.elec_amount - putRd.elec_fee) < 0.01
    && Math.abs(billAfter.total - (billAfter.rent_amount + putRd.water_fee + putRd.elec_fee + 5)) < 0.01,
    '未收款账单的水电费与合计随抄表同步');
  const badR = await fetchJar(`${BASE}/api/readings/${rdNew.id}`, jsonInit('PUT', { water_curr: 5 }));
  check(badR.status === 400, '期末读数小于期初读数被拒绝');
  const putB = await fetchJar(`${BASE}/api/bills/${blNew.id}`, jsonInit('PUT', { other_amount: 88.5, status: 'paid' }));
  const putBl = (await putB.json()).data;
  check(putB.status === 200 && putBl.status === 'paid' && !!putBl.paid_date
    && Math.abs(putBl.total - (putBl.rent_amount + putBl.water_amount + putBl.elec_amount + 88.5)) < 0.01,
    '编辑账单重算合计并自动登记收款日期');
  await fetchJar(`${BASE}/api/readings/${rdNew.id}`, jsonInit('PUT', { water_curr: 35 }));
  const paidBill = (await (await fetchJar(`${BASE}/api/bills/${blNew.id}`)).json()).data;
  check(Math.abs(paidBill.water_amount - putRd.water_fee) < 0.01, '已收款账单金额不被后续抄表改动覆盖');
  const dupB = await fetchJar(`${BASE}/api/bills/${blNew.id}`, jsonInit('PUT', { period: 'bad-format' }));
  check(dupB.status === 400, '非法账期格式被拒绝');
  await fetchJar(`${BASE}/api/bills/${blNew.id}`, { method: 'DELETE' });
  const delR = await fetchJar(`${BASE}/api/readings/${rdNew.id}`, { method: 'DELETE' });
  check(delR.status === 200, '删除抄表 / 账单接口可用');
  const bootAfter = await (await fetchJar(`${BASE}/api/bootstrap`)).json();
  check(!bootAfter.data.readings.some(r => r.id === rdNew.id) && !bootAfter.data.bills.some(b => b.id === blNew.id),
    '测试记录清理完毕，业务数据回到原状');

  // 概览资产结构四类目
  const mc = t.dashMetrics();
  const cls = mc.shops.byClass;
  check(cls.length === 4 && cls.map(c => c.label).join('/') === '在租/空置/维修/欠费',
    '资产结构类目与商铺管理统计栏完全对齐', cls.map(c => c.label).join('/'));
  check(cls.reduce((n, c) => n + c.value, 0) === mc.shops.total, '环图四类互斥且合计等于商铺总数');
  check(cls[3].value === mc.shops.arrearsCount && Math.abs(cls[3].amount - mc.shops.arrearsSum) < 0.01,
    '欠费类目关联未收款账单');
  const pie = t.shopPieData(mc);
  check(pie.length === 4 && pie.every(p => p.itemStyle && p.itemStyle.color), '环图四段带类目配色');
  const ov14 = renderView('dashboard');
  check(/dash-cats/.test(ov14) && ['rented', 'vacant', 'maintenance', 'arrears']
    .every(k => ov14.includes(`data-act="dashCat" data-k="${k}"`)), '概览资产结构卡展示四类目');
  check(/类目与商铺管理一致/.test(ov14) && !/class="dlegend"/.test(ov14), '资产结构卡去掉不相干图例并标注口径');
  await click({ act: 'dashCat', k: 'arrears' });
  check(S.dashDrill && S.dashDrill.type === 'arrears' && S.shopStatus === 'arrears'
    && /欠费商铺/.test(view()), '点击欠费类目下钻明细并预置商铺筛选');
  await click({ act: 'dashClear' });
  await click({ act: 'dashCat', k: 'rented' });
  check(S.shopStatus === 'rented' && /在租 · 商铺明细/.test(view()), '点击在租类目下钻在租商铺');
  await click({ act: 'dashClear' });
  S.shopStatus = 'all'; S.dashDrill = null; S.view = 'dashboard'; t.render();

  /* ---------- 1.15.0：保养记录可编辑 / 保养状态可编辑 ---------- */
  const closeAll = () => { for (let i = 0; i < 5; i++) t.closeModal(); };
  check(Object.keys(t.MAINTAIN_STATUS).join('/') === 'planned/doing/done/postponed',
    '保养状态四类枚举（待保养 / 保养中 / 已完成 / 已延期）');
  check(t.eqMaintainInfo({ status: 'normal', next_maintain: '2020-01-01' }).key === 'planned'
    && t.eqMaintainInfo({ status: 'normal', next_maintain: '2020-01-01' }).label === '保养已到期',
    '未手动设定时按下次保养日期自动派生');
  check(t.eqMaintainInfo({ status: 'normal', next_maintain: '2020-01-01', maintain_status: 'done' }).key === 'done',
    '手动设定的保养状态优先于日期派生');
  check(t.maintainWarn({ status: 'normal', next_maintain: '2020-01-01', maintain_status: 'done' }) === false,
    '标记本轮已完成后不再进入待保养提醒');
  check(S.data.meta.app.version === t.CHANGELOG[0].v,
    '服务端下发版本与更新日志当前版本一致', S.data.meta.app.version);

  const eqHtml15 = renderView('equipments');
  check(/保养状态/.test(eqHtml15) && /data-act="eqMaintainFilter" data-k="postponed"/.test(eqHtml15),
    '设备列表显示保养状态列与状态筛选');
  check(/data-act="editEqMaintain"/.test(eqHtml15) && /data-act="eq"/.test(eqHtml15),
    '设备行提供保养状态编辑入口');
  await click({ act: 'eqMaintainFilter', k: 'doing' });
  check(S.eqMaintain === 'doing' && /class="chip active" data-act="eqMaintainFilter" data-k="doing"/.test(view()),
    '点击保养状态筛选即时生效');
  await click({ act: 'eqMaintainFilter', k: 'all' });
  S.mode.equipments = 'card'; t.render();
  check(/data-act="editEqMaintain"/.test(view()) && /保养中|已完成|已延期/.test(view()),
    '方块视图同样显示保养状态并提供编辑入口');
  S.mode.equipments = 'list'; t.render();

  const seedMaintain = S.data.equipment_logs.find(l => l.type === 'maintain');
  const eqWithLog = S.data.equipments.find(e => e.id === seedMaintain.equipment_id) || S.data.equipments[0];
  t.openEqDetail(eqWithLog.id);
  const eqDetail15 = modal();
  check(/data-act="editEqLog"/.test(eqDetail15) && /data-act="delEqLog"/.test(eqDetail15),
    '设备详情的维保记录逐条可编辑 / 删除');
  check(/data-act="editEqMaintain"/.test(eqDetail15) && /保养状态/.test(eqDetail15),
    '设备详情展示并可直接编辑保养状态');
  check(/已完成|保养中|已延期|待保养/.test(eqDetail15), '记录列表显示保养状态标签');
  closeAll();

  const aLog = S.data.equipment_logs.find(l => l.equipment_id === eqWithLog.id) || seedMaintain;
  t.openEqLogForm(null, aLog.id);
  check(/编辑维保 \/ 保养记录/.test(modal()) && /data-k="maintain_status"/.test(modal())
    && /data-k="next_maintain"/.test(modal()) && /保存修改/.test(modal()),
    '记录编辑表单可改保养状态、日期与下次保养');
  closeAll();
  t.openEqLogForm(eqWithLog.id);
  check(/新增设备记录/.test(modal()) && /data-k="maintain_status"/.test(modal()) && /保存记录/.test(modal()),
    '新增记录入口保持可用且可选保养状态');
  closeAll();
  t.openEqMaintainForm(eqWithLog.id);
  check(/编辑设备保养状态/.test(modal()) && /按日期自动/.test(modal())
    && /data-k="maintain_status"/.test(modal()) && /data-k="add_log"/.test(modal()),
    '保养状态表单含自动 / 手动状态与留痕选项');
  closeAll();
  await click({ act: 'delEqLog', id: String(aLog.id) });
  check(/删除维保记录/.test(modal()), '删除维保记录前有二次确认');
  closeAll();
  const peq15 = t.printEqHtml(eqWithLog.id);
  check(/保养状态/.test(peq15) && /<table>/.test(peq15), '设备 A4 打印含保养状态与记录状态列');
  check(!/data-act="editEqLog"/.test(peq15), '打印档案保持纯数据，不含编辑按钮');

  // 服务端：用一台无历史记录的设备造数据，验证新增 / 编辑 / 校验 / 快捷状态 / 删除回退，最后清理
  const testEq = S.data.equipments.find(e => !S.data.equipment_logs.some(l => l.equipment_id === e.id))
    || S.data.equipments[0];
  const origSt = testEq.maintain_status || '', origNext = testEq.next_maintain || '';
  const LOGDAY = '2020-02-03';
  const postL = await fetchJar(`${BASE}/api/equipments/${testEq.id}/logs`, jsonInit('POST', {
    type: 'maintain', log_date: LOGDAY, content: '测试保养记录', cost: 120, operator: '测试',
    maintain_status: 'doing', next_maintain: '2020-05-01'
  }));
  const plj = await postL.json();
  const newLog = plj.data;
  check(postL.status === 200 && newLog && newLog.maintain_status === 'doing'
    && newLog.next_maintain === '2020-05-01', '新增保养记录保存状态与下次保养日期');
  check(plj.equipment && plj.equipment.maintain_status === 'doing'
    && plj.equipment.next_maintain === '2020-05-01', '最新保养记录状态同步到设备');

  const putL = await fetchJar(`${BASE}/api/equipment_logs/${newLog.id}`, jsonInit('PUT', {
    maintain_status: 'done', content: '测试保养记录（已完成）', cost: 168.5, next_maintain: '2020-06-02'
  }));
  const pulj = await putL.json();
  check(putL.status === 200 && pulj.data.maintain_status === 'done' && pulj.data.cost === 168.5,
    '编辑记录可改保养状态与费用');
  check(pulj.synced === true && pulj.equipment.maintain_status === 'done'
    && pulj.equipment.next_maintain === '2020-06-02', '编辑最新记录同步设备状态与保养计划');
  check(pulj.data.log_date === LOGDAY && /已完成/.test(pulj.data.content), '未提交的字段保持原值');
  const badSt = await fetchJar(`${BASE}/api/equipment_logs/${newLog.id}`, jsonInit('PUT', { maintain_status: 'nope' }));
  check(badSt.status === 400, '非法保养状态被拒绝');
  const badCost = await fetchJar(`${BASE}/api/equipment_logs/${newLog.id}`, jsonInit('PUT', { cost: -5 }));
  check(badCost.status === 400, '负费用被拒绝');
  const badDay = await fetchJar(`${BASE}/api/equipment_logs/${newLog.id}`, jsonInit('PUT', { log_date: '2020/02/03' }));
  check(badDay.status === 400, '非法日期格式被拒绝');
  const badType = await fetchJar(`${BASE}/api/equipment_logs/${newLog.id}`, jsonInit('PUT', { type: 'hack' }));
  check(badType.status === 400, '非法记录类型被拒绝');

  const mtRes = await fetchJar(`${BASE}/api/equipments/${testEq.id}/maintain`, jsonInit('PUT', {
    maintain_status: 'postponed', next_maintain: '2020-07-01', note: '备件未到货顺延',
    add_log: '1', log_date: '2020-02-04'
  }));
  const mtj = await mtRes.json();
  check(mtRes.status === 200 && mtj.data.maintain_status === 'postponed'
    && mtj.data.next_maintain === '2020-07-01', '快捷编辑保养状态与下次保养日期');
  check(mtj.log && mtj.log.type === 'maintain' && mtj.log.maintain_status === 'postponed'
    && /备件/.test(mtj.log.content), '状态编辑可自动追加一条保养记录留痕');
  const autoRes = await fetchJar(`${BASE}/api/equipments/${testEq.id}/maintain`,
    jsonInit('PUT', { maintain_status: 'auto', add_log: '0' }));
  const autoj = await autoRes.json();
  check(autoRes.status === 200 && !autoj.data.maintain_status, '切回按日期自动时清空手动状态');
  const badMt = await fetchJar(`${BASE}/api/equipments/${testEq.id}/maintain`,
    jsonInit('PUT', { maintain_status: 'bad', add_log: '0' }));
  check(badMt.status === 400, '快捷编辑的非法状态被拒绝');

  const delNewest = await fetchJar(`${BASE}/api/equipment_logs/${mtj.log.id}`, { method: 'DELETE' });
  const delj = await delNewest.json();
  check(delNewest.status === 200 && delj.data.recomputed === true
    && delj.data.equipment.maintain_status === 'done', '删除最新记录后按剩余记录回退保养状态');
  const xls15 = await fetchJar(`${BASE}/api/export?module=equipments&maintain=done`);
  check(xls15.status === 200 && Number(xls15.headers.get('x-export-sheets')) > 0,
    '按保养状态筛选导出 Excel 可用');
  await fetchJar(`${BASE}/api/equipment_logs/${newLog.id}`, { method: 'DELETE' });
  await fetchJar(`${BASE}/api/equipments/${testEq.id}`,
    jsonInit('PUT', { maintain_status: origSt, next_maintain: origNext }));
  const boot15 = await (await fetchJar(`${BASE}/api/bootstrap`)).json();
  check(!boot15.data.equipment_logs.some(l => l.id === newLog.id || l.id === (mtj.log && mtj.log.id)),
    '测试保养记录清理完毕，业务数据回到原状');
  check(boot15.data.equipment_logs.some(l => l.maintain_status === 'doing'),
    '种子保养记录保留可编辑的多种状态');

  await t.refresh();
  S.eqMaintain = 'all'; S.eqQuery = ''; S.eqCat = 'all'; S.shopStatus = 'all';
  S.dashDrill = null; S.view = 'dashboard'; t.render();

  /* ---------- 1.17.0：概览与可视化面板合并为可视化驾驶舱 ---------- */
  check(t.TITLES.dashboard.title === '可视化驾驶舱' && !t.TITLES.overview,
    'TITLES 只保留单一驾驶舱模块');
  check(t.normalizeView('overview') === 'dashboard' && t.normalizeView('cockpit') === 'dashboard'
    && t.normalizeView('') === 'dashboard' && t.normalizeView('unknown') === 'dashboard'
    && t.normalizeView('shops') === 'shops', '旧视图别名与非法值统一归一到驾驶舱');
  check(t.COCKPIT_VIEW === 'dashboard'
    && t.COCKPIT_TABS.map(x => x.k).join('/') === 'overview/assets/finance/engineering',
    '驾驶舱四个分析维度定义完整');
  check(t.MODULE_VIEWS.length === 7 && t.MODULE_VIEWS[0] === 'dashboard'
    && t.MODULE_VIEWS.indexOf('overview') === -1
    && t.MODULE_VIEWS.includes('archives') && t.MODULE_VIEWS.includes('warehouse'),
    '设置页模块清单去掉旧概览并加入档案 / 仓库');
  check(t.MOD_META.length === 7 && t.MOD_META[0][1] === '可视化驾驶舱'
    && t.MOD_META.some(x => x[1] === '档案管理') && t.MOD_META.some(x => x[1] === '仓库管理'),
    '关于页模块清单同步合并并纳入两个新模块');
  const nav17 = (() => { S.view = 'dashboard'; t.render(); return document.querySelector('#nav').innerHTML; })();
  check((nav17.match(/data-view="dashboard"/g) || []).length === 1
    && !/data-view="overview"/.test(nav17) && !/>概览</.test(nav17)
    && /可视化驾驶舱/.test(nav17), '侧栏只有一个驾驶舱入口且显示新模块名');
  check(typeof t.viewOverview === 'function' && typeof t.viewDashboard === 'function'
    && /dash-hero/.test(t.viewOverview()) && /dash-hero/.test(t.viewDashboard()),
    '旧入口兼容：概览 / 可视化面板都渲染同一驾驶舱');
  check(typeof t.mountCockpitCharts === 'function' && typeof t.mountCharts === 'function'
    && typeof t.mountDashboardCharts === 'function', '图表挂载入口合并且保留旧别名');
  check(typeof t.cockpitSection === 'function' && typeof t.dashStatStrip === 'function',
    '分区渲染与紧凑指标带组件可用');
  await click({ act: 'dashTab', k: 'assets' });
  check(S.cockpitTab === 'assets' && /id="dbShop"/.test(view()) && !/id="dbUtil"/.test(view()),
    '点击分析维度切换到资产与租赁并只渲染该分区图表');
  await click({ act: 'dashTab', k: 'bad-tab' });
  check(S.cockpitTab === 'overview', '非法维度回落到经营总览');
  const put17 = await (await fetchJar(BASE + '/api/settings', jsonInit('PUT', { default_view: 'overview' }))).json();
  check(put17.data.default_view === 'dashboard', '服务端把旧默认模块 overview 归一为 dashboard',
    put17.data.default_view);
  const get17 = await (await fetchJar(BASE + '/api/settings')).json();
  check(get17.defaults.default_view === 'dashboard' && get17.data.default_view === 'dashboard',
    '出厂默认模块与实际值均为可视化驾驶舱');
  check(S.data.meta.app.version === '1.26.0', '服务端版本号升级到 1.26.0', S.data.meta.app.version);

  /* ---------- 全站冒烟：所有视图 + 全部表单 ---------- */
  S.mode = {};
  let smokeErr = '';
  for (const v of ['dashboard', 'shops', 'equipments', 'contracts', 'payments', 'archives', 'warehouse', 'settings', 'about', 'users', 'audit']) {
    for (const m of ['list', 'card']) {
      S.mode = { [v]: m };
      try {
        S.view = v; t.render();
        if (/undefined|NaN|\[object Object\]/.test(view())) throw new Error('渲染出现 undefined/NaN');
      } catch (e) { smokeErr += ` ${v}/${m}:${e.message}`; }
    }
  }
  check(!smokeErr, '十一个视图 × 两种模式渲染无异常（含档案 / 仓库）', smokeErr);

  const forms = [
    ['shopForm(new)', () => t.shopForm()],
    ['eqForm(new)', () => t.eqForm()],
    ['contractForm(new)', () => t.contractForm()],
    ['archiveForm(new)', () => t.archiveForm()],
    ['whForm(new)', () => t.whForm()]
  ];
  let formErr = '';
  for (const [n, fn] of forms) {
    try { fn(); if (!modal()) throw new Error('未打开'); } catch (e) { formErr += ` ${n}:${e.message}`; }
  }
  check(!formErr, '新增类表单可正常打开（无附件面板）', formErr);

  /* ---------- 1.18.0：商铺装修 / 维修进度、档案管理、仓库管理 ---------- */
  const boot118 = await (await fetchJar(BASE + '/api/bootstrap')).json();
  const d118 = boot118.data;
  check(['shop_progress_logs', 'archives', 'archive_logs', 'warehouse_items', 'warehouse_records']
    .every(k => Array.isArray(d118[k])), 'bootstrap 下发五张新业务表');
  check(d118.shop_progress_logs.length >= 10 && d118.archives.length >= 8
    && d118.archive_logs.length >= 3 && d118.warehouse_items.length >= 12
    && d118.warehouse_records.length >= 8, '演示数据覆盖进度 / 档案 / 仓库流水');
  check(d118.overview.shopWorks.decorating >= 1 && d118.overview.shopWorks.repairing >= 1
    && d118.overview.archives.borrowed >= 1 && d118.overview.warehouse.lowStock >= 1,
    '服务端概览聚合新增装修 / 维修 / 档案 / 仓库指标');
  check(Object.keys(t.SHOP_WORK_STATUS).join('/') === 'none/planned/doing/done/paused',
    '装修 / 维修状态五类枚举完整');
  check(t.SHOP_WORK_TYPES.decoration === '装修' && t.SHOP_WORK_TYPES.repair === '维修',
    '进度类型区分装修与维修');

  const decoShop = d118.shops.find(s => s.decoration_status === 'doing');
  const cleanShop = d118.shops.find(s => !s.decoration_status || s.decoration_status === 'none');
  check(!!decoShop && t.shopWorkProgress(decoShop, 'decoration') > 0, '种子商铺带装修进度');
  const shops118 = renderView('shops');
  check(/data-act="shopStatus" data-k="decorating"/.test(shops118)
    && !/data-act="shopStatus" data-k="repairing"/.test(shops118)
    && /data-act="shopStatus" data-k="maintenance"/.test(shops118),
    '商铺统计栏保留装修中，删除重复的维修中，只留唯一维修类目');
  check(/sc-work/.test(renderView('shops')) || /装修 \/ 维修/.test(shops118),
    '商铺列表展示装修与维修状态');
  const decoData = t.shopDetailData(decoShop.id);
  const decoDetail = t.shopDetailInner(decoData);
  check(/work-panel/.test(decoDetail) && /data-act="addShopWork"/.test(decoDetail)
    && /data-act="editShopWork"/.test(decoDetail), '商铺详情含双状态卡与进度操作');
  check(/装修进度记录/.test(decoDetail) && /维修进度记录/.test(decoDetail),
    '商铺详情分列装修 / 维修进度时间线');
  check(/data-act="editShopWorkLog"/.test(decoDetail) && /data-act="delShopWorkLog"/.test(decoDetail),
    '进度记录逐条可编辑 / 删除');
  const shopPrint118 = t.printDocHtml(decoShop.id);
  check(!/class="work-panel"/.test(shopPrint118) && !/装修进度记录/.test(shopPrint118)
    && !/维修进度记录/.test(shopPrint118) && !/data-act="editShopWorkLog"/.test(shopPrint118),
    '1.21.0：商铺 A4 打印隐藏装修 / 维修状态卡与两条进度时间线');
  check(t.shopWorkFields().map(f => f.k).join('/') === 'type/log_date/title/progress/status/content/operator',
    '进度表单字段完整');
  t.openShopWorkStatusForm(cleanShop.id, 'repair');
  check(/编辑维修状态/.test(modal()) && /data-act="submitForm"/.test(modal()), '快捷状态编辑表单可打开');
  t.closeModal();

  // 进度写入 → 编辑 → 删除的完整回算链路
  const wp1 = await (await fetchJar(BASE + '/api/shop_progress_logs', jsonInit('POST', {
    shop_id: cleanShop.id, type: 'decoration', log_date: '2026-11-08', title: '测试装修进度',
    progress: 40, status: 'doing', content: '接口回归', operator: '测试'
  }))).json();
  check(wp1.ok === true && wp1.data.progress === 40, '新增装修进度记录成功');
  let shopAfter = await (await fetchJar(BASE + '/api/shops/' + cleanShop.id)).json();
  check(shopAfter.data.decoration_status === 'doing' && shopAfter.data.decoration_progress === 40,
    '最新进度自动回算商铺装修状态与百分比');
  const wp2 = await (await fetchJar(BASE + '/api/shop_progress_logs/' + wp1.data.id,
    jsonInit('PUT', { progress: 100, status: 'done', content: '改为完工' }))).json();
  check(wp2.ok === true && wp2.data.progress === 100, '进度记录可编辑');
  shopAfter = await (await fetchJar(BASE + '/api/shops/' + cleanShop.id)).json();
  check(shopAfter.data.decoration_status === 'done' && shopAfter.data.decoration_progress === 100,
    '编辑后商铺状态随最新进度更新');
  const badWork = await fetchJar(BASE + '/api/shop_progress_logs', jsonInit('POST', {
    shop_id: cleanShop.id, type: 'decoration', log_date: '2026-11-08', title: '非法', progress: 120, status: 'bad'
  }));
  check(badWork.status === 400, '非法进度 / 状态被服务端拒绝');
  await fetchJar(BASE + '/api/shop_progress_logs/' + wp1.data.id, { method: 'DELETE' });
  shopAfter = await (await fetchJar(BASE + '/api/shops/' + cleanShop.id)).json();
  check(shopAfter.data.decoration_status === 'none' && shopAfter.data.decoration_progress === 0,
    '删除最后一条进度后状态回退为未开始 / 0%');
  const workQuick = await (await fetchJar(BASE + '/api/shops/' + cleanShop.id + '/work',
    jsonInit('PUT', { type: 'repair', status: 'doing', progress: 25, note: '快捷状态回归', add_log: '1' }))).json();
  check(workQuick.ok === true && workQuick.data.shop.repair_status === 'doing'
    && workQuick.data.shop.repair_progress === 25 && !!workQuick.data.log,
    '快捷状态接口同时更新状态、进度并补记一条流水');
  await fetchJar(BASE + '/api/shop_progress_logs/' + workQuick.data.log.id, { method: 'DELETE' });
  await fetchJar(BASE + '/api/shops/' + cleanShop.id,
    jsonInit('PUT', { decoration_status: 'none', decoration_progress: 0, repair_status: 'none', repair_progress: 0 }));
  const badShopSt = await fetchJar(BASE + '/api/shops/' + cleanShop.id,
    jsonInit('PUT', { decoration_status: 'wrong' }));
  check(badShopSt.status === 400, '非法装修状态被服务端拒绝');

  // 档案管理
  check(Object.keys(t.ARCHIVE_CAT).length === 7 && Object.keys(t.ARCHIVE_STATUS).length === 4,
    '档案分类与状态枚举完整');
  S.archiveCat = 'all'; S.archiveStatus = 'all'; S.archiveQuery = '';
  const arcHtml = renderView('archives');
  check(/档案总数/.test(arcHtml) && /data-act="archiveCat"/.test(arcHtml)
    && /data-act="archiveStatus"/.test(arcHtml), '档案模块含统计栏与分类 / 状态筛选');
  check(/data-act="archive"/.test(arcHtml) && /id="archiveSearch"/.test(arcHtml),
    '档案列表含详情入口与搜索框');
  S.mode = { archives: 'card' };
  const arcCard = renderView('archives');
  check(/class="ecard/.test(arcCard), '档案方块模式渲染卡片');
  S.mode = {};
  const borrowedArc = d118.archives.find(a => a.status === 'borrowed');
  t.openArchiveDetail(borrowedArc.id);
  const arcDetail = modal();
  check(/借阅 \/ 归还记录/.test(arcDetail) && /data-act="addArchiveLog"/.test(arcDetail)
    && /data-act="editArchiveLog"/.test(arcDetail), '档案详情含借阅流水与逐条操作');
  check(/attach-panel/.test(arcDetail) && /data-act="printArchive"/.test(arcDetail),
    '档案详情支持扫描件附件与打印');
  t.closeModal();
  const arcPrint = t.printArchiveHtml(borrowedArc.id);
  check(/档案卡片/.test(arcPrint) && /<table>/.test(arcPrint)
    && !/data-act="editArchiveLog"/.test(arcPrint), '档案 A4 打印含借阅表且为纯数据');
  check(t.archiveFields().some(f => f.k === 'expiry') && t.archiveFields().some(f => f.k === 'security'),
    '档案表单含有效期与密级');
  const newArc = await (await fetchJar(BASE + '/api/archives', jsonInit('POST', {
    code: 'TEST-118', title: '回归测试档案', category: 'other', archive_date: '2026-11-08',
    keeper: '测试员', location: 'A-00', security: 'normal', status: 'filed', qty: 1
  }))).json();
  check(newArc.ok === true && newArc.data.status === 'filed', '新增档案默认在档');
  const bLog = await (await fetchJar(BASE + '/api/archive_logs', jsonInit('POST', {
    archive_id: newArc.data.id, type: 'borrow', person: '张三', log_date: '2026-11-08',
    due_date: '2026-11-20', purpose: '回归借用'
  }))).json();
  let arcAfter = await (await fetchJar(BASE + '/api/archives/' + newArc.data.id)).json();
  check(arcAfter.data.status === 'borrowed', '借阅登记自动把档案置为借出');
  const rLog = await (await fetchJar(BASE + '/api/archive_logs', jsonInit('POST', {
    archive_id: newArc.data.id, type: 'return', person: '张三', log_date: '2026-11-09', purpose: '归还'
  }))).json();
  arcAfter = await (await fetchJar(BASE + '/api/archives/' + newArc.data.id)).json();
  check(arcAfter.data.status === 'filed', '归还登记自动把档案置为在档');
  await fetchJar(BASE + '/api/archive_logs/' + rLog.data.id, { method: 'DELETE' });
  arcAfter = await (await fetchJar(BASE + '/api/archives/' + newArc.data.id)).json();
  check(arcAfter.data.status === 'borrowed', '删除归还记录后按剩余流水回退为借出');
  const badArc = await fetchJar(BASE + '/api/archives', jsonInit('POST', { title: '非法', category: 'wrong' }));
  check(badArc.status === 400, '非法档案分类被服务端拒绝');
  await fetchJar(BASE + '/api/archives/' + newArc.data.id, { method: 'DELETE' });
  const arcBoot = await (await fetchJar(BASE + '/api/bootstrap')).json();
  check(!arcBoot.data.archive_logs.some(l => l.archive_id === newArc.data.id),
    '删除档案时级联清理借阅流水');

  // 仓库管理
  check(Object.keys(t.WH_CAT).length === 8 && Object.keys(t.WH_RECORD_TYPE).length === 3,
    '仓库物料分类与流水类型枚举完整');
  S.warehouseCat = 'all'; S.warehouseFilter = 'all'; S.warehouseQuery = '';
  const whHtml = renderView('warehouse');
  check(/物料种类/.test(whHtml) && /低库存预警/.test(whHtml)
    && /data-act="whCat"/.test(whHtml) && /data-act="whFilter" data-k="low"/.test(whHtml),
    '仓库模块含统计栏、分类与低库存筛选');
  check(/id="whSearch"/.test(whHtml) && /data-act="addWhRecord"/.test(whHtml),
    '仓库列表含搜索框与出入库入口');
  S.mode = { warehouse: 'card' };
  check(/class="ecard/.test(renderView('warehouse')), '仓库方块模式渲染卡片');
  S.mode = {};
  const seedItem = d118.warehouse_items.find(i => i.quantity > 5);
  t.openWhDetail(seedItem.id);
  const whDetail = modal();
  check(/出入库 \/ 盘点流水/.test(whDetail) && /data-act="editWhRecord"/.test(whDetail),
    '物料详情含流水表与逐条编辑');
  check(/data-act="printWhItem"/.test(whDetail) && /attach-panel/.test(whDetail),
    '物料详情支持打印与附件');
  t.closeModal();
  const whPrint = t.printWhItemHtml(seedItem.id);
  check(/物料库存卡/.test(whPrint) && /<table>/.test(whPrint)
    && !/data-act="editWhRecord"/.test(whPrint), '物料 A4 打印含流水表且为纯数据');
  check(t.whFields(false).some(f => f.k === 'quantity') && t.whFields(true).some(f => f.k === 'opening'),
    '新建填初始库存、编辑改期初库存');
  const newItem = await (await fetchJar(BASE + '/api/warehouse_items', jsonInit('POST', {
    code: 'TEST-WH-118', name: '回归测试物料', category: 'other', unit: '件',
    quantity: 20, min_stock: 5, unit_price: 10, location: '测试库位', supplier: '测试供应商'
  }))).json();
  check(newItem.ok === true && Number(newItem.data.quantity) === 20
    && Number(newItem.data.opening) === 20, '新增物料以初始库存作为期初结存');
  const recIn = await (await fetchJar(BASE + '/api/warehouse_records', jsonInit('POST', {
    item_id: newItem.data.id, type: 'in', quantity: 10, log_date: '2026-11-01', person: '测试', purpose: '补货'
  }))).json();
  check(recIn.ok === true && Number(recIn.data.balance) === 30 && Number(recIn.data.amount) === 100,
    '入库流水自动计算结存与金额');
  const recOut = await (await fetchJar(BASE + '/api/warehouse_records', jsonInit('POST', {
    item_id: newItem.data.id, type: 'out', quantity: 8, log_date: '2026-11-03', person: '测试', purpose: '领用'
  }))).json();
  let itemAfter = await (await fetchJar(BASE + '/api/warehouse_items/' + newItem.data.id)).json();
  check(Number(recOut.data.balance) === 22 && Number(itemAfter.data.quantity) === 22,
    '出库流水回写物料当前结存');
  const recAdj = await (await fetchJar(BASE + '/api/warehouse_records', jsonInit('POST', {
    item_id: newItem.data.id, type: 'adjust', quantity: 25, log_date: '2026-11-05', person: '测试', purpose: '盘点'
  }))).json();
  check(Number(recAdj.data.balance) === 25, '盘点调整把结存改为实际盘点数');
  const overOut = await fetchJar(BASE + '/api/warehouse_records', jsonInit('POST', {
    item_id: newItem.data.id, type: 'out', quantity: 9999, log_date: '2026-11-08'
  }));
  check(overOut.status === 400, '出库超过结存被服务端拒绝');
  const badRec = await fetchJar(BASE + '/api/warehouse_records', jsonInit('POST', {
    item_id: newItem.data.id, type: 'wrong', quantity: 1, log_date: '2026-11-08'
  }));
  check(badRec.status === 400, '非法出入库类型被服务端拒绝');
  await fetchJar(BASE + '/api/warehouse_records/' + recIn.data.id,
    jsonInit('PUT', { quantity: 20, log_date: '2026-11-01' }));
  const recAdjAfter = await (await fetchJar(BASE + '/api/bootstrap')).json();
  const editedIn = recAdjAfter.data.warehouse_records.find(r => r.id === recIn.data.id);
  check(Number(editedIn.balance) === 40, '编辑流水后后续结存自动重算');
  await fetchJar(BASE + '/api/warehouse_records/' + recAdj.data.id, { method: 'DELETE' });
  itemAfter = await (await fetchJar(BASE + '/api/warehouse_items/' + newItem.data.id)).json();
  check(Number(itemAfter.data.quantity) === 32, '删除流水后物料结存自动回算');
  await fetchJar(BASE + '/api/warehouse_items/' + newItem.data.id, { method: 'DELETE' });
  const whBoot = await (await fetchJar(BASE + '/api/bootstrap')).json();
  check(!whBoot.data.warehouse_records.some(r => r.item_id === newItem.data.id),
    '删除物料时级联清理出入库流水');

  // 导出：新模块、新工作表与筛选参数
  const exp118 = {};
  for (const m of ['shops', 'archives', 'warehouse', 'all']) {
    const x = await fetchJar(BASE + '/api/export?module=' + m);
    exp118[m] = Number(x.headers.get('x-export-sheets'));
    check(x.status === 200 && exp118[m] > 0, `导出模块 ${m} 可用`, String(exp118[m]));
  }
  check(exp118.all === 19, '全量导出共 19 张工作表（含 1.26.0 楼栋汇总）', String(exp118.all));
  const expWork = await fetchJar(BASE + '/api/export?module=shops&work=decoration');
  const expLow = await fetchJar(BASE + '/api/export?module=warehouse&low=1');
  check(expWork.status === 200 && expLow.status === 200, '装修中 / 低库存筛选导出可用');

  await t.refresh();
  S.archiveCat = 'all'; S.archiveStatus = 'all'; S.archiveQuery = '';
  S.warehouseCat = 'all'; S.warehouseFilter = 'all'; S.warehouseQuery = '';
  S.shopStatus = 'all'; S.view = 'dashboard'; t.render();

  /* ---------- 1.20.0：仅关闭按钮 / × 生效，弹窗严格逐层关闭 ---------- */
  t.MODAL_DRAG.suppressClick = false;
  for (let i = 0; i < 6; i++) { S.modalReturn = null; t.closeModal(); }
  t.closeLightbox();
  const mkOverlay = (kind) => {
    const node = { dataset: {}, button: 0 };
    node.closest = (sel) => (kind === 'light' && sel === '.light-overlay')
      || (kind === 'modal' && sel === '.overlay') ? node : null;
    return node;
  };
  const clickOn = (target) => clickHandler({ target, button: 0 });
  const pressEsc = () => docListeners['keydown']({ key: 'Escape' });
  const ov = mkOverlay('modal');
  const lo = mkOverlay('light');

  // 点遮罩空白 / 框选 / ESC 都不关闭，只有关闭按钮与 × 生效
  t.openShopDetail(S.data.shops[0].id);
  const detail120 = modal();
  await clickOn(ov);
  check(modal() === detail120, '点一层遮罩空白处不关闭弹窗');
  global.window.getSelection = () => 'selected';
  await clickOn(ov);
  check(modal() === detail120, '框选文字后点遮罩仍不关闭弹窗');
  delete global.window.getSelection;
  pressEsc();
  check(modal() === detail120, '按 ESC 不关闭弹窗');
  check(/点右上角 × 关闭/.test(detail120), '弹窗标题栏提示仅可通过右上角 × 关闭');
  check(t.handleOverlayClick({ target: ov, button: 0 }) === true
    && t.handleOverlayClick({ target: { closest: () => null }, button: 0 }) === false,
    '遮罩点击只吞事件不触发关闭，弹窗内部点击正常分发');

  // 二层遮罩同样不关闭
  t.openLightbox({ title: '附件预览', body: '<div>preview</div>' });
  await clickOn(lo);
  check(!!lightbox() && modal() === detail120, '点二层遮罩空白处两层弹窗都保持');
  pressEsc();
  check(!!lightbox(), '二层预览打开时按 ESC 也不关闭');

  // 严格逐层：预览 → 详情 → 编辑回退详情 → 全关
  await click({ act: 'closeLight' });
  check(!lightbox() && modal() === detail120, '点预览窗「关闭」只收二层，一层详情保留');
  t.shopForm(S.data.shops[0].id);
  check(!!S.modalReturn, '从详情进入编辑表单记住回退目标');
  await click({ act: 'closeModal' });
  check(modal() === detail120 && !S.modalReturn, '点编辑表单「关闭」只回退详情，不连带关掉');
  await click({ act: 'closeModal' });
  check(!modal(), '再点详情「关闭」才完全关闭');

  // 旧的 all 参数不再一次性收掉整个弹窗栈
  t.openShopDetail(S.data.shops[0].id);
  t.openLightbox({ title: '附件预览', body: '<div>preview</div>' });
  t.closeModal(true);
  check(!lightbox() && !!modal(), '旧 closeModal(true) 也只收一层，不再一次性清空弹窗栈');
  for (let i = 0; i < 4; i++) { S.modalReturn = null; t.closeModal(); }
  t.closeLightbox();

  // 表单有未保存内容：遮罩仍不关，明确的「取消 / ×」按意图直接关
  t.archiveForm();
  S.modalSnapshot = 'UNSAVED-SIGNATURE';
  await clickOn(ov);
  check(!!modal(), '表单有未保存内容时点遮罩仍不关闭');
  await click({ act: 'closeModal' });
  check(!modal(), '表单有未保存内容时点「取消 / ×」按明确意图直接关闭');
  S.modalSnapshot = null;

  // 档案支持 CAD 图纸与不限制大小
  check(t.CAD_EXTS.includes('.dwg') && t.CAD_EXTS.includes('.dxf')
    && t.CAD_EXTS.includes('.rvt') && t.CAD_EXTS.includes('.step'), 'CAD 扩展名白名单完整');
  check(/\.dwg/.test(t.attachAccept('archives')) && !/\.dwg/.test(t.attachAccept('shops')),
    '仅档案模块放开 CAD 文件选择');
  check(/大小不限/.test(t.attachHint('archives')) && /25MB/.test(t.attachHint('shops')),
    '档案提示大小不限，其余模块保留 25MB 提示');
  check(t.isCadFile('一层平面图.dwg') && !t.isCadFile('合同扫描件.pdf'), 'CAD 文件识别正确');
  const arcId119 = d118.archives[0].id;
  check(/\.dwg/.test(t.attachPanelHtml('archives', arcId119))
    && /大小不限/.test(t.attachPanelHtml('archives', arcId119)), '档案附件面板展示 CAD 与不限大小说明');
  check(!/\.dwg/.test(t.attachPanelHtml('contracts', ids.contractId)), '合同附件面板不放开 CAD');

  const bigFile = Buffer.alloc(26 * 1024 * 1024, 0x41); // 超过旧 25MB 上限
  const bigName = '一层平面图.dwg';
  const before119 = S.data.attachments.length;
  await t.uploadAttachments('archives', arcId119,
    [new File([bigFile], bigName, { type: 'application/octet-stream' })], null);
  const cadAtt = S.data.attachments.find(a => a.name === bigName);
  check(!!cadAtt && cadAtt.size === bigFile.length,
    '档案可上传超过 25MB 的 CAD 图纸（服务端流式落盘）', cadAtt ? String(cadAtt.size) : 'null');
  if (cadAtt) {
    const raw119 = await fetchJar(BASE + `/api/attachments/${cadAtt.id}/raw?download=1`);
    check(raw119.status === 200 && Number(raw119.headers.get('content-length')) === bigFile.length,
      '大附件可完整下载且长度一致');
    try { await raw119.arrayBuffer(); } catch (e) {}
    t.openAttPreview(cadAtt.id);
    check(/AutoCAD/.test(lightbox()), 'CAD 附件预览提示用专业软件打开');
    t.closeLightbox();
    await fetchJar(BASE + '/api/attachments/' + cadAtt.id, { method: 'DELETE' });
    await t.refresh();
  }
  await t.uploadAttachments('contracts', ids.contractId,
    [new File([bigFile], bigName, { type: 'application/octet-stream' })], null);
  check(S.data.attachments.length === before119, '非档案模块前端仍拦截超大文件');
  const deny119 = await fetchJar(BASE + `/api/attachments?entity=contracts&id=${ids.contractId}&name=${encodeURIComponent('big.dwg')}`,
    { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: bigFile });
  check(deny119.status === 413, '服务端对非档案附件仍执行 25MB 限制', String(deny119.status));

  // 商铺统计栏：唯一「维修」类目 + 并集口径 + 全链路同源
  check(t.shopRepairScope({ status: 'rented', repair_status: 'doing' })
    && t.shopRepairScope({ status: 'maintenance', repair_status: 'none' })
    && !t.shopRepairScope({ status: 'rented', repair_status: 'done' }), '维修口径为两类并集去重');
  check(t.normalizeShopStatus('repairing') === 'maintenance'
    && t.normalizeShopStatus('bad') === 'all', '旧筛选值维修中自动归一到维修');
  S.view = 'shops'; S.shopStatus = 'all'; S.shopQuery = ''; S.mode = {};
  const shops119 = renderView('shops');
  const union119 = S.data.shops.filter(t.shopRepairScope).length;
  const chip119 = shops119.match(/data-k="maintenance"[^>]*>维修<b>([^<]+)<\/b>/);
  check(!!chip119 && Number(chip119[1]) === union119, '维修统计数字与并集口径一致',
    chip119 ? chip119[1] : 'null');
  check((shops119.match(/data-k="maintenance"/g) || []).length === 1, '统计栏只有一个维修类目');
  S.shopStatus = 'maintenance';
  const filtered119 = renderView('shops');
  // 列表模式每行有两个 data-act="shop"（名称 + 详情按钮），按去重后的商铺 ID 计数
  const shown119 = new Set(Array.from(filtered119.matchAll(/data-act="shop" data-id="(\d+)"/g), m => m[1]));
  check(shown119.size === union119, '维修筛选结果与统计数字一致', `${shown119.size}/${union119}`);
  S.shopStatus = 'all';
  S.dashBuilding = 'all'; S.dashRange = '6';
  const dm119 = t.dashMetrics();
  const mcls119 = dm119.shops.byClass.find(c => c.key === 'maintenance');
  check(mcls119.count === union119 && dm119.shops.maintenance === union119,
    '驾驶舱维修指标与统计栏同源');
  check(dm119.shops.byClass.reduce((n, c) => n + c.value, 0) === dm119.shops.total,
    '资产结构四类互斥且合计等于商铺总数');
  check(/params\.set\('repair', '1'\)/.test(code), '前端维修筛选导出使用统一并集参数');
  const expRepair119 = await fetchJar(BASE + '/api/export?module=shops&repair=1');
  check(expRepair119.status === 200 && Number(expRepair119.headers.get('x-export-sheets')) === 5,
    '维修并集筛选导出可用（含楼栋汇总共 5 张）');

  /* ---------- 1.21.0：商铺 A4 打印隐藏装修 / 维修工程状态与进度 ---------- */
  const deco121 = S.data.shops.find(s => Number(s.decoration_progress) > 0
    || String(s.decoration_status) === 'doing') || S.data.shops[0];
  const d121 = t.shopDetailData(deco121.id);
  const detail121 = t.shopDetailInner(d121);
  const body121 = t.shopDetailInner(d121, { print: true });
  const print121 = t.printDocHtml(deco121.id);
  check(/work-panel/.test(detail121) && /装修进度记录/.test(detail121)
    && /维修进度记录/.test(detail121) && /data-act="addShopWork"/.test(detail121),
    '屏幕详情仍完整显示装修 / 维修状态卡与两条进度时间线');
  check(!/class="work-panel"/.test(body121) && !/装修 \/ 维修工程状态与进度/.test(body121)
    && !/装修进度记录/.test(body121) && !/维修进度记录/.test(body121),
    '打印版商铺主体完全不输出装修 / 维修工程区块');
  check(!/class="work-panel"/.test(print121) && !/装修 \/ 维修工程状态与进度/.test(print121)
    && !/装修进度记录/.test(print121) && !/维修进度记录/.test(print121)
    && !/data-act="addShopWork"/.test(print121) && !/data-act="editShopWorkLog"/.test(print121),
    '商铺 A4 打印档案隐藏装修 / 维修状态与两条进度记录');
  check(/商铺档案/.test(print121) && /水电抄表/.test(print121)
    && /费用账单/.test(print121) && /制表人/.test(print121),
    '打印稿其余租赁档案内容完整保留');
  check(/\.work-panel\{display:none !important\}/.test(print121), '打印样式含 work-panel 兜底隐藏');
  const exportSrc121 = fs.readFileSync(path.join(__dirname, '..', 'pack', 'app', 'server', 'export.js'), 'utf8');
  check(/装修维修进度/.test(exportSrc121) && /decoration_status/.test(exportSrc121),
    'Excel「装修维修进度」工作表与四个状态列仍保留，导出不受打印精简影响');

  await t.refresh();
  S.shopStatus = 'all'; S.view = 'dashboard'; S.dashBuilding = 'all'; t.render();
  for (let i = 0; i < 6; i++) { S.modalReturn = null; t.closeModal(); }
  t.closeLightbox();

  /* ---------- 1.22.0：PDF / 表格附件点击预览 · 导出前表格预览 ---------- */
  S.lightReturn = null; t.closeLightbox();
  const xlsxLib122 = require(path.join(__dirname, '..', 'pack', 'app', 'server', 'xlsx.js'));
  const xlsxBuf122 = xlsxLib122.build([
    { name: '材料清单', columns: [{ h: '材料' }, { h: '数量' }, { h: '单价' }],
      rows: [['螺丝', 12, 0.5], ['电缆', 3, 128]] },
    { name: '验收记录', columns: [{ h: '日期' }, { h: '结论' }], rows: [['2026-11-09', '合格']] }
  ], { creator: 'ui-test' });
  const arcId122 = S.data.archives[0].id;
  const put122 = async (entity, id, name, mime, buf) => {
    const r = await fetchJar(`${BASE}/api/attachments?entity=${entity}&id=${id}&name=${encodeURIComponent(name)}`,
      { method: 'POST', headers: { 'Content-Type': mime }, body: buf });
    check(r.status === 200, '预览测试附件上传成功：' + name, String(r.status));
  };
  await put122('archives', arcId122, '材料清单.xlsx', 'application/octet-stream', xlsxBuf122);
  await put122('archives', arcId122, '租金明细.csv', 'text/csv',
    Buffer.from('\uFEFF楼层,商铺,月租\n1F,"A-101, 转角",8600\n2F,B-205,7200\n', 'utf8'));
  await put122('contracts', ids.contractId, '合同补充说明.txt', 'text/plain',
    Buffer.from('验收补充说明：消防已复检合格。', 'utf8'));
  await t.refresh();
  const att122 = (n) => S.data.attachments.find(a => a.name === n);
  const xlsxAtt = att122('材料清单.xlsx'), csvAtt = att122('租金明细.csv');
  const txtAtt = att122('合同补充说明.txt'), pdfAtt = att122('验收单.pdf');
  check(!!xlsxAtt && !!csvAtt && !!txtAtt && !!pdfAtt, 'PDF / xlsx / csv / txt 四类附件已就绪');

  check(t.attPreviewKind(pdfAtt) === 'pdf' && t.attPreviewKind(xlsxAtt) === 'table'
    && t.attPreviewKind(csvAtt) === 'table' && t.attPreviewKind(txtAtt) === 'text'
    && t.attPreviewable(xlsxAtt) && !t.attPreviewable({ name: '图纸.dwg', mime: 'application/octet-stream' }),
    '附件预览分类：PDF / 表格 / 文本 / 不可预览');
  check(/PDF 预览/.test(t.attachPanelHtml('contracts', ids.contractId))
    && /表格预览/.test(t.attachPanelHtml('archives', arcId122))
    && /点击预览/.test(t.thumbsHtml('archives', arcId122, 6)),
    '附件卡片与缩略图显示可预览角标与提示');

  const pvX = await (await fetchJar(BASE + `/api/attachments/${xlsxAtt.id}/preview`)).json();
  check(pvX.ok && pvX.data.kind === 'table' && pvX.data.sheets.length === 2
    && pvX.data.sheets[0].name === '材料清单'
    && pvX.data.sheets[0].rows[0][0] === '材料' && pvX.data.sheets[0].rows[1][0] === '螺丝'
    && pvX.data.sheets[0].rows[1][1] === '12',
    'xlsx 附件解析出双工作表、表头与数值单元格',
    JSON.stringify(pvX.data && pvX.data.sheets && pvX.data.sheets[0] && pvX.data.sheets[0].rows));
  const pvC = await (await fetchJar(BASE + `/api/attachments/${csvAtt.id}/preview`)).json();
  check(pvC.ok && pvC.data.kind === 'table' && pvC.data.sheets[0].rows[1][1] === 'A-101, 转角',
    'CSV 附件正确去 BOM 并解析引号内逗号',
    JSON.stringify(pvC.data && pvC.data.sheets && pvC.data.sheets[0] && pvC.data.sheets[0].rows));
  const pvT = await (await fetchJar(BASE + `/api/attachments/${txtAtt.id}/preview`)).json();
  check(pvT.ok && pvT.data.kind === 'text' && /消防已复检合格/.test(pvT.data.text),
    '纯文本附件返回可预览文本');
  // 真实 Excel / WPS 导出的 xlsx 多用 sharedStrings，且会混用 inlineStr / 数字 / XML 实体
  const zip122 = (files) => {
    const zl = require('zlib');
    const locals = [], centrals = [];
    let off = 0;
    for (const f of files) {
      const name = Buffer.from(f.name, 'utf8'), data = Buffer.from(f.data, 'utf8');
      const comp = zl.deflateRawSync(data);
      const lh = Buffer.alloc(30);
      lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6);
      lh.writeUInt16LE(8, 8); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22);
      lh.writeUInt16LE(name.length, 26);
      const local = Buffer.concat([lh, name, comp]);
      locals.push(local);
      const ch = Buffer.alloc(46);
      ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
      ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10);
      ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24);
      ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(off, 42);
      centrals.push(Buffer.concat([ch, name]));
      off += local.length;
    }
    const cd = Buffer.concat(centrals), eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 8);
    eocd.writeUInt16LE(files.length, 10); eocd.writeUInt32LE(cd.length, 12);
    eocd.writeUInt32LE(off, 16);
    return Buffer.concat([...locals, cd, eocd]);
  };
  const sharedXlsx122 = zip122([
    { name: 'xl/workbook.xml', data: '<?xml version="1.0"?><workbook><sheets><sheet name="共享字符串表" sheetId="1" r:id="rId1"/></sheets></workbook>' },
    { name: 'xl/sharedStrings.xml', data: '<sst><si><t>姓名</t></si><si><t>张三</t></si></sst>' },
    { name: 'xl/worksheets/sheet1.xml', data: '<worksheet><sheetData>' +
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
      '<row r="2"><c r="A2" t="inlineStr"><is><t>A&amp;B</t></is></c><c r="B2"><v>42</v></c></row>' +
      '</sheetData></worksheet>' }
  ]);
  await put122('archives', arcId122, '共享字符串表.xlsx', 'application/octet-stream', sharedXlsx122);
  await t.refresh();
  const sharedAtt = att122('共享字符串表.xlsx');
  const pvS = await (await fetchJar(BASE + `/api/attachments/${sharedAtt.id}/preview`)).json();
  check(pvS.ok && pvS.data.kind === 'table'
    && pvS.data.sheets[0].rows[0][0] === '姓名' && pvS.data.sheets[0].rows[0][1] === '张三'
    && pvS.data.sheets[0].rows[1][0] === 'A&B' && pvS.data.sheets[0].rows[1][1] === '42',
    'sharedStrings / inlineStr / 数字 / XML 实体混合单元格解析正确',
    JSON.stringify(pvS.data && pvS.data.sheets && pvS.data.sheets[0] && pvS.data.sheets[0].rows));

  const pvP = await (await fetchJar(BASE + `/api/attachments/${pdfAtt.id}/preview`)).json();
  check(pvP.ok && pvP.data.kind === 'pdf', 'PDF 附件预览接口返回 pdf 类型');

  const rawPdf = await fetchJar(BASE + `/api/attachments/${pdfAtt.id}/raw`);
  check(rawPdf.headers.get('content-type') === 'application/pdf'
    && /inline/.test(rawPdf.headers.get('content-disposition') || ''),
    'PDF raw 按扩展名修正 MIME 并内联返回', rawPdf.headers.get('content-type'));
  try { await rawPdf.arrayBuffer(); } catch (e) {}
  const rangePdf = await fetchJar(BASE + `/api/attachments/${pdfAtt.id}/raw`, { headers: { Range: 'bytes=0-4' } });
  check(rangePdf.status === 206 && /^bytes 0-4\/\d+$/.test(rangePdf.headers.get('content-range') || ''),
    'PDF 支持 Range 206 分段加载', String(rangePdf.status) + ' ' + String(rangePdf.headers.get('content-range')));
  try { await rangePdf.arrayBuffer(); } catch (e) {}

  await t.openAttPreview(pdfAtt.id);
  check(/<iframe class="att-pv-frame" src="\/app\/pmops\/api\/attachments\/\d+\/raw"/.test(lightbox())
    && /新窗口打开/.test(lightbox()) && /下载原文件/.test(lightbox()),
    '点击 PDF 附件在弹窗内嵌阅读器并保留打开 / 下载');
  t.closeLightbox();

  await t.openAttPreview(xlsxAtt.id);
  const xHtml122 = lightbox();
  check(/class="att-pv-table"/.test(xHtml122) && /材料清单/.test(xHtml122)
    && /data-act="attSheet" data-k="1"/.test(xHtml122)
    && /螺丝/.test(xHtml122) && /data-sheet="1" hidden/.test(xHtml122),
    '点击 xlsx 附件渲染 HTML 表格、双工作表标签与非首表隐藏');
  t.switchAttSheet(1);
  check(/data-act="closeLight"/.test(lightbox()), '切换工作表不破坏弹窗结构');
  t.closeLightbox();
  await t.openAttPreview(csvAtt.id);
  check(/A-101, 转角/.test(lightbox()) && /class="att-pv-table"/.test(lightbox()),
    '点击 CSV 附件渲染表格');
  t.closeLightbox();
  await t.openAttPreview(txtAtt.id);
  check(/att-pv-pre/.test(lightbox()) && /验收补充说明/.test(lightbox()), '点击文本附件预览纯文本');
  t.closeLightbox();

  const exp122 = await (await fetchJar(BASE + '/api/export?module=shops&preview=1')).json();
  check(exp122.ok && exp122.data.module === 'shops' && exp122.data.sheets.length === 5
    && exp122.data.sheets[0].columns.length > 0,
    '导出预览接口按模块返回工作表与表头（含楼栋汇总共 5 张）', exp122.data ? String(exp122.data.sheets.length) : 'null');
  const expAll122 = await (await fetchJar(BASE + '/api/export?module=all&preview=1')).json();
  check(expAll122.ok && expAll122.data.sheets.length === 19,
    '全量导出预览与 xlsx 下载工作表数量一致（19 张）',
    expAll122.data ? String(expAll122.data.sheets.length) : 'null');
  await t.openExportPreview('shops');
  check(/表格预览/.test(lightbox()) && /class="att-pv-table"/.test(lightbox())
    && /下载 Excel/.test(lightbox()), '顶栏「预览表格」在二层弹窗渲染工作表');
  t.closeLightbox();
  check(/data-act="previewExport"/.test(t.topAction()) && /预览表格/.test(t.topAction()),
    '顶栏新增「预览表格」按钮');

  t.openAttList('contracts', ids.contractId);
  const attList122 = lightbox();
  check(/data-att-list="1"/.test(attList122), '附件总览带逐层标记');
  await t.openAttPreview(pdfAtt.id);
  check(/att-pv-frame/.test(lightbox()) && !/data-att-list="1"/.test(lightbox()),
    '从附件总览点开预览覆盖二层');
  t.closeLightbox();
  // 1.23.0：预览期间附件若有增删，回到的是按最新数据重建的总览，不再逐字节等于旧缓存
  check(/data-att-list="1"/.test(lightbox()) && /attach-panel/.test(lightbox())
    && (lightbox() === attList122 || /data-att-count=/.test(lightbox())),
    '关闭预览先回到附件总览（严格逐层，1.23.0 起总览数据为最新）');
  t.closeLightbox();
  check(lightbox() === '', '再点一次关闭才清空二层');

  const beSrc122 = fs.readFileSync(path.join(__dirname, '..', 'pack', 'app', 'server', 'server.js'), 'utf8');
  const exSrc122 = fs.readFileSync(path.join(__dirname, '..', 'pack', 'app', 'server', 'export.js'), 'utf8');
  check(/function previewAttachment/.test(beSrc122) && /function unzipEntries/.test(beSrc122)
    && /\/preview/.test(beSrc122) && /function previewSheets/.test(exSrc122),
    '服务端零依赖预览解析与导出预览入口存在');
  for (const a of [xlsxAtt, csvAtt, txtAtt, sharedAtt]) {
    if (a) await fetchJar(BASE + '/api/attachments/' + a.id, { method: 'DELETE' });
  }
  await t.refresh();
  S.lightReturn = null; t.closeLightbox();

  /* ---------- 1.23.0：上传 / 删除详情附件全链路同步 ---------- */
  const sid123 = S.data.shops[0].id;
  const post123 = (name, mime, buf) => fetchJar(
    `${BASE}/api/attachments?entity=shops&id=${sid123}&name=${encodeURIComponent(name)}`,
    { method: 'POST', headers: { 'Content-Type': mime }, body: buf });
  const makeFile123 = (name, text, mime) => Object.assign(Buffer.from(text), {
    name, type: mime, size: Buffer.byteLength(text)
  });

  // 详情弹窗的缩略图区与附件面板都带原地同步标记
  t.openShopDetail(sid123);
  check(/att-gallery/.test(modal()) && /attach-panel/.test(modal()),
    '商铺详情含可原地同步的缩略图区与附件面板');
  const gallery123 = t.attGalleryHtml('shops', sid123, 3, '暂无商铺照片 / 附件');
  check(/data-entity="shops"/.test(gallery123) && /data-max="3"/.test(gallery123)
    && /data-empty="暂无商铺照片 \/ 附件"/.test(gallery123), '缩略图区带同步标记与空态配置');

  // 面板渲染配置写进 dataset，重绘时不丢失标题开关 / 空态文案 / 只读状态
  const custom123 = t.attachPanelHtml('shops', sid123, { title: false, empty: '自定义空态', readonly: true });
  check(/data-title="0"/.test(custom123) && /data-empty="自定义空态"/.test(custom123)
    && /data-readonly="1"/.test(custom123), '附件面板把渲染配置写进 dataset');
  const panelBox123 = { dataset: { entity: 'shops', eid: String(sid123), title: '0', empty: '自定义空态', readonly: '1' }, outerHTML: '' };
  queryAllOverride = (sel) => sel === '.attach-panel' ? [panelBox123] : [];
  t.rerenderAttachPanels();
  check(/data-title="0"/.test(panelBox123.outerHTML) && /自定义空态/.test(panelBox123.outerHTML)
    && !/sect-title/.test(panelBox123.outerHTML) && !/upload-btn/.test(panelBox123.outerHTML),
    '原地重绘保留标题开关 / 空态文案 / 只读状态');

  const galleryBox123 = { dataset: { entity: 'shops', id: String(sid123), max: '3', empty: '暂无商铺照片 / 附件' }, outerHTML: '' };
  queryAllOverride = (sel) => sel === '.att-gallery' ? [galleryBox123] : [];
  t.rerenderAttGalleries();
  check(/att-gallery/.test(galleryBox123.outerHTML) && /商铺现场照片/.test(galleryBox123.outerHTML),
    '缩略图区原地重绘读出最新附件');
  queryAllOverride = null;

  // ① 通过前端 uploadAttachments 真实上传：服务端落库 + 本地缓存 + 面板 / 缩略图区同时可见
  await t.uploadAttachments('shops', sid123, [makeFile123('同步测试附件.png', 'v123 sync', 'image/png')], null);
  const srv123 = await (await fetchJar(`${BASE}/api/attachments?entity=shops&id=${sid123}`)).json();
  check(srv123.ok && srv123.data.some(a => a.name === '同步测试附件.png'), '前端上传后服务端已落库');
  check((S.data.attachments || []).some(a => a.entity === 'shops' && a.name === '同步测试附件.png'),
    '上传后本地附件缓存即时同步，不必关闭再打开详情');
  check(/同步测试附件\.png/.test(t.attachPanelHtml('shops', sid123)), '附件面板即时出现新附件');
  check(/同步测试附件\.png/.test(t.attGalleryHtml('shops', sid123, 3, '暂无商铺照片 / 附件')),
    '详情缩略图区即时出现新附件（旧版漏刷的不同步点）');
  check(t.attachSignature().indexOf('同步测试附件.png') >= 0, '附件快照签名随上传变化');
  check(/attach-panel/.test(modal()), '整包刷新后详情弹窗仍保持打开');

  // ② 附件总览计数与列表内容均为最新
  const listBody123 = t.attListBodyHtml('shops', sid123);
  check(/共 \d+ 个附件/.test(listBody123) && /data-att-count="shops:/.test(listBody123)
    && /同步测试附件\.png/.test(listBody123), '附件总览计数与列表均为最新');
  const countBox123 = { dataset: { attCount: `shops:${sid123}` }, innerHTML: '' };
  queryAllOverride = (sel) => sel === '[data-att-count]' ? [countBox123] : [];
  t.syncAttListHeader();
  check(/共 \d+ 个附件/.test(countBox123.innerHTML), '总览计数可原地同步');
  queryAllOverride = null;

  // ③ 模拟另一个页面上传：打开总览前主动核对服务端最新
  const ext123 = await post123('另一个页面上传.txt', 'text/plain', Buffer.from('other page'));
  check(ext123.status === 200, '模拟另一个页面上传附件成功');
  const ok123 = await t.fetchAttachments('shops', sid123);
  check(ok123 && (S.data.attachments || []).some(a => a.name === '另一个页面上传.txt'),
    '打开总览前可主动核对服务端最新附件');
  t.openAttList('shops', sid123);
  check(/另一个页面上传\.txt/.test(lightbox()), '附件总览渲染跨页面上传的新附件');

  // ④ 预览期间上传 → 关闭预览回到按最新数据重建的总览，不再是过期缓存
  const someAtt123 = (S.data.attachments || []).find(a => a.entity === 'shops' && a.name === '同步测试附件.png');
  await t.openAttPreview(someAtt123.id);
  check(/data-att-preview="1"/.test(lightbox()), '附件预览在二层打开');
  await t.uploadAttachments('shops', sid123, [makeFile123('预览期间上传.txt', 'during preview', 'text/plain')], null);
  t.closeLightbox();
  check(/data-att-list="1"/.test(lightbox()) && /预览期间上传\.txt/.test(lightbox()),
    '预览期间上传后关闭预览回到最新总览（不再显示过期缓存）');
  t.closeLightbox();
  check(lightbox() === '', '再关一次才清空二层，逐层规则不变');

  // ⑤ 服务端 DELETE 回传最新列表 + 前端删除后各展示位同步移除
  const delAtt123 = (S.data.attachments || []).find(a => a.name === '同步测试附件.png');
  const delRes123 = await (await fetchJar(`${BASE}/api/attachments/${delAtt123.id}`, { method: 'DELETE' })).json();
  check(delRes123.ok && Array.isArray(delRes123.data) && !delRes123.data.some(a => a.id === delAtt123.id),
    '服务端删除附件回传删除后的最新列表');
  await t.syncAttachData('shops', sid123);
  check(!(S.data.attachments || []).some(a => a.id === delAtt123.id), '前端同步后本地缓存移除已删除附件');
  check(!/同步测试附件\.png/.test(t.attachPanelHtml('shops', sid123))
    && !/同步测试附件\.png/.test(t.attGalleryHtml('shops', sid123, 3, '暂无商铺照片 / 附件')),
    '删除后附件面板与缩略图区同时移除');

  // 清理本轮测试附件，恢复干净状态
  for (const a of (S.data.attachments || []).filter(x => /另一个页面上传|预览期间上传/.test(x.name))) {
    await fetchJar(`${BASE}/api/attachments/${a.id}`, { method: 'DELETE' });
  }
  await t.refresh();
  S.lightReturn = null; t.closeLightbox();

  /* ---------- 退出 / 重新登录（真实事件链路） ---------- */
  await click({ act: 'logout' });
  check(/login-card/.test(document.querySelector('#loginRoot').innerHTML), '退出后出现登录页');
  check(!S.auth && !S.data, '退出后清空登录态与数据');

  // 造一个「上次停留在合同管理、驾驶舱停在收支分区」的脏状态，验证登录后回到干净的驾驶舱首屏
  try { localStorage.setItem('pmops_last_view', 'contracts'); } catch (e) {}
  S.view = 'contracts'; S.cockpitTab = 'finance'; S.dashRange = '12';
  S.dashBuilding = 'A 栋'; S.dashDrill = { type: 'month', key: '2026-11' };

  document.querySelector('#loginUser').value = 'admin';
  document.querySelector('#loginPass').value = 'bad-password';
  await click({ act: 'loginSubmit' });
  check(!S.auth, '错误密码登录失败');
  check(document.querySelector('#loginPass').value === '', '登录失败后清空密码框便于重试');
  document.querySelector('#loginPass').value = 'admin123';
  await click({ act: 'loginSubmit' });
  await new Promise((r) => setTimeout(r, 800));
  check(!!S.auth && !!S.data, '重新登录后自动加载', S.auth ? S.auth.username : 'null');
  check(!document.querySelector('#loginRoot').innerHTML, '登录成功后隐藏登录页');
  check(S.auth.role === 'admin' && S.auth.password_is_default === true, '登录态带初始密码提醒');
  check(S.view === 'dashboard' && S.cockpitTab === 'overview' && S.dashRange === '6'
    && S.dashBuilding === 'all' && S.dashDrill === null,
    '重新登录固定进入可视化驾驶舱并重置维度 / 时间 / 楼栋 / 下钻',
    `${S.view}/${S.cockpitTab}/${S.dashRange}`);
  check(localStorage.getItem('pmops_last_view') === null, '登录时清除旧模块记忆');
  check(/可视化驾驶舱/.test(view()) && /data-act="dashTab" data-k="overview"/.test(view()),
    '登录后首屏渲染驾驶舱经营总览');

  /* ============================================================
     1.24.0：OnlyOffice 实现 Office 文件在线预览
     ============================================================ */
  const http124 = require('http');
  const crypto124 = require('crypto');
  // 起一个本地假 Document Server，验证服务端连通性探测 + 配置 + 取文件全链路
  const mockOo = http124.createServer((req, res) => {
    if (req.url === '/healthcheck') {
      res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('true'); return;
    }
    if (String(req.url).indexOf('/web-apps/apps/api/documents/api.js') === 0) {
      res.writeHead(200, { 'Content-Type': 'application/javascript' });
      res.end('window.DocsAPI={DocEditor:function(){}};'); return;
    }
    res.writeHead(404); res.end('not found');
  });
  await new Promise(r => mockOo.listen(0, '127.0.0.1', r));
  const OO_BASE = `http://127.0.0.1:${mockOo.address().port}`;

  // ① 出厂默认关闭：不引入任何外部依赖
  const setOff124 = await (await fetchJar(BASE + '/api/settings')).json();
  check(setOff124.data.oo_enabled === '0' && setOff124.data.oo_server === ''
    && setOff124.data.oo_jwt_set === false, 'OnlyOffice 出厂默认关闭，不配置时零外部依赖');
  check(!t.ooReady(), '未启用时前端 ooReady 为 false');
  check(setOff124.defaults.oo_enabled === '0' && setOff124.defaults.oo_jwt_secret === '',
    '出厂默认值含 OnlyOffice 四项且密钥为空');

  // ② 造 Office 附件
  const cid124 = S.data.contracts[0].id;
  const putAtt124 = async (name, mime, buf) => {
    const r = await fetchJar(
      `${BASE}/api/attachments?entity=contracts&id=${cid124}&name=${encodeURIComponent(name)}`,
      { method: 'POST', headers: { 'Content-Type': mime }, body: buf });
    return (await r.json()).data;
  };
  const doc124 = await putAtt124('工程联系单.docx',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document', Buffer.from('PK fake docx'));
  const ppt124 = await putAtt124('汇报材料.pptx',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation', Buffer.from('PK fake pptx'));
  const xls124 = await putAtt124('旧台账.xls', 'application/vnd.ms-excel', Buffer.from('fake xls'));
  const xlsx124 = await putAtt124('台账.xlsx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', Buffer.from('PK fake xlsx'));
  const pdf124 = await putAtt124('扫描件.pdf', 'application/pdf', Buffer.from('%PDF-1.4 fake'));
  check([doc124, ppt124, xls124, xlsx124, pdf124].every(a => a && a.id), '上传 Word / PPT / xls / xlsx / PDF 附件成功');
  await t.refresh();
  const cfgOff124 = await fetchJar(`${BASE}/api/onlyoffice/config/${doc124.id}`);
  check(cfgOff124.status === 400 && (await cfgOff124.json()).error.indexOf('未启用') >= 0,
    '未启用时配置接口拒绝并引导到系统设置');
  check(t.attPreviewKind(doc124) === 'other' && t.attBuiltinKind(doc124) === 'other',
    '未配置时 docx 仍无预览角标，保持旧行为');

  // ③ 设置保存：地址规范化 + JWT 密钥全程脱敏
  const putSet124 = await (await fetchJar(BASE + '/api/settings', jsonInit('PUT', {
    oo_enabled: '1', oo_server: OO_BASE + '/', oo_jwt_secret: 'test-onlyoffice-secret',
    oo_public_url: BASE
  }))).json();
  check(putSet124.data.oo_enabled === '1' && putSet124.data.oo_server === OO_BASE,
    '设置保存生效，地址自动补协议 / 去尾斜杠', putSet124.data.oo_server);
  check(putSet124.data.oo_jwt_secret === '******' && putSet124.data.oo_jwt_set === true,
    'JWT 密钥保存后只回传掩码，不下发明文');
  const boot124 = await (await fetchJar(BASE + '/api/bootstrap')).json();
  check(boot124.data.settings.oo_jwt_secret === '******', 'bootstrap 快照不下发明文密钥');
  const backup124 = await (await fetchJar(BASE + '/api/backup')).json();
  check(backup124.settings.oo_jwt_secret === '******', '全量备份同样不含明文密钥');
  const mask124 = await (await fetchJar(BASE + '/api/settings', jsonInit('PUT', {
    oo_jwt_secret: '******', project_name: '掩码测试'
  }))).json();
  check(mask124.data.oo_jwt_set === true && mask124.data.project_name === '掩码测试',
    '原样提交掩码表示不修改密钥');
  const badAddr124 = await (await fetchJar(BASE + '/api/settings', jsonInit('PUT', {
    oo_server: 'javascript:alert(1)'
  }))).json();
  check(badAddr124.data.oo_server === '', '伪协议地址被服务端拒绝');
  const ipAddr124 = await (await fetchJar(BASE + '/api/settings', jsonInit('PUT', {
    oo_server: `127.0.0.1:${mockOo.address().port}/`
  }))).json();
  check(ipAddr124.data.oo_server === OO_BASE, '直接填 IP:端口自动补 http 协议');
  await fetchJar(BASE + '/api/settings', jsonInit('PUT', { project_name: '' }));

  // ④ 连通性探测（结果放 data，HTTP 恒 ok:true）
  const st124 = await (await fetchJar(BASE + '/api/onlyoffice/status')).json();
  check(st124.ok === true && st124.data.connected === true && st124.data.probe === 'healthcheck',
    '测试连接命中 /healthcheck 并判定为连通', JSON.stringify(st124.data));
  const stBad124 = await (await fetchJar(BASE + '/api/onlyoffice/status?server='
    + encodeURIComponent('http://127.0.0.1:1'))).json();
  check(stBad124.ok === true && stBad124.data.connected === false,
    '连不上时返回可展示的失败原因，不会被前端当成请求异常');

  // ⑤ 生成 DocEditor 配置：类型 / 只读 / 签名 URL / JWT
  await t.refresh();
  check(t.ooReady() === true, '启用并填地址后前端 ooReady 为 true');
  const cfgJ124 = await (await fetchJar(`${BASE}/api/onlyoffice/config/${doc124.id}`)).json();
  const c124 = cfgJ124.data;
  check(c124.docType === 'word' && c124.mode === 'view' && c124.jwt === true,
    'docx 配置：word 文档 / 只读预览 / 启用 JWT');
  check(c124.server === OO_BASE && c124.script === OO_BASE + '/web-apps/apps/api/documents/api.js',
    '配置返回 DocServer 根地址与 api.js 脚本地址');
  check(c124.config.document.fileType === 'docx'
    && /^pmops-\d+-[0-9a-f]+$/.test(c124.config.document.key), '文档 key 按附件内容生成且格式合法');
  check(c124.config.editorConfig.mode === 'view' && c124.config.document.permissions.edit === false,
    '预览为只读，不会写回 / 覆盖原附件');
  check(c124.config.document.url.indexOf(`/api/onlyoffice/file/${doc124.id}?token=`) >= 0
    && c124.config.editorConfig.callbackUrl.indexOf(`/api/onlyoffice/callback/${doc124.id}?token=`) >= 0,
    '取文件与回调都使用带短期签名的公开 URL');
  check(c124.config.editorConfig.lang === 'zh-CN' && c124.config.editorConfig.user.id === 'admin',
    '编辑器语言与当前登录用户同步');
  const jwt124 = String(c124.config.token || '').split('.');
  check(jwt124.length === 3, 'JWT 为三段式 HS256 结构');
  const jwtPayload124 = JSON.parse(Buffer.from(jwt124[1], 'base64url').toString('utf8'));
  check(jwtPayload124.document.url === c124.config.document.url,
    'JWT 载荷覆盖整份配置（含取文件 URL）');
  const jwtExpect124 = crypto124.createHmac('sha256', 'test-onlyoffice-secret')
    .update(jwt124[0] + '.' + jwt124[1]).digest('base64url');
  check(jwtExpect124 === jwt124[2], 'JWT 用保存的密钥签名（掩码提交未改密钥）');
  const cfgPpt124 = await (await fetchJar(`${BASE}/api/onlyoffice/config/${ppt124.id}`)).json();
  const cfgXls124 = await (await fetchJar(`${BASE}/api/onlyoffice/config/${xls124.id}`)).json();
  const cfgXlsx124 = await (await fetchJar(`${BASE}/api/onlyoffice/config/${xlsx124.id}`)).json();
  check(cfgPpt124.data.docType === 'slide' && cfgXls124.data.docType === 'cell'
    && cfgXlsx124.data.docType === 'cell', 'PPT → slide、xls / xlsx → cell 类型映射正确');
  const png124 = (S.data.attachments || []).find(a => /\.png$/i.test(a.name));
  if (png124) {
    const cfgPng124 = await fetchJar(`${BASE}/api/onlyoffice/config/${png124.id}`);
    check(cfgPng124.status === 400, '非 Office 格式不生成配置');
  }
  const anonCfg124 = await realFetch(`${BASE}/api/onlyoffice/config/${doc124.id}`);
  check(anonCfg124.status === 401, '配置接口仍需登录（未登录 401）');

  // ⑥ DocServer 反向取文件：签名校验 / MIME / Range / 回调
  const fileUrl124 = c124.config.document.url;
  const anonFile124 = await realFetch(fileUrl124);
  const fileBuf124 = Buffer.from(await anonFile124.arrayBuffer());
  check(anonFile124.status === 200 && fileBuf124.toString() === 'PK fake docx',
    'DocServer 凭签名 URL 取到原文件（无需登录 Cookie）');
  check(String(anonFile124.headers.get('content-type')).indexOf('wordprocessingml') >= 0,
    '取文件返回 Word 正确 MIME');
  check((await realFetch(`${BASE}/api/onlyoffice/file/${doc124.id}`)).status === 403,
    '无签名取文件被拒绝');
  check((await realFetch(`${BASE}/api/onlyoffice/file/${doc124.id}?token=1.1.abc`)).status === 403,
    '过期签名被拒绝');
  check((await realFetch(`${BASE}/api/onlyoffice/file/${doc124.id}?token=`
    + encodeURIComponent(fileUrl124.split('token=')[1]) + 'x')).status === 403,
    '伪造签名被拒绝');
  const range124 = await realFetch(fileUrl124, { headers: { Range: 'bytes=0-5' } });
  check(range124.status === 206 && /^bytes 0-5\//.test(String(range124.headers.get('content-range'))),
    '取文件支持 Range 206 分段');
  const cb124 = await realFetch(c124.config.editorConfig.callbackUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"status":2}'
  });
  check(cb124.status === 200 && (await cb124.json()).error === 0, '只读回调返回 error:0 正常结束会话');
  check((await realFetch(`${BASE}/api/onlyoffice/callback/${doc124.id}`,
    { method: 'POST' })).status === 403, '无签名回调被拒绝');

  // ⑦ 关闭 JWT 后配置不再带 token，重新开启保持可用
  await fetchJar(BASE + '/api/settings', jsonInit('PUT', { oo_jwt_secret: '' }));
  const cfgNoJwt124 = await (await fetchJar(`${BASE}/api/onlyoffice/config/${doc124.id}`)).json();
  check(cfgNoJwt124.data.jwt === false && !cfgNoJwt124.data.config.token,
    '清空密钥后按「未启用 JWT」的 DocServer 生成配置');
  await fetchJar(BASE + '/api/settings', jsonInit('PUT', { oo_jwt_secret: 'test-onlyoffice-secret' }));

  // ⑧ 前端分类 / 角标 / 切换按钮
  await t.refresh();
  check(t.attPreviewKind(doc124) === 'office' && t.attBuiltinKind(doc124) === 'other',
    'docx 启用后走 OnlyOffice，内置仍视为不可预览');
  check(t.attPreviewKind(ppt124) === 'office' && t.attPreviewKind(xls124) === 'office',
    'PPT / 旧版 xls 也纳入在线预览');
  check(t.attPreviewKind(xlsx124) === 'table' && t.attPreviewKind(pdf124) === 'pdf',
    'xlsx / PDF 仍优先零依赖内置预览');
  check(t.attPreviewable(doc124) && /Office 预览/.test(t.attPreviewTag(doc124)),
    'Office 附件带专属预览角标且可点击');
  check(t.OO_OFFICE_EXTS.has('.docx') && t.OO_OFFICE_EXTS.has('.pptx') && !t.OO_OFFICE_EXTS.has('.dwg'),
    '可预览扩展名与服务端保持一致，CAD 不在其中');
  check(!/officePreview/.test(t.attPreviewBase(pdf124, 'pdf').footer),
    'PDF 预览窗不显示 OnlyOffice 切换按钮');
  check(/data-act="officePreview"/.test(t.attPreviewBase(xlsx124, 'table').footer),
    '内置表格预览窗可一键切到 OnlyOffice');
  check(/data-act="builtinPreview"/.test(t.attPreviewBase(xlsx124, 'office').footer),
    'OnlyOffice 窗可切回内置表格');
  check(/OnlyOffice 只读预览/.test(t.attPreviewBase(doc124, 'office').sub),
    '预览窗副标题标注 OnlyOffice 只读');
  check(/\.pptx/.test(t.ATT_ACCEPT) && /\.xlsm/.test(t.ATT_ACCEPT),
    '附件上传选择器扩充 PPT / xlsm 等 Office 格式');

  // ⑨ 设置页配置卡片与「测试连接」
  const setHtml124 = renderView('settings');
  check(/data-oo-card="1"/.test(setHtml124) && /Office 在线预览（OnlyOffice）/.test(setHtml124),
    '系统设置新增 Office 在线预览卡片');
  check(/data-k="oo_enabled"/.test(setHtml124) && /data-k="oo_server"/.test(setHtml124)
    && /data-k="oo_jwt_secret" type="password"/.test(setHtml124)
    && /data-k="oo_public_url"/.test(setHtml124), '四项配置渲染齐全，JWT 用密码框');
  check(/data-act="testOoServer"/.test(setHtml124) && /id="ooStatusHint"/.test(setHtml124),
    '设置页提供「测试连接」按钮与状态提示位');
  check(/JWT 已配置/.test(setHtml124), '已配置密钥时状态栏显示「JWT 已配置」');
  check(t.OO_SETTING_KEYS.length === 4 && t.SETTING_KEYS.indexOf('oo_server') > 0,
    'OnlyOffice 字段并入设置白名单且可单独复用');
  await t.testOoServerUI();
  check(/连接成功/.test(String(document.querySelector('#ooStatusHint').textContent)),
    '前端「测试连接」显示成功状态');

  // ⑩ 真实 DocEditor 渲染 / 逐层关闭 / 切换
  let ooCalls124 = [], ooDestroyed124 = 0;
  global.window.DocsAPI = {
    DocEditor: function (id, cfg) {
      ooCalls124.push({ id, cfg });
      this.destroyEditor = () => { ooDestroyed124++; };
    }
  };
  S.ooScriptUrl = '';
  await t.openAttPreview(doc124.id);
  check(/data-oo-preview="1"/.test(lightbox()) && /class="oo-editor"/.test(lightbox()),
    '点击 docx 附件打开 OnlyOffice 预览窗并挂载容器');
  check(new RegExp(`id="oo-editor-${doc124.id}"`).test(lightbox()), '容器 id 与附件绑定');
  check(ooCalls124.length === 1 && ooCalls124[0].cfg.documentType === 'word',
    'DocEditor 用 word 配置实例化');
  check(ooCalls124[0].cfg.editorConfig.mode === 'view'
    && ooCalls124[0].cfg.document.permissions.edit === false, 'DocEditor 只读，不写回原文件');
  check(!!S.ooEditor, 'DocEditor 实例保存在状态中，关窗时可销毁');
  check(/data-act="closeLight"/.test(lightbox()) && /下载原文件/.test(lightbox()),
    '预览窗保留「关闭」与「下载原文件」');
  t.destroyOoEditor();
  check(S.ooEditor === null && ooDestroyed124 === 1, 'destroyOoEditor 调用 destroyEditor 并清空状态');

  await click({ act: 'officePreview', id: String(xlsx124.id) });
  check(/data-oo-preview="1"/.test(lightbox()) && /data-act="builtinPreview"/.test(lightbox()),
    '内置表格预览可一键切到 OnlyOffice 完整渲染');
  await click({ act: 'builtinPreview', id: String(xlsx124.id) });
  check(/data-att-preview="1"/.test(lightbox()) && !/data-oo-preview="1"/.test(lightbox()),
    'OnlyOffice 窗可切回内置预览且不残留编辑器标记');
  t.closeLightbox();

  t.openAttList('contracts', cid124);
  await t.openAttPreview(doc124.id);
  check(/data-oo-preview="1"/.test(lightbox()), '从「+N 附件总览」可打开 OnlyOffice 预览');
  t.closeLightbox();
  check(/data-att-list="1"/.test(lightbox()), '关闭 OnlyOffice 预览先回到附件总览（严格逐层）');
  t.closeLightbox();
  check(lightbox() === '', '再关一次才清空二层弹窗');
  check(S.ooEditor === null && ooDestroyed124 >= 2, '关窗时 DocEditor 已销毁，不留 iframe 会话');
  await t.openAttPreview(pdf124.id);
  check(/att-pv-frame/.test(lightbox()) && !/data-oo-preview="1"/.test(lightbox()),
    'OnlyOffice 关窗后 PDF 内置预览不受影响');
  t.closeLightbox();

  // ⑪ 关闭 OnlyOffice 后完全回到零依赖内置预览
  await fetchJar(BASE + '/api/settings', jsonInit('PUT', {
    oo_enabled: '0', oo_server: '', oo_jwt_secret: '', oo_public_url: ''
  }));
  await t.refresh();
  check(!t.ooReady() && t.attPreviewKind(doc124) === 'other',
    '关闭 OnlyOffice 后 Word 附件恢复为原来的下载方式');
  check(/支持图片、PDF、Word \/ Excel \/ PPT/.test(t.attachHint('contracts')),
    '附件上传提示同步覆盖 Office 格式');
  mockOo.close();

  /* ============================================================
     1.25.0：全局手机端网页自适应
     ============================================================ */
  const v125Html = fs.readFileSync(path.join(__dirname, '..', 'pack', 'app', 'www', 'index.html'), 'utf8');
  const v125Css = (v125Html.match(/<style>([\s\S]*?)<\/style>/) || [, ''])[1];
  const v125Srv = fs.readFileSync(path.join(__dirname, '..', 'pack', 'app', 'server', 'server.js'), 'utf8');
  const v125Man = fs.readFileSync(path.join(__dirname, '..', 'pack', 'manifest'), 'utf8');
  const v125Doc = fs.readFileSync(path.join(__dirname, '..', '安装说明.md'), 'utf8');

  // ① 断点与视口
  check(/<meta name="viewport" content="width=device-width, initial-scale=1">/.test(v125Html),
    '页面保留移动端 viewport 元信息');
  check(t.MOBILE_MAX === 820, '运行时断点与 CSS 一致（820px）', String(t.MOBILE_MAX));
  check(/@media screen and \(max-width:820px\)/.test(v125Css)
    && /@media screen and \(max-width:560px\)/.test(v125Css)
    && /@media screen and \(max-width:380px\)/.test(v125Css),
    '三档屏幕断点齐备：抽屉 820 / 手机 560 / 极窄屏 380');
  check(!/@media\(max-width:820px\)/.test(v125Css), '旧的顶部横滚侧栏规则已被抽屉方案替换');
  check((v125Css.match(/@media screen and \(max-width:/g) || []).length === 3,
    '新增断点全部仅作用于 screen，打印 A4 排版不受影响');
  check(/@page\{size:A4 portrait/.test(v125Html) && /\.work-panel\{display:none !important\}/.test(v125Html),
    'A4 打印样式与 1.21.0 打印精简兜底仍然保留');
  check(/@media \(prefers-reduced-motion:reduce\)/.test(v125Css), '尊重系统「减少动态效果」偏好');

  // ② 抽屉导航结构与样式
  check(/id="navToggle" data-act="navToggle"/.test(v125Html)
    && /id="navBackdrop" data-act="closeNav"/.test(v125Html)
    && /class="nav-close" data-act="closeNav"/.test(v125Html)
    && /class="topbar-title"/.test(v125Html),
    '汉堡按钮 / 遮罩 / 抽屉关闭 × / 标题容器均在页面骨架中');
  check(/\.nav-toggle,\.nav-close,\.nav-backdrop,\.tap-hint\{display:none\}/.test(v125Css),
    '桌面端隐藏全部移动端构件，桌面布局不变');
  check(/\.app\{display:block\}/.test(v125Css) && /main\{margin-left:0;min-height:100dvh\}/.test(v125Css),
    '窄屏取消左侧固定宽度偏移，主区占满整屏');
  check(/body\.nav-open \.sidebar\{transform:none/.test(v125Css)
    && /body\.nav-open \.nav-backdrop\{opacity:1;visibility:visible\}/.test(v125Css)
    && /body\.nav-open\{overflow:hidden\}/.test(v125Css),
    'body.nav-open 一处开关同时驱动抽屉、遮罩与背景滚动锁定');
  check(/\.nav-toggle\{\s*display:inline-flex/.test(v125Css) && /\.nav-close\{\s*display:flex/.test(v125Css),
    '窄屏才显示汉堡按钮与抽屉关闭按钮');
  check(/\.nav\{flex-direction:column;overflow:visible/.test(v125Css)
    && /\.nav-item\{width:100%;min-height:42px/.test(v125Css),
    '抽屉内导航恢复纵向列表并放大触摸目标至 42px');
  check(/\.topbar-actions\{[\s\S]*?order:3;width:100%/.test(v125Css)
    && /overflow-x:auto/.test(v125Css),
    '顶栏操作按钮独占一行并可横向滑动');

  // ③ 全模块布局重排
  check(/\.shop-grid,\.egrid,\.bld-grid\{grid-template-columns:1fr/.test(v125Css)
    && /\.attach-grid\{grid-template-columns:repeat\(auto-fill,minmax\(110px,1fr\)\)/.test(v125Css),
    '商铺 / 通用实体 / 楼栋卡片手机端单列，附件宫格两列以上');
  check(/\.stats\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/.test(v125Css)
    && /\.dk-grid,\.dash-stat\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\) !important/.test(v125Css)
    && /\.kv\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/.test(v125Css),
    '统计栏 / 驾驶舱指标 / 详情键值统一两列紧凑排布');
  check(/\.grid-2,\.grid-2b,\.dash-row\.a,\.dash-row\.b,\.dash-row\.c,\.dash-grid,\.set-grid\{grid-template-columns:1fr/.test(v125Css),
    '概览双栏、驾驶舱四组布局与设置页全部改单列');
  check(/\.dchart\{height:200px\}/.test(v125Css) && /\.chart\{height:210px\}/.test(v125Css),
    '驾驶舱与概览图表高度按手机屏幕收缩');
  check(/overflow-x:auto;\s*-webkit-overflow-scrolling:touch/.test(v125Css)
    && /\.table-wrap,\.pb-wrap,\.drill-wrap,\.att-pv-scroll,\.att-pv-pre\{/.test(v125Css),
    '宽表格 / 付款计划 / 下钻明细 / 预览区改为触摸友好的独立横向滚动');
  check(/input,select,textarea\{font-size:16px;height:40px\}/.test(v125Css)
    && /\.form-grid\{grid-template-columns:1fr/.test(v125Css),
    '表单单列 + 16px 字号，避免 iOS 聚焦自动缩放');
  check(/\.modal,\.modal\.sm,\.modal\.lg,\.modal\.xl,\.modal\.xxl\{[\s\S]*?width:100% !important/.test(v125Css)
    && /\.modal-body\{padding:13px;flex:1 1 auto;min-height:0/.test(v125Css)
    && /\.modal-foot\{padding:10px 12px;flex-wrap:wrap/.test(v125Css),
    '弹窗近全屏、内容区独立滚动、底部按钮自动换行');
  check(/\.att-pv-frame\{height:56dvh\}/.test(v125Css) && /\.oo-editor\{height:58dvh;min-height:0\}/.test(v125Css),
    'PDF 与 OnlyOffice 预览高度按可视高度适配');
  check(/\.modal-head\{touch-action:auto/.test(v125Css) && /\.drag-hint\{display:none\}/.test(v125Css)
    && /\.tap-hint\{display:inline\}/.test(v125Css),
    '手机端标题栏恢复触摸滚动，拖拽提示改为关闭指引');
  check((v125Html.match(/class="tap-hint"/g) || []).length === 2,
    '一层弹窗与二层预览窗都带移动端关闭指引');

  // ④ 运行时：断点判定、抽屉状态与关闭时机
  global.window.innerWidth = undefined;
  check(t.isMobileLayout() === false, '桌面 / 未取到宽度时按桌面布局处理');
  global.window.innerWidth = 390;
  check(t.isMobileLayout() === true, '390px 手机宽度判定为移动布局');
  global.window.innerWidth = 820;
  check(t.isMobileLayout() === true, '820px 断点边界仍走抽屉布局');
  global.window.innerWidth = 821;
  check(t.isMobileLayout() === false, '821px 起回到桌面布局');
  global.window.innerWidth = 390;

  check(t.setNavOpen(true) === true && S.navOpen === true
    && document.body.classList.contains('nav-open')
    && document.querySelector('#navToggle').getAttribute('aria-expanded') === 'true',
    '展开抽屉同步设置 body 类与 aria-expanded');
  check(t.toggleNav() === false && S.navOpen === false
    && !document.body.classList.contains('nav-open'), '再点汉堡收起抽屉');
  t.MODAL_DRAG.suppressClick = false;
  await click({ act: 'navToggle' });
  check(S.navOpen === true && document.body.classList.contains('nav-open'), '事件分发：汉堡按钮可展开抽屉');
  await click({ act: 'closeNav' });
  check(S.navOpen === false, '事件分发：遮罩 / × 可收起抽屉');

  t.setNavOpen(true);
  t.setView('shops');
  check(S.navOpen === false && S.view === 'shops', '切换任意模块自动收起抽屉');
  t.setNavOpen(true);
  t.openModal({ title: '移动端弹窗', body: '内容' });
  check(S.navOpen === false, '打开一层弹窗时优先收起抽屉');
  t.setNavOpen(true);
  t.openLightbox({ title: '移动端预览', body: '内容' });
  check(S.navOpen === false, '打开二层预览时同样收起抽屉');
  document.querySelector('#modalRoot').innerHTML = '';
  document.querySelector('#lightRoot').innerHTML = '';
  S.modalReturn = null; S.lightReturn = null; S.formSubmit = null;

  t.setNavOpen(true);
  docListeners.keydown({ key: 'Escape' });
  check(S.navOpen === false, '无弹窗时 ESC 只收起导航抽屉');
  document.querySelector('#modalRoot').innerHTML = '<div class="overlay"></div>';
  t.setNavOpen(true);
  docListeners.keydown({ key: 'Escape' });
  check(S.navOpen === true, '有弹窗时 ESC 仍不关弹窗也不误收抽屉（1.20.0 规则不变）');
  t.closeNav();
  document.querySelector('#modalRoot').innerHTML = '';

  check(t.dragEventAllowed({ pointerType: 'touch' }) === false, '手机触摸手势不触发弹窗拖拽');
  check(t.dragEventAllowed({ pointerType: 'mouse' }) === true, '窄屏接鼠标时仍可按桌面方式拖动');
  global.window.PointerEvent = undefined;
  check(t.dragEventAllowed({}) === false, '无 PointerEvent 的旧移动浏览器一律按触摸处理');
  global.window.PointerEvent = function PointerEvent() {};
  check(t.dragEventAllowed({}) === true, '桌面 / 有指针事件时保留原有拖拽能力');
  delete global.window.PointerEvent;
  global.window.innerWidth = 1024;
  check(t.dragEventAllowed({ pointerType: 'touch' }) === true, '桌面宽度下拖拽不受移动端规则影响');
  check(/if \(!dragEventAllowed\(e\)\) return;/.test(v125Html), '拖拽监听器确实接入了触摸禁用判定');

  let resizeCalls = 0;
  S.charts.push({ resize() { resizeCalls++; }, dispose() {} });
  t.resizeCharts();
  check(resizeCalls === 1, 'resizeCharts 逐张重算 ECharts 实例');
  t.setNavOpen(true);
  t.onViewportChange();
  check(resizeCalls === 2 && S.navOpen === false,
    '窗口 / 横竖屏变化：重算图表并自动关闭已展开的抽屉');
  S.charts.pop();
  global.window.innerWidth = undefined;

  // ⑤ 版本与文档一致性（1.26.0）
  check(/const APP_VERSION = "1\.26\.0"/.test(v125Srv), '服务端 APP_VERSION 升到 1.26.0');
  check(/^version=1\.26\.0/m.test(v125Man) && /^changelog=1\.26\.0/m.test(v125Man),
    'manifest 版本与更新说明同步到 1.26.0');
  check(/1\.26\.0 起商铺管理增加「楼栋管理」/.test(v125Man) && /1\.25\.0 起全局适配手机/.test(v125Man),
    'manifest 描述同时保留楼栋管理与手机端自适应');
  check(/## 1\.26\.0 更新（商铺管理 · 楼栋管理）/.test(v125Doc)
    && /## 1\.25\.0 更新（全局手机端网页自适应）/.test(v125Doc)
    && /### 手机端使用/.test(v125Doc), '安装说明新增 1.26.0 楼栋管理章节并保留 1.25.0 手机端章节');
  const v125Renders = ['render-preview.js', 'render-dashboard-preview.js', 'render-print-preview.js', 'render-mobile-preview.js']
    .map(f => fs.readFileSync(path.join(__dirname, f), 'utf8'));
  check(v125Renders.every(s => /1\.26\.0/.test(s)), '四份常规 / 手机预览脚本版本号同步');
  check(fs.existsSync(path.join(__dirname, 'render-mobile-preview.js'))
    && /preview-mobile-1\.26\.0\.html/.test(fs.readFileSync(path.join(__dirname, 'render-mobile-preview.js'), 'utf8')),
    '390px 真 iframe 手机端预览脚本同步到 1.26.0');
  check(fs.existsSync(path.join(__dirname, 'render-building-preview.js'))
    && /preview-buildings-1\.26\.0\.html/.test(fs.readFileSync(path.join(__dirname, 'render-building-preview.js'), 'utf8')),
    '新增楼栋管理桌面 / 手机双视口预览脚本');
  check(S.data.meta.app.version === t.CHANGELOG[0].v && t.CHANGELOG[0].v === '1.26.0',
    '服务端下发版本 / 更新日志 / 前端版本三者一致', S.data.meta.app.version);

  // 复原视图，避免影响后续留痕断言
  t.setView('dashboard'); t.render();

  /* ---------- 1.26.0：商铺管理 · 楼栋管理 ---------- */
  const v126Srv = fs.readFileSync(path.join(__dirname, '..', 'pack', 'app', 'server', 'server.js'), 'utf8');
  const v126Css = (fs.readFileSync(path.join(__dirname, '..', 'pack', 'app', 'www', 'index.html'), 'utf8')
    .match(/<style>([\s\S]*?)<\/style>/) || [, ''])[1];
  const boot126 = await (await fetchJar(BASE + '/api/bootstrap')).json();
  const bldRows = boot126.data.buildings || [];
  check(Array.isArray(bldRows) && bldRows.length >= 3,
    'bootstrap 下发楼栋台账（种子 A / B / C 栋）', String(bldRows.length));
  const ov126 = boot126.data.overview || {};
  check(ov126.buildings && ov126.buildings.total === bldRows.length
    && ov126.buildings.unregistered === 0,
    '概览统计含楼栋总数 / 启用数 / 未建档数', JSON.stringify(ov126.buildings));
  const bldList = await (await fetchJar(BASE + '/api/buildings')).json();
  check(bldList.ok && bldList.data.length === bldRows.length, 'GET /api/buildings 通用 CRUD 可用');

  const newBld = await (await fetchJar(BASE + '/api/buildings', jsonInit('POST',
    { code: 'BLD-T', name: 'T栋', floors: '1F', area: 300, manager: '赵工', status: 'active' }))).json();
  check(newBld.ok && newBld.data.name === 'T栋' && Number(newBld.data.area) === 300,
    '新增楼栋并写入编号 / 楼层 / 面积 / 负责人');
  const dupResp = await fetchJar(BASE + '/api/buildings', jsonInit('POST', { name: 'T栋' }));
  const dupBody = await dupResp.json();
  check(dupResp.status === 400 && /已存在/.test(dupBody.error || ''), '楼栋名称唯一校验拒绝重复建档');
  check((await fetchJar(BASE + '/api/buildings', jsonInit('POST', { name: 'X栋', status: 'bad' }))).status === 400,
    '楼栋状态白名单校验');

  const aBld = bldRows.find(b => b.name === 'A栋') || bldRows[0];
  const aShopsBefore = (await (await fetchJar(BASE + '/api/shops')).json()).data
    .filter(s => String(s.building) === aBld.name).length;
  const renamed = await (await fetchJar(BASE + '/api/buildings/' + aBld.id,
    jsonInit('PUT', { name: 'A座' }))).json();
  const shops126 = (await (await fetchJar(BASE + '/api/shops')).json()).data;
  check(renamed.ok && renamed.data.name === 'A座'
    && shops126.filter(s => s.building === 'A座').length === aShopsBefore
    && !shops126.some(s => s.building === aBld.name),
    '楼栋改名自动同步所属商铺 building', aShopsBefore + ' 间');
  const delUsedResp = await fetchJar(BASE + '/api/buildings/' + aBld.id, { method: 'DELETE' });
  const delUsedBody = await delUsedResp.json();
  check(delUsedResp.status === 400 && /还有/.test(delUsedBody.error || ''), '楼栋下仍有商铺时拒绝删除');
  check((await fetchJar(BASE + '/api/buildings/' + newBld.data.id, { method: 'DELETE' })).status === 200,
    '空楼栋可正常删除');

  // 前端：子页 / 汇总卡片 / 筛选 / 表单 / 顶栏
  await t.refresh();
  S.view = 'shops';
  S.shopTab = 'buildings';
  const bldView = t.viewShops();
  check(/data-shop-tabs="1"/.test(bldView) && /楼栋管理/.test(bldView)
    && /data-building-summary="1"/.test(bldView) && /data-building-grid="1"/.test(bldView)
    && /data-building-card=/.test(bldView) && /bld-bar/.test(bldView),
    '商铺管理切换到楼栋管理子页并渲染指标带 / 卡片 / 出租率进度条');
  check(/data-act="newBuilding"/.test(t.topAction()) && /新增楼栋/.test(t.topAction()),
    '楼栋子页顶栏切换为「新增楼栋」');
  const st126 = t.buildingStats('A座');
  check(st126.total === aShopsBefore && st126.rate >= 0 && st126.rate <= 100
    && st126.area >= 0 && st126.rent >= 0 && st126.unpaid >= 0,
    'buildingStats 按楼栋实时聚合商铺 / 出租率 / 面积 / 租金 / 欠费');
  check(t.buildingNames().indexOf('A座') >= 0
    && t.buildingOptions('历史楼栋').some(o => o.k === '历史楼栋')
    && t.buildingOptions('历史楼栋').some(o => o.k === 'A座'),
    '楼栋下拉合并台账与商铺实际楼栋，编辑历史值不丢失');
  S.shopTab = 'shops';
  S.shopBuilding = 'A座';
  const filtered126 = t.viewShops();
  check(/data-building-filter="1"/.test(filtered126) && /data-act="shopBuilding"/.test(filtered126)
    && t.exportParams('shops').get('building') === 'A座',
    '商铺列表楼栋筛选 chips 与导出参数联动');
  check(/data-act="newShop"/.test(t.topAction()), '切回商铺列表顶栏恢复「新增商铺」');
  S.shopBuilding = 'all';

  // 未建档楼栋 → 一键补建
  const tempShop = await (await fetchJar(BASE + '/api/shops', jsonInit('POST',
    { name: '临时商铺', building: '临时楼', floor: '1F', area: 20, rent_price: 30, status: 'vacant' }))).json();
  check(tempShop.ok, '新增一间使用未建档楼栋的商铺');
  await t.refresh();
  check(t.unregisteredBuildings().indexOf('临时楼') >= 0, '前端识别商铺中使用但未建档的楼栋');
  S.shopTab = 'buildings';
  const missingView = t.viewShops();
  check(/data-bld-missing="1"/.test(missingView) && /quickCreateBuildings/.test(missingView),
    '楼栋管理页提示未建档楼栋并提供一键补建');
  await t.quickCreateBuildings();
  const bootAfterQ = await (await fetchJar(BASE + '/api/bootstrap')).json();
  check(bootAfterQ.data.buildings.some(b => b.name === '临时楼')
    && t.unregisteredBuildings().length === 0,
    '一键补建按现有商铺生成楼栋台账并消除缺口');
  await fetchJar(BASE + '/api/shops/' + tempShop.data.id, { method: 'DELETE' });
  const tempBld = bootAfterQ.data.buildings.find(b => b.name === '临时楼');
  if (tempBld) await fetchJar(BASE + '/api/buildings/' + tempBld.id, { method: 'DELETE' });
  await t.refresh();

  // 导出：楼栋汇总表与按楼栋筛选
  const expShop126 = await (await fetchJar(BASE + '/api/export?module=shops&preview=1')).json();
  const bldSheet = (expShop126.data.sheets || []).find(x => x.name === '楼栋汇总');
  check(bldSheet && bldSheet.columns.length === 19 && bldSheet.rows.length >= 3,
    '导出预览含「楼栋汇总」19 列工作表', bldSheet ? String(bldSheet.columns.length) : 'null');
  const expBldOnly = await (await fetchJar(BASE
    + '/api/export?module=shops&building=' + encodeURIComponent('A座') + '&preview=1')).json();
  check(expBldOnly.ok && expBldOnly.data.sheets[0].rows.length === aShopsBefore
    && expBldOnly.data.sheets[4].rows.length === 1,
    '按楼栋参数导出只含该楼栋商铺与一行汇总');

  // 迁移 / 附件白名单 / 手机端
  check(/function ensureBuildings/.test(v126Srv) && /ensureBuildings\(\);/.test(v126Srv)
    && /升级时按现有商铺自动建档/.test(v126Srv),
    '服务端含旧库按现有商铺楼栋自动建档迁移');
  check(t.attachAccept('buildings') === t.ATT_ACCEPT_ARCHIVE && /CAD/.test(t.attachHint('buildings')),
    '楼栋附件开放 CAD 图纸类型并给出对应提示');
  check(/\.bld-grid\{grid-template-columns:1fr/.test(v126Css), '手机端楼栋卡片自动单列');
  t.setView('dashboard'); t.render();

  /* ---------- 清空日志（放最后，避免影响前面的留痕断言） ---------- */
  const cleared = await fetchJar(BASE + '/api/audit_logs', { method: 'DELETE' });
  check(cleared.status === 200, '管理员可清空日志');
  const afterClear = await (await fetchJar(BASE + '/api/audit_logs')).json();
  check(afterClear.data.stats.all === 1 && afterClear.data.rows[0] && afterClear.data.rows[0].action === '清空日志',
    '清空后仅剩清空动作本身留痕', JSON.stringify(afterClear.data.stats));

  console.log(fail ? `\n${fail} 项失败` : '\n全部通过');
  process.exit(fail ? 1 : 0);
})();
