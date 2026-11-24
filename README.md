# 外交官 — pi + remote-pi 快速部署

在任意一台电脑上装好 pi，并接入 remote-pi，让手机能远程控制它。

三平台通用（Windows / macOS / Linux）。约 10 分钟。

---

## 包里有什么

```
外交官/
├── resources/
│   ├── windows/       node-*.msi、Git-*.exe        （离线安装包，可选）
│   ├── macos/         node-*.pkg
│   ├── linux/         node-*.tar.xz
│   ├── npm-packages/  pi、remote-pi 的 tgz（版本锁定用）
│   └── knowledge/     remote-pi-daemon/、bark-notify/（可选功能，各有 README）
├── get-resources.ps1  Windows 下补齐离线资源
└── get-resources.sh   macOS / Linux
```

离线包只是为了不用外网下载；没有也能直接走公开镜像安装。

---

## 部署

### 1. Node（≥ 18）

```bash
# Windows：双击 resources/windows/node-*.msi，或
msiexec /i resources\windows\node-v26.13.1-x64.msi

# macOS：双击 pkg，或
sudo installer -pkg resources/macos/node-v26.13.1.pkg -target /

# Linux
tar -xf resources/linux/node-v26.13.1-linux-x64.tar.xz -C /opt
sudo ln -s /opt/node-v26.13.1-linux-x64/bin/{node,npm,npx} /usr/local/bin/
```

验证：`node -v && npm -v`

### 2. Git

```bash
# Windows：resources/windows/Git-*.exe，全程默认即可
#   pi 的 bash 工具依赖 Git Bash，别装成便携版

# macOS
xcode-select --install

# Linux
sudo apt install -y git        # Debian/Ubuntu
sudo dnf install -y git        # Fedora
```

验证：`git --version`

### 3. pi + remote-pi

```bash
# 国内先换镜像（直连 npmjs 很慢）
npm config set registry https://registry.npmmirror.com

# pi（用包内 tgz 锁版本，或从镜像装）
npm install -g ./resources/npm-packages/earendil-works-pi-coding-agent-1.5.2.tgz
#   或：npm install -g @earendil-works/pi-coding-agent@1.5.2

# remote-pi 扩展（手机遥控必需）
pi install npm:remote-pi

# remote-pi CLI（只有要装 daemon 时才需要）
npm install -g ./resources/npm-packages/remote-pi-0.7.0.tgz
#   或：npm install -g remote-pi
```

验证：

```bash
pi --version                  # 1.5.2
pi list                       # 应列出 remote-pi
where remote-pi               # Windows
which remote-pi               # macOS / Linux
```

### 4. 启动 pi

```bash
mkdir -p ~/pi-remote && cd ~/pi-remote
pi
```

在 pi 里：

```text
/login      # 选 provider，填 API key
/model      # 选模型（远程听指令，便宜够用即可）
```

验证：随便问一句，能正常回复。

### 5. 确认 bash 工具可用

在 pi 里：

```text
!printf 'Bash is working\n'
```

输出 `Bash is working` 即通过。

**只有 Windows 且 Git 装在非标准路径时需要配**：

```json
// ~/.pi/agent/settings.json
{ "shellPath": "D:\\Git\\bin\\bash.exe" }
```

改完 `/reload`。默认路径能跑就不要动。

### 6. 配对手机

在 pi 里：

```text
/remote-pi pair
```

终端出二维码 + 配对 URI。手机 App 扫码，**确认手机和电脑连的是同一个 relay**（换了自建 relay 就要两边都改）。

验证：

```text
/remote-pi status
```

期望：

```
🟢 Local mesh: connected as "<目录名>"
🟢 Relay: on (...)
```

手机能看到会话并能发指令，即部署完成。

---

## 可选

| 功能 | 做法 |
|---|---|
| 后台常驻（开机自启、崩溃自愈） | 见 `resources/knowledge/remote-pi-daemon/README.md` |
| AI 主动发手机通知 | 见 `resources/knowledge/bark-notify/`（需要 Bark key） |
| 让 AI 念出文字（Windows） | 见 `resources/knowledge/say-tts/`（edge-tts + pygame）<br>macOS 直接用系统 `say "文字"`，Linux 用 `espeak` |

---

## 验收清单

```bash
node -v                 # ≥ 18
git --version
pi --version            # 1.5.2
pi list                 # 含 remote-pi
```

pi 里：

```text
!printf 'Bash is working\n'
/remote-pi status       # 🟢 Local mesh + 🟢 Relay
```

手机端能发指令并收到回复 → 完成。

---

## 常见问题

| 现象 | 处理 |
|---|---|
| `pi install` 卡住 | 确认 `npm config get registry` 是 npmmirror |
| pi 里 `!` 命令报找不到 bash | Windows 装 Git for Windows，或配 `shellPath` |
| 扫码后手机连不上 | 手机和电脑的 relay 地址必须完全一致 |
| `relay connect timeout` | 公共 relay 偶发握手慢，重试几次 |
| 想解绑旧手机 | `/remote-pi devices` 查看，`/remote-pi revoke <shortid>` |

---

## 给 AI agent 执行时的约定

- 按 1→6 顺序执行，每步跑完先验证再进入下一步
- 遇到「选模型 / 用谁的 API key / 手机 relay 地址」这类需要人决定的事，**停下来问**，不要猜
- 不要改动目标机器上已有的 pi 配置，只做本文件描述的追加
- 任何一步失败，先看常见问题；仍不通就停下报告，不要反复重试
