/**
 * 物业工程管理 - fnOS 应用后端
 *
 * 运行时：fnOS 内置 Node.js 22（install_dep_apps=nodejs_v22）
 * 数据库：SQLite（node:sqlite，无外部依赖）；不支持时自动降级为 JSON 文件存储
 * 访问：① 统一网关 /app/pmops → 转发到 ${TRIM_APPDEST}/app.sock（飞牛桌面入口）
 *       ② 内网直连 http://<NAS 内网IP>:3340 （手机 / 平板 / 其他电脑，可加书签）
 *       LAN_PORT=0 可关闭内网直连，LAN_PORT 可自定义端口
 *
 * 数据模型参照绿云 iHotel 的「产品-订单-账务」主线：
 *   商铺(room) → 抄表/账单(folio) ；合同(order) → 付款计划+付款记录(payment) → 施工进度(task)
 */
"use strict";

const http = require("http");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const zlib = require("zlib");
const path = require("path");
const exporter = require("./export");

// ---------------- 配置 ----------------
const APP_NAME = "pmops";
const GATEWAY_PREFIX = process.env.GATEWAY_PREFIX || "/app/pmops";
const SOCKET_PATH = process.env.SOCKET_PATH || "";
const PORT = Number(process.env.PORT || 5101);
// 局域网直连端口：以 http://<NAS 内网IP>:3340 访问，无需经过桌面/网关
// 设为 0 可关闭（例如端口冲突或不允许内网访问的场景）
const LAN_PORT = Number(process.env.LAN_PORT === undefined ? 3340 : process.env.LAN_PORT);
const LAN_HOST = process.env.LAN_HOST || "0.0.0.0";
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const WWW_DIR = process.env.WWW_DIR || path.join(__dirname, "..", "www");
const MAX_BODY = 10 * 1024 * 1024;

const pad2 = (n) => String(n).padStart(2, "0");
/** 本地时区时间戳 YYYY-MM-DDTHH:mm:ss。
 *  旧版用 toISOString()（UTC），前端直接截取显示会比北京时间慢 8 小时，现统一存本地时间 */
const localStamp = (d) => {
  d = d || new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
};

const APP_VERSION = "1.26.0";
const BUILD_DATE = "2026-11-10";
const DEVELOPER = "无冰咖啡糖";
const STARTED_AT = localStamp();

fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------------- 应用设置 ----------------
// 统一存在 app_meta 的 settings 键下（JSON），无需额外建表
const SETTINGS_KEY = "settings";
const SETTINGS_MIGRATE_KEY = "settings_migrated_1_16";
const LEGACY_ORG_NAME = "广州君尧物业管理有限公司"; // 1.16.0 之前预填的公司名，升级后自动清空
// 1.17.0：概览与可视化面板合并，唯一入口为 dashboard「可视化驾驶舱」
const VIEW_KEYS = ["dashboard", "shops", "equipments", "contracts", "payments", "archives", "warehouse", "users", "audit"];
const VIEW_ALIAS = { overview: "dashboard", cockpit: "dashboard" };
/** 旧库里保存的 default_view=overview 自动归一，用户无需手动改设置 */
function normalizeViewKey(v) {
  const raw = String(v == null ? "" : v).trim();
  const key = VIEW_ALIAS[raw] || raw;
  return VIEW_KEYS.includes(key) ? key : "dashboard";
}
const DEFAULT_SETTINGS = {
  // 1.16.0：项目信息全部空白出厂，由使用者自行填写，不再预置任何单位名称
  org_name: "",
  project_name: "",
  manager: "",
  phone: "",
  address: "",
  water_price: 4.2,          // 新商铺默认水费单价（元/吨）
  elec_price: 1.05,          // 新商铺默认电费单价（元/度）
  pay_remind_days: 7,        // 付款节点提前几天置为「待支付」
  maintain_remind_days: 15,  // 设备保养提前几天预警
  default_view: "dashboard", // 首次进入 / 登录后的默认模块：可视化驾驶舱
  default_mode: "list",      // 首次进入的默认显示模式
  // 1.24.0：OnlyOffice Document Server 在线预览（未启用时完全走内置预览，零外部依赖）
  oo_enabled: "0",           // "1" 启用；留空 / "0" 均视为关闭
  oo_server: "",             // Document Server 根地址，如 http://192.168.1.10:8080
  oo_jwt_secret: "",         // 可选：DocServer 启用 JWT 时填写，仅存服务端、不下发前端
  oo_public_url: ""          // 可选：本应用对外根地址，供 DocServer 反向拉取附件原文件
};

// ---------------- 表结构定义 ----------------
// 所有可写字段都在这里声明，接口层据此做白名单过滤与类型转换
const SCHEMA = {
  // 1.26.0：楼栋台账（商铺管理模块内维护）。name 即商铺 building 的关联键，
  // 改名时同步商铺、删除时校验引用，避免楼栋与商铺数据脱节。
  buildings: {
    label: "楼栋",
    fields: {
      code: "TEXT", name: "TEXT", floors: "TEXT", area: "REAL",
      manager: "TEXT", phone: "TEXT", built_year: "TEXT",
      status: "TEXT", remark: "TEXT", created_at: "TEXT"
    },
    numeric: ["area"],
    required: ["name"]
  },
  shops: {
    label: "商铺",
    fields: {
      code: "TEXT", name: "TEXT", building: "TEXT", floor: "TEXT",
      area: "REAL", rent_price: "REAL", rent_total: "REAL", status: "TEXT",
      tenant: "TEXT", tenant_phone: "TEXT", lease_start: "TEXT", lease_end: "TEXT",
      deposit: "REAL", water_price: "REAL", elec_price: "REAL",
      // 1.18.0：装修 / 维修状态与进度（进度由 shop_progress_logs 最新一条回算）
      decoration_status: "TEXT", decoration_progress: "INTEGER",
      repair_status: "TEXT", repair_progress: "INTEGER",
      remark: "TEXT", created_at: "TEXT"
    },
    numeric: ["area", "rent_price", "rent_total", "deposit", "water_price", "elec_price",
      "decoration_progress", "repair_progress"],
    required: ["name"]
  },
  // 1.18.0：商铺装修 / 维修进度记录，逐条可编辑；最新一条同步到商铺状态与进度
  shop_progress_logs: {
    label: "商铺装修/维修进度",
    fields: {
      shop_id: "INTEGER", type: "TEXT", log_date: "TEXT", title: "TEXT",
      progress: "INTEGER", status: "TEXT", content: "TEXT",
      operator: "TEXT", created_at: "TEXT"
    },
    numeric: ["shop_id", "progress"],
    required: ["shop_id"]
  },
  // 1.18.0：档案台账（合同 / 图纸 / 证照 / 验收资料等）
  archives: {
    label: "档案",
    fields: {
      code: "TEXT", title: "TEXT", category: "TEXT", entity: "TEXT", entity_id: "INTEGER",
      archive_date: "TEXT", keeper: "TEXT", location: "TEXT", security: "TEXT",
      status: "TEXT", expiry: "TEXT", qty: "REAL", remark: "TEXT", created_at: "TEXT"
    },
    numeric: ["entity_id", "qty"],
    required: ["title", "category"]
  },
  // 借阅 / 归还流水；最新一条决定档案状态
  archive_logs: {
    label: "档案借阅记录",
    fields: {
      archive_id: "INTEGER", type: "TEXT", person: "TEXT", log_date: "TEXT",
      due_date: "TEXT", purpose: "TEXT", remark: "TEXT", created_at: "TEXT"
    },
    numeric: ["archive_id"],
    required: ["archive_id"]
  },
  // 1.18.0：仓库物料；quantity 由 opening + 出入库流水回算
  warehouse_items: {
    label: "仓库物料",
    fields: {
      code: "TEXT", name: "TEXT", category: "TEXT", spec: "TEXT", unit: "TEXT",
      quantity: "REAL", opening: "REAL", min_stock: "REAL", max_stock: "REAL",
      unit_price: "REAL", location: "TEXT", supplier: "TEXT", status: "TEXT",
      remark: "TEXT", created_at: "TEXT"
    },
    numeric: ["quantity", "opening", "min_stock", "max_stock", "unit_price"],
    required: ["name"]
  },
  // 出入库 / 盘点流水；删除或编辑后按流水重算结存
  warehouse_records: {
    label: "出入库流水",
    fields: {
      item_id: "INTEGER", type: "TEXT", quantity: "REAL", unit_price: "REAL",
      amount: "REAL", balance: "REAL", log_date: "TEXT", person: "TEXT",
      related: "TEXT", purpose: "TEXT", remark: "TEXT", created_at: "TEXT"
    },
    numeric: ["item_id", "quantity", "unit_price", "amount", "balance"],
    required: ["item_id"]
  },
  readings: {
    label: "水电抄表",
    fields: {
      shop_id: "INTEGER", period: "TEXT",
      water_prev: "REAL", water_curr: "REAL",
      elec_prev: "REAL", elec_curr: "REAL",
      water_price: "REAL", elec_price: "REAL",
      water_usage: "REAL", elec_usage: "REAL",
      water_fee: "REAL", elec_fee: "REAL",
      read_date: "TEXT", remark: "TEXT", created_at: "TEXT"
    },
    numeric: ["shop_id", "water_prev", "water_curr", "elec_prev", "elec_curr",
      "water_price", "elec_price", "water_usage", "elec_usage", "water_fee", "elec_fee"],
    required: ["shop_id", "period"]
  },
  bills: {
    label: "商铺账单",
    fields: {
      shop_id: "INTEGER", period: "TEXT",
      rent_amount: "REAL", water_amount: "REAL", elec_amount: "REAL",
      other_amount: "REAL", total: "REAL",
      status: "TEXT", paid_date: "TEXT", remark: "TEXT", created_at: "TEXT"
    },
    numeric: ["shop_id", "rent_amount", "water_amount", "elec_amount", "other_amount", "total"],
    required: ["shop_id", "period"]
  },
  equipments: {
    label: "设备",
    fields: {
      code: "TEXT", name: "TEXT", category: "TEXT",
      location_type: "TEXT", shop_id: "INTEGER", location: "TEXT",
      brand: "TEXT", model: "TEXT", install_date: "TEXT", warranty_end: "TEXT",
      status: "TEXT", next_maintain: "TEXT", maintain_status: "TEXT",
      remark: "TEXT", created_at: "TEXT"
    },
    numeric: ["shop_id"],
    required: ["name", "category"]
  },
  equipment_logs: {
    label: "设备记录",
    fields: {
      equipment_id: "INTEGER", type: "TEXT", log_date: "TEXT",
      content: "TEXT", cost: "REAL", operator: "TEXT",
      maintain_status: "TEXT", next_maintain: "TEXT", created_at: "TEXT"
    },
    numeric: ["equipment_id", "cost"],
    required: ["equipment_id"]
  },
  contracts: {
    label: "工程合同",
    fields: {
      contract_no: "TEXT", name: "TEXT", contractor: "TEXT", contact: "TEXT", phone: "TEXT",
      category: "TEXT", shop_id: "INTEGER",
      sign_date: "TEXT", start_date: "TEXT", end_date: "TEXT",
      amount: "REAL", retention_rate: "REAL", progress: "INTEGER",
      status: "TEXT", remark: "TEXT", created_at: "TEXT"
    },
    numeric: ["shop_id", "amount", "retention_rate", "progress"],
    required: ["name", "contractor", "amount"]
  },
  payment_plans: {
    label: "付款计划",
    fields: {
      contract_id: "INTEGER", seq: "INTEGER", name: "TEXT",
      trigger_type: "TEXT", trigger_value: "TEXT",
      ratio: "REAL", amount: "REAL", due_date: "TEXT",
      status: "TEXT", paid_date: "TEXT", paid_amount: "REAL",
      remark: "TEXT", created_at: "TEXT"
    },
    numeric: ["contract_id", "seq", "ratio", "amount", "paid_amount"],
    required: ["contract_id", "name"]
  },
  payments: {
    label: "付款记录",
    fields: {
      plan_id: "INTEGER", contract_id: "INTEGER", amount: "REAL",
      pay_date: "TEXT", method: "TEXT", voucher_no: "TEXT",
      operator: "TEXT", remark: "TEXT", created_at: "TEXT"
    },
    numeric: ["plan_id", "contract_id", "amount"],
    required: ["amount"]
  },
  progress_logs: {
    label: "施工进度",
    fields: {
      contract_id: "INTEGER", log_date: "TEXT", title: "TEXT",
      progress: "INTEGER", content: "TEXT", operator: "TEXT", created_at: "TEXT"
    },
    numeric: ["contract_id", "progress"],
    required: ["contract_id"]
  },
  // 附件：图片 / 合同扫描件 / 验收单等，文件本体落在 DATA_DIR/attachments
  attachments: {
    label: "附件",
    fields: {
      entity: "TEXT", entity_id: "INTEGER",
      name: "TEXT", mime: "TEXT", size: "INTEGER",
      file: "TEXT", uploader: "TEXT", created_at: "TEXT"
    },
    numeric: ["entity_id", "size"],
    required: ["entity", "entity_id", "name", "file"]
  },
  // 应用账号（登录用，只走 /api/users 专用路由，不开放通用 CRUD）
  users: {
    label: "用户",
    fields: {
      username: "TEXT", name: "TEXT", role: "TEXT",
      pass_hash: "TEXT", salt: "TEXT", enabled: "TEXT",
      last_login: "TEXT", remark: "TEXT", created_at: "TEXT"
    },
    numeric: [],
    required: ["username"]
  },
  // 操作日志：登录、增删改、设置变更等关键动作
  audit_logs: {
    label: "操作日志",
    fields: {
      ts: "TEXT", user: "TEXT", action: "TEXT", module: "TEXT",
      target: "TEXT", detail: "TEXT"
    },
    numeric: [],
    required: ["ts"]
  }
};

const TABLE_NAMES = Object.keys(SCHEMA);
const WRITABLE = new Set(TABLE_NAMES);
// 附件只走专用路由（需要同时落文件），不开放通用 CRUD
WRITABLE.delete("attachments");
// 用户与操作日志只走专用路由（涉及鉴权与权限），不开放通用 CRUD
WRITABLE.delete("users");
WRITABLE.delete("audit_logs");

// 1.15.0：保养状态（空值 = 按 next_maintain 日期自动派生）与维保记录类型白名单
const MAINTAIN_STATES = new Set(["planned", "doing", "done", "postponed"]);
const EQ_LOG_TYPES = new Set(["inspect", "maintain", "repair"]);
const isDateStr = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ""));

// ---------------- 1.18.0 新增模块枚举 ----------------
// 商铺装修 / 维修：状态与进度共用一套枚举，两条业务线各自独立
const SHOP_WORK_TYPES = new Set(["decoration", "repair"]);
const SHOP_WORK_STATES = new Set(["none", "planned", "doing", "done", "paused"]);
const ARCHIVE_CATS = new Set(["contract", "drawing", "license", "acceptance", "equipment", "shop", "other"]);
const ARCHIVE_STATES = new Set(["filed", "borrowed", "sealed", "void"]);
const ARCHIVE_LOG_TYPES = new Set(["borrow", "return"]);
const WH_CATS = new Set(["tool", "hardware", "electric", "fire", "cleaning", "consumable", "spare", "other"]);
const WH_ITEM_STATES = new Set(["normal", "stopped"]);
const WH_RECORD_TYPES = new Set(["in", "out", "adjust"]);
// 1.26.0：楼栋同样可挂图纸 / 资料附件与档案
const BUILDING_STATES = new Set(["active", "inactive"]);
const ARCHIVE_ENTITIES = new Set(["shops", "contracts", "equipments", "archives", "warehouse_items", "buildings", ""]);
const clampProgress = (v) => Math.max(0, Math.min(100, Math.round(Number(v) || 0)));
const isBlankOrDate = (v) => !String(v || "").trim() || isDateStr(v);

const ROLES = ["admin", "operator", "viewer"];
const ROLE_LABEL = { admin: "管理员", operator: "操作员", viewer: "只读" };

const ATTACH_ENTITIES = new Set(["shops", "contracts", "equipments", "payment_plans", "archives", "warehouse_items", "buildings"]);
const ATTACH_DIR = path.join(DATA_DIR, "attachments");
const MAX_UPLOAD = 25 * 1024 * 1024;
try { fs.mkdirSync(ATTACH_DIR, { recursive: true }); } catch (e) { console.log("[attach] mkdir failed:", e.message); }
const nowISO = () => localStamp();

// ---------------- 存储层 ----------------
function coerce(table, raw) {
  const def = SCHEMA[table];
  const out = {};
  for (const [key, val] of Object.entries(raw || {})) {
    if (!(key in def.fields)) continue; // 白名单，拒绝未知字段
    if (def.numeric.includes(key)) {
      if (val === "" || val === null || val === undefined) { out[key] = null; continue; }
      const n = Number(val);
      out[key] = Number.isFinite(n) ? n : null;
    } else if (def.fields[key] === "INTEGER") {
      if (val === "" || val === null || val === undefined) { out[key] = null; continue; }
      const n = parseInt(val, 10);
      out[key] = Number.isFinite(n) ? n : null;
    } else {
      out[key] = val === null || val === undefined ? null : String(val).slice(0, 4000);
    }
  }
  return out;
}

function validate(table, row, partial) {
  const def = SCHEMA[table];
  if (!partial) {
    for (const key of def.required) {
      if (row[key] === undefined || row[key] === null || row[key] === "") {
        return `字段 ${key} 不能为空`;
      }
    }
  }
  return null;
}

