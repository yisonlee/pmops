# 物业工程管理（pmops）

面向飞牛 fnOS / NAS 的本地化物业工程管理系统，以 `.fpk` 应用包形式安装，数据全部存放在 NAS 本地 SQLite 与本地文件目录，不依赖外部云服务。

- **当前版本**：1.26.0（2026-11-10）
- **开发者**：无冰咖啡糖
- **运行时**：fnOS 应用中心 `nodejs_v22`，后端基于 Node.js 内置 `node:sqlite`
- **访问方式**：飞牛桌面统一网关 `/app/pmops`，或内网直连 `http://NAS_IP:3340`

## 功能概览

| 模块 | 主要内容 |
| --- | --- |
| 可视化驾驶舱 | 商铺资产结构、租金/欠费/合同/设备多维聚合，图表下钻到台账 |
| 商铺管理 | 商铺档案、楼栋管理、装修与维修状态及进度、租金与水电抄表账单、欠费统计、A4 打印 |
| 设备管理 | 八类设备台账、巡检/维修/保养记录与状态联动 |
| 项目合同 / 付款台账 | 自定义付款计划、金额与比例联动、施工进度、付款节点 |
| 档案 / 仓库 | 分类密级、借阅归还、CAD 图纸附件；物料台账与出入库流水 |
| 系统能力 | 登录与三级权限、用户与操作日志、Excel 导出与预览、PDF/表格/图片附件预览、OnlyOffice 在线预览、手机端自适应 |

弹窗交互遵循「仅关闭 / 取消按钮与右上角 × 生效、逐层收起」的约定；详细功能与部署步骤见 [安装说明.md](./安装说明.md)。

## 目录结构

```
pack/
  manifest                 应用清单（appname / version / 依赖 / 网关参数）
  cmd/                     安装、升级、卸载回调与主进程控制脚本
  config/                  权限与资源配置
  app/ui/                  桌面入口 config 与图标
  app/www/index.html       单页前端（内联脚本与样式）
  app/www/echarts.min.js   离线图表库
  app/server/server.js     后端服务、权限、数据库与 API
  app/server/export.js     Excel 导出工作表定义
  app/server/xlsx.js       零依赖 xlsx 写出
tests/                     回归测试与预览页渲染脚本
安装说明.md                 完整安装、配置与接口说明
dist/pmops-1.26.0.fpk      可直接安装的发布包
```

## 安装

在飞牛桌面「应用中心」中选择手动安装，上传 `dist/pmops-1.26.0.fpk`。安装后：

1. 通过桌面图标或 `http://NAS_IP:3340` 打开；
2. 首次登录使用内置账号 `admin / admin123`（仅用于初始化），登录后**立即修改密码**，并在「用户管理」中按角色分配账号；系统会在 `password_is_default` 中提示密码仍为默认值；
3. 如需要 Word / PPT / 旧版 xls 在线预览，在「系统设置」中填写 OnlyOffice Document Server 地址与 JWT 密钥，密钥仅存服务端且读取时掩码。

> OnlyOffice 与真实 fnOS 设备、手机浏览器的联调尚未在真机环境完成验证，如安装或运行异常请查看 `/var/apps/pmops/var/app.log`。

## 本地开发

```bash
PORT=3340 GATEWAY_PREFIX=/app/pmops DATA_DIR=.tmpdata \
  node pack/app/server/server.js
```

回归测试（当前 704 项断言）：

```bash
node tests/ui-test.js
```

预览页由 `tests/render-*.js` 生成，属于本地调试产物，已由 `.gitignore` 排除。

## 注意

本仓库只包含源码与发布包，**不包含任何真实业务数据**：数据库、附件、`.tmpdata/`、测试输出均未提交。部署到生产环境后请自行做好备份与访问控制。
