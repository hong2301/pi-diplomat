# say-tts

A small skill that lets the AI read text aloud using edge-tts.

[中文版本](README.md)

## What it does

- Converts Chinese text into speech and plays it locally
- Supports single playback or repeating 10 times
- Defaults to the Taiwan female voice `zh-TW-HsiaoChenNeural`

## Talking to the AI

```text
Use say-tts to read: Good evening, I am hamster
```

```text
Use say-tts to play: please bring me a cloth
```

## Manual usage

```bash
pip install edge-tts pygame
python scripts/say.py "text to read"
python scripts/say10.py
```