function createSQLiteStore(file, engineName) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");

  for (const [table, def] of Object.entries(SCHEMA)) {
    const cols = Object.entries(def.fields).map(([k, t]) => `${k} ${t}`).join(", ");
    db.exec(`CREATE TABLE IF NOT EXISTS ${table} (id INTEGER PRIMARY KEY AUTOINCREMENT, ${cols})`);
    // 旧库迁移：为已有表补齐新增列（如 shops.rent_total）
    const existingCols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    for (const [k, t] of Object.entries(def.fields)) {
      if (!existingCols.includes(k)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${k} ${t}`);
        console.log(`[migrate] ${table} added column ${k}`);
      }
    }
  }
  db.exec(`CREATE TABLE IF NOT EXISTS app_meta (k TEXT PRIMARY KEY, v TEXT)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_readings_shop ON readings(shop_id, period)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_bills_shop ON bills(shop_id, period)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_eq_shop ON equipments(shop_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_plans_contract ON payment_plans(contract_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_progress_contract ON progress_logs(contract_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_equipment ON equipment_logs(equipment_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_shop_progress ON shop_progress_logs(shop_id, type)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_archive_logs ON archive_logs(archive_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_wh_records ON warehouse_records(item_id)`);

  const colsOf = (t) => Object.keys(SCHEMA[t].fields);

  return {
    engine: engineName,
    file,
    list(table, filter) {
      const cols = colsOf(table);
      const where = [];
      const params = [];
      for (const [k, v] of Object.entries(filter || {})) {
        if (!cols.includes(k)) continue;
        where.push(`${k} = ?`);
        params.push(v);
      }
      const sql = `SELECT * FROM ${table}` + (where.length ? ` WHERE ${where.join(" AND ")}` : "") + ` ORDER BY id DESC`;
      return db.prepare(sql).all(...params);
    },
    get(table, id) {
      return db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(Number(id)) || null;
    },
    insert(table, row) {
      const cols = Object.keys(row);
      if (!cols.length) {
        const r = db.prepare(`INSERT INTO ${table} DEFAULT VALUES`).run();
        return this.get(table, r.lastInsertRowid);
      }
      const sql = `INSERT INTO ${table} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`;
      const r = db.prepare(sql).run(...cols.map((c) => row[c]));
      return this.get(table, r.lastInsertRowid);
    },
    update(table, id, patch) {
      const cols = Object.keys(patch);
      if (!cols.length) return this.get(table, id);
      const sql = `UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`;
      db.prepare(sql).run(...cols.map((c) => patch[c]), Number(id));
      return this.get(table, id);
    },
    remove(table, id) {
      return db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(Number(id));
    },
    count(table) {
      return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
    },
    metaGet(k) {
      const r = db.prepare(`SELECT v FROM app_meta WHERE k = ?`).get(k);
      return r ? r.v : null;
    },
    metaSet(k, v) {
      db.prepare(`INSERT INTO app_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`).run(k, String(v));
    },
    info() {
      // WAL 模式下数据主要落在 -wal 文件里，统计时一并计入
      let size = 0;
      for (const f of [file, file + "-wal", file + "-shm"]) {
        try { size += fs.statSync(f).size; } catch (e) {}
      }
      return { engine: "sqlite", file, size };
    }
  };
}

function createJSONStore(file) {
  const read = () => {
    try {
      const d = JSON.parse(fs.readFileSync(file, "utf8"));
      return d && typeof d === "object" ? d : {};
    } catch (e) { return {}; }
  };
  let data = read();
  for (const t of TABLE_NAMES) if (!Array.isArray(data[t])) data[t] = [];
  const flush = () => {
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(data), "utf8");
    fs.renameSync(tmp, file);
  };
  const nextId = (t) => data[t].reduce((m, r) => Math.max(m, Number(r.id) || 0), 0) + 1;

  return {
    engine: "json",
    file,
    list(table, filter) {
      let rows = data[table] || [];
      for (const [k, v] of Object.entries(filter || {})) {
        rows = rows.filter((r) => String(r[k]) === String(v));
      }
      return JSON.parse(JSON.stringify(rows)).sort((a, b) => b.id - a.id);
    },
    get(table, id) {
      const r = (data[table] || []).find((x) => Number(x.id) === Number(id));
      return r ? JSON.parse(JSON.stringify(r)) : null;
    },
    insert(table, row) {
      const r = Object.assign({ id: nextId(table) }, row);
      data[table].push(r);
      flush();
      return JSON.parse(JSON.stringify(r));
    },
    update(table, id, patch) {
      const r = (data[table] || []).find((x) => Number(x.id) === Number(id));
      if (!r) return null;
      Object.assign(r, patch);
      flush();
      return JSON.parse(JSON.stringify(r));
    },
    remove(table, id) {
      data[table] = (data[table] || []).filter((x) => Number(x.id) !== Number(id));
      flush();
      return { changes: 1 };
    },
    count(table) { return (data[table] || []).length; },
    metaGet(k) { return data.__meta && data.__meta[k] != null ? String(data.__meta[k]) : null; },
    metaSet(k, v) { data.__meta = data.__meta || {}; data.__meta[k] = String(v); flush(); },
    info() {
      return { engine: "json", file, size: fs.existsSync(file) ? fs.statSync(file).size : 0 };
    }
  };
}

function createStore() {
  const sqliteFile = path.join(DATA_DIR, `${APP_NAME}.db`);
  try {
    const s = createSQLiteStore(sqliteFile, "sqlite");
    return s;
  } catch (e) {
    console.log("[store] node:sqlite unavailable, fallback to JSON:", e.message);
    return createJSONStore(path.join(DATA_DIR, `${APP_NAME}.json`));
  }
}

const store = createStore();
console.log("[store] engine =", store.engine, "file =", store.file);

// ---------------- 设置读写 ----------------
let settingsMigrated = false;
/** 1.16.0：旧版本出厂预填了公司名。升级时把「从未改过的旧默认值」清成空白，只执行一次。 */
function migrateSettings() {
  if (settingsMigrated) return;
  settingsMigrated = true;
  try {
    if (store.metaGet(SETTINGS_MIGRATE_KEY) === "1") return;
    const raw = store.metaGet(SETTINGS_KEY);
    if (raw) {
      const saved = JSON.parse(raw) || {};
      if (saved.org_name === LEGACY_ORG_NAME) {
        saved.org_name = "";
        store.metaSet(SETTINGS_KEY, JSON.stringify(saved));
      }
    }
    store.metaSet(SETTINGS_MIGRATE_KEY, "1");
  } catch (e) { /* 迁移失败不阻塞启动，保留原设置 */ }
}

/**
 * 关键修复（1.16.0）：文本字段的空字符串是「用户主动清空」的有效值，必须原样保留。
 * 旧实现把 "" 与「未设置」混为一谈，导致清空项目信息保存成功、刷新后又被默认值覆盖，
 * 表现为「修改信息时无法保存」。只有「键不存在」才回退出厂值。
 */
function getSettings() {
  migrateSettings();
  let saved = {};
  try {
    const raw = store.metaGet(SETTINGS_KEY);
    if (raw) saved = JSON.parse(raw) || {};
  } catch (e) { saved = {}; }
  const out = Object.assign({}, DEFAULT_SETTINGS);
  for (const [k, def] of Object.entries(DEFAULT_SETTINGS)) {
    if (!Object.prototype.hasOwnProperty.call(saved, k)) continue;
    const v = saved[k];
    if (v === undefined || v === null) continue;
    if (typeof def === "number") {
      if (v === "") continue; // 数字字段留空 → 出厂值
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) continue;
      out[k] = /_days$/.test(k) ? Math.min(365, Math.round(n)) : Math.min(1000000, n);
    } else {
      out[k] = String(v).slice(0, ooFieldCap(k)); // 保留 ""，不再回退
    }
  }
  out.default_view = normalizeViewKey(out.default_view);
  if (out.default_mode !== "card") out.default_mode = "list";
  normalizeOoSettings(out);
  return out;
}

function saveSettings(patch) {
  const cur = getSettings();
  const next = Object.assign({}, cur);
  for (const [k, def] of Object.entries(DEFAULT_SETTINGS)) {
    if (!(k in (patch || {}))) continue;
    const raw = patch[k];
    // 1.24.0：前端只拿到掩码，原样提交表示「不修改密钥」；留空才是明确清除
    if (k === "oo_jwt_secret" && String(raw) === OO_SECRET_MASK) continue;
    if (typeof def === "number") {
      // 清空数值输入 = 恢复该项出厂默认值，界面上立即能看到结果，不再「改不动」
      if (raw === "" || raw === null || raw === undefined) { next[k] = def; continue; }
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) continue;
      next[k] = /_days$/.test(k) ? Math.min(365, Math.round(n)) : Math.min(1000000, n);
    } else {
      next[k] = String(raw == null ? "" : raw).trim().slice(0, ooFieldCap(k));
    }
  }
  next.default_view = normalizeViewKey(next.default_view);
  next.default_mode = next.default_mode === "card" ? "card" : "list";
  normalizeOoSettings(next);
  store.metaSet(SETTINGS_KEY, JSON.stringify(next));
  return next;
}

/** 对外下发设置时隐藏 JWT 密钥；oo_jwt_set 供界面显示「已配置 / 未配置」 */
function publicSettings() {
  const s = getSettings();
  return Object.assign({}, s, {
    oo_jwt_secret: s.oo_jwt_secret ? OO_SECRET_MASK : "",
    oo_jwt_set: !!s.oo_jwt_secret
  });
}

function resetSettings() {
  store.metaSet(SETTINGS_KEY, "{}");
  return getSettings();
}

/* ============================================================
   1.24.0：OnlyOffice Document Server 在线预览
   - DocServer 是独立服务，必须能「反向」拉取附件原文件，故用短期签名 URL
   - JWT 密钥只在服务端参与签名，绝不出现在浏览器可见的配置里
   ============================================================ */
const OO_SECRET_MASK = "******";
const OO_TOKEN_TTL = 6 * 3600 * 1000;
const OO_EXT_TYPES = {
  word: [".doc", ".docx", ".docm", ".dot", ".dotx", ".dotm", ".rtf", ".odt", ".ott", ".fodt"],
  cell: [".xls", ".xlsx", ".xlsm", ".xlsb", ".ods", ".ots", ".fods", ".csv"],
  slide: [".ppt", ".pptx", ".pptm", ".pps", ".ppsx", ".ppsm", ".pot", ".potx", ".odp", ".otp", ".fodp"]
};
const OO_EXT_MAP = (() => {
  const m = {};
  for (const [type, list] of Object.entries(OO_EXT_TYPES)) for (const e of list) m[e] = type;
  return m;
})();
const OO_DOC_MIME = {
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".docm": "application/vnd.ms-word.document.macroEnabled.12",
  ".dot": "application/msword", ".dotx": "application/vnd.openxmlformats-officedocument.wordprocessingml.template",
  ".dotm": "application/vnd.ms-word.template.macroEnabled.12",
  ".rtf": "application/rtf", ".odt": "application/vnd.oasis.opendocument.text",
  ".xls": "application/vnd.ms-excel", ".xlsb": "application/vnd.ms-excel.sheet.binary.macroEnabled.12",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".pptm": "application/vnd.ms-powerpoint.presentation.macroEnabled.12",
  ".pps": "application/vnd.ms-powerpoint", ".ppsx": "application/vnd.ms-powerpoint.slideshow.macroEnabled.12",
  ".ods": "application/vnd.oasis.opendocument.spreadsheet",
  ".odp": "application/vnd.oasis.opendocument.presentation",
  ".csv": "text/csv; charset=utf-8"
};

/** 网址类字段允许更长的密钥 / 地址，其余沿用 200 字符上限 */
function ooFieldCap(k) {
  return (k === "oo_jwt_secret" || k === "oo_server" || k === "oo_public_url") ? 500 : 200;
}

/** 只接受 http/https，自动补协议、去尾斜杠，杜绝 javascript: 等伪协议 */
function normalizeOoBase(v) {
  let s = String(v == null ? "" : v).trim();
  if (!s || /[\s\u0000-\u001f]/.test(s)) return "";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    if (!/^https?:\/\//i.test(s)) return "";   // 拒绝 javascript: / file: 等伪协议
  } else {
    if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return "";
    s = "http://" + s;                          // 允许直接填 IP:端口
  }
  let u;
  try { u = new URL(s); } catch (e) { return ""; }
  if ((u.protocol !== "http:" && u.protocol !== "https:") || !u.hostname) return "";
  return s.replace(/\/+$/, "");
}

function normalizeOoSettings(s) {
  s.oo_enabled = (s.oo_enabled === "1" || s.oo_enabled === 1 || s.oo_enabled === true) ? "1" : "0";
  s.oo_server = normalizeOoBase(s.oo_server);
  s.oo_public_url = normalizeOoBase(s.oo_public_url);
  s.oo_jwt_secret = String(s.oo_jwt_secret || "");
  if (s.oo_jwt_secret === OO_SECRET_MASK) s.oo_jwt_secret = "";
  return s;
}

function ooDocType(ext) { return OO_EXT_MAP[String(ext || "").toLowerCase()] || ""; }

/** 每个数据目录一份随机密钥，短签名 URL 重启后仍有效；写不进磁盘时退化为进程内密钥 */
const OO_SECRET = (() => {
  const f = path.join(DATA_DIR, ".oo_secret");
  try {
    const s = fs.readFileSync(f, "utf8").trim();
    if (s.length >= 16) return s;
  } catch (e) { /* 首次启动 */ }
  const s = crypto.randomBytes(24).toString("hex");
  try { fs.writeFileSync(f, s, { mode: 0o600 }); } catch (e) { console.log("[onlyoffice] 密钥无法持久化，重启后旧的预览链接会失效"); }
  return s;
})();

function ooToken(id, ttl) {
  const body = `${id}.${Date.now() + (ttl || OO_TOKEN_TTL)}`;
  const sig = crypto.createHmac("sha256", OO_SECRET).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function ooTokenOk(id, token) {
  const p = String(token || "").split(".");
  if (p.length !== 3 || p[0] !== String(id) || !/^\d+$/.test(p[1]) || Number(p[1]) < Date.now()) return false;
  const expect = crypto.createHmac("sha256", OO_SECRET).update(`${p[0]}.${p[1]}`).digest("base64url");
  try { return crypto.timingSafeEqual(Buffer.from(p[2]), Buffer.from(expect)); }
  catch (e) { return false; }
}

/** DocServer 开启 JWT 时，把整份配置用 HS256 签成 config.token（零依赖实现） */
function ooJwt(payload, secret) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const h = enc({ alg: "HS256", typ: "JWT" });
  const p = enc(payload);
  return `${h}.${p}.${crypto.createHmac("sha256", secret).update(`${h}.${p}`).digest("base64url")}`;
}

/** DocServer 拉取文件用的对外根地址：优先用设置里显式填写的，其次按请求头推导 */
function ooPublicBase(req, settings) {
  let base = String(settings.oo_public_url || "").trim().replace(/\/+$/, "");
  if (base) return base;
  const proto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim()
    || (req.socket && req.socket.encrypted ? "https" : "http");
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
  return host ? `${proto}://${host}` : "";
}

function onlyofficeConfig(row, req, settings, me) {
  const ext = safeExt(row.name);
  const base = ooPublicBase(req, settings);
  const token = ooToken(row.id);
  const stamp = crypto.createHash("sha1")
    .update(`${row.id}|${row.size}|${row.created_at}|${row.name}|${OO_SECRET}`).digest("hex").slice(0, 20);
  const cfg = {
    width: "100%", height: "100%", type: "desktop",
    document: {
      fileType: ext.slice(1),
      key: `pmops-${row.id}-${stamp}`,
      title: row.name,
      url: `${base}${GATEWAY_PREFIX}/api/onlyoffice/file/${row.id}?token=${encodeURIComponent(token)}`,
      permissions: {
        edit: false, download: true, print: true, review: false,
        comment: false, fillForms: false, modifyContentControl: false, copy: true
      }
    },
    documentType: ooDocType(ext),
    editorConfig: {
      mode: "view", lang: "zh-CN",
      user: { id: me ? String(me.username) : "guest", name: me ? String(me.name || me.username) : "访客" },
      customization: {
        autosave: false, forcesave: false, chat: false, comments: false,
        help: false, feedback: false, compactHeader: false, zoom: 100
      }
    }
  };
  cfg.editorConfig.callbackUrl = `${base}${GATEWAY_PREFIX}/api/onlyoffice/callback/${row.id}?token=${encodeURIComponent(token)}`;
  if (settings.oo_jwt_secret) cfg.token = ooJwt(cfg, settings.oo_jwt_secret);
  return cfg;
}

// ---------------- 登录与会话 ----------------
// 应用自有账号体系：admin / operator / viewer 三种角色，
// 会话 token 存 app_meta（重启不失效），浏览器用 Cookie 携带。
const SESSION_KEY = "sessions";
const SESSION_COOKIE = "pmops_auth";
const SESSION_TTL = 30 * 24 * 3600 * 1000; // 30 天滑动过期
const DEFAULT_ADMIN_PWD = "admin123";

const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const hashPassword = (pw, salt) => crypto.scryptSync(String(pw), String(salt), 32).toString("hex");
const newSalt = () => crypto.randomBytes(8).toString("hex");

function publicUser(u) {
  return {
    id: u.id, username: u.username, name: u.name, role: u.role,
    enabled: u.enabled !== "0", last_login: u.last_login || "", created_at: u.created_at || ""
  };
}

function findUser(username) {
  const un = String(username || "").trim().toLowerCase();
  return store.list("users").find((u) => String(u.username).toLowerCase() === un) || null;
}

function isDefaultAdminPassword(u) {
  return !!u && String(u.username).toLowerCase() === "admin" &&
    u.salt && u.pass_hash === hashPassword(DEFAULT_ADMIN_PWD, u.salt);
}

/** 确保至少有一个管理员（老库升级也生效） */
function ensureAdminUser() {
  if (store.list("users").length) return;
  const salt = newSalt();
  store.insert("users", coerce("users", {
    username: "admin", name: "管理员", role: "admin", enabled: "1",
    pass_hash: hashPassword(DEFAULT_ADMIN_PWD, salt), salt,
    remark: "初始管理员", created_at: nowISO()
  }));
  console.log("[auth] created default admin account (admin / " + DEFAULT_ADMIN_PWD + ")");
}

function loadSessions() {
  try {
    const raw = store.metaGet(SESSION_KEY);
    const obj = raw ? JSON.parse(raw) : {};
    return obj && typeof obj === "object" ? obj : {};
  } catch (e) { return {}; }
}

function saveSessions(obj) {
  store.metaSet(SESSION_KEY, JSON.stringify(obj));
}

function createSession(u) {
  const token = crypto.randomBytes(24).toString("hex");
  const sessions = loadSessions();
  // 顺带清掉过期会话
  const now = Date.now();
  for (const [k, s] of Object.entries(sessions)) {
    if (!s || !s.expires || s.expires < now) delete sessions[k];
  }
  sessions[token] = { username: u.username, name: u.name || u.username, role: u.role, created: now, expires: now + SESSION_TTL };
  saveSessions(sessions);
  return token;
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** 读会话并滑动续期；返回 {username,name,role} 或 null */
function getSession(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  const sessions = loadSessions();
  const s = sessions[token];
  if (!s || !s.expires || s.expires < Date.now()) {
    if (s) { delete sessions[token]; saveSessions(sessions); }
    return null;
  }
  s.expires = Date.now() + SESSION_TTL;
  saveSessions(sessions);
  return { token, username: s.username, name: s.name, role: s.role };
}

function destroySession(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return;
  const sessions = loadSessions();
  if (sessions[token]) { delete sessions[token]; saveSessions(sessions); }
}

const sessionCookieHeader = (token, clear) => clear
  ? `${SESSION_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly`
  : `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${Math.floor(SESSION_TTL / 1000)}; SameSite=Lax; HttpOnly`;

// ---------------- 操作日志 ----------------
const AUDIT_LIMIT = 5000;

function logAct(user, action, mod, target, detail) {
  try {
    store.insert("audit_logs", {
      ts: nowISO(),
      user: String(user || "—").slice(0, 80),
      action: String(action || "").slice(0, 40),
      module: String(mod || "").slice(0, 40),
      target: String(target || "").slice(0, 200),
      detail: String(detail || "").slice(0, 500)
    });
    // 超量时裁掉最老的记录
    const n = store.count("audit_logs");
    if (n > AUDIT_LIMIT) {
      store.list("audit_logs").slice(AUDIT_LIMIT).forEach((r) => store.remove("audit_logs", r.id));
    }
  } catch (e) { console.log("[audit] log failed:", e.message); }
}

/** 从记录里挑一个可读的标识（名称 / 编号 / 账期…） */
function rowLabel(table, row) {
  if (!row) return "";
  const r = table === "contracts" && row.contract ? Object.assign({}, row.contract, row) : row;
  return r.name || r.title || r.period || r.code || r.username || (r.seq ? `第${r.seq}期` : "") || `#${r.id || ""}`;
}

/** 读取时给日期加减天数（YYYY-MM-DD） */
function addDays(dateStr, days) {
  const d = new Date(String(dateStr) + "T00:00:00Z");
  if (isNaN(d.getTime())) return dateStr;
  d.setUTCDate(d.getUTCDate() + (Number(days) || 0));
  return d.toISOString().slice(0, 10);
}

// ---------------- 通用工具 ----------------
function json(res, code, obj) {
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      const txt = Buffer.concat(chunks).toString("utf8");
      if (!txt) return resolve({});
      try { resolve(JSON.parse(txt)); } catch (e) { reject(new Error("invalid json")); }
    });
    req.on("error", reject);
  });
}

/** 商铺月租金：手动填了租金总金额(rent_total)则以手动值为准，否则按 单价×面积 */
function shopMonthlyRent(s) {
  const rt = Number(s && s.rent_total);
  if (Number.isFinite(rt) && rt > 0) return rt;
  return (Number(s && s.area) || 0) * (Number(s && s.rent_price) || 0);
}

/** 商铺写入兜底：显式提交手动月租金总金额时，自动反算租金单价（1.10.1 修复） */
function syncShopRentPrice(body, row, existing) {
  if (!body || !Object.prototype.hasOwnProperty.call(body, "rent_total")) return;
  const total = Number(body.rent_total);
  if (!Number.isFinite(total) || total <= 0) return;
  const area = Number(body.area != null ? body.area : (existing && existing.area));
  if (!Number.isFinite(area) || area <= 0) return;
  row.rent_price = r2(total / area);
}

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const todayStr = () => localStamp().slice(0, 10);

// ---------------- 附件 ----------------
/** 1.19.0：附件上传流式落盘，内存占用恒定；limit=Infinity 表示不限制大小（档案 CAD 图纸） */
function saveUpload(req, limit, dest) {
  return new Promise((resolve, reject) => {
    let size = 0, settled = false;
    const ws = fs.createWriteStream(dest);
    const fail = (err) => {
      if (settled) return;
      settled = true;
      try { ws.destroy(); } catch (e) {}
      try { fs.unlinkSync(dest); } catch (e) {}
      reject(err instanceof Error ? err : new Error(String(err || "上传失败")));
    };
    ws.on("error", fail);
    ws.on("finish", () => { if (!settled) { settled = true; resolve(size); } });
    req.on("error", fail);
    req.on("data", (c) => {
      if (settled) return;
      size += c.length;
      if (Number.isFinite(limit) && size > limit) {
        fail(new Error("文件超过大小限制"));
        try { req.pause(); } catch (e) {}
        return;
      }
      if (!ws.write(c)) req.pause();
    });
    ws.on("drain", () => { if (!settled) req.resume(); });
    req.on("end", () => { if (!settled) ws.end(); });
  });
}

/** 只保留安全扩展名，文件名本身绝不参与路径拼接 */
function safeExt(name) {
  const m = String(name || "").match(/\.([A-Za-z0-9]{1,8})$/);
  return m ? "." + m[1].toLowerCase() : "";
}

function cleanName(name) {
  const base = String(name || "").replace(/[\\/\u0000-\u001f]/g, "_").trim().slice(0, 180);
  return base || "附件";
}

/* ============================================================
   1.22.0：附件在线预览（PDF 内联渲染 / 表格与文本解析）
   零外部依赖：ZIP 目录 + zlib + 轻量 OOXML / CSV 读取
   ============================================================ */
const ATT_MIME = {
  ".pdf": "application/pdf",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xlsm": "application/vnd.ms-excel.sheet.macroEnabled.12",
  ".xls": "application/vnd.ms-excel",
  ".csv": "text/csv; charset=utf-8",
  ".tsv": "text/tab-separated-values; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp", ".tif": "image/tiff"
};
const PREVIEW_TABLE_EXT = new Set([".xlsx", ".xlsm", ".csv", ".tsv"]);
const PREVIEW_TEXT_EXT = new Set([".txt", ".log", ".json", ".xml", ".md"]);
const PREVIEW_MAX_BYTES = 24 * 1024 * 1024;
const PREVIEW_MAX_ROWS = 200;
const PREVIEW_MAX_COLS = 40;

/** 上传时的 Content-Type 不可靠，按扩展名兜底修正，保证 PDF 能在 iframe 中内联渲染 */
function attachMime(row) {
  const ext = safeExt(row && row.name);
  const fixed = ATT_MIME[ext];
  const cur = String((row && row.mime) || "");
  if (fixed && (!cur || cur === "application/octet-stream" || ext === ".pdf" || ext === ".csv" || ext === ".txt" || ext === ".xlsx")) return fixed;
  return cur || "application/octet-stream";
}

function xmlText(s) {
  return String(s || "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&");
}

/** 读取标准 ZIP 的中央目录（xlsx 就是 zip）；只解出需要的成员 */
function unzipEntries(buf) {
  let eocd = -1;
  const floor = Math.max(0, buf.length - 65558);
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("不是有效的 xlsx 文件（缺少 ZIP 目录）");
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const out = new Map();
  let inflated = 0;
  for (let n = 0; n < count && off + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString("utf8", off + 46, off + 46 + nameLen);
    if (localOff + 30 <= buf.length && buf.readUInt32LE(localOff) === 0x04034b50) {
      const start = localOff + 30 + buf.readUInt16LE(localOff + 26) + buf.readUInt16LE(localOff + 28);
      const raw = buf.subarray(start, start + compSize);
      const data = method === 8 ? zlib.inflateRawSync(raw) : raw;
      inflated += data.length;
      if (inflated > 64 * 1024 * 1024) throw new Error("表格内容过大，已停止解析");
      out.set(name, data);
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function sharedStringsOf(entries) {
  const buf = entries.get("xl/sharedStrings.xml");
  if (!buf) return [];
  const xml = buf.toString("utf8");
  const out = [];
  const re = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = re.exec(xml))) {
    let s = "";
    const tre = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
    let t;
    while ((t = tre.exec(m[1]))) s += xmlText(t[1]);
    out.push(s);
  }
  return out;
}

function sheetFilesOf(entries) {
  const names = [...entries.keys()]
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/sheet(\d+)/)[1]) - Number(b.match(/sheet(\d+)/)[1]));
  const wb = entries.get("xl/workbook.xml");
  const titles = [];
  if (wb) {
    const re = /<sheet\b[^>]*name="([^"]*)"[^>]*\/?>/g;
    let m;
    while ((m = re.exec(wb.toString("utf8")))) titles.push(xmlText(m[1]));
  }
  return names.map((file, i) => ({ file, name: titles[i] || `工作表 ${i + 1}` }));
}

