[English](README.md) | [简体中文](README.zh-CN.md)

# CarryOn · 续上

**找回原话，核对决定，让讨论接着进行。**

把自己选择导入的旧聊天，整理成能回溯的决定、还没解决的问题，以及交给下一次讨论的背景。让下一次可以接着聊。

![合成资料生成的交接编辑界面](docs/images/handoff.png)

**中文界面、单人、本机使用。** 不连接模型也能导入、关键词查找、人工建卡、模板交接、备份恢复。提炼、自然语言回答和润色是可选功能，使用自行配置的 OpenAI 兼容 Chat Completions 接口。

当前为开源测试版。本地流程用合成资料验证；真实模型的内容质量、私人聊天上的使用价值尚未验证。

## 在本机打开

需要 **Node.js 22.14.0 或更新版本**、npm，以及 macOS 或 Linux。自动检查覆盖 Node 22 / 24。数据库使用 Node 内置 SQLite。

```sh
git clone https://github.com/bigu1/CarryOn.git
cd CarryOn
npm ci
npm run build
sh scripts/start.sh
```

打开终端显示的地址，默认 `http://127.0.0.1:43173`。端口占用时尝试下一个，不结束占用它的程序。停止当前实例：

```sh
sh scripts/stop.sh
```

开发热更新用 `npm run dev`。指定其他数据目录：

```sh
XUSHANG_DATA_DIR=./local-data sh scripts/start.sh
XUSHANG_DATA_DIR=./local-data sh scripts/stop.sh
```

## 第一次怎么用

1. 用合成演示资料体验，或粘贴 / 导入 UTF-8 TXT、Markdown、应用自有 [JSON v1](schemas/json-v1.schema.json)。
2. 先核对预览里的说话人、日期和主题，再确认导入。取消预览不入库。
3. 查关键词、打开原文，选中文字或点「整段建卡」。AI 建议与用户决定分开记录。
4. 逐条确认、修改或拒绝候选。「已确认准确」表示概括和原文一致，不表示历史说法已经现场验证。
5. 在「交接说明」选择主题和本次目标，预览后可编辑、复制或下载 Markdown；未知项和未决问题会保留。
6. 在「设置与数据」导出备份。备份包含私人聊天，应自行妥善保管。恢复先校验新库，再替换当前库，同时保留本地恢复前快照。

## 资料与模型边界

- 只监听回环地址，校验 Host / Origin，并使用会话与 CSRF 校验保护写入。请在本机使用，不通过隧道或公网反向代理暴露服务。
- 默认资料存在 `data/`，浏览器存储不是唯一库。个人库与演示库隔离。没有遥测、远程字体、剪贴板监听，不自动读取其他 AI 应用。
- 凭据只在服务进程内存里，不进数据库和备份，重启后清除。浏览器每次发送先预览；资料、问题或设置变化后重新预览。
- 远程模型必须 HTTPS，本机回环允许 HTTP。拒绝重定向，并限制输入、输出、超时、重试和取消。
- 删除来源会清除应用可见正文、使派生内容和迟到结果失效。已下载的文件和恢复前快照不会自动被回收；不承诺磁盘取证级擦除。
- 引用会校验范围和逐字匹配，但有引用不等于模型解释正确，仍需人工核对。

## 名称、兼容与署名

英文产品名是 **CarryOn**，中文名是 **续上**；仓库和包名使用 CarryOn / `carryon`。旧 `xushang.db`、`xushang-backup`、Cookie 和 `XUSHANG_*` 环境变量保留为数据与协议兼容标识，已有库和备份继续可用；它们不代表另一个产品名。

版权与公开提交归属为 **bigu1**。提交使用该账号的 GitHub 隐私邮箱，避免公开真实邮箱。

## 检查与代码位置

```sh
npm run typecheck
npm test
npm run build
npx playwright install chromium
npm run test:e2e
npm audit
npm run check:public
```

浏览器测试每次建立新的临时库，使用隔离端口，拒绝日常默认端口。`npm run perf:20k` 建立独立合成库，数字只代表运行它的机器。

`src/client/` 是界面与组件；`src/server/routes/` 是 HTTP 边界；`src/domain/` 是卡片与交接规则；`src/importers/` 是导入预览；`src/search/` 是字面检索；`src/ai/` 是发送计划和模型任务；`src/storage/` 是 SQLite、删除和备份替换。

阅读[原始产品合同](docs/specification/01-产品与实现方案.md)、[当前验收证据](docs/ACCEPTANCE.md)、[运行说明](docs/RUNBOOK.md)和[安全说明](SECURITY.md)及[隐私与署名复核](docs/PRIVACY_AUDIT.md)。公开仓库与发行包包含源码、测试、合成样例和文档，不含个人资料库或旧私人 Git 历史。

## 参与开发与许可

见 [CONTRIBUTING.md](CONTRIBUTING.md)，采用 [MIT 许可证](LICENSE)。
