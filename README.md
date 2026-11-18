# 外交官 — pi 远程接入部署包

把一台**外部电脑**变成「手机能远程控制」的 pi 节点，一次装完。

> 名字的来由：这台机器不在你的组网内，它通过**公共 relay** 和你的手机单线联系——
> 像派出去的外交官，只跟你一个人通消息。

**支持 Windows / macOS / Linux**，当前 **Windows 适配最完整**（含离线安装包），
macOS / Linux 的步骤同样写全，资源按需就地取用。

---

## 包里有什么

```
外交官/
├── README.md                  ← 本文件：这是什么、怎么用
└── resources/
    ├── windows/               node-v26.13.1-x64.msi          （36 MB）
    │                          Git-2.56.1-64-bit.exe          （67 MB）
    ├── macos/                 node-v26.13.1.pkg              （105 MB）
    ├── linux/                 node-v26.13.1-linux-x64.tar.xz （34 MB）
    ├── npm-packages/          pi 1.5.2 + remote-pi 0.7.0 的 tgz（版本锁定用）
    └── knowledge/             ← 装完给 pi「看」的知识
        ├── remote-pi-daemon/  常驻 daemon 部署工具（含体检/日志/会话归档）
        └── bark-notify/       skill：让那边的 AI 主动给你发手机通知
```

约 240 MB（含三平台 node 安装包）。只为目标平台拷对应子目录即可。

> **从 GitHub clone 的版本不含大二进制**（GitHub 单文件 100 MB 限制）。
> 缺资源时跑一次补齐脚本即可：
>
> ```powershell
> # Windows
> powershell -ExecutionPolicy Bypass -File .\get-resources.ps1
> ```
> ```bash
> # macOS / Linux
> bash get-resources.sh
> ```
>
> 两个脚本都从 `cdn.npmmirror.com` 拉 node/git，用 `npm pack` 补两个 tgz，幂等可重跑。

---

## 用它做什么

| 场景 | 结果 |
|---|---|
| 别人的电脑上装 pi，你手机远程用它 | ✅ 通过公共 relay 连接，用完切回自己的 relay |
| 让它长期后台待命 | ✅ 加装 daemon（开机自启 + 崩溃自愈）|
| 它能主动给你发手机通知 | ✅ 加装 bark-notify 技能 |

**不做的事**：不改你的组网、不碰对方的既有配置（只追加）。

---

## 三平台差异一览

| | Windows | macOS | Linux |
|---|---|---|---|
| node | `windows\node-*.msi` 双击 / `msiexec /i` | `macos\node-*.pkg` 双击 / `installer` | `linux\node-*.tar.xz` 解压加 PATH |
| git | `windows\Git-*.exe`（含 Git Bash，**pi 的 bash 工具依赖它**）| `xcode-select --install`（系统自带）| `apt install git` / `dnf install git` |
| bash 工具 | 默认找 `C:\Program Files\Git\bin\bash.exe` | 用系统 `/bin/bash` | 用系统 `/bin/bash` |
| 需要额外配置 | 若 Git 装在非标准路径 → 配 `shellPath` | 无 | 无 |
| 适配程度 | ✅ 已实测（本包来源机） | ⚠️ 步骤完整，未在本包内实测 | ⚠️ 同上 |

---

## 怎么用这份文件

### 如果你是人

按 第 0 → 10 步 的顺序做。每步都写了「执行什么 / 应该看到什么 / 出错怎么办」。
第 7、8 步是可选功能，不做也能正常远程控制。

### 如果你是 AI agent

如果这台电脑上已经有一个能用的 AI（pi / 其他 agent），把本文件全文交给它即可。

- 从「第 0 步」开始，逐条执行、逐条验证
- **遇到「⏸ 停下来问人」标记的地方，必须停下来**，把选项和默认值说清楚，不要自己猜
- 不要跳过验证步骤 —— 每一步都有可观测的成功标志
- 不要修改目标机器上已有的 pi 配置，只按本文件指定的方式**追加**
- 任何一步失败，先看该步的「失败处理」，仍不行就停下来报告，不要反复重试

你需要向人索取两样东西（文件里会停下来问你）：

1. **模型 API key**（或让它用自己已有的登录）
2. **Bark key**（要手机通知才需要，没有就跳过）

---


## 第 0 步：前置检查

### Windows