function colIndexOf(ref) {
  const m = String(ref || "").match(/^([A-Z]+)/);
  if (!m) return -1;
  let n = 0;
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** 解析 sheetData：兼容 sharedStrings、inlineStr、数字、布尔、空单元格 */
function parseSheetXml(xml, shared) {
  const rows = [];
  let total = 0;
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>|<row\b[^>]*\/>/g;
  let rm;
  while ((rm = rowRe.exec(xml))) {
    total++;
    if (rows.length >= PREVIEW_MAX_ROWS) continue;
    const cells = [];
    const cellRe = /<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/g;
    let cm;
    while ((cm = cellRe.exec(rm[1] || ""))) {
      const attrs = cm[1] || cm[3] || "";
      const inner = cm[2] || "";
      const ref = (attrs.match(/\br="([A-Z]+\d+)"/) || [])[1] || "";
      const type = (attrs.match(/\bt="([^"]+)"/) || [])[1] || "";
      const idx = colIndexOf(ref);
      const col = idx >= 0 ? idx : cells.length;
      let val = "";
      if (type === "inlineStr") {
        const tre = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
        let t;
        while ((t = tre.exec(inner))) val += xmlText(t[1]);
      } else {
        const v = inner.match(/<v\b[^>]*>([\s\S]*?)<\/v>/);
        val = v ? xmlText(v[1]) : "";
        if (type === "s") val = shared[Number(val)] == null ? "" : shared[Number(val)];
        else if (type === "b") val = val === "1" ? "TRUE" : "FALSE";
      }
      if (col >= PREVIEW_MAX_COLS) continue;
      while (cells.length < col) cells.push("");
      cells[col] = val;
    }
    rows.push(cells);
  }
  return { rows, totalRows: total };
}

function decodeText(buf) {
  let s = buf.toString("utf8");
  if (/\uFFFD/.test(s)) {
    try { s = new TextDecoder("gbk").decode(buf); } catch (e) { /* 运行时无 GBK 解码器时保留 UTF-8 结果 */ }
  }
  return s.replace(/^\uFEFF/, "");
}

/** CSV / TSV：支持引号、转义引号、字段内换行 */
function parseDelimited(text, sep) {
  const rows = [];
  let row = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += c;
    } else if (c === '"' && cell === "") quoted = true;
    else if (c === sep) { row.push(cell); cell = ""; }
    else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (c !== "\r") cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/** 生成单个附件的预览数据（表格与附件导出预览前端共用同一结构） */
function previewAttachment(row) {
  const base = { name: row.name, size: Number(row.size) || 0 };
  const ext = safeExt(row.name);
  const file = attachmentPath(row);
  if (!file || !fs.existsSync(file)) return Object.assign(base, { kind: "unsupported", reason: "附件文件已丢失" });
  const size = fs.statSync(file).size;
  if (ext === ".pdf") return Object.assign(base, { kind: "pdf", size });
  if (/^image\//.test(attachMime(row))) return Object.assign(base, { kind: "image", size });
  if (ext === ".xls") return Object.assign(base, {
    kind: "unsupported", size, reason: "旧版 .xls 暂不支持在线预览，请下载后用 Excel / WPS 打开，或另存为 .xlsx 后重新上传"
  });
  if (PREVIEW_TABLE_EXT.has(ext) || PREVIEW_TEXT_EXT.has(ext)) {
    if (size > PREVIEW_MAX_BYTES) return Object.assign(base, {
      kind: "unsupported", size, reason: "文件超过 24MB，在线预览已跳过，请下载后打开"
    });
    const buf = fs.readFileSync(file);
    if (ext === ".xlsx" || ext === ".xlsm") {
      try {
        const entries = unzipEntries(buf);
        const shared = sharedStringsOf(entries);
        const sheets = sheetFilesOf(entries).map((s) => {
          const p = parseSheetXml(entries.get(s.file).toString("utf8"), shared);
          return { name: s.name, columns: [], rows: p.rows, totalRows: p.totalRows, truncated: p.totalRows > PREVIEW_MAX_ROWS };
        });
        if (!sheets.length) throw new Error("未找到工作表");
        return Object.assign(base, { kind: "table", format: "xlsx", size, sheets });
      } catch (e) {
        return Object.assign(base, { kind: "unsupported", size, reason: "表格解析失败：" + e.message });
      }
    }
    const text = decodeText(buf);
    if (ext === ".csv" || ext === ".tsv") {
      const all = parseDelimited(text, ext === ".csv" ? "," : "\t");
      const rows = all.slice(0, PREVIEW_MAX_ROWS).map((r) => r.slice(0, PREVIEW_MAX_COLS));
      return Object.assign(base, {
        kind: "table", format: ext.slice(1), size,
        sheets: [{ name: row.name, columns: [], rows, totalRows: all.length, truncated: all.length > PREVIEW_MAX_ROWS }]
      });
    }
    return Object.assign(base, { kind: "text", size, text: text.slice(0, 200000) });
  }
  return Object.assign(base, {
    kind: "unsupported", size,
    reason: isCadExt(ext) ? "CAD / 工程图纸请用 AutoCAD 等专业软件打开" : "该文件暂不支持在线预览，请下载后查看"
  });
}

function isCadExt(ext) {
  return [".dwg", ".dxf", ".dwf", ".dwt", ".dws", ".dxb", ".rvt", ".rfa", ".rft", ".skp",
    ".stp", ".step", ".igs", ".iges", ".sat", ".stl", ".obj", ".3ds", ".plt", ".hpgl", ".ifc"].indexOf(ext) >= 0;
}

function attachmentsOf(entity, entityId) {
  return store.list("attachments", { entity, entity_id: Number(entityId) })
    .sort((a, b) => (a.id - b.id));
}

function attachmentPath(row) {
  // 统一按 / 分段，避免 Windows 建的库拷到 Linux 后路径失效
  const parts = String(row.file || "").split(/[\\/]+/).filter((p) => p && p !== "." && p !== "..");
  const p = path.resolve(ATTACH_DIR, ...parts.slice(parts[0] === "attachments" ? 1 : 0));
  if (!p.startsWith(path.resolve(ATTACH_DIR))) return null; // 防目录穿越
  return p;
}

function removeAttachment(row) {
  const p = attachmentPath(row);
  if (p) { try { fs.unlinkSync(p); } catch (e) {} }
  store.remove("attachments", row.id);
}

function removeAttachmentsOf(entity, entityId) {
  attachmentsOf(entity, entityId).forEach(removeAttachment);
}

// ---------------- 业务逻辑 ----------------
/** 合同详情：附付款计划、付款记录、施工进度、汇总 */
function contractDetail(id) {
  const c = store.get("contracts", id);
  if (!c) return null;
  const plans = store.list("payment_plans", { contract_id: c.id }).sort((a, b) => (a.seq || 0) - (b.seq || 0));
  const payments = store.list("payments", { contract_id: c.id });
  const logs = store.list("progress_logs", { contract_id: c.id }).sort((a, b) => String(b.log_date).localeCompare(String(a.log_date)));
  const paid = plans.filter((p) => p.status === "paid").reduce((s, p) => s + (Number(p.paid_amount) || Number(p.amount) || 0), 0);
  const planned = plans.reduce((s, p) => s + (Number(p.amount) || 0), 0);
  const shop = c.shop_id ? store.get("shops", c.shop_id) : null;
  return {
    ...c,
    shop_name: shop ? shop.name : null,
    plans,
    payments,
    progress_logs: logs,
    attachments: attachmentsOf("contracts", c.id),
    summary: {
      planned: r2(planned),
      paid: r2(paid),
      unpaid: r2(Math.max(0, (Number(c.amount) || 0) - paid)),
      planGap: r2((Number(c.amount) || 0) - planned),
      planCount: plans.length,
      paidCount: plans.filter((p) => p.status === "paid").length,
      overdueCount: plans.filter((p) => p.status !== "paid" && p.due_date && p.due_date < todayStr()).length
    }
  };
}

/** 按比例生成付款计划；amount 由合同总额与比例算得 */
function buildPlans(contract, specs) {
  const total = Number(contract.amount) || 0;
  const seqStart = store.list("payment_plans", { contract_id: contract.id }).length;
  const created = [];
  specs.forEach((s, i) => {
    const seq = seqStart + i + 1;
    let ratio = Number(s.ratio) || 0;
    const amount = s.amount != null && s.amount !== "" ? Number(s.amount) : r2(total * ratio / 100);
    // 只手动输入金额未给比例时，自动按金额反算占合同比例
    if (!ratio && amount && total > 0) ratio = Math.round(amount / total * 1000) / 10;
    const row = coerce("payment_plans", {
      contract_id: contract.id,
      seq,
      name: s.name || `第${seq}期`,
      trigger_type: s.trigger_type || "date",
      trigger_value: s.trigger_value != null ? String(s.trigger_value) : "",
      ratio,
      amount,
      due_date: s.due_date || "",
      // 签约即付的节点（首付款）生成后直接进入待支付
      status: s.status || (s.trigger_type === "sign" ? "due" : "pending"),
      paid_date: s.paid_date || "",
      paid_amount: s.paid_amount != null ? s.paid_amount : 0,
      remark: s.remark || ""
    });
    row.created_at = nowISO();
    created.push(store.insert("payment_plans", row));
  });
  return created;
}

/** 自定义付款计划：整表覆盖保存。
 *  带 id 的节点原地更新（附件不丢）；已付款节点只调整期次且强制保留；未付款的旧节点删除。 */
function replaceContractPlans(c, specs) {
  const total = Number(c.amount) || 0;
  const existing = store.list("payment_plans", { contract_id: c.id });
  const byId = new Map(existing.map((p) => [String(p.id), p]));
  // 已付款节点若未出现在草稿中（例如直接调接口），强制保留并排在最前，避免期次重复
  const orphanPaid = existing.filter((p) => p.status === "paid"
    && !specs.some((s) => s.id != null && String(s.id) === String(p.id)));
  const offset = orphanPaid.length;
  const keepIds = new Set();
  const result = [];
  specs.forEach((s, i) => {
    const seq = offset + i + 1;
    let ratio = Number(s.ratio) || 0;
    const amount = s.amount != null && s.amount !== "" ? Number(s.amount) : r2(total * ratio / 100);
    if (!ratio && amount && total > 0) ratio = Math.round(amount / total * 1000) / 10;
    const base = {
      seq,
      name: s.name || `第${seq}期`,
      trigger_type: s.trigger_type || "date",
      trigger_value: s.trigger_value != null ? String(s.trigger_value) : "",
      ratio, amount,
      due_date: s.due_date || "",
      remark: s.remark || ""
    };
    const old = s.id != null ? byId.get(String(s.id)) : null;
    if (old) {
      keepIds.add(String(old.id));
      const patch = old.status === "paid"
        ? { seq }
        : coerce("payment_plans", Object.assign({}, base, { status: old.status || "pending" }));
      result.push(store.update("payment_plans", old.id, patch));
    } else {
      const row = coerce("payment_plans", Object.assign({ contract_id: c.id }, base, {
        status: s.trigger_type === "sign" ? "due" : "pending",
        paid_amount: 0
      }));
      row.created_at = nowISO();
      result.push(store.insert("payment_plans", row));
    }
  });
  existing.forEach((p) => {
    if (keepIds.has(String(p.id))) return;
    const oi = orphanPaid.findIndex((o) => String(o.id) === String(p.id));
    if (oi >= 0) {
      result.push(store.update("payment_plans", p.id, { seq: oi + 1 }));
      return;
    }
    removeAttachmentsOf("payment_plans", p.id);
    store.remove("payment_plans", p.id);
  });
  return result;
}

/** 进度上报后，把到期/达标的付款节点置为待支付 */
function unlockPlans(contractId, progress) {
  const plans = store.list("payment_plans", { contract_id: contractId });
  const unlocked = [];
  for (const p of plans) {
    if (p.status !== "pending") continue;
    if (p.trigger_type === "progress") {
      const target = Number(p.trigger_value) || 100;
      if (progress >= target) {
        store.update("payment_plans", p.id, { status: "due" });
        unlocked.push(p.name);
      }
    }
  }
  return unlocked;
}

/** 已到应付日期（含设置中的提前提醒天数）但仍未支付的节点，自动置为「待支付」 */
function refreshDuePlans() {
  const today = todayStr();
  const horizon = addDays(today, Math.max(0, Number(getSettings().pay_remind_days) || 0));
  let changed = 0;
  for (const p of store.list("payment_plans")) {
    if (p.status === "pending" && p.due_date && p.due_date <= horizon) {
      store.update("payment_plans", p.id, { status: "due" });
      changed++;
    }
  }
  return changed;
}

// ---------------- 关于 ----------------
/** 本机内网 IPv4 地址（用于「关于」页展示局域网访问地址） */
function lanAddresses() {
  const out = [];
  try {
    const ifs = os.networkInterfaces();
    for (const name of Object.keys(ifs)) {
      for (const it of ifs[name] || []) {
        if (it.family === "IPv4" && !it.internal) out.push({ iface: name, ip: it.address });
      }
    }
  } catch (e) {}
  return out;
}

function aboutInfo() {
  const settings = getSettings();
  const counts = {};
  let total = 0;
  for (const t of TABLE_NAMES) {
    counts[t] = store.count(t);
    total += counts[t];
  }
  const atts = store.list("attachments");
  const attSize = atts.reduce((s, a) => s + (Number(a.size) || 0), 0);
  const mem = process.memoryUsage();
  const info = store.info();
  return {
    app: {
      name: "物业工程管理",
      code: APP_NAME,
      version: APP_VERSION,
      build: BUILD_DATE,
      developer: DEVELOPER,
      desc: "面向园区 / 写字楼的物业工程一体化管理应用"
    },
    runtime: {
      node: process.version,
      platform: process.platform + " " + process.arch,
      uptime: Math.round(process.uptime()),
      memory: mem.rss,
      gateway: GATEWAY_PREFIX,
      listen: SOCKET_PATH ? "unix socket" : "http:" + PORT,
      lanPort: LAN_PORT,
      lanEnabled: LAN_PORT > 0,
      lanUrls: LAN_PORT > 0 ? lanAddresses().map((a) => "http://" + a.ip + ":" + LAN_PORT) : [],
      startedAt: STARTED_AT
    },
    store: Object.assign({}, info, {
      sizeText: info.size >= 1048576 ? (info.size / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(info.size / 1024)) + " KB"
    }),
    counts,
    total,
    attachments: { count: atts.length, size: attSize },
    settings
  };
}

// ---------------- 概览 ----------------
function overview() {
  const shops = store.list("shops");
  const eqs = store.list("equipments");
  const contracts = store.list("contracts");
  const plans = store.list("payment_plans");
  const today = todayStr();
  // 1.26.0：楼栋台账与商铺实际使用的楼栋名对比，供驾驶舱 / 一键建档提示
  const buildings = store.list("buildings");
  const registeredBuildings = new Set(buildings.map((b) => String(b.name || "").trim()).filter(Boolean));
  const shopBuildingNames = new Set(shops.map((s) => String(s.building || "").trim()).filter(Boolean));
  const unregisteredBuildings = Array.from(shopBuildingNames).filter((n) => !registeredBuildings.has(n));

  const totalArea = shops.reduce((s, x) => s + (Number(x.area) || 0), 0);
  const monthlyRent = shops.filter((s) => s.status === "rented")
    .reduce((s, x) => s + shopMonthlyRent(x), 0);

  const eqByCat = {};
  for (const e of eqs) eqByCat[e.category] = (eqByCat[e.category] || 0) + 1;
  const eqAbnormal = eqs.filter((e) => e.status === "repair" || e.status === "stopped").length;
  // 「到期保养」= 已过保养日 + 设置里提前 N 天进入预警窗口
  const maintainHorizon = addDays(today, Math.max(0, Number(getSettings().maintain_remind_days) || 0));
  // 1.15.0：手动标记「本轮保养已完成」的设备不再进入待保养提醒
  const dueEqs = eqs.filter((e) => e.next_maintain && e.next_maintain <= maintainHorizon
    && e.status !== "stopped" && e.maintain_status !== "done");
  const eqDue = dueEqs.length;

  const amountTotal = contracts.reduce((s, c) => s + (Number(c.amount) || 0), 0);
  const paidTotal = plans.filter((p) => p.status === "paid")
    .reduce((s, p) => s + (Number(p.paid_amount) || Number(p.amount) || 0), 0);
  const unpaidTotal = plans.filter((p) => p.status !== "paid")
    .reduce((s, p) => s + (Number(p.amount) || 0), 0);
  const overdue = plans.filter((p) => p.status !== "paid" && p.due_date && p.due_date < today);

  // 近 6 个月收付款趋势
  const months = [];
  const d = new Date();
  for (let i = 5; i >= 0; i--) {
    const dt = new Date(d.getFullYear(), d.getMonth() - i, 1);
    months.push(`${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}`);
  }
  const bills = store.list("bills");
  const payments = store.list("payments");
  const cashflow = months.map((m) => ({
    month: m,
    income: r2(bills.filter((b) => b.status === "paid" && String(b.paid_date || "").startsWith(m))
      .reduce((s, b) => s + (Number(b.total) || 0), 0)),
    outcome: r2(payments.filter((p) => String(p.pay_date || "").startsWith(m))
      .reduce((s, p) => s + (Number(p.amount) || 0), 0))
  }));

  // 账单收缴 / 欠费 / 租约到期 / 维保费用：与经营驾驶舱共用同一份业务数据
  const unpaidBills = bills.filter((b) => b.status !== "paid" && (Number(b.total) || 0) > 0);
  const arrearsShopIds = new Set(unpaidBills.map((b) => b.shop_id));
  const leaseHorizon = addDays(today, 60);
  const leaseExpiring = shops.filter((s) => s.status === "rented" && s.lease_end && s.lease_end <= leaseHorizon);
  const maintainCost = months.reduce((s, m) => s + store.list("equipment_logs")
    .filter((l) => String(l.log_date || "").startsWith(m))
    .reduce((n, l) => n + (Number(l.cost) || 0), 0), 0);

  const todos = [];
  const arrearsByShop = shops
    .map((s) => ({ s, amount: unpaidBills.filter((b) => b.shop_id === s.id).reduce((n, b) => n + (Number(b.total) || 0), 0) }))
    .filter((x) => x.amount > 0).sort((a, b) => b.amount - a.amount);
  for (const x of arrearsByShop.slice(0, 3)) {
    todos.push({
      level: "warn", title: `商铺欠费：${x.s.name}`,
      desc: `未收款 ¥${x.amount.toLocaleString("zh-CN")} · ${x.s.tenant || "未登记租户"}`, action: "shops"
    });
  }
  for (const s of leaseExpiring.slice(0, 2)) {
    todos.push({ level: "info", title: `租约临近到期：${s.name}`, desc: `到期日 ${s.lease_end} · ${s.tenant || ""}`, action: "shops" });
  }
  for (const p of overdue.slice(0, 6)) {
    const c = contracts.find((x) => x.id === p.contract_id);
    todos.push({
      level: "danger",
      title: `付款逾期：${p.name}`,
      desc: `${c ? c.name : "合同"} · 应付 ¥${(Number(p.amount) || 0).toLocaleString()} · ${p.due_date}`,
      action: "payments"
    });
  }
  for (const e of dueEqs.slice(0, 4)) {
    const late = e.next_maintain < today;
    todos.push({
      level: late ? "danger" : "warn",
      title: `${late ? "设备保养已到期" : "设备临近保养"}：${e.name}`,
      desc: `计划日期 ${e.next_maintain}${e.location ? " · " + e.location : ""}`,
      action: "equipments"
    });
  }
  for (const e of eqs.filter((x) => x.status === "repair").slice(0, 4)) {
    todos.push({ level: "warn", title: `设备维修中：${e.name}`, desc: e.location || "", action: "equipments" });
  }
  for (const s of shops.filter((x) => x.status === "vacant").slice(0, 4)) {
    todos.push({ level: "info", title: `商铺空置：${s.name}`, desc: `${s.building || ""} ${s.floor || ""} · ${s.area || 0}㎡`, action: "shops" });
  }

  return {
    shops: {
      total: shops.length,
      rented: shops.filter((s) => s.status === "rented").length,
      vacant: shops.filter((s) => s.status === "vacant").length,
      maintenance: shops.filter((s) => s.status === "maintenance").length,
      totalArea: r2(totalArea),
      monthlyRent: r2(monthlyRent)
    },
    // 1.26.0：楼栋覆盖情况（unregistered = 商铺里出现但台账尚未建档的楼栋）
    buildings: {
      total: buildings.length,
      active: buildings.filter((b) => b.status !== "inactive").length,
      inUse: shopBuildingNames.size,
      unregistered: unregisteredBuildings.length
    },
    equipments: { total: eqs.length, byCategory: eqByCat, abnormal: eqAbnormal, dueMaintain: eqDue },
    contracts: {
      total: contracts.length,
      ongoing: contracts.filter((c) => c.status === "ongoing").length,
      amountTotal: r2(amountTotal),
      paidTotal: r2(paidTotal),
      unpaidTotal: r2(unpaidTotal),
      overdueCount: overdue.length,
      progressAvg: contracts.length
        ? Math.round(contracts.reduce((s, c) => s + (Number(c.progress) || 0), 0) / contracts.length)
        : 0
    },
    cashflow,
    billing: {
      billCount: bills.length,
      paidCount: bills.filter((b) => b.status === "paid").length,
      unpaidCount: unpaidBills.length,
      unpaidTotal: r2(unpaidBills.reduce((s, b) => s + (Number(b.total) || 0), 0)),
      arrearsShops: arrearsShopIds.size,
      collectRate: bills.length
        ? Math.round(bills.filter((b) => b.status === "paid").length / bills.length * 100)
        : 0,
      leaseExpiring: leaseExpiring.length
    },
    maintenance: { costTotal: r2(maintainCost), dueCount: eqDue },
    // 1.18.0：装修 / 维修进度、档案与仓库风险，供驾驶舱和 KPI 直接取用
    shopWorks: {
      decorating: shops.filter((s) => s.decoration_status === "doing").length,
      repairing: shops.filter((s) => s.repair_status === "doing").length,
      logs: store.list("shop_progress_logs").length,
      avgDecoration: shops.length ? Math.round(shops.reduce((n, s) => n + (Number(s.decoration_progress) || 0), 0) / shops.length) : 0
    },
    archives: {
      total: store.list("archives").length,
      borrowed: store.list("archives").filter((a) => a.status === "borrowed").length,
      expiring: store.list("archives").filter((a) => a.expiry && a.expiry <= addDays(today, 60)).length
    },
    warehouse: {
      items: store.list("warehouse_items").length,
      lowStock: store.list("warehouse_items")
        .filter((i) => i.status !== "stopped" && (Number(i.quantity) || 0) <= (Number(i.min_stock) || 0)).length,
      value: r2(store.list("warehouse_items")
        .reduce((n, i) => n + (Number(i.quantity) || 0) * (Number(i.unit_price) || 0), 0))
    },
    todos: todos.slice(0, 12)
  };
}

// ---------------- 演示数据 ----------------
/**
 * 1.26.0：旧库升级时按现有商铺的楼栋名自动建档。
 * 没有这条迁移，老数据会出现「商铺有 A栋、楼栋台账却为空」的断层。
 */
function ensureBuildings() {
  if (store.count("buildings") > 0) return;
  const names = Array.from(new Set(store.list("shops")
    .map((s) => String(s.building || "").trim()).filter(Boolean)))
    .sort((a, b) => a.localeCompare(b, "zh-CN"));
  if (!names.length) return;
  for (const name of names) {
    const list = store.list("shops", { building: name });
    const floors = Array.from(new Set(list.map((s) => String(s.floor || "").trim()).filter(Boolean)))
      .sort((a, b) => a.localeCompare(b, "zh-CN")).join(" / ");
    store.insert("buildings", {
      code: "", name, floors,
      area: r2(list.reduce((n, s) => n + (Number(s.area) || 0), 0)),
      manager: "", phone: "", built_year: "", status: "active",
      remark: "升级时按现有商铺自动建档", created_at: nowISO()
    });
  }
  console.log(`[migrate] buildings auto-created: ${names.join("、")}`);
}

function seedIfEmpty() {
  if (store.metaGet("seeded") === "1") return;
  if (store.count("shops") > 0 || store.count("contracts") > 0) {
    store.metaSet("seeded", "1");
    return;
  }
  console.log("[seed] inserting demo dataset");

  // 1.26.0：楼栋台账示例，名称与 shopSeed 的 building 一一对应
  const buildingSeed = [
    ["BLD-A", "A栋", "1F / 2F", 441.5, "王工", "13800138011", "2018", "主力商业栋，含一层与二层"],
    ["BLD-B", "B栋", "1F", 216, "李工", "13800138012", "2019", "邻街商铺"],
    ["BLD-C", "C栋", "1F", 210, "王工", "13800138013", "2020", "超市主力店"]
  ];
  buildingSeed.forEach((b) => store.insert("buildings", {
    code: b[0], name: b[1], floors: b[2], area: b[3], manager: b[4], phone: b[5],
    built_year: b[6], status: "active", remark: b[7], created_at: nowISO()
  }));

  const shopSeed = [
    ["S-101", "一层101", "A栋", "1F", 86.5, 68, "rented", "张记茶餐厅", "13800138001", 12000, 4.2, 1.05],
    ["S-102", "一层102", "A栋", "1F", 62, 72, "rented", "美宜佳便利店", "13800138002", 10000, 4.2, 1.05],
    ["S-103", "一层103", "A栋", "1F", 120, 55, "vacant", "", "", 0, 4.2, 1.05],
    ["S-201", "二层201", "A栋", "2F", 95, 45, "rented", "城市书房", "13800138003", 9000, 4.2, 1.05],
    ["S-202", "二层202", "A栋", "2F", 78, 45, "maintenance", "", "", 0, 4.2, 1.05],
    ["B-101", "B栋101", "B栋", "1F", 150, 38, "rented", "力量健身工作室", "13800138004", 15000, 4.2, 1.05],
    ["B-102", "B栋102", "B栋", "1F", 66, 40, "vacant", "", "", 0, 4.2, 1.05],
    ["C-101", "C栋101", "C栋", "1F", 210, 32, "rented", "鲜丰生鲜超市", "13800138005", 20000, 4.2, 1.05]
  ];
  const shops = shopSeed.map((s) => store.insert("shops", coerce("shops", {
    code: s[0], name: s[1], building: s[2], floor: s[3],
    area: s[4], rent_price: s[5], status: s[6],
    tenant: s[7], tenant_phone: s[8], deposit: s[9],
    lease_start: s[6] === "rented" ? "2026-01-01" : "",
    lease_end: s[6] === "rented" ? "2026-12-31" : "",
    water_price: s[10], elec_price: s[11],
    remark: ""
  })));

  const eqSeed = [
    ["AC-01", "中央空调主机", "aircon", "public", "A栋屋面", "格力", "GMV-1200W", "normal", "2026-12-15"],
    ["AC-02", "多联机室内机(1F)", "aircon", "public", "A栋一层", "格力", "GMV-NDR71P", "normal", "2026-11-20"],
    ["AC-03", "冷却塔", "aircon", "public", "A栋屋面", "良机", "LBC-200", "repair", "2026-10-30"],
    ["FIRE-01", "喷淋主泵", "fire", "public", "消防泵房", "凯泉", "XBD-50", "normal", "2026-11-20"],
    ["FIRE-02", "消防报警主机", "fire", "public", "消防控制室", "海湾", "JB-QB-GST200", "normal", "2026-12-01"],
    ["FIRE-03", "烟感探测器(公区)", "fire", "public", "各楼层", "海湾", "JTY-GD-G3", "normal", "2027-01-10"],
    ["ELE-01", "高压配电柜", "electric", "public", "配电房", "正泰", "KYN28-12", "normal", "2026-12-20"],
    ["ELE-02", "低压配电柜", "electric", "public", "配电房", "正泰", "GCK", "normal", "2026-12-20"],
    ["ELE-03", "柴油发电机组", "electric", "public", "发电机房", "康明斯", "200kW", "stopped", "2026-11-08"],
    ["WK-01", "视频监控 NVR", "weak", "public", "安防控制室", "海康威视", "DS-8632N", "normal", "2026-11-25"],
    ["WK-02", "门禁控制器", "weak", "public", "A栋一层", "中控智慧", "F18", "normal", "2027-02-01"],
    ["WK-03", "核心交换机", "weak", "public", "弱电间", "华为", "S5735-L24T4S", "normal", "2026-12-05"],
    ["PL-01", "生活给水泵", "plumbing", "public", "生活泵房", "南方泵业", "CDL32-40", "normal", "2026-11-18"],
    ["PL-02", "污水提升泵", "plumbing", "public", "地下车库", "南方泵业", "WQ50-15", "repair", "2026-11-10"],
    ["PL-03", "屋面排水系统", "plumbing", "public", "各栋屋面", "—", "—", "normal", "2026-12-28"],
    ["ELV-01", "1# 客梯", "elevator", "public", "A栋电梯井", "蒂升", "TE-Evolution", "normal", "2026-11-28"],
    ["ELV-02", "2# 货梯", "elevator", "public", "B栋电梯井", "日立", "HGE-1000", "normal", "2026-12-12"],
    ["KT-01", "食堂排烟风机", "kitchen", "public", "员工食堂", "德通", "DT-40", "normal", "2026-11-22"],
    ["KT-02", "商用洗碗机", "kitchen", "shop", "A栋一层 101 铺", "迈科", "MW-2000", "repair", "2026-11-30"],
    ["OTH-01", "车库道闸", "other", "public", "地下车库入口", "捷顺", "JSDZ-3000", "normal", "2027-01-05"]
  ];
  const eqs = eqSeed.map((e) => store.insert("equipments", coerce("equipments", {
    code: e[0], name: e[1], category: e[2], location_type: e[3], location: e[4],
    brand: e[5], model: e[6], status: e[7], next_maintain: e[8],
    install_date: "2024-06-01", warranty_end: "2027-06-01", remark: ""
  })));

  // 合同 1：外墙翻新
  const c1 = store.insert("contracts", coerce("contracts", {
    contract_no: "HT-2026-006", name: "A栋外墙翻新工程",
    contractor: "广州宏建装饰工程有限公司", contact: "陈工", phone: "13900139001",
    category: "renovation", sign_date: "2026-09-20", start_date: "2026-10-08", end_date: "2026-12-30",
    amount: 880000, retention_rate: 10, progress: 45, status: "ongoing",
    remark: "含脚手架搭拆、基层处理、真石漆饰面"
  }));
  const p1 = buildPlans(c1, [
    { name: "首付款", ratio: 30, trigger_type: "sign", trigger_value: "", due_date: "2026-09-27", status: "paid", paid_date: "2026-09-25", paid_amount: 264000 },
    { name: "进度款（进度50%）", ratio: 30, trigger_type: "progress", trigger_value: "50", due_date: "2026-11-15" },
    { name: "进度款（进度80%）", ratio: 30, trigger_type: "progress", trigger_value: "80", due_date: "2026-12-10" },
    { name: "质保金（竣工验收）", ratio: 10, trigger_type: "progress", trigger_value: "100", due_date: "2026-12-30" }
  ]);
  store.insert("payments", coerce("payments", {
    plan_id: p1[0].id, contract_id: c1.id, amount: 264000, pay_date: "2026-09-25",
    method: "转账", voucher_no: "PZ20260925001", operator: "李经理", remark: "按合同 30% 首付款"
  }));
  [
    ["2026-10-08", "正式开工", 5, "施工队进场，围挡与安全防护搭设完成"],
    ["2026-10-18", "脚手架搭设完成", 20, "A栋东、南立面双排脚手架验收合格"],
    ["2026-10-28", "基层处理完成 60%", 38, "空鼓、开裂部位铲除并修补，界面剂施工"],
    ["2026-11-05", "真石漆样板确认", 45, "业主、监理、施工方三方确认样板色号"]
  ].forEach((g) => store.insert("progress_logs", coerce("progress_logs", {
    contract_id: c1.id, log_date: g[0], title: g[1], progress: g[2], content: g[3], operator: "陈工"
  })));

  // 合同 2：消防改造
  const c2 = store.insert("contracts", coerce("contracts", {
    contract_no: "HT-2026-009", name: "B栋消防系统改造",
    contractor: "广州安泰消防工程有限公司", contact: "刘工", phone: "13900139002",
    category: "repair", sign_date: "2026-10-15", start_date: "2026-10-20", end_date: "2026-11-30",
    amount: 356000, retention_rate: 5, progress: 70, status: "ongoing",
    remark: "喷淋主管更换、报警主机升级、末端试水"
  }));
  const p2 = buildPlans(c2, [
    { name: "首付款", ratio: 40, trigger_type: "sign", trigger_value: "", due_date: "2026-10-20", status: "paid", paid_date: "2026-10-19", paid_amount: 142400 },
    { name: "进度款（进度60%）", ratio: 40, trigger_type: "progress", trigger_value: "60", due_date: "2026-11-12", status: "due" },
    { name: "尾款（验收合格）", ratio: 20, trigger_type: "progress", trigger_value: "100", due_date: "2026-11-30" }
  ]);
  store.insert("payments", coerce("payments", {
    plan_id: p2[0].id, contract_id: c2.id, amount: 142400, pay_date: "2026-10-19",
    method: "转账", voucher_no: "PZ20261019003", operator: "李经理", remark: "预付 40%"
  }));
  [
    ["2026-10-20", "开工交底", 10, "核对图纸，确认停水停电窗口期"],
    ["2026-10-31", "喷淋主管更换完成", 45, "B栋 1-3 层主管更换并打压试验合格"],
    ["2026-11-04", "报警主机升级完成", 70, "主机更换、点位调试、联动测试"]
  ].forEach((g) => store.insert("progress_logs", coerce("progress_logs", {
    contract_id: c2.id, log_date: g[0], title: g[1], progress: g[2], content: g[3], operator: "刘工"
  })));

  // 已完成合同
  const c3 = store.insert("contracts", coerce("contracts", {
    contract_no: "HT-2026-003", name: "C栋给排水管道更换",
    contractor: "广州通源管道工程有限公司", contact: "王工", phone: "13900139003",
    category: "repair", sign_date: "2026-06-05", start_date: "2026-06-10", end_date: "2026-07-20",
    amount: 128000, retention_rate: 5, progress: 100, status: "settled",
    remark: "已竣工验收并结算"
  }));
  const p3 = buildPlans(c3, [
    { name: "首付款", ratio: 40, trigger_type: "sign", trigger_value: "", due_date: "2026-06-12", status: "paid", paid_date: "2026-06-11", paid_amount: 51200 },
    { name: "竣工款", ratio: 55, trigger_type: "progress", trigger_value: "100", due_date: "2026-07-25", status: "paid", paid_date: "2026-07-26", paid_amount: 70400 },
    { name: "质保金", ratio: 5, trigger_type: "progress", trigger_value: "100", due_date: "2027-07-20", status: "pending" }
  ]);
  [
    { plan: p3[0], amount: 51200, date: "2026-06-11" },
    { plan: p3[1], amount: 70400, date: "2026-07-26" }
  ].forEach((x) => store.insert("payments", coerce("payments", {
    plan_id: x.plan.id, contract_id: c3.id, amount: x.amount, pay_date: x.date,
    method: "转账", voucher_no: "PZ" + x.date.replace(/-/g, "") + "0" + x.plan.seq,
    operator: "李经理", remark: ""
  })));

  // 抄表 + 账单（2026-10）
  const period = "2026-10";
  shops.filter((s) => s.status === "rented").forEach((s, i) => {
    const wu = 12 + i * 3.5;
    const eu = 320 + i * 145;
    const rd = store.insert("readings", coerce("readings", {
      shop_id: s.id, period,
      water_prev: 1200 + i * 40, water_curr: 1200 + i * 40 + wu,
      elec_prev: 8600 + i * 300, elec_curr: 8600 + i * 300 + eu,
      water_price: s.water_price, elec_price: s.elec_price,
      water_usage: r2(wu), elec_usage: r2(eu),
      water_fee: r2(wu * (Number(s.water_price) || 0)),
      elec_fee: r2(eu * (Number(s.elec_price) || 0)),
      read_date: "2026-10-31", remark: ""
    }));
    const rent = r2((Number(s.area) || 0) * (Number(s.rent_price) || 0));
    const total = r2(rent + Number(rd.water_fee) + Number(rd.elec_fee));
    store.insert("bills", coerce("bills", {
      shop_id: s.id, period, rent_amount: rent,
      water_amount: rd.water_fee, elec_amount: rd.elec_fee,
      other_amount: 0, total, status: i < 3 ? "paid" : "unpaid",
      paid_date: i < 3 ? "2026-11-05" : "", remark: ""
    }));
  });

  // 设备保养记录示例（1.15.0）：覆盖已完成 / 保养中 / 已延期三种状态，便于直接体验编辑
  const seedLog = (eq, type, daysAgo, content, cost, operator, st, next) =>
    store.insert("equipment_logs", coerce("equipment_logs", {
      equipment_id: eq.id, type, log_date: addDays(todayStr(), -daysAgo),
      content, cost, operator, maintain_status: st,
      next_maintain: next || "", created_at: nowISO()
    }));
  seedLog(eqs[0], "maintain", 18, "季度保养：清洗滤网、检查冷媒压力与排水管", 680, "李工", "done", eqs[0].next_maintain);
  seedLog(eqs[1], "maintain", 5, "月度保养进行中：更换皮带，待复检", 0, "王工", "doing", eqs[1].next_maintain);
  seedLog(eqs[3], "inspect", 2, "日常巡检：运行参数正常", 0, "王工", "done", "");
  seedLog(eqs[6], "maintain", 30, "保养计划因备件未到货顺延", 0, "李工", "postponed", eqs[6].next_maintain);
  store.update("equipments", eqs[1].id, { maintain_status: "doing" });
  store.update("equipments", eqs[6].id, { maintain_status: "postponed" });

  // 1.18.0：商铺装修 / 维修进度示例（每条进度都会回算商铺状态与百分比）
  const seedWork = (shop, type, rows) => {
    for (const x of rows) {
      store.insert("shop_progress_logs", coerce("shop_progress_logs", {
        shop_id: shop.id, type, log_date: x[0], title: x[1], progress: x[2],
        status: x[3], content: x[4], operator: x[5], created_at: nowISO()
      }));
    }
    recomputeShopWork(shop.id, type);
  };
  seedWork(shops[0], "decoration", [
    ["2026-03-06", "装修进场", 15, "doing", "租户进场装修，水电点位确认", "李工"],
    ["2026-03-28", "竣工验收通过", 100, "done", "消防与用电验收合格，装修押金退还", "李工"]
  ]);
  seedWork(shops[2], "decoration", [
    ["2026-10-12", "进场放线", 10, "doing", "新租户装修方案审批通过，现场放线", "王工"],
    ["2026-10-26", "隔墙与水电预埋", 45, "doing", "轻钢龙骨隔墙完成，水电管线预埋 70%", "王工"],
    ["2026-11-06", "地砖铺贴完成", 65, "doing", "地砖铺贴完成，等待木作与油漆进场", "王工"]
  ]);
  seedWork(shops[6], "decoration", [
    ["2026-11-07", "装修报备受理", 0, "planned", "图纸已收，等待物业审批开工", "李工"]
  ]);
  seedWork(shops[4], "repair", [
    ["2026-10-30", "渗漏勘查", 10, "doing", "二层顶面渗水，已定位屋面防水层破损点", "陈工"],
    ["2026-11-05", "防水层修补", 40, "doing", "屋面局部防水层铲除重做，闭水试验待复查", "陈工"]
  ]);
  seedWork(shops[1], "repair", [
    ["2026-09-12", "卷帘门故障报修", 5, "doing", "卷帘门电机异响，已联系厂家", "王工"],
    ["2026-09-18", "更换电机并验收", 100, "done", "更换电机与限位器，试运行正常", "王工"]
  ]);

  // 1.18.0：档案台账与借阅记录示例
  const archiveSeed = [
    ["DA-2026-001", "A栋外墙翻新工程施工合同", "contract", "contracts", c1.id, "2026-09-22", "档案室 A-01", "internal", "filed", "", 1],
    ["DA-2026-002", "B栋消防系统改造竣工图", "drawing", "contracts", c2.id, "2026-11-02", "档案室 B-03", "internal", "filed", "", 3],
    ["DA-2026-003", "C栋给排水管道竣工验收资料", "acceptance", "contracts", c3.id, "2026-07-25", "档案室 B-05", "internal", "filed", "", 2],
    ["DA-2026-004", "物业服务营业执照副本", "license", "", null, "2026-01-10", "档案室 保险柜", "secret", "filed", "2027-01-09", 1],
    ["DA-2026-005", "消防应急预案与备案回执", "license", "", null, "2026-02-18", "档案室 A-08", "internal", "filed", "2026-12-31", 1],
    ["DA-2026-006", "中央空调主机合格证与说明书", "equipment", "equipments", eqs[0].id, "2024-06-01", "档案室 C-02", "normal", "filed", "", 1],
    ["DA-2026-007", "一层101 租赁合同及附件", "shop", "shops", shops[0].id, "2026-01-05", "档案室 A-12", "secret", "borrowed", "2026-12-31", 1],
    ["DA-2026-008", "2025 年度设备巡检汇总表", "other", "", null, "2026-01-20", "档案室 C-09", "normal", "sealed", "", 1]
  ];
  const archives = archiveSeed.map((a) => store.insert("archives", coerce("archives", {
    code: a[0], title: a[1], category: a[2], entity: a[3], entity_id: a[4],
    archive_date: a[5], keeper: "档案管理员", location: a[6], security: a[7],
    status: a[8], expiry: a[9], qty: a[10], remark: "", created_at: nowISO()
  })));
  store.insert("archive_logs", coerce("archive_logs", {
    archive_id: archives[6].id, type: "borrow", person: "招商部 林经理",
    log_date: addDays(todayStr(), -3), due_date: addDays(todayStr(), 4),
    purpose: "租户续约核对租期与押金条款", remark: "", created_at: nowISO()
  }));
  store.insert("archive_logs", coerce("archive_logs", {
    archive_id: archives[1].id, type: "borrow", person: "工程部 陈工",
    log_date: addDays(todayStr(), -18), due_date: addDays(todayStr(), -11),
    purpose: "消防改造复核", remark: "", created_at: nowISO()
  }));
  store.insert("archive_logs", coerce("archive_logs", {
    archive_id: archives[1].id, type: "return", person: "工程部 陈工",
    log_date: addDays(todayStr(), -12), due_date: "", purpose: "图纸已归还并核对无误",
    remark: "", created_at: nowISO()
  }));
  for (const a of archives) recomputeArchiveStatus(a.id);

  // 1.18.0：仓库物料与出入库流水示例
  // [编号, 名称, 分类, 规格, 单位, 目标结存, 安全库存, 单价, 库位, 供应商, 期初库存]
  // 期初库存 = 目标结存 - 下方示例流水的净变动，保证重算后结存与展示值一致
  const itemSeed = [
    ["WL-001", "LED 平板灯 600×600", "electric", "18W / 220V", "盏", 42, 20, 38, "A区-01", "佛山照明", 28],
    ["WL-002", "消防烟感探测器", "fire", "JTY-GD-G3", "只", 16, 12, 12.5, "A区-03", "海湾", 10],
    ["WL-003", "铜芯电缆 3×2.5mm²", "electric", "ZR-YJV", "米", 8, 50, 12.8, "B区-02", "珠江电缆", 38],
    ["WL-004", "不锈钢膨胀螺栓 M8", "hardware", "M8×80", "套", 260, 100, 0.85, "C区-05", "固特", 260],
    ["WL-005", "PVC 直接头 DN25", "hardware", "DN25", "个", 130, 80, 1.2, "C区-06", "联塑", 130],
    ["WL-006", "洗手液（10L 装）", "cleaning", "10L/桶", "桶", 6, 8, 58, "D区-01", "蓝月亮", 6],
    ["WL-007", "保洁垃圾袋（大号）", "consumable", "80×100cm 50只/包", "包", 24, 20, 16.5, "D区-03", "本地供应商", 24],
    ["WL-008", "数字万用表", "tool", "UT61E", "台", 3, 2, 420, "工具架-01", "优利德", 3],
    ["WL-009", "冲击钻 26mm", "tool", "GBH2-26", "台", 2, 1, 890, "工具架-02", "博世", 2],
    ["WL-010", "空调过滤网", "spare", "GMV 专用", "片", 30, 10, 45, "B区-08", "格力", 30],
    ["WL-011", "消火栓水带 25m", "fire", "DN65", "条", 10, 8, 95, "A区-09", "天河消防", 13],
    ["WL-012", "润滑机油 4L", "other", "5W-30", "桶", 4, 3, 128, "D区-07", "长城", 4]
  ];
  const items = itemSeed.map((x) => store.insert("warehouse_items", coerce("warehouse_items", {
    code: x[0], name: x[1], category: x[2], spec: x[3], unit: x[4],
    quantity: x[10], opening: x[10], min_stock: x[6], max_stock: r2(x[5] * 3),
    unit_price: x[7], location: x[8], supplier: x[9], status: "normal",
    remark: "", created_at: nowISO()
  })));
  const seedWhRec = (it, type, qty, date, person, purpose) => store.insert("warehouse_records",
    coerce("warehouse_records", {
      item_id: it.id, type, quantity: qty, unit_price: it.unit_price,
      amount: r2(qty * (Number(it.unit_price) || 0)), balance: 0,
      log_date: date, person, related: "", purpose, remark: "", created_at: nowISO()
    }));
  seedWhRec(items[0], "in", 20, addDays(todayStr(), -25), "仓管员 赵姐", "季度补货");
  seedWhRec(items[0], "out", 6, addDays(todayStr(), -9), "工程部 王工", "A栋二层灯具更换");
  seedWhRec(items[1], "in", 10, addDays(todayStr(), -18), "仓管员 赵姐", "消防备件补充");
  seedWhRec(items[1], "out", 4, addDays(todayStr(), -4), "工程部 陈工", "B栋烟感故障更换");
  seedWhRec(items[2], "out", 30, addDays(todayStr(), -6), "工程部 李工", "配电房线路改造");
  seedWhRec(items[5], "in", 10, addDays(todayStr(), -12), "仓管员 赵姐", "清洁用品月度采购");
  seedWhRec(items[5], "adjust", 6, addDays(todayStr(), -2), "仓管员 赵姐", "月度盘点核对");
  seedWhRec(items[10], "out", 3, addDays(todayStr(), -15), "工程部 陈工", "消防演练损耗补充");
  for (const it of items) recomputeWarehouseStock(it.id);

  store.metaSet("seeded", "1");
  console.log("[seed] done");
}

// 按当前抄表记录重算某商铺某账期的水电费，并同步未收款账单（1.14.0）
// 已收款账单金额保持历史原值，避免改写收款事实。
function syncBillUtilities(shopId, period) {
  const bills = store.list("bills", { shop_id: Number(shopId), period })
    .filter((b) => b.status !== "paid");
  if (!bills.length) return [];
  const reads = store.list("readings", { shop_id: Number(shopId) })
    .filter((r) => r.period === period);
  const water = r2(reads.reduce((n, r) => n + (Number(r.water_fee) || 0), 0));
  const elec = r2(reads.reduce((n, r) => n + (Number(r.elec_fee) || 0), 0));
  return bills.map((b) => store.update("bills", b.id, {
    water_amount: water,
    elec_amount: elec,
    total: r2((Number(b.rent_amount) || 0) + water + elec + (Number(b.other_amount) || 0))
  }));
}

/* ---------------- 设备保养记录（1.15.0） ---------------- */
function validateEqLog(row) {
  if (!EQ_LOG_TYPES.has(row.type)) return "记录类型不合法";
  if (!isDateStr(row.log_date)) return "日期格式应为 YYYY-MM-DD";
  if (!String(row.content || "").trim()) return "处理内容不能为空";
  if (row.cost != null && Number(row.cost) < 0) return "费用不能为负数";
  if (!MAINTAIN_STATES.has(row.maintain_status)) return "保养状态不合法";
  if (row.next_maintain && !isDateStr(row.next_maintain)) return "下次保养日期格式应为 YYYY-MM-DD";
  return null;
}

/** 一条保养记录是否为该设备最新的一条（用于只让最新记录影响设备当前状态） */
function isLatestMaintainLog(eqId, log) {
  if (!log || log.type !== "maintain") return false;
  const others = store.list("equipment_logs", { equipment_id: Number(eqId) })
    .filter((x) => x.type === "maintain" && Number(x.id) !== Number(log.id));
  return others.every((o) => {
    const a = String(o.log_date || ""), b = String(log.log_date || "");
    return a < b || (a === b && Number(o.id) < Number(log.id));
  });
}

/** 删除最新保养记录后，按剩余最新一条回退设备保养状态；无记录则恢复按日期自动 */
function recomputeEqMaintain(eqId) {
  const rows = store.list("equipment_logs", { equipment_id: Number(eqId) })
    .filter((l) => l.type === "maintain")
    .sort((a, b) => String(b.log_date || "").localeCompare(String(a.log_date || "")) || (b.id - a.id));
  const st = rows.length && MAINTAIN_STATES.has(rows[0].maintain_status) ? rows[0].maintain_status : "";
  return store.update("equipments", eqId, { maintain_status: st });
}

/* ---------------- 1.18.0：商铺装修 / 维修进度 ---------------- */
function validateShopWorkLog(row) {
  if (!SHOP_WORK_TYPES.has(row.type)) return "进度类型只能是装修或维修";
  if (!SHOP_WORK_STATES.has(row.status)) return "状态不合法";
  if (!isDateStr(row.log_date)) return "日期格式应为 YYYY-MM-DD";
  if (!String(row.title || "").trim() && !String(row.content || "").trim()) return "请填写进度标题或说明";
  const p = Number(row.progress);
  if (!Number.isFinite(p) || p < 0 || p > 100) return "进度须为 0 ~ 100 之间的整数";
  return null;
}

/** 按「装修 / 维修」分别把最新一条进度记录回算到商铺状态与百分比 */
function recomputeShopWork(shopId, type) {
  const shop = store.get("shops", shopId);
  if (!shop || !SHOP_WORK_TYPES.has(type)) return null;
  const rows = store.list("shop_progress_logs", { shop_id: Number(shopId) })
    .filter((l) => l.type === type)
    .sort((a, b) => String(a.log_date || "").localeCompare(String(b.log_date || "")) || (a.id - b.id));
  const last = rows[rows.length - 1];
  const patch = type === "decoration"
    ? { decoration_status: last ? last.status : "none", decoration_progress: last ? clampProgress(last.progress) : 0 }
    : { repair_status: last ? last.status : "none", repair_progress: last ? clampProgress(last.progress) : 0 };
  return store.update("shops", shopId, patch);
}

/* ---------------- 1.18.0：档案借阅 ---------------- */
function validateArchive(row) {
  if (row.category && !ARCHIVE_CATS.has(row.category)) return "档案分类不合法";
  if (row.status && !ARCHIVE_STATES.has(row.status)) return "档案状态不合法";
  if (row.entity && !ARCHIVE_ENTITIES.has(row.entity)) return "关联对象类型不合法";
  if (row.archive_date && !isDateStr(row.archive_date)) return "归档日期格式应为 YYYY-MM-DD";
  if (row.expiry && !isDateStr(row.expiry)) return "有效期格式应为 YYYY-MM-DD";
  if (row.qty != null && Number(row.qty) < 0) return "数量不能为负数";
  return null;
}
function validateArchiveLog(row) {
  if (!ARCHIVE_LOG_TYPES.has(row.type)) return "借阅记录类型不合法";
  if (!String(row.person || "").trim()) return "请填写借阅 / 归还人";
  if (!isDateStr(row.log_date)) return "日期格式应为 YYYY-MM-DD";
  if (row.due_date && !isDateStr(row.due_date)) return "应还日期格式应为 YYYY-MM-DD";
  return null;
}
/** 最新一条借阅 / 归还流水决定「在档 / 借出」；封存与作废状态为人工设定，不被覆盖 */
function recomputeArchiveStatus(archiveId) {
  const a = store.get("archives", archiveId);
  if (!a) return null;
  if (a.status === "sealed" || a.status === "void") return a;
  const rows = store.list("archive_logs", { archive_id: Number(archiveId) })
    .sort((x, y) => String(x.log_date || "").localeCompare(String(y.log_date || "")) || (x.id - y.id));
  const last = rows[rows.length - 1];
  return store.update("archives", archiveId, { status: last && last.type === "borrow" ? "borrowed" : "filed" });
}

/* ---------------- 1.18.0：仓库库存 ---------------- */
function whStep(before, rec) {
  const q = Number(rec.quantity) || 0;
  if (rec.type === "in") return { after: r2(before + q), delta: q };
  if (rec.type === "out") return { after: r2(before - q), delta: -q };
  return { after: r2(q), delta: r2(q - before) }; // adjust：q 为盘点后的实际结存
}
function whSorted(records) {
  return records.slice().sort((a, b) => String(a.log_date || "").localeCompare(String(b.log_date || ""))
    || (Number(a.id || 0) - Number(b.id || 0)));
}
/** 校验拟写入的全部流水：按时间顺序模拟，任何时点结存为负即拒绝 */
function validateWhHistory(item, records) {
  let bal = Number(item.opening) || 0;
  for (const r of whSorted(records)) {
    if (!WH_RECORD_TYPES.has(r.type)) return "出入库类型不合法";
    const q = Number(r.quantity);
    if (!Number.isFinite(q) || q < 0) return "数量须为不少于 0 的数字";
    if ((r.type === "in" || r.type === "out") && q <= 0) return "入库 / 出库数量必须大于 0";
    if (!isDateStr(r.log_date)) return "日期格式应为 YYYY-MM-DD";
    bal = whStep(bal, r).after;
    if (bal < 0) return `库存不足：${String(r.log_date || "")} 后结存将为 ${bal}`;
  }
  return null;
}
/** 按流水重算每条结存 / 金额与物料当前库存（新增、编辑、删除后统一调用） */
function recomputeWarehouseStock(itemId) {
  const item = store.get("warehouse_items", itemId);
  if (!item) return null;
  let bal = Number(item.opening) || 0;
  for (const r of whSorted(store.list("warehouse_records", { item_id: Number(itemId) }))) {
    const st = whStep(bal, r);
    bal = st.after;
    const amount = r2(Math.abs(st.delta) * (Number(r.unit_price) || Number(item.unit_price) || 0));
    if (Number(r.balance) !== bal || Number(r.amount) !== amount) {
      store.update("warehouse_records", r.id, { balance: bal, amount });
    }
  }
  return store.update("warehouse_items", itemId, { quantity: bal });
}
function validateWhItem(row) {
  if (row.category && !WH_CATS.has(row.category)) return "物料分类不合法";
  if (row.status && !WH_ITEM_STATES.has(row.status)) return "物料状态不合法";
  for (const k of ["quantity", "opening", "min_stock", "max_stock", "unit_price"]) {
    if (row[k] != null && Number(row[k]) < 0) return `${k} 不能为负数`;
  }
  return null;
}

/** 通用 CRUD 写入前：补默认值并做新模块的业务校验（返回错误文案，null 表示通过） */
function applyModuleDefaults(table, row, body, cur) {
  if (table === "buildings") {
    if (row.name != null) row.name = String(row.name).trim();
    if (row.code != null) row.code = String(row.code).trim();
    if (!cur) row.status = row.status || "active";
  }
  if (table === "shop_progress_logs") {
    row.type = row.type || "decoration";
    row.status = row.status || "doing";
    row.progress = row.progress == null ? 0 : clampProgress(row.progress);
    row.log_date = row.log_date || todayStr();
  }
  if (table === "archives" && !cur) {
    row.status = row.status || "filed";
    row.security = row.security || "internal";
    row.archive_date = row.archive_date || todayStr();
    row.qty = row.qty == null ? 1 : row.qty;
    row.entity = row.entity || "";
  }
  if (table === "archive_logs") {
    row.type = row.type || "borrow";
    row.log_date = row.log_date || todayStr();
  }
  if (table === "warehouse_items") {
    if (!cur) {
      row.opening = row.opening == null ? (Number(row.quantity) || 0) : row.opening;
      row.quantity = row.opening;
      row.status = row.status || "normal";
      row.unit = row.unit || "件";
      row.category = row.category || "other";
    } else if (body.opening === undefined) {
      delete row.quantity; // 当前库存由流水派生，不允许直接改写
    } else {
      row.quantity = row.opening;
    }
  }
  if (table === "warehouse_records") {
    row.type = row.type || "in";
    row.log_date = row.log_date || todayStr();
    row.quantity = Number(row.quantity) || 0;
    if (row.unit_price == null) {
      const item = store.get("warehouse_items", row.item_id);
      row.unit_price = item ? (Number(item.unit_price) || 0) : 0;
    }
    row.amount = 0; // 由 recomputeWarehouseStock 按实际变动量填写
    row.balance = 0;
  }
}

function validateModuleWrite(table, row, cur) {
  if (table === "buildings") {
    const m = cur ? Object.assign({}, cur, row) : row;
    const name = String(m.name || "").trim();
    if (!name) return "楼栋名称不能为空";
    if (name.length > 40) return "楼栋名称不超过 40 个字符";
    if (m.status && !BUILDING_STATES.has(m.status)) return "楼栋状态不合法";
    const dup = store.list("buildings")
      .some((b) => String(b.name || "").trim() === name && (!cur || Number(b.id) !== Number(cur.id)));
    if (dup) return `楼栋「${name}」已存在，请勿重复建档`;
    return null;
  }
  if (table === "shops") {
    const m = cur ? Object.assign({}, cur, row) : row;
    if (m.decoration_status && !SHOP_WORK_STATES.has(m.decoration_status)) return "装修状态不合法";
    if (m.repair_status && !SHOP_WORK_STATES.has(m.repair_status)) return "维修状态不合法";
    for (const k of ["decoration_progress", "repair_progress"]) {
      if (m[k] != null && (Number(m[k]) < 0 || Number(m[k]) > 100)) return "进度须为 0 ~ 100";
    }
    return null;
  }
  const m = cur ? Object.assign({}, cur, row) : row;
  if (table === "shop_progress_logs") return validateShopWorkLog(m);
  if (table === "archives") return validateArchive(m);
  if (table === "archive_logs") return validateArchiveLog(m);
  if (table === "warehouse_items") return validateWhItem(m);
  if (table === "warehouse_records") {
    const item = store.get("warehouse_items", m.item_id);
    if (!item) return "物料不存在";
    if (!WH_RECORD_TYPES.has(m.type)) return "出入库类型不合法";
    const others = store.list("warehouse_records", { item_id: Number(m.item_id) })
      .filter((r) => !cur || Number(r.id) !== Number(cur.id));
    const prospect = others.concat([Object.assign({}, m, { id: cur ? cur.id : Number.MAX_SAFE_INTEGER })]);
    return validateWhHistory(item, prospect);
  }
  return null;
}

/** 通用 CRUD 写入后：把进度 / 借阅 / 库存回算到主表，并返回刷新后的记录 */
function syncModuleAfterWrite(table, row, cur, method) {
  if (method === "DELETE") {
    if (table === "shop_progress_logs") {
      // 编辑时可能改过类型，两条业务线都回算一遍，避免旧类型残留状态
      for (const t of SHOP_WORK_TYPES) recomputeShopWork(row.shop_id, t);
    }
    if (table === "archive_logs") recomputeArchiveStatus(row.archive_id);
    if (table === "warehouse_records") recomputeWarehouseStock(row.item_id);
    return null;
  }
  // 1.26.0：楼栋改名时同步所属商铺的 building 文本，避免台账与商铺脱节
  if (table === "buildings" && cur && row.name && row.name !== cur.name) {
    const oldName = String(cur.name || "").trim();
    const newName = String(row.name || "").trim();
    const moved = store.list("shops", { building: oldName });
    moved.forEach((s) => store.update("shops", s.id, { building: newName }));
    console.log(`[buildings] rename "${oldName}" -> "${newName}", ${moved.length} shops synced`);
    return store.get(table, row.id);
  }
  if (table === "shop_progress_logs") {
    for (const t of SHOP_WORK_TYPES) recomputeShopWork(row.shop_id, t);
    return store.get(table, row.id);
  }
  if (table === "archive_logs") { recomputeArchiveStatus(row.archive_id); return store.get(table, row.id); }
  if (table === "warehouse_records") { recomputeWarehouseStock(row.item_id); return store.get(table, row.id); }
  if (table === "warehouse_items" && cur && row.opening !== undefined) {
    recomputeWarehouseStock(row.id);
    return store.get(table, row.id);
  }
  return row;
}

// ---------------- API 路由 ----------------
async function handleAPI(req, res, urlPath) {
  let route = urlPath.split("?")[0];
  if (route.startsWith(GATEWAY_PREFIX)) route = route.slice(GATEWAY_PREFIX.length);
  const qs = new URLSearchParams(urlPath.split("?")[1] || "");
  const seg = route.split("/").filter(Boolean); // ['api', ...]

  const session = getSession(req);
  // 登录用户优先；未登录时退回网关注入的用户名（仅用于日志展示）
  const user = session ? session.username : (req.headers["x-trim-username"] || "local");
  const me = session;
  const routeKey = seg.slice(1).join("/");

  if (seg[0] !== "api") return json(res, 404, { ok: false, error: "not found" });

  // ---------------- 鉴权 ----------------
  // 公开接口：登录、健康检查、OnlyOffice 取文件 / 回调（DocServer 无浏览器会话，改用短期签名 URL）
  const OO_PUBLIC_ROUTE = /^onlyoffice\/(file|callback)\//.test(routeKey);
  if (!me && routeKey !== "auth/login" && routeKey !== "health" && !OO_PUBLIC_ROUTE) {
    res.setHeader("WWW-Authenticate", 'Cookie realm="pmops"');
    return json(res, 401, { ok: false, error: "未登录或登录已过期", code: "UNAUTHORIZED" });
  }
  // 角色权限：只读账号禁止一切写操作（改自己密码除外）
  const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
  if (me && me.role === "viewer" && WRITE_METHODS.has(req.method) && routeKey !== "auth/logout" && routeKey !== "auth/password") {
    return json(res, 403, { ok: false, error: "只读账号没有操作权限，请联系管理员" });
  }
  // 用户管理仅管理员可用
  if (seg[1] === "users" && (!me || me.role !== "admin")) {
    return json(res, 403, { ok: false, error: "只有管理员可以管理用户" });
  }

  // ---------------- 登录 / 会话 ----------------
  if (seg[1] === "auth") {
    if (seg[2] === "login" && req.method === "POST") {
      const body = await readBody(req).catch(() => null);
      if (!body) return json(res, 400, { ok: false, error: "请求格式错误" });
      const u = findUser(body.username);
      if (!u || u.pass_hash !== hashPassword(body.password || "", u.salt || "")) {
        logAct(body.username || "?", "登录失败", "认证", String(body.username || "").slice(0, 80), "用户名或密码错误");
        return json(res, 401, { ok: false, error: "用户名或密码错误" });
      }
      if (u.enabled === "0") return json(res, 403, { ok: false, error: "该账号已被停用，请联系管理员" });
      store.update("users", u.id, { last_login: nowISO() });
      const token = createSession(u);
      res.setHeader("Set-Cookie", sessionCookieHeader(token, false));
      logAct(u.username, "登录", "认证", u.username, `角色：${ROLE_LABEL[u.role] || u.role}`);
      const info = publicUser(u);
      info.password_is_default = isDefaultAdminPassword(u);
      console.log(`[auth] login ${u.username} (${u.role})`);
      return json(res, 200, { ok: true, data: info });
    }
    if (seg[2] === "logout" && req.method === "POST") {
      if (me) logAct(me.username, "退出登录", "认证", me.username);
      destroySession(req);
      res.setHeader("Set-Cookie", sessionCookieHeader("", true));
      return json(res, 200, { ok: true });
    }
    if (seg[2] === "me" && req.method === "GET") {
      const u = findUser(me.username);
      const info = u ? publicUser(u) : { username: me.username, name: me.name, role: me.role };
      info.password_is_default = u ? isDefaultAdminPassword(u) : false;
      return json(res, 200, { ok: true, data: info });
    }
    if (seg[2] === "password" && (req.method === "PUT" || req.method === "POST")) {
      const body = await readBody(req).catch(() => null);
      if (!body) return json(res, 400, { ok: false, error: "请求格式错误" });
      const u = findUser(me.username);
      if (!u) return json(res, 404, { ok: false, error: "账号不存在" });
      if (u.pass_hash !== hashPassword(body.old_password || "", u.salt || "")) {
        return json(res, 400, { ok: false, error: "当前密码不正确" });
      }
      const npw = String(body.new_password || "");
      if (npw.length < 6) return json(res, 400, { ok: false, error: "新密码至少 6 位" });
      const salt = newSalt();
      store.update("users", u.id, { salt, pass_hash: hashPassword(npw, salt) });
      logAct(me.username, "修改密码", "认证", me.username);
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { ok: false, error: "接口不存在", route });
  }

  // ---------------- 用户管理（仅管理员） ----------------
  if (seg[1] === "users") {
    if (req.method === "GET" && !seg[2]) {
      return json(res, 200, { ok: true, data: store.list("users").map(publicUser) });
    }
    if (req.method === "POST" && !seg[2]) {
      const body = await readBody(req).catch(() => null);
      if (!body) return json(res, 400, { ok: false, error: "请求格式错误" });
      const username = String(body.username || "").trim();
      if (!/^[A-Za-z0-9_\-\u4e00-\u9fa5]{2,20}$/.test(username)) {
        return json(res, 400, { ok: false, error: "用户名须为 2-20 位字母 / 数字 / 汉字 / - _" });
      }
      if (findUser(username)) return json(res, 409, { ok: false, error: "用户名已存在" });
      const role = ROLES.includes(body.role) ? body.role : "operator";
      const pw = String(body.password || "");
      if (pw.length < 6) return json(res, 400, { ok: false, error: "初始密码至少 6 位" });
      const salt = newSalt();
      const saved = store.insert("users", coerce("users", {
        username, name: String(body.name || "").trim() || username,
        role, enabled: body.enabled === false || body.enabled === "0" ? "0" : "1",
        pass_hash: hashPassword(pw, salt), salt,
        remark: String(body.remark || "").slice(0, 200), created_at: nowISO()
      }));
      logAct(user, "新增用户", "用户管理", username, `角色：${ROLE_LABEL[role]}`);
      return json(res, 200, { ok: true, data: publicUser(saved) });
    }
    const uid = Number(seg[2]);
    const target = store.get("users", uid);
    if (!target) return json(res, 404, { ok: false, error: "用户不存在" });

    if (req.method === "PUT" || req.method === "PATCH") {
      const body = await readBody(req).catch(() => null);
      if (!body) return json(res, 400, { ok: false, error: "请求格式错误" });
      const patch = {};
      if (body.name !== undefined) patch.name = String(body.name).trim().slice(0, 40) || target.username;
      if (body.remark !== undefined) patch.remark = String(body.remark).slice(0, 200);
      if (body.role !== undefined) {
        if (!ROLES.includes(body.role)) return json(res, 400, { ok: false, error: "角色不正确" });
        // 保证系统里始终有至少一个启用的管理员
        const admins = store.list("users").filter((x) => x.role === "admin" && x.enabled !== "0" && x.id !== target.id);
        if (target.role === "admin" && target.enabled !== "0" && (body.role !== "admin" || body.enabled === "0" || body.enabled === false) && !admins.length) {
          return json(res, 400, { ok: false, error: "至少保留一个启用的管理员账号" });
        }
        patch.role = body.role;
      }
      if (body.enabled !== undefined) {
        const enabling = body.enabled === true || body.enabled === "1";
        if (target.id === uid && !enabling) return json(res, 400, { ok: false, error: "不能停用自己的账号" });
        const admins = store.list("users").filter((x) => x.role === "admin" && x.enabled !== "0" && x.id !== target.id);
        if (target.role === "admin" && target.enabled !== "0" && !enabling && !admins.length) {
          return json(res, 400, { ok: false, error: "至少保留一个启用的管理员账号" });
        }
        patch.enabled = enabling ? "1" : "0";
      }
      if (body.password) {
        const pw = String(body.password);
        if (pw.length < 6) return json(res, 400, { ok: false, error: "密码至少 6 位" });
        const salt = newSalt();
        patch.salt = salt;
        patch.pass_hash = hashPassword(pw, salt);
      }
      const row = store.update("users", uid, patch);
      logAct(user, "修改用户", "用户管理", target.username,
        body.password ? "（重置了密码）" : Object.keys(patch).join("、"));
      return json(res, 200, { ok: true, data: publicUser(row) });
    }

    if (req.method === "DELETE") {
      if (target.username === me.username) return json(res, 400, { ok: false, error: "不能删除当前登录的账号" });
      const admins = store.list("users").filter((x) => x.role === "admin" && x.enabled !== "0" && x.id !== target.id);
      if (target.role === "admin" && target.enabled !== "0" && !admins.length) {
        return json(res, 400, { ok: false, error: "至少保留一个启用的管理员账号" });
      }
      store.remove("users", uid);
      logAct(user, "删除用户", "用户管理", target.username);
      return json(res, 200, { ok: true });
    }
    return json(res, 405, { ok: false, error: "不支持的请求方法" });
  }

  // ---------------- 操作日志 ----------------
  if (seg[1] === "audit_logs") {
    if (req.method === "GET") {
      const all = store.list("audit_logs"); // 已按 id 倒序（最新在前）
      let rows = all;
      const q = (qs.get("q") || "").trim().toLowerCase();
      const fUser = qs.get("user") || "";
      const fModule = qs.get("module") || "";
      const days = Number(qs.get("days") || 0);
      if (days > 0) {
        const since = localStamp(new Date(Date.now() - days * 86400000));
        rows = rows.filter((r) => (r.ts || "") >= since);
      }
      if (fUser) rows = rows.filter((r) => r.user === fUser);
      if (fModule) rows = rows.filter((r) => r.module === fModule);
      if (q) rows = rows.filter((r) =>
        [r.user, r.action, r.module, r.target, r.detail].some((x) => String(x || "").toLowerCase().includes(q)));
      const limit = Math.min(1000, Math.max(1, Number(qs.get("limit") || 300)));
      const todayPrefix = todayStr();
      const weekSince = localStamp(new Date(Date.now() - 7 * 86400000));
      return json(res, 200, {
        ok: true,
        data: {
          rows: rows.slice(0, limit),
          total: rows.length,
          users: [...new Set(all.map((r) => r.user).filter(Boolean))],
          modules: [...new Set(all.map((r) => r.module).filter(Boolean))],
          stats: {
            today: all.filter((r) => String(r.ts || "").startsWith(todayPrefix)).length,
            week: all.filter((r) => (r.ts || "") >= weekSince).length,
            all: all.length
          }
        }
      });
    }
    if (req.method === "DELETE") {
      if (me.role !== "admin") return json(res, 403, { ok: false, error: "只有管理员可以清空日志" });
      const n = store.count("audit_logs");
      store.list("audit_logs").forEach((r) => store.remove("audit_logs", r.id));
      logAct(user, "清空日志", "操作日志", `共 ${n} 条`);
      return json(res, 200, { ok: true, removed: n });
    }
    return json(res, 405, { ok: false, error: "不支持的请求方法" });
  }

  // ---------------- 附件 ----------------
  // GET    /api/attachments?entity=contracts&id=3      列出附件
  // POST   /api/attachments?entity=contracts&id=3&name=a.jpg   请求体为文件二进制
  // GET    /api/attachments/9/raw[?download=1]         读取文件（1.22.0：PDF 支持 Range 内联预览）
  // GET    /api/attachments/9/preview                  1.22.0：表格 / 文本 / PDF 在线预览数据
  // DELETE /api/attachments/9                          删除附件
  if (seg[1] === "attachments") {
    const aid = seg[2];
    const sub = seg[3];

    // 1.22.0：预览数据接口（只读，登录后所有角色可用）
    if (req.method === "GET" && aid && sub === "preview") {
      const row = store.get("attachments", aid);
      if (!row) return json(res, 404, { ok: false, error: "附件不存在" });
      let data;
      try { data = previewAttachment(row); }
      catch (e) { return json(res, 400, { ok: false, error: "预览失败：" + e.message }); }
      return json(res, 200, { ok: true, data });
    }

    if (req.method === "GET" && aid && sub === "raw") {
      const row = store.get("attachments", aid);
      if (!row) return json(res, 404, { ok: false, error: "附件不存在" });
      const file = attachmentPath(row);
      if (!file || !fs.existsSync(file)) return json(res, 404, { ok: false, error: "附件文件已丢失" });
      const stat = fs.statSync(file);
      const download = qs.get("download") === "1";
      const mime = download ? "application/octet-stream" : attachMime(row);
      const disp = `${download ? "attachment" : "inline"}; filename="${encodeURIComponent(row.name)}"; filename*=UTF-8''${encodeURIComponent(row.name)}`;
      const head = {
        "Content-Type": mime,
        "Content-Disposition": disp,
        "Cache-Control": "private, max-age=604800",
        "Accept-Ranges": "bytes",
        "X-Content-Type-Options": "nosniff"
      };
      // 浏览器内置 PDF 阅读器会按 Range 分段取文件，必须正确返回 206
      const range = String(req.headers.range || "");
      const m = !download && /^bytes=(\d*)-(\d*)$/.exec(range);
      if (m) {
        let start = m[1] ? Number(m[1]) : 0;
        let end = m[2] ? Number(m[2]) : stat.size - 1;
        if (start >= stat.size || end < start) {
          res.writeHead(416, Object.assign({ "Content-Range": `bytes */${stat.size}` }, head));
          return res.end();
        }
        end = Math.min(end, stat.size - 1);
        res.writeHead(206, Object.assign({}, head, {
          "Content-Length": end - start + 1,
          "Content-Range": `bytes ${start}-${end}/${stat.size}`
        }));
        return fs.createReadStream(file, { start, end }).pipe(res);
      }
      res.writeHead(200, Object.assign({ "Content-Length": stat.size }, head));
      return fs.createReadStream(file).pipe(res);
    }

    if (req.method === "DELETE" && aid) {
      const row = store.get("attachments", aid);
      if (!row) return json(res, 404, { ok: false, error: "附件不存在" });
      removeAttachment(row);
      logAct(user, "删除附件", "附件", row.name, `${row.entity} #${row.entity_id}`);
      // 1.23.0：回传该记录删除后的最新附件列表，便于前端一次同步所有展示位
      return json(res, 200, { ok: true, data: attachmentsOf(row.entity, row.entity_id) });
    }

    if (req.method === "POST") {
      const entity = String(qs.get("entity") || "");
      const eid = Number(qs.get("id") || 0);
      if (!ATTACH_ENTITIES.has(entity)) return json(res, 400, { ok: false, error: "不支持的附件归属类型" });
      if (!eid || !store.get(entity, eid)) return json(res, 404, { ok: false, error: "归属记录不存在" });
      const name = cleanName(qs.get("name"));
      const ext = safeExt(name);
      const fileName = `${entity}_${eid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`;
      const dest = path.join(ATTACH_DIR, fileName);
      // 1.19.0：档案（含 CAD 图纸）不限制大小；1.26.0：楼栋 CAD 图纸同样不限大小，其余仍按 MAX_UPLOAD
      const unlimited = entity === "archives" || (entity === "buildings" && isCadExt(ext));
      const limit = unlimited ? Infinity : MAX_UPLOAD;
      let size = 0;
      try {
        size = await saveUpload(req, limit, dest);
      } catch (e) {
        return json(res, 413, { ok: false, error: e.message || "上传失败" });
      }
      if (!size) {
        try { fs.unlinkSync(dest); } catch (e) {}
        return json(res, 400, { ok: false, error: "文件内容为空" });
      }
      const row = store.insert("attachments", {
        entity, entity_id: eid, name,
        mime: String(req.headers["content-type"] || "application/octet-stream").split(";")[0].trim() || "application/octet-stream",
        size,
        file: "attachments/" + fileName,
        uploader: user,
        created_at: nowISO()
      });
      console.log(`[attach] +${size}B ${entity}#${eid} ${name} by ${user}`);
      logAct(user, "上传附件", "附件", name, `${entity} #${eid}`);
      return json(res, 200, { ok: true, data: row });
    }

    if (req.method === "GET") {
      const entity = String(qs.get("entity") || "");
      const eid = Number(qs.get("id") || 0);
      if (!ATTACH_ENTITIES.has(entity)) return json(res, 400, { ok: false, error: "不支持的附件归属类型" });
      return json(res, 200, { ok: true, data: attachmentsOf(entity, eid) });
    }

    return json(res, 405, { ok: false, error: "不支持的请求方法" });
  }

  /* ============================================================
     1.24.0：OnlyOffice 在线预览
     GET  /api/onlyoffice/status            测试 Document Server 连通性（需登录）
     GET  /api/onlyoffice/config/{id}      生成 DocEditor 配置（需登录）
     GET  /api/onlyoffice/file/{id}        DocServer 拉取原文件（公开，短期签名 token）
     POST /api/onlyoffice/callback/{id}    DocServer 关闭会话回调（公开，短期签名 token）
     ============================================================ */
  if (seg[1] === "onlyoffice") {
    const settings = getSettings();
    const sub = seg[2];
    const aid = seg[3];

    if (req.method === "GET" && sub === "status") {
      // 允许设置页用当前输入框里的地址直接「测试连接」，不必先保存整页设置
      const base = normalizeOoBase(qs.get("server")) || settings.oo_server;
      // 连通性结果放在 data 里，HTTP 层恒 ok:true，避免前端 api() 把「连不上」当成请求异常
      const out = (o) => json(res, 200, { ok: true, data: Object.assign({ server: base }, o) });
      if (!base) return out({ connected: false, error: "尚未填写 Document Server 地址" });
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 6000);
      try {
        let r = await fetch(base + "/healthcheck", { signal: ctl.signal });
        let probe = "healthcheck";
        if (!r.ok) {
          probe = "api.js";
          r = await fetch(base + "/web-apps/apps/api/documents/api.js", { signal: ctl.signal });
        }
        const detail = (await r.text()).trim().slice(0, 120);
        clearTimeout(timer);
        return out({
          connected: !!r.ok, status: r.status, probe, detail,
          error: r.ok ? "" : `Document Server 返回 ${r.status}`
        });
      } catch (e) {
        clearTimeout(timer);
        return out({
          connected: false,
          error: "无法连接：" + (e && e.name === "AbortError" ? "连接超时" : (e && e.message ? e.message : String(e)))
        });
      }
    }

    if (req.method === "GET" && sub === "config" && aid) {
      const row = store.get("attachments", aid);
      if (!row) return json(res, 404, { ok: false, error: "附件不存在" });
      if (settings.oo_enabled !== "1") return json(res, 400, { ok: false, error: "OnlyOffice 在线预览未启用，请先在「系统设置 → Office 在线预览」中开启" });
      if (!settings.oo_server) return json(res, 400, { ok: false, error: "尚未填写 Document Server 地址" });
      const ext = safeExt(row.name);
      if (!ooDocType(ext)) return json(res, 400, { ok: false, error: `${ext || "该文件"} 不属于 OnlyOffice 可预览的 Office 格式` });
      const file = attachmentPath(row);
      if (!file || !fs.existsSync(file)) return json(res, 404, { ok: false, error: "附件文件已丢失" });
      if (!ooPublicBase(req, settings)) return json(res, 400, { ok: false, error: "无法确定本应用对外地址，请在「系统设置 → Office 在线预览」填写「本应用对外地址」" });
      const cfg = onlyofficeConfig(row, req, settings, me);
      return json(res, 200, {
        ok: true,
        data: {
          server: settings.oo_server,
          script: settings.oo_server + "/web-apps/apps/api/documents/api.js",
          docType: ooDocType(ext),
          mode: "view",
          jwt: !!settings.oo_jwt_secret,
          config: cfg
        }
      });
    }

    // DocServer 反向取原文件：不带 Cookie，只认 config 里下发的短期签名
    if (req.method === "GET" && sub === "file" && aid) {
      if (!ooTokenOk(aid, qs.get("token"))) return json(res, 403, { ok: false, error: "预览链接无效或已过期，请重新打开附件" });
      const row = store.get("attachments", aid);
      if (!row) return json(res, 404, { ok: false, error: "附件不存在" });
      const file = attachmentPath(row);
      if (!file || !fs.existsSync(file)) return json(res, 404, { ok: false, error: "附件文件已丢失" });
      const stat = fs.statSync(file);
      const ext = safeExt(row.name);
      const head = {
        "Content-Type": OO_DOC_MIME[ext] || attachMime(row),
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(row.name)}`,
        "Cache-Control": "private, no-store",
        "Accept-Ranges": "bytes",
        "X-Content-Type-Options": "nosniff"
      };
      const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ""));
      if (m) {
        let start = m[1] ? Number(m[1]) : 0;
        let end = m[2] ? Number(m[2]) : stat.size - 1;
        if (start >= stat.size || end < start) {
          res.writeHead(416, Object.assign({ "Content-Range": `bytes */${stat.size}` }, head));
          return res.end();
        }
        end = Math.min(end, stat.size - 1);
        res.writeHead(206, Object.assign({}, head, {
          "Content-Length": end - start + 1,
          "Content-Range": `bytes ${start}-${end}/${stat.size}`
        }));
        return fs.createReadStream(file, { start, end }).pipe(res);
      }
      res.writeHead(200, Object.assign({ "Content-Length": stat.size }, head));
      return fs.createReadStream(file).pipe(res);
    }

    // 只读预览不产生保存动作，收到回调直接确认结束会话
    if (req.method === "POST" && sub === "callback" && aid) {
      req.resume();
      if (!ooTokenOk(aid, qs.get("token"))) return json(res, 403, { error: 1, message: "预览链接无效或已过期" });
      return json(res, 200, { error: 0 });
    }

    return json(res, 405, { ok: false, error: "不支持的请求方法" });
  }

  // 健康检查
  if (seg[1] === "health") {
    return json(res, 200, { ok: true, app: APP_NAME, store: store.info(), user, time: nowISO() });
  }

  // 元数据（前端下拉选项）
  if (seg[1] === "meta") {
    return json(res, 200, {
      ok: true,
      categories: exporter.CATEGORIES,
      shopStatus: [{ k: "rented", n: "在租" }, { k: "vacant", n: "空置" }, { k: "maintenance", n: "维修" }],
      eqStatus: [{ k: "normal", n: "正常" }, { k: "repair", n: "维修中" }, { k: "stopped", n: "停用" }],
      maintainStatus: [
        { k: "auto", n: "按日期自动" }, { k: "planned", n: "待保养" },
        { k: "doing", n: "保养中" }, { k: "done", n: "已完成" }, { k: "postponed", n: "已延期" }
      ],
      contractStatus: [
        { k: "draft", n: "草拟" }, { k: "ongoing", n: "施工中" },
        { k: "paused", n: "暂停" }, { k: "done", n: "已完工" }, { k: "settled", n: "已结算" }
      ],
      contractCategory: [{ k: "renovation", n: "改造" }, { k: "repair", n: "维修" }, { k: "new", n: "新建" }],
      triggerTypes: [{ k: "sign", n: "签约即付" }, { k: "progress", n: "按施工进度" }, { k: "date", n: "按约定日期" }],
      // 1.18.0 新增模块下拉选项
      shopWorkStatus: [
        { k: "none", n: "未开始" }, { k: "planned", n: "待开工" }, { k: "doing", n: "进行中" },
        { k: "done", n: "已完成" }, { k: "paused", n: "已暂停" }
      ],
      archiveCategory: [
        { k: "contract", n: "合同档案" }, { k: "drawing", n: "图纸资料" }, { k: "license", n: "证照文件" },
        { k: "acceptance", n: "验收资料" }, { k: "equipment", n: "设备资料" },
        { k: "shop", n: "商铺资料" }, { k: "other", n: "其他" }
      ],
      archiveStatus: [
        { k: "filed", n: "在档" }, { k: "borrowed", n: "借出" },
        { k: "sealed", n: "已封存" }, { k: "void", n: "已作废" }
      ],
      warehouseCategory: [
        { k: "tool", n: "工具" }, { k: "hardware", n: "五金" }, { k: "electric", n: "电气" },
        { k: "fire", n: "消防" }, { k: "cleaning", n: "清洁用品" }, { k: "consumable", n: "耗材" },
        { k: "spare", n: "备品备件" }, { k: "other", n: "其他" }
      ],
      warehouseRecordType: [
        { k: "in", n: "入库" }, { k: "out", n: "出库" }, { k: "adjust", n: "盘点调整" }
      ]
    });
  }

  // 概览
  if (seg[1] === "overview") {
    refreshDuePlans();
    return json(res, 200, { ok: true, data: overview() });
  }

  // 全量快照（前端一次拉取）
  if (seg[1] === "bootstrap") {
    refreshDuePlans();
    const contracts = store.list("contracts").map((c) => contractDetail(c.id));
    return json(res, 200, {
      ok: true,
      data: {
        buildings: store.list("buildings"), // 1.26.0：楼栋台账（商铺管理子页）
        shops: store.list("shops"),
        readings: store.list("readings"),
        bills: store.list("bills"),
        equipments: store.list("equipments"),
        equipment_logs: store.list("equipment_logs"),
        shop_progress_logs: store.list("shop_progress_logs"),
        archives: store.list("archives"),
        archive_logs: store.list("archive_logs"),
        warehouse_items: store.list("warehouse_items"),
        warehouse_records: store.list("warehouse_records"),
        contracts,
        payment_plans: store.list("payment_plans").sort((a, b) => (a.contract_id - b.contract_id) || (a.seq - b.seq)),
        payments: store.list("payments"),
        attachments: store.list("attachments"),
        overview: overview(),
        settings: publicSettings(), // 1.24.0：JWT 密钥不下发浏览器
        meta: {
          serverTime: nowISO(),
          user: me ? (() => {
            const mu = findUser(me.username);
            return {
              username: me.username, name: me.name, role: me.role,
              password_is_default: mu ? isDefaultAdminPassword(mu) : false
            };
          })() : { username: user },
          store: store.info(),
          app: { version: APP_VERSION, build: BUILD_DATE, developer: DEVELOPER },
          lan: {
            port: LAN_PORT,
            enabled: LAN_PORT > 0,
            urls: LAN_PORT > 0 ? lanAddresses().map((a) => "http://" + a.ip + ":" + LAN_PORT) : []
          }
        }
      }
    });
  }

  // ---------------- 应用设置 ----------------
  if (seg[1] === "settings") {
    if (seg[2] === "reset") {
      if (req.method !== "POST") return json(res, 405, { ok: false, error: "不支持的请求方法" });
      console.log(`[settings] reset by ${user}`);
      logAct(user, "恢复默认设置", "系统设置");
      resetSettings();
      return json(res, 200, { ok: true, data: publicSettings(), defaults: DEFAULT_SETTINGS });
    }
    if (req.method === "GET") {
      return json(res, 200, { ok: true, data: publicSettings(), defaults: DEFAULT_SETTINGS });
    }
    if (req.method === "PUT" || req.method === "POST") {
      const body = await readBody(req).catch(() => null);
      if (!body) return json(res, 400, { ok: false, error: "请求格式错误" });
      saveSettings(body);
      console.log(`[settings] saved by ${user}: 字段 ${Object.keys(body).join("、")}`);
      logAct(user, "修改设置", "系统设置", "", `字段：${Object.keys(body).join("、")}`);
      return json(res, 200, { ok: true, data: publicSettings() });
    }
    return json(res, 405, { ok: false, error: "不支持的请求方法" });
  }

  // ---------------- 关于 ----------------
  if (seg[1] === "about") {
    return json(res, 200, { ok: true, data: aboutInfo() });
  }

  // ---------------- 数据备份（全量 JSON 快照） ----------------
  if (seg[1] === "backup") {
    const payload = {
      app: APP_NAME,
      name: "物业工程管理",
      version: APP_VERSION,
      exported_at: nowISO(),
      store_engine: store.engine,
      settings: publicSettings(), // 1.24.0：备份文件同样不含 JWT 明文密钥
      data: {}
    };
    for (const t of TABLE_NAMES) payload.data[t] = store.list(t);
    const buf = Buffer.from(JSON.stringify(payload, null, 2), "utf8");
    const stamp = localStamp().slice(0, 16).replace(/[-:T]/g, "");
    const asciiName = `${APP_NAME}-backup-${stamp}.json`;
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": buf.length,
      "Content-Disposition": `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent("物业工程管理-数据备份-" + stamp + ".json")}`,
      "Cache-Control": "no-store"
    });
    res.end(buf);
    console.log(`[backup] ${buf.length}B by ${user}`);
    logAct(user, "下载数据备份", "系统设置", "", `${(buf.length / 1024).toFixed(0)} KB`);
    return;
  }

  // ---------------- Excel 导出 ----------------
  // GET /api/export?module=shops|equipments|contracts|payments|overview|all
  //   可选 filter：status、cat、id（导出「当前看到的数据」）
  // GET /api/export?module=shops&preview=1            1.22.0：先看表格，返回 JSON 而非 xlsx
  if (seg[1] === "export") {
    const moduleName = qs.get("module") || "all";
    const exportFilter = {
      status: qs.get("status") || "",
      cat: qs.get("cat") || "",
      overdue: qs.get("overdue") === "1",
      arrears: qs.get("arrears") === "1",
      maintain: qs.get("maintain") || "",
      low: qs.get("low") === "1",
      work: qs.get("work") || "",
      repair: qs.get("repair") === "1",
      building: qs.get("building") || "", // 1.26.0：按楼栋筛选商铺台账
      remindDays: Number(getSettings().maintain_remind_days) || 0,
      id: qs.get("id") ? Number(qs.get("id")) : 0
    };
    refreshDuePlans();
    if (qs.get("preview") === "1") {
      try {
        const data = exporter.previewSheets(store, moduleName, exportFilter, qs.get("limit"));
        return json(res, 200, { ok: true, data });
      } catch (e) {
        return json(res, 400, { ok: false, error: "预览失败：" + e.message });
      }
    }
    try {
      const out = exporter.buildWorkbook(store, moduleName, exportFilter);
      const asciiName = `${APP_NAME}-${moduleName}-${todayStr().replace(/-/g, "")}.xlsx`;
      res.writeHead(200, {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Length": out.buffer.length,
        "Content-Disposition": `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(out.filename)}`,
        "Cache-Control": "no-store",
        "X-Export-Sheets": String(out.sheetCount)
      });
      res.end(out.buffer);
      console.log(`[export] module=${out.module} sheets=${out.sheetCount} size=${out.buffer.length} user=${user}`);
      logAct(user, "导出 Excel", "导出", out.module, `${out.sheetCount} 张工作表 · ${(out.buffer.length / 1024).toFixed(0)} KB`);
    } catch (e) {
      console.log("[export] failed:", e.message);
      return json(res, 400, { ok: false, error: "导出失败：" + e.message });
    }
    return;
  }

  const table = seg[1];
  const id = seg[2];
  const action = seg[3];

  // ---- 商铺：抄表 ----
  if (table === "shops" && id && action === "readings" && req.method === "POST") {
    const shop = store.get("shops", id);
    if (!shop) return json(res, 404, { ok: false, error: "商铺不存在" });
    const body = await readBody(req).catch(() => null);
    if (!body) return json(res, 400, { ok: false, error: "请求格式错误" });
    const row = coerce("readings", {
      ...body,
      shop_id: shop.id,
      water_price: body.water_price != null && body.water_price !== "" ? body.water_price : shop.water_price,
      elec_price: body.elec_price != null && body.elec_price !== "" ? body.elec_price : shop.elec_price
    });
    if (row.water_prev == null || row.water_curr == null || row.elec_prev == null || row.elec_curr == null) {
      return json(res, 400, { ok: false, error: "水表、电表的期初/期末读数都必须填写" });
    }
    if (row.water_curr < row.water_prev || row.elec_curr < row.elec_prev) {
      return json(res, 400, { ok: false, error: "期末读数不能小于期初读数" });
    }
    row.water_usage = r2(row.water_curr - row.water_prev);
    row.elec_usage = r2(row.elec_curr - row.elec_prev);
    row.water_fee = r2(row.water_usage * (Number(row.water_price) || 0));
    row.elec_fee = r2(row.elec_usage * (Number(row.elec_price) || 0));
    row.read_date = row.read_date || todayStr();
    row.created_at = nowISO();
    const savedReading = store.insert("readings", row);
    logAct(user, "录入抄表", "商铺", shop.name || shop.code,
      `${row.period} 水费 ${row.water_fee} 元 · 电费 ${row.elec_fee} 元`);
    return json(res, 200, { ok: true, data: savedReading });
  }

  // ---- 商铺：生成账单 ----
  if (table === "shops" && id && action === "bills" && req.method === "POST") {
    const shop = store.get("shops", id);
    if (!shop) return json(res, 404, { ok: false, error: "商铺不存在" });
    const body = await readBody(req).catch(() => ({}));
    const period = (body.period || "").trim();
    if (!/^\d{4}-\d{2}$/.test(period)) return json(res, 400, { ok: false, error: "账期格式应为 YYYY-MM" });
    const exists = store.list("bills", { shop_id: shop.id }).find((b) => b.period === period);
    if (exists) return json(res, 409, { ok: false, error: `${period} 账单已存在` });
    const reads = store.list("readings", { shop_id: shop.id }).filter((r) => r.period === period);
    const water = reads.reduce((s, r) => s + (Number(r.water_fee) || 0), 0);
    const elec = reads.reduce((s, r) => s + (Number(r.elec_fee) || 0), 0);
    const rent = r2(shopMonthlyRent(shop));
    const other = Number(body.other_amount) || 0;
    const row = coerce("bills", {
      shop_id: shop.id, period,
      rent_amount: rent, water_amount: r2(water), elec_amount: r2(elec),
      other_amount: r2(other), total: r2(rent + water + elec + other),
      status: "unpaid", paid_date: "", remark: body.remark || ""
    });
    row.created_at = nowISO();
    const savedBill = store.insert("bills", row);
    logAct(user, "生成账单", "商铺", shop.name || shop.code, `${period} 合计 ${row.total} 元`);
    return json(res, 200, { ok: true, data: savedBill });
  }

  // ---- 1.18.0：商铺装修 / 维修状态快捷编辑（可同时补一条进度记录） ----
  if (table === "shops" && id && action === "work" && (req.method === "PUT" || req.method === "POST")) {
    const shop = store.get("shops", id);
    if (!shop) return json(res, 404, { ok: false, error: "商铺不存在" });
    const body = await readBody(req).catch(() => null);
    if (!body || typeof body !== "object") return json(res, 400, { ok: false, error: "请求格式错误" });
    const type = String(body.type || "");
    if (!SHOP_WORK_TYPES.has(type)) return json(res, 400, { ok: false, error: "进度类型只能是装修或维修" });
    const status = String(body.status || "");
    if (!SHOP_WORK_STATES.has(status)) return json(res, 400, { ok: false, error: "状态不合法" });
    const progress = clampProgress(body.progress);
    const note = String(body.note || "").trim();
    let log = null;
    if (note || body.add_log === true || String(body.add_log) === "1") {
      const row = coerce("shop_progress_logs", {
        shop_id: shop.id, type, log_date: body.log_date || todayStr(),
        title: String(body.title || "").trim() || `${type === "decoration" ? "装修" : "维修"}进度更新`,
        progress, status, content: note || `状态调整为 ${status}，进度 ${progress}%`,
        operator: String(body.operator || user || ""), created_at: nowISO()
      });
      const err = validateShopWorkLog(row);
      if (err) return json(res, 400, { ok: false, error: err });
      log = store.insert("shop_progress_logs", row);
    }
    const patch = type === "decoration"
      ? { decoration_status: status, decoration_progress: progress }
      : { repair_status: status, repair_progress: progress };
    const updated = store.update("shops", id, patch);
    logAct(user, "更新商铺进度", "商铺", shop.name || shop.code,
      `${type === "decoration" ? "装修" : "维修"} · ${status} ${progress}%${log ? " · 已补记进度" : ""}`);
    return json(res, 200, { ok: true, data: { shop: updated, log } });
  }

  // ---- 账单收款 ----
  if (table === "bills" && id && action === "pay" && req.method === "POST") {
    const bill = store.get("bills", id);
    if (!bill) return json(res, 404, { ok: false, error: "账单不存在" });
    const body = await readBody(req).catch(() => ({}));
    logAct(user, "账单收款", "商铺", `${bill.period} 账单`, `金额 ${bill.total} 元`);
    return json(res, 200, {
      ok: true,
      data: store.update("bills", bill.id, { status: "paid", paid_date: body.paid_date || todayStr() })
    });
  }

  // ---- 设备：新增记录 ----
  if (table === "equipments" && id && action === "logs" && req.method === "POST") {
    const eq = store.get("equipments", id);
    if (!eq) return json(res, 404, { ok: false, error: "设备不存在" });
    const body = await readBody(req).catch(() => null);
    if (!body || typeof body !== "object") return json(res, 400, { ok: false, error: "请求格式错误" });
    const row = coerce("equipment_logs", {
      ...body, equipment_id: eq.id, log_date: body.log_date || todayStr()
    });
    row.type = row.type || "inspect";
    row.maintain_status = body.maintain_status || "done";
    row.next_maintain = body.next_maintain || "";
    row.created_at = nowISO();
    const err = validateEqLog(row);
    if (err) return json(res, 400, { ok: false, error: err });
    const saved = store.insert("equipment_logs", row);
    const patch = {};
    if (body.resolve) patch.status = "normal";
    if (body.next_maintain) patch.next_maintain = String(body.next_maintain);
    if (isLatestMaintainLog(eq.id, saved)) patch.maintain_status = saved.maintain_status;
    if (Object.keys(patch).length) store.update("equipments", eq.id, patch);
    logAct(user, "新增设备记录", "设备", eq.name,
      `${row.type} ${row.log_date} · 保养状态 ${row.maintain_status} · ${row.content || ""}`.trim());
    return json(res, 200, { ok: true, data: saved, equipment: store.get("equipments", eq.id) });
  }

  // ---- 设备：快捷编辑保养状态（1.15.0） ----
  // 状态选「自动」时清空手动值，恢复由 next_maintain 日期派生；可同时写入一条保养记录留痕。
  if (table === "equipments" && id && action === "maintain" && ["PUT", "PATCH"].includes(req.method)) {
    const eq = store.get("equipments", id);
    if (!eq) return json(res, 404, { ok: false, error: "设备不存在" });
    const body = await readBody(req).catch(() => null);
    if (!body || typeof body !== "object") return json(res, 400, { ok: false, error: "请求格式错误" });
    const st = String(body.maintain_status || "auto");
    if (st !== "auto" && !MAINTAIN_STATES.has(st)) return json(res, 400, { ok: false, error: "保养状态不合法" });
    if (body.next_maintain && !isDateStr(body.next_maintain)) {
      return json(res, 400, { ok: false, error: "下次保养日期格式应为 YYYY-MM-DD" });
    }
    const patch = { maintain_status: st === "auto" ? "" : st };
    if (body.next_maintain) patch.next_maintain = String(body.next_maintain);
    const equipment = store.update("equipments", eq.id, patch);
    let log = null;
    if (String(body.add_log) === "1" && String(body.note || "").trim()) {
      const row = coerce("equipment_logs", {
        equipment_id: eq.id, type: "maintain", log_date: body.log_date || todayStr(),
        content: String(body.note).trim(), cost: 0, operator: user,
        maintain_status: st === "auto" ? "done" : st, next_maintain: body.next_maintain || ""
      });
      row.created_at = nowISO();
      log = store.insert("equipment_logs", row);
    }
    logAct(user, "修改保养状态", "设备", eq.name,
      `${st === "auto" ? "按日期自动" : st} · 下次保养 ${equipment.next_maintain || "未设置"}${log ? " · 已写入保养记录" : ""}`);
    return json(res, 200, { ok: true, data: equipment, log });
  }

  // ---- 合同：自定义付款计划（整表保存） ----
  if (table === "contracts" && id && action === "plans" && seg[4] === "batch" && req.method === "POST") {
    const c = store.get("contracts", id);
    if (!c) return json(res, 404, { ok: false, error: "合同不存在" });
    const body = await readBody(req).catch(() => null);
    if (!body || !Array.isArray(body.plans)) return json(res, 400, { ok: false, error: "付款计划格式错误" });
    const specs = body.plans.slice(0, 100);
    for (const s of specs) {
      if (!s || !String(s.name || "").trim() || !(Number(s.amount) > 0)) {
        return json(res, 400, { ok: false, error: "每期需填写节点名称与大于 0 的金额" });
      }
    }
    const rows = replaceContractPlans(c, specs);
    const sum = r2(rows.reduce((n, p) => n + (Number(p.amount) || 0), 0));
    logAct(user, "自定义付款计划", "项目合同管理", c.name, `${rows.length} 期 · 合计 ¥${sum}`);
    return json(res, 200, { ok: true, data: contractDetail(c.id) });
  }

  // ---- 合同：追加付款计划 ----
  if (table === "contracts" && id && action === "plans" && req.method === "POST") {
    const c = store.get("contracts", id);
    if (!c) return json(res, 404, { ok: false, error: "合同不存在" });
    const body = await readBody(req).catch(() => ({}));
    const created = buildPlans(c, [body]);
    logAct(user, "追加付款节点", "项目合同管理", c.name, `${created[0] ? created[0].name : ""} ${created[0] ? "¥" + r2(created[0].amount) : ""}`.trim());
    return json(res, 200, { ok: true, data: created[0] });
  }

  // ---- 合同：上报施工进度 ----
  if (table === "contracts" && id && action === "progress" && req.method === "POST") {
    const c = store.get("contracts", id);
    if (!c) return json(res, 404, { ok: false, error: "合同不存在" });
    const body = await readBody(req).catch(() => ({}));
    const progress = Math.max(0, Math.min(100, Number(body.progress)));
    if (!Number.isFinite(progress)) return json(res, 400, { ok: false, error: "请填写 0-100 的进度" });
    if (progress < (Number(c.progress) || 0)) {
      return json(res, 400, { ok: false, error: "进度不能回退（当前 " + (c.progress || 0) + "%）" });
    }
    const log = coerce("progress_logs", {
      contract_id: c.id,
      log_date: body.log_date || todayStr(),
      title: body.title || `进度更新至 ${progress}%`,
      progress,
      content: body.content || "",
      operator: body.operator || user
    });
    log.created_at = nowISO();
    store.insert("progress_logs", log);

    const patch = { progress };
    if (progress >= 100) patch.status = "done";
    else if (c.status === "draft") patch.status = "ongoing";
    store.update("contracts", c.id, patch);

    const unlocked = unlockPlans(c.id, progress);
    logAct(user, "上报进度", "项目合同管理", c.name, `${progress}%，解锁 ${unlocked && unlocked.length ? unlocked.length : 0} 个付款节点`);
    return json(res, 200, { ok: true, data: contractDetail(c.id), unlocked });
  }

  // ---- 付款计划：登记付款 ----
  if (table === "payment_plans" && id && action === "pay" && req.method === "POST") {
    const plan = store.get("payment_plans", id);
    if (!plan) return json(res, 404, { ok: false, error: "付款节点不存在" });
    if (plan.status === "paid") return json(res, 409, { ok: false, error: "该节点已支付" });
    const body = await readBody(req).catch(() => ({}));
    const amount = body.amount != null && body.amount !== "" ? Number(body.amount) : Number(plan.amount);
    if (!Number.isFinite(amount) || amount <= 0) return json(res, 400, { ok: false, error: "付款金额不正确" });
    const payDate = body.pay_date || todayStr();

    const payment = store.insert("payments", {
      plan_id: plan.id,
      contract_id: plan.contract_id,
      amount: r2(amount),
      pay_date: payDate,
      method: body.method || "转账",
      voucher_no: body.voucher_no || "",
      operator: body.operator || user,
      remark: body.remark || "",
      created_at: nowISO()
    });
    store.update("payment_plans", plan.id, {
      status: "paid", paid_date: payDate, paid_amount: r2(amount)
    });
    logAct(user, "登记付款", "项目付款台帐", `${plan.name}（${plan.seq}期）`, `¥${r2(amount)} · ${body.method || "转账"}`);
    return json(res, 200, { ok: true, data: payment, contract: contractDetail(plan.contract_id) });
  }

  // ---- 1.14.0：水电抄表 / 费用账单 的逐条编辑与删除 ----
  // 专用路由优先于通用 CRUD：编辑抄表会自动重算用量、费用，并同步同账期未收款账单；
  // 编辑账单会自动重算合计；删除抄表同样回写账单，保证欠费统计与概览始终准确。
  if ((table === "readings" || table === "bills") && id && !action
      && ["PUT", "PATCH", "DELETE"].includes(req.method)) {
    const isRead = table === "readings";
    const cur = store.get(table, id);
    if (!cur) return json(res, 404, { ok: false, error: `${isRead ? "抄表" : "账单"}记录不存在` });

    if (req.method === "DELETE") {
      store.remove(table, id);
      const synced = isRead ? syncBillUtilities(cur.shop_id, cur.period) : [];
      logAct(user, isRead ? "删除抄表" : "删除账单", "商铺",
        `${cur.period} ${isRead ? "抄表" : "账单"}`,
        isRead ? `同步 ${synced.length} 张未收款账单` : `金额 ${cur.total} 元`);
      return json(res, 200, { ok: true, data: { synced: synced.length } });
    }

    const body = await readBody(req).catch(() => null);
    if (!body || typeof body !== "object") {
      return json(res, 400, { ok: false, error: "请求格式错误" });
    }
    const shop = store.get("shops", cur.shop_id);
    const merged = coerce(table, { ...cur, ...body, shop_id: cur.shop_id });
    delete merged.created_at;

    if (isRead) {
      const unit = (key, fallback) => {
        if (body[key] !== undefined && body[key] !== "") return Number(merged[key]) || 0;
        if (cur[key] != null) return Number(cur[key]) || 0;
        return Number(fallback) || 0;
      };
      merged.water_price = unit("water_price", shop && shop.water_price);
      merged.elec_price = unit("elec_price", shop && shop.elec_price);
      const nums = [merged.water_prev, merged.water_curr, merged.elec_prev, merged.elec_curr];
      if (nums.some((v) => v == null || !Number.isFinite(Number(v)))) {
        return json(res, 400, { ok: false, error: "水表、电表的期初/期末读数都必须填写" });
      }
      if (Number(merged.water_curr) < Number(merged.water_prev)
        || Number(merged.elec_curr) < Number(merged.elec_prev)) {
        return json(res, 400, { ok: false, error: "期末读数不能小于期初读数" });
      }
      if (!/^\d{4}-\d{2}$/.test(String(merged.period || ""))) {
        return json(res, 400, { ok: false, error: "账期格式应为 YYYY-MM" });
      }
      merged.water_usage = r2(Number(merged.water_curr) - Number(merged.water_prev));
      merged.elec_usage = r2(Number(merged.elec_curr) - Number(merged.elec_prev));
      merged.water_fee = r2(merged.water_usage * merged.water_price);
      merged.elec_fee = r2(merged.elec_usage * merged.elec_price);
      merged.read_date = merged.read_date || todayStr();
    } else {
      if (!/^\d{4}-\d{2}$/.test(String(merged.period || ""))) {
        return json(res, 400, { ok: false, error: "账期格式应为 YYYY-MM" });
      }
      const dup = store.list("bills", { shop_id: cur.shop_id })
        .find((b) => b.period === merged.period && Number(b.id) !== Number(id));
      if (dup) return json(res, 409, { ok: false, error: `${merged.period} 账单已存在` });
      merged.total = r2(["rent_amount", "water_amount", "elec_amount", "other_amount"]
        .reduce((n, k) => n + (Number(merged[k]) || 0), 0));
      merged.status = merged.status === "paid" ? "paid" : "unpaid";
      merged.paid_date = merged.status === "paid" ? (merged.paid_date || todayStr()) : "";
    }

    const saved = store.update(table, id, merged);
    if (!saved) return json(res, 404, { ok: false, error: "not found" });
    let synced = [];
    if (isRead) {
      synced = syncBillUtilities(cur.shop_id, saved.period);
      if (cur.period !== saved.period) {
        synced = synced.concat(syncBillUtilities(cur.shop_id, cur.period));
      }
    }
    logAct(user, isRead ? "修改抄表" : "修改账单", "商铺", `${saved.period} ${isRead ? "抄表" : "账单"}`,
      isRead ? `水费 ${saved.water_fee} 元 · 电费 ${saved.elec_fee} 元 · 同步 ${synced.length} 张账单`
        : `合计 ${saved.total} 元 · ${saved.status === "paid" ? "已收" : "未收"}`);
    return json(res, 200, { ok: true, data: saved, synced: synced.length });
  }

  // ---- 1.15.0：设备维保 / 保养记录逐条编辑与删除 ----
  // 专用路由优先于通用 CRUD：编辑可修改保养状态、日期、内容与费用，并只让最新一条
  // 保养记录同步设备当前保养状态；删除最新记录后按剩余记录回退，避免覆盖手动设置。
  if (table === "equipment_logs" && id && !action && ["PUT", "PATCH", "DELETE"].includes(req.method)) {
    const cur = store.get("equipment_logs", id);
    if (!cur) return json(res, 404, { ok: false, error: "维保记录不存在" });
    const eq = store.get("equipments", cur.equipment_id);
    const eqName = eq ? eq.name : `设备 #${cur.equipment_id}`;

    if (req.method === "DELETE") {
      const wasLatest = isLatestMaintainLog(cur.equipment_id, cur);
      store.remove("equipment_logs", cur.id);
      let equipment = eq ? store.get("equipments", eq.id) : null;
      if (wasLatest && equipment) equipment = recomputeEqMaintain(eq.id);
      logAct(user, "删除设备记录", "设备", eqName,
        `${cur.type || "记录"} ${cur.log_date}${wasLatest ? " · 已按剩余记录回退保养状态" : ""}`);
      return json(res, 200, { ok: true, data: { equipment, recomputed: wasLatest } });
    }

    const body = await readBody(req).catch(() => null);
    if (!body || typeof body !== "object") return json(res, 400, { ok: false, error: "请求格式错误" });
    const merged = coerce("equipment_logs", { ...cur, ...body, equipment_id: cur.equipment_id });
    merged.created_at = cur.created_at;
    merged.type = merged.type || "inspect";
    merged.maintain_status = (body.maintain_status === undefined || body.maintain_status === "")
      ? (cur.maintain_status || "done") : String(body.maintain_status);
    merged.next_maintain = body.next_maintain === undefined ? (cur.next_maintain || "") : String(body.next_maintain || "");
    merged.log_date = merged.log_date || todayStr();
    const err = validateEqLog(merged);
    if (err) return json(res, 400, { ok: false, error: err });
    const saved = store.update("equipment_logs", cur.id, merged);

    const patch = {};
    if (body.resolve === true || String(body.resolve) === "1") patch.status = "normal";
    if (body.next_maintain) patch.next_maintain = String(body.next_maintain);
    const synced = isLatestMaintainLog(cur.equipment_id, saved);
    if (synced) patch.maintain_status = saved.maintain_status;
    if (Object.keys(patch).length && eq) store.update("equipments", eq.id, patch);

    logAct(user, "修改设备记录", "设备", eqName,
      `${saved.type} ${saved.log_date} · 保养状态 ${saved.maintain_status}${synced ? " · 已同步设备" : ""}`);
    return json(res, 200, {
      ok: true, data: saved, synced,
      equipment: eq ? store.get("equipments", eq.id) : null
    });
  }

  // ---- 通用 CRUD ----
  if (WRITABLE.has(table)) {
    if (req.method === "GET" && !id) {
      const filter = {};
      for (const [k, v] of qs.entries()) {
        if (k in SCHEMA[table].fields) filter[k] = v;
      }
      return json(res, 200, { ok: true, data: store.list(table, filter) });
    }
    if (req.method === "GET" && id) {
      if (table === "contracts") {
        const d = contractDetail(id);
        if (!d) return json(res, 404, { ok: false, error: "not found" });
        return json(res, 200, { ok: true, data: d });
      }
      const row = store.get(table, id);
      if (!row) return json(res, 404, { ok: false, error: "not found" });
      return json(res, 200, { ok: true, data: row });
    }
    if (req.method === "POST" && !id) {
      const body = await readBody(req).catch(() => null);
      if (!body) return json(res, 400, { ok: false, error: "请求格式错误" });
      const row = coerce(table, body);
      if (table === "shops") syncShopRentPrice(body, row, null);
      applyModuleDefaults(table, row, body, null);
      const err = validate(table, row, false) || validateModuleWrite(table, row, null);
      if (err) return json(res, 400, { ok: false, error: err });
      row.created_at = nowISO();
      const saved = store.insert(table, row);
      const synced = syncModuleAfterWrite(table, saved, null, "POST") || saved;

      // 合同创建时附带付款计划模板
      if (table === "contracts" && Array.isArray(body.plans) && body.plans.length) {
        buildPlans(saved, body.plans);
        logAct(user, "新增", SCHEMA[table].label, rowLabel(table, saved), `含 ${body.plans.length} 个付款计划节点`);
        return json(res, 200, { ok: true, data: contractDetail(saved.id) });
      }
      logAct(user, "新增", SCHEMA[table].label, rowLabel(table, saved));
      return json(res, 200, { ok: true, data: synced });
    }
    if ((req.method === "PUT" || req.method === "PATCH") && id) {
      const body = await readBody(req).catch(() => null);
      if (!body) return json(res, 400, { ok: false, error: "请求格式错误" });
      const cur = store.get(table, id);
      if (!cur) return json(res, 404, { ok: false, error: "not found" });
      const patch = coerce(table, body);
      if (table === "shops") syncShopRentPrice(body, patch, cur);
      applyModuleDefaults(table, patch, body, cur);
      delete patch.created_at;
      const err = validate(table, patch, true) || validateModuleWrite(table, patch, cur);
      if (err) return json(res, 400, { ok: false, error: err });
      const row = store.update(table, id, patch);
      if (!row) return json(res, 404, { ok: false, error: "not found" });
      const synced = syncModuleAfterWrite(table, row, cur, "PUT") || row;
      logAct(user, "修改", SCHEMA[table].label, rowLabel(table, row), `字段：${Object.keys(patch).join("、")}`);
      return json(res, 200, { ok: true, data: synced });
    }
    if (req.method === "DELETE" && id) {
      const delTarget = store.get(table, id);
      // 1.26.0：楼栋下仍有商铺时禁止删除，避免产生无归属楼栋的孤儿商铺
      if (table === "buildings" && delTarget) {
        const used = store.list("shops", { building: String(delTarget.name || "").trim() });
        if (used.length) {
          return json(res, 400, {
            ok: false,
            error: `楼栋「${delTarget.name}」下还有 ${used.length} 间商铺，请先在商铺中改到其他楼栋后再删除`
          });
        }
        removeAttachmentsOf("buildings", Number(id));
      }
      // 级联清理，保持数据一致
      if (table === "shops") {
        store.list("readings", { shop_id: Number(id) }).forEach((r) => store.remove("readings", r.id));
        store.list("bills", { shop_id: Number(id) }).forEach((b) => store.remove("bills", b.id));
        store.list("shop_progress_logs", { shop_id: Number(id) }).forEach((x) => store.remove("shop_progress_logs", x.id));
        removeAttachmentsOf("shops", Number(id));
      }
      if (table === "archives") {
        store.list("archive_logs", { archive_id: Number(id) }).forEach((x) => store.remove("archive_logs", x.id));
        removeAttachmentsOf("archives", Number(id));
      }
      if (table === "warehouse_items") {
        store.list("warehouse_records", { item_id: Number(id) }).forEach((x) => store.remove("warehouse_records", x.id));
        removeAttachmentsOf("warehouse_items", Number(id));
      }
      if (table === "contracts") {
        const plans = store.list("payment_plans", { contract_id: Number(id) });
        plans.forEach((p) => {
          store.list("payments", { plan_id: p.id }).forEach((x) => store.remove("payments", x.id));
          removeAttachmentsOf("payment_plans", p.id);
          store.remove("payment_plans", p.id);
        });
        store.list("payments", { contract_id: Number(id) }).forEach((x) => store.remove("payments", x.id));
        store.list("progress_logs", { contract_id: Number(id) }).forEach((x) => store.remove("progress_logs", x.id));
        removeAttachmentsOf("contracts", Number(id));
      }
      if (table === "equipments") {
        store.list("equipment_logs", { equipment_id: Number(id) }).forEach((x) => store.remove("equipment_logs", x.id));
        removeAttachmentsOf("equipments", Number(id));
      }
      if (table === "payment_plans") {
        store.list("payments", { plan_id: Number(id) }).forEach((x) => store.remove("payments", x.id));
        removeAttachmentsOf("payment_plans", Number(id));
      }
      store.remove(table, id);
      if (delTarget) syncModuleAfterWrite(table, delTarget, delTarget, "DELETE");
      logAct(user, "删除", SCHEMA[table].label, rowLabel(table, delTarget));
      return json(res, 200, { ok: true });
    }
  }

  return json(res, 404, { ok: false, error: "接口不存在", route });
}

