# dsh-next-message

DSH Web 客户端的输入框里，替你把下一句话写好：一轮回复结束后给出灰色建议，**Tab / 右方向键 / Enter** 接受，也可以直接无视它。

建议只留在内存里，不写 session log；采纳后草稿清空，下一轮重新给。

## 安装

### 方式一：git（推荐）

```bash
dsh plugin --profile desktop add github:HUkiah/dsh-next-message
```

固定版本（pnpm 会把 git 依赖锁到具体 commit，升级＝重新 add 一个新 tag）：

```bash
dsh plugin --profile desktop add github:HUkiah/dsh-next-message#v0.1.2
```

Web 侧栏 **Plugins → Add plugin** 里粘贴 `https://github.com/HUkiah/dsh-next-message` 等价。安装会把这个 bundle 加进 profile 的 `dsh.profile.bundles`，并默认启用。

### 方式二：release tarball（不需要 git）

每个 release 都附一份 `npm pack` 产物。下面这个地址**不带版本号，永远指向最新那版**：

```bash
dsh plugin --profile desktop add \
  https://github.com/HUkiah/dsh-next-message/releases/latest/download/dsh-next-message.tgz
```

要钉住某一版就换成带版本的文件名（`.../releases/download/v0.1.2/dsh-next-message-0.1.2.tgz`），
已经下载到本地就按绝对路径装：

```bash
dsh plugin --profile desktop add /abs/path/dsh-next-message-0.1.2.tgz
```

### 方式三：本地目录（开发用）

```bash
dsh plugin --profile desktop add /abs/path/to/dsh-next-message
```

`link:` 直接指向源目录，改代码立即生效（见「开发」）。代价是换机器要重新指路径。

## 配置

在 **Plugins** 页展开这个插件，或直接改 profile 的 `cordis.patch.yml`：

```yaml
- id: next-message
  name: '@local/dsh-next-message'
  config:
    enabled: true
    timeoutMs: 20000
    maxOutputTokens: 200
    maxSuggestionChars: 60
    maxContextChars: 6000
    reasoningEffort: "off"
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `timeoutMs` | `20000` | 单次预测的超时；超时只是这一轮不出建议 |
| `maxOutputTokens` | `200` | 预测调用的输出上限 |
| `maxSuggestionChars` | `60` | 字符上限。超出时按**最近的子句边界**裁剪（句末标点保留，逗号/分号丢掉）；裁完不足上限一半就整条丢弃——不硬切，宁可不给半句。裁剪记在日志的 `rawChars` / `clipped` |
| `maxContextChars` | `6000` | 送给模型的上下文上限（首条任务陈述 + 近期对话） |
| `reasoningEffort` | `"off"` | 预测调用的推理档位。调高会明显变慢，输入框里的等待是有感知的 |

## 数据文件与效果报告

运行时产物都在 `$DSH_HOME/next-message/`（默认 `~/.dsh/next-message/`），**不在包目录里**——插件装进 profile 的 `node_modules` 之后包目录会被重装覆盖。

| 文件 | 内容 |
|---|---|
| `next-message.log` | 逐行 JSON。看这几类就够了：`apply`（host 半挂载，带 `scriptMtime` 能证明跑的是哪一版文件）、`diag`（自检快照）、`suggestion`（出了建议，带 `ms`/`rawChars`/`clipped`）、`abstain`（没出，带 `reason`）、`outcome`（建议 vs 你实际发的那句）、`judge`（离线评审汇总） |
| `judge.json` | 离线评审的逐条判定，跨轮次累积 |

`abstain` 的 reason 一眼能读懂：`abstained`（模型主动沉默）、`too-long`（超上限且裁不出完整子句）、`recycled`（和你刚说过的话重合）、`invalid-json`、`marker`、`empty`。

效果报告（采纳率、延迟、建议/实际输入对照）：

```bash
node report.mjs                  # 总览 + 最近 15 对
node report.mjs --session 05a27f # 只看某个会话
node report.mjs --n 40 --all     # 最近 40 对 / 全部
```

## 隐私

送进模型的内容都会先过一遍凭据脱敏（`impl.js` 的 `redactSecrets`，13 条规则）：

- 私钥整块（PEM）、连接串里的口令（`postgres://user:pw@host`）、`Bearer` / `Basic` 认证头；
- 各家带前缀的令牌：`sk-` / `sk-ant-` / `ghp_` / `xoxb-` / `sk_live_` / `AKIA` / `AIza` / JWT；
- 赋值形态的密钥（含 `DB_PASSWORD=`、`OPENAI_API_KEY=` 这类带前缀键名）与中文的 `密码：…`。

替换成 `[redacted:类型]` 标记而不是空串，模型仍知道这里原本是什么。**故意不做**"长随机串"这类泛化启发式——文件名、commit hash、base64 图片都会被误伤，而它们正是准确率最强的具体性信号；同理，值是 `process.env.X` / `config.x` / `${VAR}` 这类**引用**时不脱敏。

