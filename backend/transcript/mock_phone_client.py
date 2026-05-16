"""Simple WebSocket client that connects to the transcription server and prints events.

Usage: set `TRANSCRIPT_WS` env var to change the server URL (default ws://localhost:8000/ws/transcript)
"""
import asyncio
import json
import os

import websockets


URL = os.getenv("TRANSCRIPT_WS", "ws://localhost:8000/ws/transcript")


async def run_client():
    print(f"Connecting to transcription server at {URL}")
    try:
        async with websockets.connect(URL) as ws:
            print("Connected. Waiting for transcript events...")
            async for message in ws:
                try:
                    payload = json.loads(message)
                except Exception:
                    payload = message
                print("[Phone]", json.dumps(payload, ensure_ascii=False))
    except Exception as exc:
        print("Connection error:", exc)


if __name__ == "__main__":
    asyncio.run(run_client())