// ---------------- 静态资源 ----------------
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json"
};

function serveStatic(req, res, urlPath) {
  const raw = urlPath.split("?")[0];
  let rel = raw;
  if (rel.startsWith(GATEWAY_PREFIX)) rel = rel.slice(GATEWAY_PREFIX.length);
  // 网关根路径补斜杠，保证页面内相对资源（echarts.min.js / api）解析正确；
  // 内网直连 http://<ip>:3340/ 直接托管首页，不做跳转
  if (raw === GATEWAY_PREFIX) {
    res.writeHead(302, { Location: GATEWAY_PREFIX + "/" }).end();
    return;
  }
  if (rel === "") rel = "/";
  try { rel = decodeURIComponent(rel); } catch (e) { rel = "/"; }

  if (rel.includes("..") || rel.includes("\0")) {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" }).end("Bad Request");
    return;
  }
  if (rel === "/" || rel === "") rel = "/index.html";

  const root = path.resolve(WWW_DIR);
  const target = path.resolve(path.join(root, rel));
  if (!(target === root || target.startsWith(root + path.sep))) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" }).end("Forbidden");
    return;
  }
  let stat;
  try { stat = fs.statSync(target); } catch (e) { stat = null; }
  if (!stat || !stat.isFile()) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("404 Not Found");
    return;
  }
  const ext = path.extname(target).toLowerCase();
  res.writeHead(200, {
    "Content-Type": MIME[ext] || "application/octet-stream",
    "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=3600",
    "X-Content-Type-Options": "nosniff"
  });
  fs.createReadStream(target).pipe(res);
}