三个模型边界都覆盖：预测上下文、写进日志供评审用的助手上下文、评审 payload 本身。所以 `next-message.log` 与 `judge.json` 里也不会留下密钥。

## 开发

分层和热加载边界：

| 文件 | 角色 | 改动如何生效 |
|---|---|---|
| `host.js` | 稳定入口壳。Loader 只导入它，它再用带时间戳的 URL 动态 import `host-real.js` | —（**别改成静态导入**，改了重载就会静默跑旧代码，`entry-shim-test.mjs` 会挡住） |
| `host-real.js` | host 半：注册 typert manifest、每会话的建议缓存、监听会话事件 | Plugins 页关掉再打开 |
| `impl.js` | 策略层：prompt、上下文裁剪、归一化、相似度、长度裁剪、离线评审 | 同上（实际是每次轮询都重新导入，改完一两秒即生效） |
| `client.js` | 浏览器半，手写 module wrapper，**没有构建步骤** | 刷新页面 |
| `paths.js` | 数据文件位置，唯一定义处 | 重启应用 |

准确率相关的改动基本都在 `impl.js`。离线评审（`judge.json`、`judge` 日志行）由 `impl.js` 里的 `DIAG_VERSION` 加一触发，复用最近一次预测用过的模型。

测试脚本，多数不需要真实模型：

```bash
node entry-shim-test.mjs     # 入口壳确实在做动态重载
node impl-context-test.mjs   # 上下文裁剪边界
node judge-dryrun.mjs        # 评审路径干跑，不调模型
node shadow-pair-test.mjs    # 影子建议是不是同一轮
node pending-test.mjs        # 跨轮配对不被误清
node judge-variant-test.mjs  # 评审按 primary / shadow 分组
node diag-safety-test.mjs    # 诊断路径不抛错
node audit-sim.mjs           # 崩溃恢复后插件在 Plugins 页的状态（只动 /tmp 副本）
```

这些脚本会读写 `$DSH_HOME/next-message/`。想拿一份干净环境跑，加 `DSH_HOME=/tmp/whatever`。

## 常见问题

### 装完没反应，输入框上面一直挂着一行 `next-message 自检 [...]`

先看那行的阶段名：

- **`poll-empty`**：不是错误。含义是"轮询成功，宿主说这个会话现在没有建议"。宿主半要是没加载起来，你会看到 `poll-error` / `poll-rejected` 那种报错行。
- 预测只有一个触发条件：**某个轮次真正跑完**（`turn/end` + `completed`）。只是打开一个历史会话、干等，永远不会出建议——没有任何轮次结束，宿主没有可预测的东西。
- 所以正确的验证是：**发一条消息、等助手把这一轮答完**，1–2 秒后灰字建议出现（或者这一轮助手没说出具体的下一步，模型按设计沉默，日志里会记 `abstain`）。
- 这行自检在收到第一条建议后自动消失。要看它到底卡在哪，`tail -3 ~/.dsh/next-message/next-message.log`。

### `git ls-remote` 报 `exit code 69`、`You have not agreed to the Xcode license agreements`

跟插件无关：macOS 的 `/usr/bin/git` 是个 shim，系统开发者许可没接受时它直接退出 69，于是所有走 git 的安装（git 规格依赖、brew、npm 的 git 依赖）都装不了。两条路：

```bash
xcode-select -p                    # 先看开发者目录指向哪
sudo xcodebuild -license accept    # 装了完整 Xcode：接受许可
sudo xcode-select --install        # 只有 Command Line Tools、没有 xcodebuild：重装 CLT，过程中点同意
```

不想碰系统、或者没有管理员权限，就走上面的 **方式二**：release tarball 用 HTTPS 取包，全程不调用 git（实测在 `git` 直接退出 69 的机器上可装）。

### 升级

已安装的插件不会自动更新：

- git 规格：`dsh plugin --profile desktop add github:HUkiah/dsh-next-message#<新 tag>`；
- tarball 规格：重新 add 一次最新那个 URL。

## 兼容性

- 依赖 harness 自己的内部包：`@deepseek-ai/cordis`、`@deepseek-ai/dsh-typert-protocol`、`@deepseek-ai/dsh-home-paths`。它们由 DSH 在 `$DSH_HOME/profiles/node_modules` 下提供，所以这个包不能脱离 DSH 单独运行。
- `package.json` 目前**没有**声明 `peerDependencies`，安装时不做 DSH 版本兼容性检查（插件管理器只检查 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 这些 peer，判定基准是运行时的 `@deepseek-ai/dsh-app-boot` 版本）。要在版本不匹配时被拦住，自己加：

  ```json
  "peerDependencies": { "@deepseek-ai/dsh": "^0.2.0-rc.2" }
  ```

  注意声明之后，git / tarball 规格是**装完再判**，不通过会回滚并恢复 profile 的 `package.json` 与 lockfile。

## 许可证

MIT，见 [LICENSE](LICENSE)。
