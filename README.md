# dsh-next-message

在 DSH Web 客户端的输入框里预测你的下一句话：一轮回复结束后给出灰色建议，**Tab / 右方向键 / Enter** 接受。

建议只在内存里，不写 session log；采纳后草稿被清空，下一轮会重新给。

## 安装

### 从 GitHub 安装（推荐）

```bash
dsh plugin --profile desktop add github:HUkiah/dsh-next-message
```

或者在 Web 侧栏 **Plugins → Add plugin** 里粘贴 `https://github.com/HUkiah/dsh-next-message`。安装会把这个 bundle 加进 profile 的 `dsh.profile.bundles` 并默认启用。

固定版本（pnpm 会把 git 依赖锁到具体 commit，升级要重新 add）：

```bash
dsh plugin --profile desktop add github:HUkiah/dsh-next-message#v0.1.0
```

### 从本地目录安装（开发用）

```bash
dsh plugin --profile desktop add /abs/path/to/dsh-next-message
```

`add` 走的是 pnpm，所以 tarball、`file:`、绝对路径都行：

```bash
npm pack                                            # 产出 local-dsh-next-message-0.1.0.tgz（文件名带 @local 前缀）
dsh plugin --profile desktop add ./local-dsh-next-message-0.1.0.tgz
```

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
| `timeoutMs` | `20000` | 单次预测的超时，超时就这一轮不出建议 |
| `maxOutputTokens` | `200` | 预测调用的输出上限 |
| `maxSuggestionChars` | `60` | 建议长于这个值直接丢弃（宁可不给，也不给半句） |
| `maxContextChars` | `6000` | 送给模型的上下文上限 |
| `reasoningEffort` | `"off"` | 预测调用用的推理档位。调高会明显变慢，输入框里的等待是有感知的 |

## 数据文件

运行时产物都在 `$DSH_HOME/next-message/`（默认 `~/.dsh/next-message/`），**不在包目录里**——插件从 GitHub 装进 profile 的 `node_modules` 之后，包目录会被重装覆盖，写在那儿会丢。

| 文件 | 内容 |
|---|---|
| `next-message.log` | 逐行 JSON：每次建议、每次跳过（含原因）、每轮的 outcome 对照 |
| `judge.json` | 离线评审结果，跨轮次累积；改 `impl.js` 里的 `DIAG_VERSION` 触发一次 |

效果报告（采纳率、延迟、建议/实际输入对照）：

```bash
node report.mjs                  # 总览 + 最近 15 对
node report.mjs --session 05a27f # 只看某个会话
node report.mjs --n 40 --all     # 最近 40 对 / 全部
```

## 开发

三个层次，热加载边界不一样：

| 文件 | 角色 | 改动如何生效 |
|---|---|---|
| `host.js` | 稳定入口壳。Loader 只导入它，它用带时间戳的 URL 动态 import `host-real.js` | —（**别改成静态导入**，改了重载就会静默跑旧代码，`entry-shim-test.mjs` 会挡住） |
| `host-real.js` | host 半：注册 typert manifest、每会话的建议缓存、监听会话事件 | Plugins 页关掉再打开 |
| `impl.js` | 策略层：prompt、上下文裁剪、归一化、相似度、离线评审 | 同上，改完即生效 |
| `client.js` | 浏览器半，手写 module wrapper，**没有构建步骤** | 刷新页面 |
| `paths.js` | 数据文件位置，唯一定义处 | 重启应用 |

准确率相关的改动基本都在 `impl.js`。

测试脚本（多数不需要真实模型）：

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

这些脚本会读写 `$DSH_HOME/next-message/`。想用干净环境跑，加 `DSH_HOME=/tmp/whatever`。

## 兼容性

- 依赖 harness 自己的内部包：`@deepseek-ai/cordis`、`@deepseek-ai/dsh-typert-protocol`、`@deepseek-ai/dsh-home-paths`。它们由 DSH 在 `$DSH_HOME/profiles/node_modules` 下提供，所以这个包不能脱离 DSH 单独运行。
- `package.json` 目前**没有**声明 `peerDependencies`，安装时不做 DSH 版本兼容性检查（插件管理器只检查 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 这些 peer，判定基准是运行时的 `@deepseek-ai/dsh-app-boot` 版本）。要在版本不匹配时被拦住，自己加：

  ```json
  "peerDependencies": { "@deepseek-ai/dsh": "^0.2.0-rc.2" }
  ```

  注意声明之后，git / tarball 规格是**装完再判**，不通过会回滚并恢复 profile 的 `package.json` 与 lockfile。
- 已安装的插件不会自动更新：升级 = 重新 `dsh plugin ... add <新版本或新 tag>`。
