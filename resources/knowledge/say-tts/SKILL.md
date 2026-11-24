---
name: say-tts
description: 将文字通过 edge-tts 转成语音并播放，支持单次朗读和重复朗读。触发词：say、tts、朗读、播放文字。
---

# say-tts

将文本转为语音并通过本地扬声器播放，默认使用 `zh-CN-XiaoxiaoNeural`（大陆女声）语音。

## 何时使用

当用户希望 AI 把一段文字读出来，或调用本地 TTS 能力时。

## 环境要求

**Windows 专用**。macOS 自带 `say`、Linux 有 `espeak`，直接命令行读就行，不用装这套：

```bash
say "要读的文字"          # macOS
espeak "要读的文字"       # Linux
```

Windows 上需要：

- Python 3.8+
- `pip install edge-tts pygame`

## 运行方式

### 单次朗读

```bash
python scripts/say.py "晚上好，我是 hamster"
```

或在 Windows 命令行：

```bash
say.bat "晚上好，我是 hamster"
```

不带参数时朗读默认文本：

```bash
say.bat
```

### 重复朗读 10 次

```bash
python scripts/say10.py
```

## 触发词

以下任意表达都会触发 TTS：

- 直接朗读：`说...`、`朗读...`、`播放...`。
- 讲述内容：`讲...`（如讲故事、讲个笑话、讲一段话）。当用户说“讲...”时，先输出文本，再自动调用 TTS 朗读。
- 描述性请求：`把...读出来`、`播放文字...`。

## 可调参数

| 脚本 | 参数 | 说明 |
|------|------|------|
| `say.py` | `TEXT`（命令行参数） | 要朗读的文本，默认为 "晚上好，我是 hamster" |
| `say10.py` | `TEXT`（脚本内变量） | 默认重复朗读 "小宝帮我拿个布进来" 10 次 |
| 共同 | `VOICE` | 默认 `zh-CN-XiaoxiaoNeural`，可改为其他 edge-tts 语音 |

## 自检

在运行前检查：

1. Python 是否可用：`python --version`
2. 依赖是否已安装：`pip show edge-tts pygame`
3. 是否有可用的音频输出设备

## 回应规则

- 只要脚本正常执行（命令返回成功），就默认用户已经听到声音。
- 运行成功后，**不要反问**“你听到了吗”“声音正常吗”之类的话。
- 只用极简短的方式确认已执行，例如：“已朗读：XXX。”或仅输出文本内容。
- 只有当脚本报错、依赖缺失或环境异常时，才向用户说明问题。

## 安全提示

- 脚本运行时会生成临时 MP3 文件，并在播放结束后删除。
- 播放结束前会阻塞进程，直到音频播放完毕。