```powershell
# 1) 系统版本（需要 Win10 1809+ / Win11）
[System.Environment]::OSVersion.Version

# 2) 是否有管理员权限（装 node/git 需要）
([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

# 3) 已装了什么（可能已有，就不用重装）
node -v; npm -v; git --version; pi --version
```

期望：`node -v` 输出 `v18` 以上；`git --version` 有输出；`pi --version` 有输出（没有就后面装）。

### macOS

```bash
sw_vers                          # macOS 版本
uname -m                         # arm64 = Apple Silicon，x86_64 = Intel
node -v; npm -v; git --version; pi --version
```

### Linux

```bash
cat /etc/os-release | head -3
uname -m                         # x86_64 / aarch64
node -v; npm -v; git --version; pi --version
```

### 记录初始状态（重要）

```bash
# 如果已有 pi，先备份配置并记下 packages
cp ~/.pi/agent/settings.json ~/.pi/agent/settings.json.bak-$(date +%Y%m%d-%H%M) 2>/dev/null
cat ~/.pi/agent/settings.json 2>/dev/null
```

Windows：

```powershell
if (Test-Path "$env:USERPROFILE\.pi\agent\settings.json") {
  Copy-Item "$env:USERPROFILE\.pi\agent\settings.json" "$env:USERPROFILE\.pi\agent\settings.json.bak-$(Get-Date -Format yyyyMMdd-HHmm)"
  Get-Content "$env:USERPROFILE\.pi\agent\settings.json"
}
```

**🛑 把 `packages` 字段抄下来**，最后要对比它没被改坏。

---

## 第 1 步：部署 node

目标：`node -v` 输出 ≥ v18（本包带 v26.13.1）。

### Windows

```powershell
# 方式 A：图形界面（推荐）
#   双击 resources\windows\node-v26.13.1-x64.msi，一路 Next

# 方式 B：静默安装
msiexec /i "resources\windows\node-v26.13.1-x64.msi" /qn /norestart

# 装完必须重开一个终端，再验证
node -v
npm -v
```

失败处理：
- `msiexec` 报权限错误 → 用管理员 PowerShell 重跑
- 装完 `node -v` 仍找不到 → 关掉所有终端重开；还不行就看 `C:\Program Files\nodejs` 是否在 PATH

### macOS

```bash
# 方式 A：双击 resources/macos/node-v26.13.1.pkg
# 方式 B：命令行
sudo installer -pkg resources/macos/node-v26.13.1.pkg -target /

# Apple Silicon 若想用 arm64 原生包，去 nodejs.org 下 arm64 版本
node -v && npm -v
```

### Linux

```bash
# 方式 A：解压即用（不需要 root）
sudo mkdir -p /usr/local/lib/nodejs
sudo tar -xJf resources/linux/node-v26.13.1-linux-x64.tar.xz -C /usr/local/lib/nodejs
echo 'export PATH=/usr/local/lib/nodejs/node-v26.13.1-linux-x64/bin:$PATH' >> ~/.bashrc
source ~/.bashrc
node -v && npm -v

# 方式 B：包管理器（版本可能旧，但够用）
# Ubuntu/Debian: sudo apt install -y nodejs npm
# Fedora/RHEL:   sudo dnf install -y nodejs npm
```

> aarch64 机器请下 `node-v26.13.1-linux-arm64.tar.xz`（本包内是 x64）。

**验证**：`node -v` 输出 v18 以上。

---

## 第 2 步：部署 git

**为什么必须装**：pi 的 `bash` 工具需要一个 Bash 可执行文件。

- Windows：pi 默认找 `C:\Program Files\Git\bin\bash.exe`
- macOS / Linux：系统自带 `/bin/bash`，只要装 git 命令本身

### Windows

```powershell
# 静默安装（含 Git Bash）
"resources\windows\Git-2.56.1-64-bit.exe" /VERYSILENT /NORESTART /NOCANCEL /SP-

# 装完重开终端
git --version
```

失败处理：图形界面双击手动装，一路 Next（默认选项即可，**必须保留 "Git Bash" 组件**）。

### macOS

```bash
# git 通常随 Xcode Command Line Tools 一起装
xcode-select --install          # 弹窗点「安装」
git --version

# 已装过但想升级：brew install git
```

### Linux

```bash
# Ubuntu/Debian
sudo apt update && sudo apt install -y git

# Fedora/RHEL
sudo dnf install -y git

# Arch
sudo pacman -S --noconfirm git

git --version
```

**验证**：`git --version` 有输出。

---

## 第 3 步：部署 pi 和 remote-pi

