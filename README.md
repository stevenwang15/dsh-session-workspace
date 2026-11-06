# dsh-session-workspace

> **每个对话，一个专属文件夹。**
> 装一次，之后直接点「新建对话」就行——DSH 会自动给这个对话一个独立文件夹，别的对话看不到、也改不到里面的文件。

[English](README.en.md) | 中文

---

## 它解决什么烦恼

现在的 DeepSeek Harness 里，**所有对话共用同一个文件夹**（`default-workspace`）。

打个比方：大家都在同一张桌子上干活。你在 A 对话里写了一半的报告、跑出来的数据、下载的附件，换个对话一看，全都还在桌上——B 对话能看到、能改、甚至能删掉。对话越多，桌子越乱。

装上这个插件之后：**每开一个新对话，DSH 自动发一张自己的新桌子。** 这个对话里产生的所有文件都只在自己的文件夹里，和其他对话互不打扰。

| | 装之前 | 装之后 |
|---|---|---|
| 新对话放文件的位置 | 全部挤在同一个文件夹 | 每个对话一个独立文件夹 |
| A 对话的文件，B 对话能看到吗 | 能 | 不能 |
| 需要你手动操作吗 | —— | 不需要，照常点「新建对话」 |

## 装完之后你会看到什么

1. 点侧边栏的 **新建对话（New Session）**；
2. 侧边栏多出一行工作区，名字是创建时间，比如 `2026-11-06 20:15`；
3. 这个对话读写的文件都在 `文稿/deepseek-harness/session-workspaces/20261106-201533-a1b2/` 里；
4. 再点一次新建对话，又是一个全新的工作区和文件夹；
5. 全程不用手动建文件夹、不用选路径、不用改设置。

想找文件？在访达（Finder）里打开这个文件夹就能看到所有对话的文件夹：

```sh
open ~/Documents/deepseek-harness/session-workspaces
```

## 输入框旁边的小开关

打开任意对话后，输入框工具栏的**最左边**有一个小胶囊：

- 亮着 **`独立工作区`**：新对话会自动建独立文件夹（默认就是这样）；
- 点一下变成灰色 **`共用工作区`**：下一个新对话先不隔离，还放在你当前选的文件夹里；
- 再点一下又恢复。想临时不隔离的时候用，**重启 DSH 后自动变回默认**，不会改坏设置。

> 小提醒：一个对话的文件夹在它被创建的那一刻就定下来了，所以这个开关只影响**之后新建**的对话，不会把当前对话搬家。

## 安装（三步）

**第 1 步：在终端里装插件**

```sh
dsh plugin --profile desktop add github:stevenwang15/dsh-session-workspace
```

> 如果这条命令报错，也可以用 Release 里的压缩包：下载 `dsh-session-workspace-0.2.0.tgz`，然后执行
> `dsh plugin --profile desktop add file:下载文件的绝对路径`。

**第 2 步：告诉 DSH 启用它**

打开 `~/.dsh/profiles/desktop/package.json`，找到 `dsh` → `profile` → `bundles` 这个数组，把 `"dsh-session-workspace"` 加进去，像这样：

```json
"bundles": [
  "@deepseek-ai/dsh-base",
  "@deepseek-ai/dsh-web-app",
  …其它原本就有的条目…,
  "dsh-session-workspace"
]
```

**第 3 步：彻底重启 DSH**

菜单栏「DeepSeek Harness → 退出」（或窗口激活时按 **Cmd+Q**），确认「活动监视器」里**没有**任何 DeepSeek Harness 进程了，再重新打开。

> 只关掉窗口、再点 Dock 图标打开，**不算重启**——后台进程还在跑，插件不会生效。这是最容易踩的坑。

## 怎么确认装好了

- 打开任意对话，输入框工具栏左边能看到 `独立工作区` 胶囊；
- 点「新建对话」，侧边栏会多出一个新工作区；
- 看一下 `~/Documents/deepseek-harness/session-workspaces/`，里面会多出带时间戳的文件夹。

## 常见问题

**看不到胶囊？**
1. 确认是**彻底退出**再打开（活动监视器里旧进程都没了）；
2. 再按 Cmd+R / F5 刷新一次页面；
3. 确认第 2 步的 `bundles` 里确实加了 `"dsh-session-workspace"`。