// ---------------- 服务器 ----------------
const server = http.createServer((req, res) => {
  const urlPath = req.url || "/";
  const isAPI = urlPath === GATEWAY_PREFIX + "/api" || urlPath.startsWith("/api/") ||
    urlPath.startsWith(GATEWAY_PREFIX + "/api/");
  const fail = (e) => {
    console.log("[error]", e && e.stack ? e.stack : e);
    if (!res.headersSent) json(res, 500, { ok: false, error: "服务器内部错误" });
  };
  if (isAPI) {
    handleAPI(req, res, urlPath).catch(fail);
    return;
  }
  try { serveStatic(req, res, urlPath); } catch (e) { fail(e); }
});

seedIfEmpty();
ensureBuildings(); // 1.26.0：旧库按现有商铺楼栋自动建档
ensureAdminUser();
refreshDuePlans();

if (SOCKET_PATH) {
  try { fs.rmSync(SOCKET_PATH, { force: true }); } catch (e) {}
  server.listen(SOCKET_PATH, () => {
    console.log(`${APP_NAME} listening on unix socket ${SOCKET_PATH}`);
    console.log(`gateway prefix: ${GATEWAY_PREFIX}, www: ${WWW_DIR}, data: ${DATA_DIR}`);
  });
} else {
  server.listen(PORT, () => {
    console.log(`${APP_NAME} (dev) listening at http://localhost:${PORT}${GATEWAY_PREFIX}`);
    console.log(`gateway prefix: ${GATEWAY_PREFIX}, www: ${WWW_DIR}, data: ${DATA_DIR}`);
  });
}