### 3.1 先换国内镜像（重要）

直连 npmjs 在国内会慢到放弃：

```bash
npm config set registry https://registry.npmmirror.com
npm config get registry        # 应输出 https://registry.npmmirror.com/
```

> 装完如果想恢复：`npm config set registry https://registry.npmjs.org`

### 3.2 装 pi

```bash
# 方式 A：用包内离线 tgz（版本锁定，推荐）
npm install -g ./resources/npm-packages/earendil-works-pi-coding-agent-1.5.2.tgz

# 方式 B：从镜像装指定版本
npm install -g @earendil-works/pi-coding-agent@1.5.2

pi --version        # 期望 1.5.2
```

> 注：tgz 只锁定 pi 自身的版本，它依赖的包仍会从 npm registry（镜像）拉取。
> 所以「离线包」= 版本确定，不等于完全断网可装。

### 3.3 装 remote-pi

**两个东西要分清**：

| 组件 | 作用 | 安装方式 |
|---|---|---|
| **pi 扩展** | 提供 `agent_send` / `list_peers` 等工具 + 手机遥控 | `pi install npm:remote-pi` |
| **CLI** | `remote-pi` / `pi-supervisord` 命令行（daemon 要用）| `npm i -g remote-pi` |

只做手机遥控 → 只装扩展就够。
后面要装 daemon（第 7 步）→ 两个都要。

```bash
# 扩展（必需）
pi install npm:remote-pi

# CLI（第 7 步要用）
npm install -g ./resources/npm-packages/remote-pi-0.7.0.tgz
# 或者：npm install -g remote-pi
```

验证：

```bash
pi list                    # 应看到 npm:remote-pi
which remote-pi            # 有输出说明 CLI 装好了（Windows: where remote-pi）
```

**⏸ 停下来问人**：如果没有 `remote-pi-0.7.0.tgz` 且镜像里也拉不到，问用户是否可以先跳过 CLI（不影响第 4～6 步）。

---

## 第 4 步：启动 pi，登录 + 选模型

### 4.1 建工作目录

不要用对方的桌面或文档目录，建一个专用的：

```bash
mkdir -p ~/pi-remote && cd ~/pi-remote
```

### 4.2 启动并登录

```bash
pi
```

在 pi 里：

```text
/login
```

按提示选择 provider 并填入 API key。
**⏸ 停下来问人**：用谁的 key？
- 用对方自己已有的账号 → 让对方自己扫码/登录
- 用你的 key → 明确告诉对方这会消耗谁的额度

**⚠️ 不要把 API key 写进任何会留在对方磁盘上的文件明文**，除非用户明确同意。

### 4.3 选模型

```text
/model
```

选一个**便宜、够用**的模型（这台机器主要用于远程听指令，不需要顶级模型）。

验证：随便问一句「你好」，能正常回复。

### 4.4 确认工作目录

后面配对、daemon 都基于这个目录。记下它的绝对路径：

```bash
# pi 里执行
!pwd
```

---

## 第 5 步：确认 bash 工具可用

这一步是 **Windows 专属**，macOS/Linux 一般直接可用。

### 在 pi 里执行

```text
!printf 'Bash is working\n'
```

**期望**：输出 `Bash is working`。

### 如果报找不到 bash

Windows 上 pi 按这个顺序找：

1. `~/.pi/agent/settings.json` 里的 `shellPath`
2. `C:\Program Files\Git\bin\bash.exe`
3. `C:\Program Files (x86)\Git\bin\bash.exe`
4. `PATH` 上的 `bash.exe`

如果 Git 装在**非标准位置**（比如 `D:\Git`），显式配置：

```json
// ~/.pi/agent/settings.json
{
  "shellPath": "D:\\Git\\bin\\bash.exe"
}
```

（Windows 路径要用正斜杠或双反斜杠。）

改完在 pi 里执行 `/reload`。

> 注意：如果你**能**看到 `Bash is working`，就**不要**动这个配置。默认发现顺序已经够用。

---

## 第 6 步：配对手机

### 6.1 生成二维码

在 pi 里执行：

```text
/remote-pi pair
```

终端会显示一个二维码 + 一串配对 URI。

### 6.2 手机操作

1. 打开 remote-pi App
2. **把 relay 地址切成公共 relay**（不是你自己组网的那个）
3. 扫码

### 6.3 验证

在 pi 里执行：

```text
/remote-pi status
```

期望看到：