**点了新建对话，但没有新文件夹？**
可能是这几种正常情况：

- 复用了上一次留下的「空白对话」；
- 输入框开关切到了 `共用工作区`；
- 你在一个**手动添加的项目工作区**里新建——默认会尊重你的选择，不隔离。

**升级插件后没变化？**
插件是本地安装的，重复安装同一路径不会覆盖旧版本。先删掉再装，然后彻底重启：

```sh
dsh plugin --profile desktop remove dsh-session-workspace
dsh plugin --profile desktop add github:stevenwang15/dsh-session-workspace
```

**删掉侧边栏的工作区，会删掉文件吗？**
不会。删工作区只是删掉侧边栏里的这一行分组，文件夹和聊天记录都还在。

**会占很多磁盘吗？**
每个新对话一个文件夹，和普通文件夹一样。插件不会自动清理，方便你回溯；不用的文件夹可以自己删。

**卸载插件？**

```sh
./scripts/uninstall-local.sh desktop   # 或者手动从 bundles 里删掉再 remove
```

已经建好的工作区和文件夹都会保留。

---

## 下面是给想深入了解的人看的（普通用户可以跳过）

### 可调整的设置

在 `~/.dsh/profiles/desktop/cordis.patch.yml` 末尾加一行就能改：

```yaml
- id: session-workspace
  config:
    enabled: true          # false = 完全停用这个插件
    mode: managed          # managed = 手动加的项目不隔离；all = 所有新对话都隔离
    baseDir: /Users/你/Documents/deepseek-harness/session-workspaces
```

| 设置 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关，`false` 就等于没装。 |
| `mode` | `managed` | `managed`：只隔离默认工作区和插件自己建的工作区，你手动添加的项目保持原样；`all`：新建对话一律隔离。 |
| `baseDir` | `默认工作区旁边的 session-workspaces` | 每个对话的文件夹都放在这里。 |

### 它是怎么做到的（技术版）

DSH 里「工作区」就是一个目录：会话创建时记录的 `cwd` 同时是它的**沙箱根**（只能写这个目录）和侧边栏的分组依据。插件做两件事：

- **Host 半身（`index.js`）**：包装 `ctx.sessionController.create`。新对话来临时，先独占创建一个目录、注册成 Workspace，再带着这个 Workspace 创建会话，于是会话的 `cwd` = 新目录。
  - 显式指定目录（`cwd`）、复用空白会话（`sessionId`）、手动项目工作区都保持原生行为；
  - 创建失败会自动回退到原生行为，**不会卡住你新建对话**；
  - 通过内核 `connection` 的 Fetch 路由提供 `GET/POST /api/session-workspace/{state,enabled}`，鉴权由内核 `/api` 通道负责。
- **浏览器半身（`client.js`）**：手写的 `__ModuleLoader__` bundle（无构建步骤，只依赖 DSH 自带的 React），通过 `conversation.input.left` 插槽把胶囊放到输入框工具栏，颜色全部使用主题变量，自动跟随明暗模式。

失败的清理、沙箱根不可变、子代理/分叉继承父目录等细节，都写在了代码注释和 `docs/notes/` 里。

### 兼容性

- 在 **DSH 0.2.2-rc.1**（当前桌面版）上完整测试通过；
- 隔离功能只依赖 DSH 的公开服务；如果未来的版本移除了输入框插槽，胶囊会不显示，但**隔离本身照常工作**。

### 开发与测试

零依赖、无需构建，克隆即可跑：

```sh
npm test                 # 28 项测试（Host 单元 21 + 浏览器半身 2 + 分发契约 5）
npm run e2e              # 真 DSH Host 端到端：隔离 / 空白复用 / 显式目录
npm run e2e:control      # 真 DSH Host 端到端：开关接口 + 浏览器 bundle 发布
```

E2E 会起一个独立的 `DSH_HOME`（在工作区下的 `.e2e*`），**不碰你正在用的 `~/.dsh`**，也不花模型 token。详见 [docs/E2E.md](docs/E2E.md)。

## License

[MIT](LICENSE)
