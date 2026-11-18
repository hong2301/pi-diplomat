# remote-pi-daemon

把 **Pi 的常驻 agent**（remote-pi 的 daemon 模式）在 Windows / macOS / Linux 上一条命令装好、验好、管起来。

> 上游：[jacobaraujo7/remote_pi](https://github.com/jacobaraujo7/remote_pi) · 扩展包 `remote-pi@0.7.0`
> 姊妹项目：[`../remote-relay`](../remote-relay)（自建 relay 服务端）

---

## 它解决什么问题

remote-pi 有两种用法：

| 模式 | 谁在跑 | 电脑锁屏/关窗口后 |
|---|---|---|
| 交互式 `/remote-pi` | 你开的那个 pi 窗口 | 断开 |
| **daemon 模式** | `pi-supervisord` 常驻服务 + N 个 `pi --mode rpc` 后台进程 | **继续在线**，手机随时能发指令 |

daemon 模式官方有完整支持，但**要在三个平台上分别正确安装服务**（systemd --user / launchd / Task Scheduler），
还要避开几个真实的坑。这个工具把这一层封装成一条命令，并且只调用官方 CLI，不复制官方逻辑。

---

## 前置条件

| 项 | 要求 |
|---|---|
| node | >= 20（pi 自身要求） |
| pi | 已安装且在 `PATH` 里（`pi --version` 能跑） |
| npm | 能用全局安装（`npm root -g` 有输出） |
| 网络 | 手机与电脑在同一个 relay 上（社区 relay 或自建 `remote-relay`） |
| 平台 | Windows 10+ / macOS / Linux（有 systemd --user） |

---

## 快速开始

```bash
# 默认部署 ~/workspace/repo/daemon，agent 名取目录名（daemon）
node deploy.mjs install
```

它会依次做：

1. **预检** —— node 版本、`pi` 是否在 PATH、npm 是否可用（不过就不动手）
2. **旧部署残留检测** —— 手工做的任务计划 XML / 启动 VBS / 写死路径的 `packages`
3. **`npm install -g remote-pi`** —— 官方明确要求：`pi install npm:remote-pi` 只装扩展，**不暴露 CLI**
4. **`remote-pi install`** —— 装 `pi-supervisord` 系统服务（各平台机制见下表）
5. **`remote-pi create ~/workspace/repo/daemon --name daemon`** —— 注册并立即拉起
6. **`remote-pi daemon restart <id>`** —— 用 registry 里的名字重启（原因见「设计决策 4」）
7. **验证** —— registry / 运行态 / 日志关键字扫描

装完会打印手机配对步骤（**只需一次**）：

```bash
cd ~/workspace/repo/daemon && pi
# 在 pi 里执行：/remote-pi pair    然后手机扫码
# 然后关掉这个 pi 窗口，daemon 接管后台
```

### 常用参数

```bash
node deploy.mjs install --cwd ~/projects/api --name backend
node deploy.mjs install --relay http://100.78.95.53:1247   # 自建 relay
node deploy.mjs install --dry-run                            # 只看要做什么
```

---

## 命令

| 命令 | 说明 |
|---|---|
| `install` | 完整部署（默认命令） |
| `status` | 服务状态 / registry / 运行态 / **会话体积体检** |
| `logs [-f] [--tail N]` | supervisor 日志（各平台自动选日志源） |
| `restart` / `stop` | 只操作本目录的 daemon（按 id，不碰别的） |
| `reset-session` | 归档当前会话（`--continue` 膨胀导致变慢时用） |
| `harden` | 只加固 Windows 崩溃自愈（保活启动器 + Repetition） |
| `doctor [--clean]` | 全面体检；`--clean` 顺带清理旧部署残留 |
| `uninstall [--remove-daemon] [--purge --yes]` | 卸载服务；`--purge` 连 `~/.pi/remote` 一起清 |

全局选项：`--cwd` `--name` `--relay` `--skip-global` `--dry-run` `--no-start`。

`--no-start` 只注册不启动：目标目录此刻还开着交互式 `pi` 时用它，避免 daemon 的
`--continue` 和交互式会话续到**同一个 jsonl**（pi 没有会话锁，两个进程同时 append 会互相污染）。

---

## 三个平台各自装了什么

| 平台 | 服务机制 | 提权 | 崩溃自愈 | 日志 |
|---|---|---|---|---|
| Windows | Task Scheduler 任务 `RemotePiSupervisor`（`schtasks /Create /XML`），动作是 `wscript.exe` 跑隐藏 VBS 启动器 | **需要管理员**，会弹 UAC | **保活启动器**（node 退出 5s 后重跑），由 `harden` 打入 | `~/.pi/remote/supervisord.log` |
| macOS | `~/Library/LaunchAgents/dev.remotepi.supervisord.plist` + `launchctl bootstrap gui/$UID` | 不需要 sudo | 自带 `KeepAlive` | 同上 |
| Linux | `~/.config/systemd/user/remote-pi-supervisord.service` + `systemctl --user enable --now` | 不需要 sudo | 自带 `Restart=on-failure` | `journalctl --user -u remote-pi-supervisord` |

无头 Linux 还需要一次 `loginctl enable-linger $USER`，否则登出后服务被回收。

这些模板都来自官方包内的 `service-templates/`，本工具**不自己渲染**，只调用 `remote-pi install`。

---

## 设计决策（都是踩过的坑）

### 1. 不用 `pi install npm:remote-pi` 提供 CLI

官方 README 写得很明确：

> Install the package globally so `remote-pi` and `pi-supervisord` are on your PATH
> (`pi install npm:remote-pi` alone makes the Pi extension available but does NOT expose the CLI binaries).

所以部署必须 `npm i -g remote-pi`。扩展和 CLI 是同一份代码的两个入口，互不替代。

### 2. `packages` 必须与全局包同路径（这条是实测出来的，和官方注释相反）

上游 0.7.0 在 `dist/index.js` 里做了「双加载去重」：用
`globalThis[Symbol.for("remote-pi.extension.appliedRegistry")]` 上一个 `WeakSet<pi>` 记录「这个 `pi` 已接线」。

**在 pi 1.5.2 上它没有生效**。实测日志：

```
Failed to load extension "~/.pi/agent/npm/node_modules/remote-pi/dist/index.js":
  Tool "agent_send" conflicts with "<npm root -g>/remote-pi/dist/index.js"
```

原因：supervisor 用 `-e <全局包>/dist/index.js` 拉起 daemon，而 `packages: ["npm:remote-pi"]`
又自动发现 `~/.pi/agent/npm/node_modules/remote-pi`。两条路径不同 → 两份模块实例，
而两次加载拿到的 `pi` 并不是同一个对象 → `WeakSet` 判不出来 → `registerTool` 硬冲突 →
daemon 崩溃循环（1s / 5s / 30s / 5min 退避）。

所以 `install` 会**主动把 `packages` 对齐成当前全局包的 realpath**：

```json
{ "packages": ["C:/Users/jiang/AppData/Local/.../node_modules/remote-pi"] }
```

代价是换 node 版本 / 改 npm 全局前缀后路径失效，重跑 `node deploy.mjs install` 即可，
`doctor` 会在两者不一致时直接报出来。

### 3. 不碰 `daemon start`（全量）

0.7.0 的 `Supervisor._opStartAll()` 仍然是：

```js
this._spawnEntry(entry.id, entry.cwd);        // ← 漏了 entry.name
```

而 `_spawnEntry` 用 `name ?? defaultAgentName(cwd)` 组装 `REMOTE_PI_DIRECT_CONFIG`，
全量 `daemon start` 会把 agent 名重置成目录名，手机 App 里的会话名跟着变。

带 id 的路径是对的（`_opStart(id)` / `_spawnAllFromRegistry()` 都传了 `entry.name`）。
所以本工具只走 `create`（内部 `_opStart`）和 `daemon restart <id>`，永不调用全量 `daemon start`。

> 上游修掉之后这条限制可以去掉，`doctor` 不会因此报错。

### 4. 会话膨胀 → 手机端「像坏了」

daemon 的启动参数含 `--continue`（`rpcSpawnArgs()`），会一直续同一个会话。
实测：某会话从 10-13 续到 11-17 到 2.2 MB / 256,952 input tokens，
一轮「你好」耗时从 3.4 s 涨到 **61.7 s** —— 手机侧看起来就是没反应。

`status` / `doctor` 会体检会话目录，超过 20 MB 就提示：

```bash
node deploy.mjs reset-session    # 归档旧 jsonl，下轮 daemon 自动开新会话
node deploy.mjs restart
```

### 5. Windows 的「开机自启」和「崩溃自愈」是两件事

自启没问题：官方模板给的是 `<LogonTrigger>`（登录即启），`ExecutionTimeLimit=PT0S`（不限时）。

崩溃自愈有坑。官方任务在 `<Settings>` 里写了 `<RestartOnFailure><Interval>PT1M</Interval><Count>999</Count>`，
但动作是 `wscript.exe → cmd /c → node` 三层包装。实测（Win10 22H2）：

```
taskkill /F /T 杀掉 supervisor 树
→ State=Ready, LastTaskResult=1
→ 等 150 秒，没有任何重启
```

给 trigger 加 `<Repetition><Interval>PT2M</Interval>` 同样没触发。结论：**这两条路在包装任务上不可靠**。

所以 `harden` 会把官方启动器换成「保活包壳」：

```vbs
Do
  rc = CreateObject("Wscript.Shell").Run("<cmd /c node supervisord.js >> log 2>&1>", 0, True)
  WScript.Sleep 5000
Loop
```

wscript 常驻，node 一退出 5 秒后重跑。实测：

```
杀 node 6300  →  12s 后 supervisor 7736 + daemon 11796 自动回来（restarts=0，名字不变）
```

原启动器备份为 `RemotePiSupervisorLauncher.vbs.official-<ts>`，`remote-pi install` 会覆盖回官方版，
重跑 `node deploy.mjs harden` 即可。

---

## 目录与文件

| 路径 | 作用 |
|---|---|
| `~/.pi/remote/daemons.json` | daemon 注册表（`{cwd, name}` 列表，id = `sha256(realpath(cwd))[:8]`） |
| `~/.pi/remote/peers.json` | 已配对的手机（**别删，删了要重新扫码**） |
| `~/.pi/remote/config.json` | `relay` 地址 |
| `~/.pi/remote/supervisord.log` | Windows / macOS 的 supervisor + 所有 daemon 日志（`[<cwd>]` 前缀） |
| `~/.pi/remote/supervisor.sock` | CLI ↔ supervisor 的控制通道（UDS） |
| `~/.pi/agent/npm/node_modules/remote-pi` | `pi install npm:remote-pi` 装的**扩展**副本（本工具会把 `packages` 从它改指全局包，避免双加载） |
| `<npm root -g>/remote-pi` | `npm i -g` 装的**CLI**副本（supervisor 注册的服务指向这里） |
| `~/.pi/agent/sessions/--<mangled-cwd>--/` | 该 daemon 的会话历史 |

---

## 排障

先跑：

```bash
node deploy.mjs doctor
node deploy.mjs logs --tail 100
```

| 现象 | 常见原因 | 处理 |
|---|---|---|
| `remote-pi install` 卡住/失败 | Windows 上 UAC 被拒 | 重新跑，点「是」；或管理员 PowerShell 手动 `remote-pi install` |
| 服务装了但 daemon 不起来 | 服务里烘焙的 PATH 没有 `pi` | 确认 `pi` 在当前 PATH，再 `install` 一次（重写 PATH） |
| `Cannot find module` | 全局包被移动/升级 | `remote-pi uninstall && npm i -g remote-pi && remote-pi install` |
| `Tool "xxx" conflicts` | `-e` 与 `packages` 指向了不同副本 | `node deploy.mjs install`（会重新对齐 packages）；`doctor` 可预检 |
| daemon `crashed` 且重启次数到 4 | 模型/API key 失效、项目未信任 | 在该 cwd 里交互式跑一次 `pi` 修好配置 |
| 手机连不上但服务正常 | relay 地址两边不一致 | `remote-pi set-relay <url>` 后 `node deploy.mjs restart` |
| 手机端很慢/超时 | 会话膨胀 | `node deploy.mjs reset-session && node deploy.mjs restart` |

官方更细的 8 个场景：`<npm root -g>/remote-pi/docs/daemon.md`。

---

## 卸载

```bash
# 只卸服务，保留注册表和配对（之后 install 能原样恢复）
node deploy.mjs uninstall

# 顺带注销这个目录的 daemon
node deploy.mjs uninstall --remove-daemon

# 彻底清（会丢手机配对）
node deploy.mjs uninstall --remove-daemon --purge --yes
```

删掉的只是服务与注册；`npm uninstall -g remote-pi` 需要的话自己执行。

---

## 与 remote-relay 的分工

```
iPhone App ─┐
            ├─ Tailscale ─> remote-relay :1247  ─> 各机 pi / daemon
Mac pi ─────┘                  ↑
Windows pi ────────────────────┘   本工具负责「每台机器上的常驻 agent 服务」
```

`remote-relay` 只需要一台 24h 在线的机器跑；本工具跑在**每一台**需要常驻 agent 的机器上。