/* ---------------- 内网直连端口 ----------------
 * 同一套请求处理逻辑再起一个 TCP 监听，手机 / 平板 / 其他电脑在同一个局域网内
 * 直接访问 http://<NAS 内网IP>:3340 即可使用，不需要经过飞牛桌面。
 * 端口占用等异常只记日志，不影响网关主通道。
 */
let lanServer = null;
if (LAN_PORT > 0) {
  const handler = server.listeners("request")[0];
  lanServer = http.createServer((req, res) => handler(req, res));
  lanServer.on("error", (e) => {
    const msg = e && e.code === "EADDRINUSE"
      ? `端口 ${LAN_PORT} 已被占用，局域网直连不可用（不影响网关访问）`
      : String((e && e.message) || e);
    console.log("[lan] " + msg);
  });
  lanServer.listen(LAN_PORT, LAN_HOST, () => {
    const addrs = lanAddresses();
    console.log(`${APP_NAME} listening on http://${LAN_HOST}:${LAN_PORT} (LAN)`);
    for (const a of addrs) console.log(`  LAN access: http://${a.ip}:${LAN_PORT}`);
    if (!addrs.length) console.log("  LAN access: 未检测到内网 IPv4 地址");
  });
}

const shutdown = () => {
  try { server.close(); } catch (e) {}
  try { if (lanServer) lanServer.close(); } catch (e) {}
  if (SOCKET_PATH) { try { fs.rmSync(SOCKET_PATH, { force: true }); } catch (e) {} }
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