```
🟢 Local mesh: connected as "<目录名>"
🟢 Relay: on (...)
```

手机上应该能看到这台机器的会话，并且能发指令。

**⏸ 停下来问人**：手机上 relay 地址切换到底在哪、公共地址是什么，需要用户确认（各版本 App 位置不同）。

### 6.4 常见失败

| 现象 | 原因 | 处理 |
|---|---|---|
| 扫码后连不上 | relay 地址不一致 | 手机和电脑必须连**同一个** relay |
| `relay connect timeout` | 公共 relay 握手慢（Cloudflare） | 重试几次；属已知波动，不是配置问题 |
| 重复配对 | 之前配过 | `/remote-pi devices` 看列表，必要时 `/remote-pi revoke <shortid>` |
| 状态显示 `waiting for an app` | 还没手机连上 | 手机端重新扫码/确认 relay |

---

## 第 7 步（可选）：部署 daemon 守护进程

**作用**：让 pi 在后台常驻，开机自启、崩溃自愈。手机随时能连，不用开着终端窗口。

### 7.1 准备工具

把 `resources/knowledge/remote-pi-daemon/` 拷到一个固定位置，比如：

```bash
cp -r resources/knowledge/remote-pi-daemon ~/remote-pi-daemon
```

### 7.2 先读它的说明

```bash
cat ~/remote-pi-daemon/README.md
```

里面写了：平台差异、6 个设计决策、排障表。

### 7.3 执行安装

```bash
node ~/remote-pi-daemon/deploy.mjs install --cwd ~/pi-remote --name <给这台机器起的名字>
```

- `--cwd`：daemon 的工作目录（用第 4.4 步记下的路径）
- `--name`：手机 App 里显示的名字，建议用能一眼认出对方的词

**Windows 会弹一次 UAC**，点「是」（它要写任务计划）。

### 7.4 它会做什么

1. 预检（node / pi / npm）
2. 检测旧部署残留
3. 确保全局 CLI 在位
4. **对齐 `settings.json` 的 `packages`**（否则 daemon 会因扩展重复加载崩溃）
5. 安装系统服务（Windows 任务计划 / launchd / systemd）
6. 注册并启动 daemon
7. 加固崩溃自愈（Windows 换保活启动器）
8. 验证

### 7.5 验证

```bash
node ~/remote-pi-daemon/deploy.mjs status
node ~/remote-pi-daemon/deploy.mjs doctor
```

期望 `doctor` 全绿。

### 7.6 注意

- daemon 的 id 是 `sha256(realpath(cwd))[:8]`，**不是** `--name` 的名字
- 装完关掉终端，pi 仍在后台跑，手机照样能连
- 卸载：`node ~/remote-pi-daemon/deploy.mjs uninstall`

---

## 第 8 步（可选）：加装 bark 技能

**作用**：让**那边的 AI 主动给你发手机通知**。

不是「每轮自动推送」，而是给 AI 一份技能说明 —— 当它干完活、卡住了、需要你决策时，
可以自己调 Bark 给你发一条。你也可以直接对它说「用 bark 通知我」。

### 8.1 需要的东西

**Bark key**（手机 Bark App 首页那串字符）。
**⏸ 停下来问人**：用谁的 key？
- 用你的 → 通知都推到你手机（适合「我远程指挥这台机器」）
- 用对方自己的 → 通知推给对方（适合「帮对方装个助手」）

### 8.2 安装（技能形态）

```bash
# 各平台路径一致：~/.pi/agent/skills/
mkdir -p ~/.pi/agent/skills/bark-notify
cp -r resources/knowledge/bark-notify/. ~/.pi/agent/skills/bark-notify/
```

装完确认关键文件在位：

```bash
ls ~/.pi/agent/skills/bark-notify/
# 期望看到：SKILL.md  README.md  scripts/  sounds.json  badges.json  config.example.json
```

> 包内**不含**真实的 `config.json`（避免泄露 key），只有 `config.example.json`。

### 8.3 写配置

```bash
cat > ~/.pi/agent/skills/bark-notify/config.json <<'JSON'
{
  "server": "https://api.day.app",
  "key": "在这里填 Bark key",
  "sound": "calypso",
  "group": "Pi",
  "name": ""
}
JSON
```

- `name` 留空就用主机名做标题前缀；多台机器建议显式填（一眼看出是谁发的）
- `group` 决定手机上如何分组

### 8.4 生效

