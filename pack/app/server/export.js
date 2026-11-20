/**
 * 导出模块：把各业务模块整理成 Excel 工作簿
 *
 * 设计原则：导出「看到的」数据 —— 支持按当前筛选条件（分类/状态）与单条记录导出。
 * 金额、面积、进度等保持数值类型，Excel 里可直接求和、排序。
 */
"use strict";

const xlsx = require("./xlsx");

const CATEGORIES = [
  { k: "aircon", n: "空调" },
  { k: "fire", n: "消防" },
  { k: "electric", n: "强电" },
  { k: "weak", n: "弱电" },
  { k: "plumbing", n: "给排水" },
  { k: "elevator", n: "电梯" },
  { k: "kitchen", n: "厨房设备" },
  { k: "other", n: "其他" }
];
const CAT_LABEL = CATEGORIES.reduce((m, c) => ((m[c.k] = c.n), m), {});

const SHOP_STATUS = { rented: "在租", vacant: "空置", maintenance: "维修" };
const EQ_STATUS = { normal: "正常", repair: "维修中", stopped: "停用" };
const CONTRACT_STATUS = { draft: "草拟", ongoing: "施工中", paused: "暂停", done: "已完工", settled: "已结算" };
const PLAN_STATUS = { pending: "未到期", due: "待支付", paid: "已支付" };
const CONTRACT_CAT = { renovation: "改造", repair: "维修", new: "新建" };
const EQ_LOG_TYPE = { inspect: "巡检", repair: "维修", maintain: "保养" };
const MAINTAIN_LABEL = { planned: "待保养", doing: "保养中", done: "已完成", postponed: "已延期" };
const TRIGGER = { sign: "签约即付", progress: "按施工进度", date: "按约定日期" };

/* 1.18.0 新增模块文案 */
const WORK_STATUS = { none: "未开始", planned: "待开工", doing: "进行中", done: "已完成", paused: "已暂停" };
const WORK_TYPE = { decoration: "装修", repair: "维修" };
const ARCHIVE_CAT = {
  contract: "合同档案", drawing: "图纸资料", license: "证照文件", acceptance: "验收资料",
  equipment: "设备资料", shop: "商铺资料", other: "其他"
};
const ARCHIVE_STATUS = { filed: "在档", borrowed: "借出", sealed: "已封存", void: "已作废" };
const ARCHIVE_SECURITY = { normal: "普通", internal: "内部", secret: "机密" };
const ARCHIVE_LOG_TYPE = { borrow: "借阅", return: "归还" };
const WH_CAT = {
  tool: "工具", hardware: "五金", electric: "电气", fire: "消防",
  cleaning: "清洁用品", consumable: "耗材", spare: "备品备件", other: "其他"
};
const WH_RECORD_TYPE = { in: "入库", out: "出库", adjust: "盘点调整" };
const WH_ITEM_STATUS = { normal: "正常", stopped: "停用" };

