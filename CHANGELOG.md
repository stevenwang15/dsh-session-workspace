# Changelog

## 0.2.0 — 2026-11-06

- 新增浏览器半身：输入框工具栏左侧的 `独立工作区 / 共用工作区` 运行时开关，悬停说明，中英文字典，明暗主题自适应。
- 新增 Host 控制接口 `GET/POST /api/session-workspace/{state,enabled}`，通过内核 `connection` 的 Fetch 路由注册：鉴权、Origin 校验与 owner 判定由内核 `/api` 通道负责。
- 隔离失败时新增完整回退与清理：目录/注册失败不阻断新建对话；会话已发布时保留其目录与工作区注册，避免 `cwd` 悬空。
- 安装脚本改为「先 remove 再 add」，修复 `file:` 依赖是内容快照、重复 `add` 不升级的问题。
- 新增真实 Host 端到端测试 `scripts/e2e-control.mjs`（开关、关闭后不隔离、浏览器 bundle 发布），并把调研笔记归档到 `docs/`。

## 0.1.0 — 2026-11-06

- 首个版本：包装 `ctx.sessionController.create`，为每个新对话自动创建目录、注册 Workspace，让会话的 `cwd`（沙箱根）落在独立目录。
- `managed` / `all` 两种隔离模式；显式 `cwd`、空白会话复用、手动项目工作区保持原生行为。
- 单元测试、分发契约测试，以及真实 Host 端到端测试 `scripts/e2e-remote.mjs`。
