#!/usr/bin/env python3
import asyncio
import tempfile
import os
import pygame
import edge_tts

VOICE = "zh-CN-XiaoxiaoNeural"
TEXT = "小宝帮我拿个布进来"
COUNT = 10

async def speak_once(text):
    with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as tmp:
        tmp_path = tmp.name
    try:
        await edge_tts.Communicate(text, VOICE).save(tmp_path)
        pygame.mixer.music.load(tmp_path)
        pygame.mixer.music.play()
        while pygame.mixer.music.get_busy():
            pygame.time.Clock().tick(10)
    finally:
        try:
            os.remove(tmp_path)
        except OSError:
            pass

async def main():
    pygame.mixer.init()
    for i in range(COUNT):
        print(f"第 {i+1} 次")
        await speak_once(TEXT)

if __name__ == "__main__":
    asyncio.run(main())
