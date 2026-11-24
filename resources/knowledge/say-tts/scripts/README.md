# say-tts scripts

本目录包含 TTS 播放脚本，供 skill 调用或手动执行。

## 脚本

- `say.py`：单次朗读命令行传入的文本
- `say10.py`：重复朗读脚本内设定的文本 10 次
- `say.bat`：Windows 批处理入口，调用 `say.py`

## 手动用法

```bash
python say.py "要朗读的文字"
python say10.py
```