/** 1.15.0：与前端一致的保养状态口径（手动值优先，否则按下次保养日期派生） */
function localDay() {
  const d = new Date(), p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function addDays(dateStr, days) {
  const d = new Date(String(dateStr) + "T00:00:00Z");
  if (isNaN(d.getTime())) return dateStr;
  d.setUTCDate(d.getUTCDate() + (Number(days) || 0));
  return d.toISOString().slice(0, 10);
}
function eqMaintainInfo(e, filter) {
  const m = String((e && e.maintain_status) || "");
  if (MAINTAIN_LABEL[m]) return { key: m, label: MAINTAIN_LABEL[m] };
  if (!e || e.status === "stopped") return { key: "normal", label: "停用免保养" };
  const t = localDay();
  if (e.next_maintain && e.next_maintain < t) return { key: "planned", label: "保养已到期" };
  if (e.next_maintain && e.next_maintain <= addDays(t, Number(filter && filter.remindDays) || 0)) {
    return { key: "planned", label: "待保养" };
  }
  return { key: "normal", label: "状态正常" };
}

/** 商铺月租金：手动填了租金总金额(rent_total)则以手动值为准，否则按 单价×面积 */
function shopMonthlyRent(s) {
  const rt = Number(s && s.rent_total);
  if (Number.isFinite(rt) && rt > 0) return rt;
  return num(s && s.area) * num(s && s.rent_price);
}

const todayStr = () => new Date().toISOString().slice(0, 10);
const num = (n) => (Number.isFinite(Number(n)) ? Number(n) : 0);
const r2 = (n) => Math.round(num(n) * 100) / 100;

/** 租金单价：手动填了月租金总金额时按「总额 ÷ 面积」反算，与前端展示保持一致 */
function shopUnitPrice(s) {
  const rt = Number(s && s.rent_total);
  const area = num(s && s.area);
  if (Number.isFinite(rt) && rt > 0 && area > 0) return r2(rt / area);
  return num(s && s.rent_price);
}

const MODULES = {
  shops: { label: "商铺", title: "商铺台账" },
  equipments: { label: "设备", title: "设备台账" },
  contracts: { label: "合同", title: "合同台账" },
  payments: { label: "付款台账", title: "付款台账" },
  overview: { label: "经营分析", title: "经营分析" },
  dashboard: { label: "经营分析", title: "经营分析" },
  archives: { label: "档案台账", title: "档案台账" },
  warehouse: { label: "仓库物料", title: "仓库物料台账" },
  all: { label: "全部数据", title: "物业工程管理-全量数据" }
};

/* ---------------- 通用列 ---------------- */
const C = {
  id: (h) => ({ h, w: 14 }),
  text: (h, w) => ({ h, w: w || 16 }),
  num: (h, w) => ({ h, w: w || 13, t: "num" }),
  int: (h, w) => ({ h, w: w || 10, t: "num", money: false }),
  date: (h) => ({ h, w: 12 })
};

function byKey(list) {
  const m = {};
  (list || []).forEach((x) => { m[x.id] = x; });
  return m;
}
function sortBy(list, key) {
  return list.slice().sort((a, b) => String(key(a) || "").localeCompare(String(key(b) || ""), "zh-CN"));
}

/* ---------------- 各工作表 ---------------- */
function sheetShops(store, filter) {
  const shopMap = byKey(store.list("shops"));
  const readings = store.list("readings");
  const bills = store.list("bills");
  let shops = sortBy(store.list("shops"), (s) => s.code || s.name);
  if (filter.id) shops = shops.filter((s) => s.id === Number(filter.id));
  // 1.26.0：按楼栋筛选（与商铺管理页的楼栋 chips、表格预览共用同一口径）
  if (filter.building) shops = shops.filter((s) => String(s.building || "").trim() === String(filter.building).trim());
  if (filter.status) shops = shops.filter((s) => s.status === filter.status);
  // 1.18.0：装修中筛选对应商铺统计栏类目；1.19.0：「维修」为经营业态与维修工程进度的并集
  if (filter.work === "decoration") shops = shops.filter((s) => s.decoration_status === "doing");
  if (filter.work === "repair") shops = shops.filter((s) => s.repair_status === "doing");
  if (filter.repair) shops = shops.filter((s) => s.status === "maintenance" || s.repair_status === "doing");
  // 欠费筛选：只导出存在未收款账单的商铺（与前端「欠费」统计项一致）
  if (filter.arrears) {
    const owing = new Set(bills.filter((b) => b.status !== "paid" && num(b.total) > 0).map((b) => String(b.shop_id)));
    shops = shops.filter((s) => owing.has(String(s.id)));
  }

  const ids = new Set(shops.map((s) => s.id));
  const shopRows = shops.map((s) => [
    s.code || "", s.name || "", s.building || "", s.floor || "",
    r2(s.area), r2(shopUnitPrice(s)), r2(shopMonthlyRent(s)),
    SHOP_STATUS[s.status] || s.status || "",
    WORK_STATUS[s.decoration_status] || "未开始", r2(s.decoration_progress || 0),
    WORK_STATUS[s.repair_status] || "未开始", r2(s.repair_progress || 0),
    s.tenant || "", s.tenant_phone || "", s.lease_start || "", s.lease_end || "",
    r2(s.deposit), r2(s.water_price), r2(s.elec_price), s.remark || ""
  ]);

  const workRows = store.list("shop_progress_logs")
    .filter((l) => ids.has(l.shop_id))
    .sort((a, b) => String(a.log_date || "").localeCompare(String(b.log_date || "")) || (a.shop_id - b.shop_id))
    .map((l) => [
      (shopMap[l.shop_id] || {}).name || `#${l.shop_id}`, WORK_TYPE[l.type] || l.type || "",
      l.log_date || "", l.title || "", r2(l.progress || 0),
      WORK_STATUS[l.status] || l.status || "", l.content || "", l.operator || ""
    ]);

  const readRows = readings
    .filter((r) => ids.has(r.shop_id))
    .sort((a, b) => String(b.period).localeCompare(String(a.period)) || (a.shop_id - b.shop_id))
    .map((r) => [
      (shopMap[r.shop_id] || {}).name || `#${r.shop_id}`, r.period || "",
      r2(r.water_prev), r2(r.water_curr), r2(r.water_usage), r2(r.water_price), r2(r.water_fee),
      r2(r.elec_prev), r2(r.elec_curr), r2(r.elec_usage), r2(r.elec_price), r2(r.elec_fee),
      r.read_date || "", r.remark || ""
    ]);

  const billRows = bills
    .filter((b) => ids.has(b.shop_id))
    .sort((a, b) => String(b.period).localeCompare(String(a.period)) || (a.shop_id - b.shop_id))
    .map((b) => [
      (shopMap[b.shop_id] || {}).name || `#${b.shop_id}`, b.period || "",
      r2(b.rent_amount), r2(b.water_amount), r2(b.elec_amount), r2(b.other_amount), r2(b.total),
      b.status === "paid" ? "已收款" : "未收款", b.paid_date || "", b.remark || ""
    ]);

  return [
    {
      name: "商铺台账",
      columns: [
        C.id("编号"), C.text("商铺名称", 22), C.text("楼栋", 10), C.text("楼层", 8),
        C.num("面积(㎡)", 12), C.num("租金单价\n(元/㎡·月)", 15), C.num("月租金(元)", 14),
        C.text("状态", 9), C.text("装修状态", 10), C.num("装修进度(%)", 13),
        C.text("维修状态", 10), C.num("维修进度(%)", 13),
        C.text("租户", 22), C.text("联系电话", 14),
        C.date("租期起"), C.date("租期止"), C.num("押金(元)", 12),
        C.num("水价(元/吨)", 13), C.num("电价(元/度)", 13), C.text("备注", 28)
      ],
      rows: shopRows
    },
    {
      name: "装修维修进度",
      columns: [
        C.text("商铺", 20), C.text("类型", 8), C.date("日期"), C.text("节点标题", 24),
        C.num("进度(%)", 11), C.text("状态", 10), C.text("进度说明", 34), C.text("经办人", 14)
      ],
      rows: workRows
    },
    {
      name: "水电抄表",
      columns: [
        C.text("商铺", 20), C.text("账期", 9),
        C.num("上期水表", 11), C.num("本期水表", 11), C.num("用水量(吨)", 11),
        C.num("水价(元/吨)", 12), C.num("水费(元)", 12),
        C.num("上期电表", 11), C.num("本期电表", 11), C.num("用电量(度)", 11),
        C.num("电价(元/度)", 12), C.num("电费(元)", 12),
        C.date("抄表日期"), C.text("备注", 22)
      ],
      rows: readRows
    },
    {
      name: "商铺账单",
      columns: [
        C.text("商铺", 20), C.text("账期", 9),
        C.num("租金(元)"), C.num("水费(元)"), C.num("电费(元)"), C.num("其他(元)"),
        C.num("合计(元)", 14), C.text("收款状态", 10), C.date("收款日期"), C.text("备注", 22)
      ],
      rows: billRows
    }
  ];
}

/* ---------------- 1.26.0 楼栋汇总 ----------------
 * 与前端「楼栋管理」卡片同源：商铺数 / 状态分布 / 面积 / 月租金 / 欠费 / 出租率
 * 全部由 shops、bills 实时聚合，不存冗余统计字段。
 */
const BUILDING_STATUS_EXPORT = { active: "启用", inactive: "停用" };
function sheetBuildings(store, filter) {
  const shops = store.list("shops");
  const bills = store.list("bills");
  const unpaidOf = (sid) => bills
    .filter((b) => Number(b.shop_id) === Number(sid) && b.status !== "paid")
    .reduce((n, b) => n + num(b.total), 0);
  let rows = sortBy(store.list("buildings"), (b) => b.code || b.name);
  const only = String((filter && filter.building) || "").trim();
  if (only) rows = rows.filter((b) => String(b.name || "").trim() === only);
  const data = rows.map((b) => {
    const name = String(b.name || "").trim();
    const list = shops.filter((s) => String(s.building || "").trim() === name);
    const rented = list.filter((s) => s.status === "rented").length;
    return [
      b.code || "", name, b.floors || "", r2(b.area || 0),
      list.length, rented,
      list.filter((s) => s.status === "vacant").length,
      list.filter((s) => s.status === "maintenance").length,
      list.filter((s) => s.decoration_status === "doing").length,
      list.filter((s) => s.repair_status === "doing").length,
      r2(list.reduce((n, s) => n + num(s.area), 0)),
      r2(list.reduce((n, s) => n + shopMonthlyRent(s), 0)),
      r2(list.reduce((n, s) => n + unpaidOf(s.id), 0)),
      list.length ? Math.round(rented / list.length * 100) : 0,
      b.manager || "", b.phone || "", b.built_year || "",
      BUILDING_STATUS_EXPORT[b.status] || "启用", b.remark || ""
    ];
  });
  return [{
    name: "楼栋汇总",
    columns: [
      C.text("楼栋编号", 12), C.text("楼栋名称", 16), C.text("楼层 / 层数", 16),
      C.num("登记面积(㎡)", 14), C.num("商铺数", 9), C.num("在租", 9),
      C.num("空置", 9), C.num("维修", 9), C.num("装修中", 10), C.num("维修中", 10),
      C.num("商铺总面积(㎡)", 16), C.num("月租金合计(元)", 16), C.num("累计欠费(元)", 16),
      C.num("出租率(%)", 12), C.text("负责人", 12), C.text("联系电话", 15),
      C.text("建成年份", 11), C.text("状态", 9), C.text("备注", 28)
    ],
    rows: data
  }];
}

function sheetEquipments(store, filter) {
  const logs = store.list("equipment_logs");
  const costByEq = {};
  logs.forEach((l) => { costByEq[l.equipment_id] = (costByEq[l.equipment_id] || 0) + num(l.cost); });

  let eqs = sortBy(store.list("equipments"), (e) => e.code || e.name);
  if (filter.id) eqs = eqs.filter((e) => e.id === Number(filter.id));
  if (filter.cat) eqs = eqs.filter((e) => e.category === filter.cat);
  if (filter.status) eqs = eqs.filter((e) => e.status === filter.status);
  if (filter.maintain) eqs = eqs.filter((e) => eqMaintainInfo(e, filter).key === filter.maintain);

  const ids = new Set(eqs.map((e) => e.id));
  const eqRows = eqs.map((e) => [
    e.code || "", e.name || "", CAT_LABEL[e.category] || "其他",
    e.location || "", e.location_type === "shop" ? "商铺内" : "公共区域",
    e.brand || "", e.model || "", e.install_date || "", e.warranty_end || "",
    EQ_STATUS[e.status] || e.status || "", eqMaintainInfo(e, filter).label, e.next_maintain || "",
    (logs.filter((l) => l.equipment_id === e.id).length),
    r2(costByEq[e.id]), e.remark || ""
  ]);

  const eqMap = byKey(store.list("equipments"));
  const logRows = logs
    .filter((l) => ids.has(l.equipment_id))
    .sort((a, b) => String(b.log_date).localeCompare(String(a.log_date)))
    .map((l) => [
      (eqMap[l.equipment_id] || {}).name || `#${l.equipment_id}`,
      (eqMap[l.equipment_id] || {}).code || "",
      CAT_LABEL[(eqMap[l.equipment_id] || {}).category] || "",
      EQ_LOG_TYPE[l.type] || l.type || "", l.log_date || "",
      MAINTAIN_LABEL[String(l.maintain_status || "done")] || "已完成",
      l.content || "", r2(l.cost), l.operator || "", l.next_maintain || ""
    ]);

  return [
    {
      name: "设备台账",
      columns: [
        C.id("设备编号"), C.text("设备名称", 20), C.text("分类", 11),
        C.text("安装位置", 18), C.text("位置类型", 10), C.text("品牌", 12), C.text("型号", 16),
        C.date("安装日期"), C.date("保修截止"), C.text("状态", 9), C.text("保养状态", 11),
        C.date("下次保养"), C.int("维保次数", 10), C.num("累计维保(元)", 14), C.text("备注", 24)
      ],
      rows: eqRows
    },
    {
      name: "维保记录",
      columns: [
        C.text("设备", 20), C.id("设备编号"), C.text("分类", 11), C.text("类型", 9),
        C.date("日期"), C.text("保养状态", 11), C.text("内容", 44),
        C.num("费用(元)"), C.text("经办人", 12), C.date("下次保养")
      ],
      rows: logRows
    }
  ];
}

function sheetContracts(store, filter) {
  const contracts = sortBy(store.list("contracts"), (c) => c.contract_no || c.name);
  const plans = store.list("payment_plans");
  const payments = store.list("payments");
  const logs = store.list("progress_logs");
  const shops = byKey(store.list("shops"));

  let list = contracts;
  if (filter.id) list = list.filter((c) => c.id === Number(filter.id));
  if (filter.status) list = list.filter((c) => c.status === filter.status);
  const ids = new Set(list.map((c) => c.id));

  const contractRows = list.map((c) => {
    const ps = plans.filter((p) => p.contract_id === c.id);
    const paid = ps.filter((p) => p.status === "paid")
      .reduce((s, p) => s + num(p.paid_amount || p.amount), 0);
    return [
      c.contract_no || "", c.name || "", c.contractor || "", c.contact || "", c.phone || "",
      CONTRACT_CAT[c.category] || c.category || "",
      c.shop_id && shops[c.shop_id] ? shops[c.shop_id].name : "",
      c.sign_date || "", c.start_date || "", c.end_date || "",
      r2(c.amount), r2(c.retention_rate), num(c.progress),
      CONTRACT_STATUS[c.status] || c.status || "",
      r2(ps.reduce((s, p) => s + num(p.amount), 0)), r2(paid),
      r2(Math.max(0, num(c.amount) - paid)), ps.length, c.remark || ""
    ];
  });

  const cMap = byKey(store.list("contracts"));
  const cName = (id) => (cMap[id] || {}).name || `#${id}`;
  const cNo = (id) => (cMap[id] || {}).contract_no || "";

  const planRows = plans
    .filter((p) => ids.has(p.contract_id))
    .sort((a, b) => (a.contract_id - b.contract_id) || (a.seq - b.seq))
    .map((p) => {
      const overdue = p.status !== "paid" && p.due_date && p.due_date < todayStr();
      return [
        cName(p.contract_id), cNo(p.contract_id), num(p.seq), p.name || "",
        (TRIGGER[p.trigger_type] || p.trigger_type || "") + (p.trigger_value ? `（${p.trigger_value}%）` : ""),
        r2(p.ratio), r2(p.amount), p.due_date || "",
        PLAN_STATUS[p.status] || p.status || "",
        r2(p.paid_amount), p.paid_date || "",
        overdue ? Math.max(0, Math.round((new Date(todayStr()) - new Date(p.due_date)) / 86400000)) : 0,
        p.remark || ""
      ];
    });

  const payRows = payments
    .filter((x) => ids.has(x.contract_id))
    .sort((a, b) => String(b.pay_date).localeCompare(String(a.pay_date)))
    .map((x) => {
      const plan = plans.find((p) => p.id === x.plan_id);
      return [
        cName(x.contract_id), cNo(x.contract_id), plan ? plan.name : "",
        r2(x.amount), x.pay_date || "", x.method || "", x.voucher_no || "",
        x.operator || "", x.remark || ""
      ];
    });

  const logRows = logs
    .filter((l) => ids.has(l.contract_id))
    .sort((a, b) => String(a.log_date).localeCompare(String(b.log_date)))
    .map((l) => [cName(l.contract_id), l.log_date || "", l.title || "", num(l.progress), l.content || "", l.operator || ""]);

  return [
    {
      name: "合同台账",
      columns: [
        C.text("合同编号", 15), C.text("合同名称", 26), C.text("施工单位", 26),
        C.text("联系人", 9), C.text("电话", 14), C.text("类别", 8), C.text("关联商铺", 16),
        C.date("签订日期"), C.date("开工日期"), C.date("竣工日期"),
        C.num("合同金额(元)", 15), C.num("质保金(%)", 11), C.int("进度(%)", 9),
        C.text("状态", 9), C.num("计划付款(元)", 14), C.num("已付(元)", 14),
        C.num("未付(元)", 14), C.int("节点数", 8), C.text("备注", 30)
      ],
      rows: contractRows
    },
    {
      name: "付款计划",
      columns: [
        C.text("合同", 26), C.text("合同编号", 15), C.int("期次", 7), C.text("付款节点", 20),
        C.text("触发条件", 16), C.num("比例(%)", 10), C.num("计划金额(元)", 14),
        C.date("应付日期"), C.text("状态", 9), C.num("实付金额(元)", 14),
        C.date("付款日期"), C.int("逾期天数", 9), C.text("备注", 22)
      ],
      rows: planRows
    },
    {
      name: "付款流水",
      columns: [
        C.text("合同", 26), C.text("合同编号", 15), C.text("关联节点", 20),
        C.num("付款金额(元)", 14), C.date("付款日期"), C.text("方式", 10),
        C.text("凭证号", 18), C.text("经办人", 12), C.text("备注", 24)
      ],
      rows: payRows
    },
    {
      name: "施工进度",
      columns: [
        C.text("合同", 26), C.date("记录日期"), C.text("进度节点", 22),
        C.int("进度(%)", 9), C.text("说明", 46), C.text("记录人", 12)
      ],
      rows: logRows
    }
  ];
}

function sheetPayments(store, filter) {
  const plans = store.list("payment_plans");
  const payments = store.list("payments");
  const cMap = byKey(store.list("contracts"));

  let list = plans.slice().sort((a, b) => {
    const d = String(a.due_date || "9999").localeCompare(String(b.due_date || "9999"));
    return d || (a.contract_id - b.contract_id);
  });
  if (filter.status) list = list.filter((p) => p.status === filter.status);
  if (filter.overdue) list = list.filter((p) => p.status !== "paid" && p.due_date && p.due_date < todayStr());
  if (filter.id) list = list.filter((p) => p.contract_id === Number(filter.id));

  const rows = list.map((p) => {
    const c = cMap[p.contract_id] || {};
    const overdue = p.status !== "paid" && p.due_date && p.due_date < todayStr();
    return [
      c.name || `#${p.contract_id}`, c.contract_no || "", c.contractor || "",
      num(p.seq), p.name || "",
      (TRIGGER[p.trigger_type] || p.trigger_type || "") + (p.trigger_value ? `（${p.trigger_value}%）` : ""),
      r2(p.ratio), r2(p.amount), p.due_date || "",
      PLAN_STATUS[p.status] || p.status || "",
      r2(p.paid_amount), p.paid_date || "",
      overdue ? Math.max(0, Math.round((new Date(todayStr()) - new Date(p.due_date)) / 86400000)) : 0
    ];
  });

  const ids = new Set(list.map((p) => p.contract_id));
  const payRows = payments
    .filter((x) => ids.has(x.contract_id))
    .sort((a, b) => String(b.pay_date).localeCompare(String(a.pay_date)))
    .map((x) => {
      const p = plans.find((q) => q.id === x.plan_id);
      const c = cMap[x.contract_id] || {};
      return [
        c.name || "", c.contract_no || "", p ? p.name : "",
        r2(x.amount), x.pay_date || "", x.method || "", x.voucher_no || "", x.operator || "", x.remark || ""
      ];
    });

  return [
    {
      name: "付款节点",
      columns: [
        C.text("合同", 26), C.text("合同编号", 15), C.text("施工单位", 24),
        C.int("期次", 7), C.text("付款节点", 20), C.text("触发条件", 16),
        C.num("比例(%)", 10), C.num("计划金额(元)", 14), C.date("应付日期"),
        C.text("状态", 9), C.num("实付金额(元)", 14), C.date("付款日期"), C.int("逾期天数", 9)
      ],
      rows
    },
    {
      name: "付款流水",
      columns: [
        C.text("合同", 26), C.text("合同编号", 15), C.text("关联节点", 20),
        C.num("付款金额(元)", 14), C.date("付款日期"), C.text("方式", 10),
        C.text("凭证号", 18), C.text("经办人", 12), C.text("备注", 24)
      ],
      rows: payRows
    }
  ];
}

function calcSummary(store) {
  const shops = store.list("shops");
  const eqs = store.list("equipments");
  const contracts = store.list("contracts");
  const plans = store.list("payment_plans");
  const today = todayStr();

  const rented = shops.filter((s) => s.status === "rented");
  const monthlyRent = rented.reduce((s, x) => s + num(x.area) * num(x.rent_price), 0);
  const totalArea = shops.reduce((s, x) => s + num(x.area), 0);

  const amountTotal = contracts.reduce((s, c) => s + num(c.amount), 0);
  const paid = plans.filter((p) => p.status === "paid").reduce((s, p) => s + num(p.paid_amount || p.amount), 0);
  const unpaid = plans.filter((p) => p.status !== "paid").reduce((s, p) => s + num(p.amount), 0);
  const overdue = plans.filter((p) => p.status !== "paid" && p.due_date && p.due_date < today);

  return { shops, eqs, contracts, plans, rented, monthlyRent, totalArea, amountTotal, paid, unpaid, overdue, today };
}

function sheetSummary(store) {
  const s = calcSummary(store);
  const archives = store.list("archives");
  const whItems = store.list("warehouse_items");
  const lowItems = whItems.filter((i) => i.status !== "stopped" && num(i.quantity) <= num(i.min_stock));

  const kpiRows = [
    ["商铺总数", s.shops.length, "间"],
    ["在租商铺", s.rented.length, "间"],
    ["空置商铺", s.shops.filter((x) => x.status === "vacant").length, "间"],
    ["维修中商铺", s.shops.filter((x) => x.status === "maintenance").length, "间"],
    ["商铺出租率", s.shops.length ? r2(s.rented.length / s.shops.length * 100) : 0, "%"],
    ["可租面积", r2(s.totalArea), "㎡"],
    ["在租月租金", r2(s.monthlyRent), "元/月"],
    ["设备总数", s.eqs.length, "台"],
    ["设备正常", s.eqs.filter((e) => e.status === "normal").length, "台"],
    ["设备维修中", s.eqs.filter((e) => e.status === "repair").length, "台"],
    ["设备停用", s.eqs.filter((e) => e.status === "stopped").length, "台"],
    ["设备待保养", s.eqs.filter((e) => e.next_maintain && e.next_maintain <= s.today).length, "台"],
    ["设备完好率", s.eqs.length ? r2((s.eqs.length - s.eqs.filter((e) => e.status !== "normal").length) / s.eqs.length * 100) : 0, "%"],
    ["工程合同数量", s.contracts.length, "份"],
    ["在建合同", s.contracts.filter((c) => c.status === "ongoing").length, "份"],
    ["合同总额", r2(s.amountTotal), "元"],
    ["已付款合计", r2(s.paid), "元"],
    ["未付款合计", r2(s.unpaid), "元"],
    ["付款完成度", s.amountTotal ? r2(s.paid / s.amountTotal * 100) : 0, "%"],
    ["逾期付款节点", s.overdue.length, "笔"],
    ["逾期金额", r2(s.overdue.reduce((a, p) => a + num(p.amount), 0)), "元"],
    ["装修中商铺", s.shops.filter((x) => x.decoration_status === "doing").length, "间"],
    ["维修处理中商铺", s.shops.filter((x) => x.repair_status === "doing").length, "间"],
    ["档案总数", archives.length, "卷"],
    ["档案借出", archives.filter((a) => a.status === "borrowed").length, "卷"],
    ["仓库物料种类", whItems.length, "项"],
    ["低库存物料", lowItems.length, "项"],
    ["库存总金额", r2(whItems.reduce((n, i) => n + num(i.quantity) * num(i.unit_price), 0)), "元"]
  ];

  const eqRows = CATEGORIES.map((c) => {
    const list = s.eqs.filter((e) => e.category === c.k);
    return [
      c.n, list.length,
      list.filter((e) => e.status === "normal").length,
      list.filter((e) => e.status === "repair").length,
      list.filter((e) => e.status === "stopped").length,
      s.eqs.length ? r2(list.length / s.eqs.length * 100) : 0
    ];
  });

  const buildings = {};
  s.shops.forEach((x) => {
    const b = x.building || "未标注";
    if (!buildings[b]) buildings[b] = { all: 0, rented: 0, area: 0, rent: 0 };
    buildings[b].all++;
    buildings[b].area += num(x.area);
    if (x.status === "rented") {
      buildings[b].rented++;
      buildings[b].rent += num(x.area) * num(x.rent_price);
    }
  });
  const bRows = Object.keys(buildings).sort().map((b) => {
    const x = buildings[b];
    return [b, x.all, x.rented, r2(x.area), r2(x.rent)];
  });

  return [
    {
      name: "经营汇总",
      columns: [C.text("指标", 24), C.num("数值", 16), C.text("单位", 10)],
      rows: kpiRows
    },
    {
      name: "设备分类统计",
      columns: [
        C.text("设备分类", 16), C.int("数量", 10), C.int("正常", 10),
        C.int("维修中", 10), C.int("停用", 10), C.num("占比(%)", 10)
      ],
      rows: eqRows
    },
    {
      name: "楼栋租金",
      columns: [C.text("楼栋", 16), C.int("商铺数", 10), C.int("在租数", 10), C.num("面积(㎡)"), C.num("月租金(元)", 15)],
      rows: bRows
    }
  ];
}

/* ---------------- 1.18.0：档案台账 ---------------- */
function sheetArchives(store, filter) {
  let list = sortBy(store.list("archives"), (a) => a.code || a.title);
  if (filter.id) list = list.filter((a) => a.id === Number(filter.id));
  if (filter.cat) list = list.filter((a) => a.category === filter.cat);
  if (filter.status) list = list.filter((a) => a.status === filter.status);
  const ids = new Set(list.map((a) => a.id));
  const archiveMap = byKey(store.list("archives"));

  const rows = list.map((a) => [
    a.code || "", a.title || "", ARCHIVE_CAT[a.category] || a.category || "",
    a.entity || "", a.entity_id || "", a.archive_date || "", a.expiry || "",
    a.keeper || "", a.location || "", ARCHIVE_SECURITY[a.security] || "普通",
    ARCHIVE_STATUS[a.status] || a.status || "", r2(a.qty || 0), a.remark || ""
  ]);
  const logRows = store.list("archive_logs")
    .filter((l) => ids.has(l.archive_id))
    .sort((a, b) => String(a.log_date || "").localeCompare(String(b.log_date || "")) || (a.archive_id - b.archive_id))
    .map((l) => [
      (archiveMap[l.archive_id] || {}).title || `#${l.archive_id}`,
      l.log_date || "", ARCHIVE_LOG_TYPE[l.type] || l.type || "",
      l.person || "", l.due_date || "", l.purpose || "", l.remark || ""
    ]);
  return [
    {
      name: "档案台账",
      columns: [
        C.id("档案编号"), C.text("档案题名", 30), C.text("分类", 12),
        C.text("关联类型", 12), C.num("关联ID", 10), C.date("归档日期"), C.date("有效期"),
        C.text("保管人", 14), C.text("存放位置", 16), C.text("密级", 9),
        C.text("状态", 9), C.num("份数", 9), C.text("备注", 26)
      ],
      rows
    },
    {
      name: "档案借阅记录",
      columns: [
        C.text("档案题名", 30), C.date("日期"), C.text("类型", 9),
        C.text("借阅/归还人", 16), C.date("应还日期"), C.text("用途", 28), C.text("备注", 22)
      ],
      rows: logRows
    }
  ];
}

/* ---------------- 1.18.0：仓库物料 ---------------- */
function sheetWarehouse(store, filter) {
  let list = sortBy(store.list("warehouse_items"), (i) => i.code || i.name);
  if (filter.id) list = list.filter((i) => i.id === Number(filter.id));
  if (filter.cat) list = list.filter((i) => i.category === filter.cat);
  if (filter.low) list = list.filter((i) => i.status !== "stopped" && num(i.quantity) <= num(i.min_stock));
  const ids = new Set(list.map((i) => i.id));
  const itemMap = byKey(store.list("warehouse_items"));

  const rows = list.map((i) => [
    i.code || "", i.name || "", WH_CAT[i.category] || i.category || "", i.spec || "", i.unit || "",
    r2(i.opening), r2(i.quantity), r2(i.min_stock), r2(i.max_stock),
    r2(i.unit_price), r2(num(i.quantity) * num(i.unit_price)),
    num(i.quantity) <= num(i.min_stock) && i.status !== "stopped" ? "低库存" : "正常",
    WH_ITEM_STATUS[i.status] || i.status || "",
    i.location || "", i.supplier || "", i.remark || ""
  ]);
  const recRows = store.list("warehouse_records")
    .filter((r) => ids.has(r.item_id))
    .sort((a, b) => String(a.log_date || "").localeCompare(String(b.log_date || "")) || (a.item_id - b.item_id))
    .map((r) => [
      (itemMap[r.item_id] || {}).name || `#${r.item_id}`,
      r.log_date || "", WH_RECORD_TYPE[r.type] || r.type || "",
      r2(r.quantity), r2(r.unit_price), r2(r.amount), r2(r.balance),
      r.person || "", r.purpose || "", r.remark || ""
    ]);
  return [
    {
      name: "仓库物料台账",
      columns: [
        C.id("物料编号"), C.text("物料名称", 24), C.text("分类", 11), C.text("规格型号", 18), C.text("单位", 8),
        C.num("期初库存", 11), C.num("当前结存", 11), C.num("安全库存", 11), C.num("库存上限", 11),
        C.num("单价(元)", 11), C.num("库存金额(元)", 14),
        C.text("库存预警", 10), C.text("状态", 9), C.text("库位", 13), C.text("供应商", 18), C.text("备注", 22)
      ],
      rows
    },
    {
      name: "出入库流水",
      columns: [
        C.text("物料", 24), C.date("日期"), C.text("类型", 10),
        C.num("数量", 11), C.num("单价(元)", 11), C.num("金额(元)", 12), C.num("结存", 11),
        C.text("经办人", 14), C.text("用途 / 关联事项", 26), C.text("备注", 20)
      ],
      rows: recRows
    }
  ];
}

/* ---------------- 入口 ---------------- */
/** 1.22.0：抽出「按模块收集工作表」，Excel 下载与在线预览共用同一份筛选口径 */
function collectSheets(store, key, f) {
  switch (key) {
    case "shops": return sheetShops(store, f).concat(sheetBuildings(store, f));
    case "equipments": return sheetEquipments(store, f);
    case "contracts": return sheetContracts(store, f);
    case "payments": return sheetPayments(store, f);
    case "archives": return sheetArchives(store, f);
    case "warehouse": return sheetWarehouse(store, f);
    case "overview":
    case "dashboard":
    case "summary": return sheetSummary(store);
    case "all":
      return []
        .concat(sheetShops(store, f))
        .concat(sheetBuildings(store, f))
        .concat(sheetEquipments(store, f))
        .concat(sheetContracts(store, f))
        // 付款台账模块只取「付款节点」，付款流水已在合同模块导出，避免同名工作表
        .concat(sheetPayments(store, f).slice(0, 1))
        .concat(sheetArchives(store, {}))
        .concat(sheetWarehouse(store, {}))
        .concat(sheetSummary(store));
    default: throw new Error("不支持的导出模块：" + key);
  }
}

/**
 * 1.22.0：导出前的表格预览数据（不生成 xlsx 二进制）
 * 返回结构与附件表格预览一致：sheets: [{ name, columns, rows, totalRows, truncated }]
 */
function previewSheets(store, moduleName, filter, limit) {
  const key = String(moduleName || "all").toLowerCase();
  const f = filter || {};
  const max = Math.min(500, Math.max(1, Number(limit) || 200));
  const sheets = collectSheets(store, key, f).map((s) => {
    const columns = (s.columns || []).map((c) => (typeof c === "string" ? c : String((c && c.h) || "")));
    const all = s.rows || [];
    return {
      name: s.name || "工作表",
      columns,
      rows: all.slice(0, max).map((r) => (r || []).map((v) => (v === null || v === undefined ? "" : String(v)))),
      totalRows: all.length,
      truncated: all.length > max
    };
  });
  const meta = MODULES[key] || MODULES.all;
  return { module: key, label: meta.label || "全部台账", title: meta.title || "台账", sheets };
}

function buildWorkbook(store, moduleName, filter) {
  const key = String(moduleName || "all").toLowerCase();
  const f = filter || {};
  const sheets = collectSheets(store, key, f);
  const meta = MODULES[key] || MODULES.all;
  const buf = xlsx.build(sheets, { creator: "物业工程管理" });
  const stamp = todayStr().replace(/-/g, "");

  // 单条记录导出：文件名带上记录名称，便于归档
  let record = "";
  if (f.id) {
    const table = {
      shops: "shops", equipments: "equipments", contracts: "contracts",
      archives: "archives", warehouse: "warehouse_items"
    }[key];
    const row = table ? store.get(table, f.id) : null;
    if (row && row.name) record = "-" + String(row.name).replace(/[\\/:*?"<>|]/g, "").slice(0, 20);
  }

  const suffix = key === "all" ? "" : "-" + (meta.label || "");
  return {
    buffer: buf,
    filename: `物业工程管理${suffix}${record}-${stamp}.xlsx`,
    sheetCount: sheets.length,
    module: key
  };
}

module.exports = { buildWorkbook, previewSheets, CATEGORIES, CAT_LABEL };