pi 自动发现 `~/.pi/agent/skills/` 下的技能，**无需 `/reload`**（若当前会话没识别，重开一次 pi）。

### 8.5 验证

在 pi 里直接说：

```text
用 bark 给我发一条测试通知，内容是「外交官已就位」
```

期望：手机收到一条标题带 `[机器名]` 的通知。

也可以让它先自检通道：

```text
先 curl 一下 Bark 接口确认能通，再发通知
```

失败处理见 `resources/knowledge/bark-notify/README.md` 的排障章节（key 为空 / 网络不通 / 收不到）。

### 8.6 之后怎么用

装好之后，那边的 AI 会在这些时候主动用它（取决于它怎么理解你的指令）：

- 「跑完了通知我」
- 「卡住了就发通知」
- 「每隔一段时间告诉我进度」

也可以随时手动说「用 bark 通知我 xxx」。

---

## 第 9 步：最终验收清单

逐项打勾：

```text
[ ] node -v        输出 v18 以上
[ ] git --version  有输出
[ ] pi --version   有输出
[ ] pi list        能看到 npm:remote-pi
[ ] pi 里 !printf 'Bash is working' 输出正常
[ ] pi 里 /remote-pi status 显示 Relay: on
[ ] 手机 App 能看到这台机器，能发指令并收到回复
[ ] （可选）deploy.mjs doctor 全绿
[ ] （可选）对 pi 说「用 bark 发条测试通知」，手机收到
[ ] settings.json 里的 packages 只新增了预期条目，原有内容未被破坏
```

最后一项用第 0 步抄下来的内容对比。

---

## 第 10 步：交付说明（写给使用者）

装完后告诉对方这几件事：

1. **这台机器现在可以被远程控制**，但只有在你的手机上、且 relay 指向公共地址时
2. **不要随意 `pi -e` 叠加扩展**，可能导致工具名冲突
3. **如果不想被远程控制**：在 pi 里执行 `/remote-pi stop`，或关掉终端（daemon 场景要 `deploy.mjs stop`）
4. **bark 是技能不是插件**：它不会自动推送，只在 AI 被要求（或它判断需要）时发通知
5. **日志在哪**：
   - Windows：`%LOCALAPPDATA%\Temp\pi\` 和 `%USERPROFILE%\.pi\remote\supervisord.log`
   - macOS/Linux：`~/.pi/remote/supervisord.log`
6. **怎么彻底移除**：
   ```bash
   node ~/remote-pi-daemon/deploy.mjs uninstall --remove-daemon
   npm uninstall -g remote-pi @earendil-works/pi-coding-agent
   rm -rf ~/pi-remote ~/.pi
   ```

---

## 完整排障表

| 现象 | 最可能的原因 | 处理 |
|---|---|---|
| `npm install` 卡住 / 很慢 | 没换镜像 | 第 3.1 步 |
| `pi: command not found` | npm 全局 bin 不在 PATH | 重开终端；或查 `npm bin -g` |
| `pi` 启动后 bash 工具报错 | 没装 git / 路径不对 | 第 2 步 + 第 5 步 |
| `/remote-pi pair` 没反应 | 扩展没加载 | `pi list` 确认；重启 pi |
| 手机扫码后无反应 | 两边 relay 不一致 | 第 6.4 步 |
| `relay connect timeout` | 公共 relay 握手慢 | 重试；属已知波动 |
| daemon 起来又崩 | `packages` 指向了两个不同副本 | 跑 `deploy.mjs install` 重新对齐 |
| daemon `no daemon with id <name>` | id 是路径哈希 | `remote-pi daemons` 看真实 id |
| bark 收不到 | key 不对 / 未 `/reload` | 见 bark-notify 的 README |
| 装完后原有 pi 配置坏了 | 对比备份 | 用第 0 步的 `.bak` 恢复 |

---

## 附：这套东西的来源

| 组件 | 来源 |
|---|---|
| pi | `@earendil-works/pi-coding-agent` v1.5.2 |
| remote-pi | `remote-pi` v0.7.0（repo: jacobaraujo7/remote_pi）|
| daemon 工具 | 本机自制，`github.com/hong2301/remote-pi-daemon` |
| bark 技能 | 本机自制，见包内 README |
| node | v26.13.1 LTS（`cdn.npmmirror.com` 镜像）|
| git | Git for Windows 2.56.1（`cdn.npmmirror.com` 镜像）|

配套知识：`知识库/magic-context-部署.md`（若这台机器也要装 Magic Context）。
