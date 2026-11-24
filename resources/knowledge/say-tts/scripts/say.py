#!/usr/bin/env python3
import sys
import os
import asyncio
import tempfile
import pygame
import edge_tts

VOICE = "zh-CN-XiaoxiaoNeural"
TEXT = sys.argv[1] if len(sys.argv) > 1 else "晚上好，我是 hamster"

async def main():
    with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as tmp:
        tmp_path = tmp.name
    try:
        await edge_tts.Communicate(TEXT, VOICE).save(tmp_path)
        pygame.mixer.init()
        pygame.mixer.music.load(tmp_path)
        pygame.mixer.music.play()
        while pygame.mixer.music.get_busy():
            pygame.time.Clock().tick(10)
    finally:
        try:
            os.remove(tmp_path)
        except OSError:
            pass

if __name__ == "__main__":
    asyncio.run(main())
