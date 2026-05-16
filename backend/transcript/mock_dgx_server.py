"""Mock DGX WebSocket server to receive forwarded transcripts.

Run this locally to simulate the DGX Spark receiving forwarded transcript events.
Set `MOCK_DGX_PORT` to change the listening port (default 9000).
"""
import asyncio
import json
import logging
import os

import websockets

logging.basicConfig(level=logging.INFO)


async def handler(websocket):
    logging.info("DGX client connected")
    try:
        async for message in websocket:
            # print a truncated preview and save full message to a file
            preview = message if len(message) < 400 else message[:400] + "..."
            print(f"[DGX] Received ({len(message)} bytes): {preview}")
            # optional: write each message to diagnostics/dgx_received.jsonl
            try:
                from pathlib import Path

                diag_dir = Path(__file__).resolve().parent / "diagnostics"
                diag_dir.mkdir(parents=True, exist_ok=True)
                out = diag_dir / "dgx_received.jsonl"
                with out.open("a", encoding="utf-8") as fh:
                    fh.write(json.dumps({"received_at": asyncio.get_event_loop().time(), "payload": json.loads(message) if message.strip().startswith("{") else message}) + "\n")
            except Exception:
                pass

            # send a lightweight ack
            try:
                await websocket.send(json.dumps({"type": "ack", "ok": True}))
            except Exception:
                pass
    except websockets.exceptions.ConnectionClosed:
        logging.info("DGX client disconnected")


async def main():
    port = int(os.getenv("MOCK_DGX_PORT", "9000"))
    host = os.getenv("MOCK_DGX_HOST", "0.0.0.0")
    print(f"Starting mock DGX WebSocket server on ws://{host}:{port}")
    async with websockets.serve(handler, host, port):
        try:
            await asyncio.Future()  # run forever
        except asyncio.CancelledError:
            pass


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("Mock DGX server stopped")
