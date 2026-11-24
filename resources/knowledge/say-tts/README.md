# say-tts

一个让 AI 帮你把文字读出来的小技能。

[English Version](docs/README.en.md)

## 能做什么

- 把任意中文文字转成语音并播放
- 单次朗读，或重复朗读 10 次
- 默认使用大陆女声 `zh-CN-XiaoxiaoNeural`

## 和 AI 对话示例

```text
用 say-tts 朗读：晚上好，我是 hamster
```

```text
用 say-tts 播放：小宝帮我拿个布进来
```

```text
用 say-tts 先自检环境，看看能不能播放
```

## 手动使用

### 安装依赖

```bash
pip install edge-tts pygame
```

### 单次朗读

```bash
python scripts/say.py "晚上好，我是 hamster"
```

Windows 下也可以直接：

```bash
say.bat "晚上好，我是 hamster"
```

### 重复朗读 10 次

```bash
python scripts/say10.py
```

## 自定义

修改 `scripts/say.py` 或 `scripts/say10.py` 里的 `VOICE` 变量，可更换其他 edge-tts 支持的声音。
