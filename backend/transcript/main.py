"""Local microphone transcription server built around whisper.cpp.

This process captures audio from the computer's microphone, transcribes short
speech segments with a local whisper.cpp binary, and broadcasts transcript
events to any connected clients over WebSocket. The same events are also saved
to JSONL and can be forwarded to the DGX Spark.
"""

from __future__ import annotations

import asyncio
import io
import json
import logging
import os
import subprocess
import tempfile
import threading
import wave
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

import numpy as np
import sounddevice as sd
import uvicorn
import websockets
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Optional noise reduction package (used only if requested via env var and installed)
try:
    import noisereduce as nr  # type: ignore
    _HAS_NOISEREDUCE = True
except Exception:
    _HAS_NOISEREDUCE = False

APP_ROOT = Path(__file__).resolve().parent
OUTPUT_JSON_DIR = APP_ROOT / "transcripts"
OUTPUT_JSON_DIR.mkdir(parents=True, exist_ok=True)
DIAGNOSTICS_DIR = APP_ROOT / "diagnostics"
DIAGNOSTICS_DIR.mkdir(parents=True, exist_ok=True)

AUDIO_SAMPLE_RATE = 16000
CHANNELS = 1
SAMPLE_WIDTH_BYTES = 2

WHISPER_CPP_BIN = Path(
    os.getenv(
        "WHISPER_CPP_BIN",
        APP_ROOT / "whisper.cpp" / "build" / "bin" / "whisper-cli",
    )
)
WHISPER_MODEL = Path(
    os.getenv(
        "WHISPER_MODEL",
        APP_ROOT / "whisper.cpp" / "models" / "ggml-small.en-tdrz.bin",
    )
)
WHISPER_LANG = os.getenv("WHISPER_LANG", "en")
WHISPER_EXTRA_ARGS = os.getenv("WHISPER_EXTRA_ARGS", "").split()
ENABLE_NOISE_REDUCTION = os.getenv("ENABLE_NOISE_REDUCTION", "false").lower() in ("1", "true", "yes")

DGX_OUTPUT_WS_URL = os.getenv("DGX_OUTPUT_WS_URL", "")
PHONE_WS_PATH = os.getenv("PHONE_WS_PATH", "/ws/transcript")

CHUNK_WINDOW_SECONDS = float(os.getenv("CHUNK_WINDOW_SECONDS", "4.0"))
CHUNK_OVERLAP_SECONDS = float(os.getenv("CHUNK_OVERLAP_SECONDS", "1.0"))
SILENCE_TIMEOUT_SECONDS = float(os.getenv("SILENCE_TIMEOUT_SECONDS", "2.5"))
MIN_AUDIO_SECONDS = float(os.getenv("MIN_AUDIO_SECONDS", "0.6"))
MIN_AUDIO_BYTES = int(AUDIO_SAMPLE_RATE * CHANNELS * SAMPLE_WIDTH_BYTES * MIN_AUDIO_SECONDS)
CAPTURE_BLOCKSIZE = int(os.getenv("CAPTURE_BLOCKSIZE", "1024"))

app = FastAPI(title="Whisper.cpp Local Transcription Server")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

connected_clients: set[WebSocket] = set()
audio_queue: asyncio.Queue[Optional[bytes]] = asyncio.Queue(maxsize=256)
capture_loop: asyncio.AbstractEventLoop | None = None
capture_stream: sd.InputStream | None = None
pipeline_task: asyncio.Task[None] | None = None
full_transcript = ""
segment_index = 0


@dataclass
class TranscriptEvent:
    type: str
    text: str
    full_transcript: str
    timestamp: str
    segment_index: int
    source: str = "whisper.cpp"
    speaker: Optional[str] = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "type": self.type,
            "text": self.text,
            "full_transcript": self.full_transcript,
            "timestamp": self.timestamp,
            "segment_index": self.segment_index,
            "source": self.source,
            "speaker": self.speaker,
        }


def save_transcript_to_json(transcript_data: dict[str, Any], session_id: str) -> None:
    output_file = OUTPUT_JSON_DIR / f"transcript_{session_id}.jsonl"
    with output_file.open("a", encoding="utf-8") as handle:
        json.dump(transcript_data, handle, ensure_ascii=False)
        handle.write("\n")


def float32_audio_to_pcm16_bytes(audio: np.ndarray) -> bytes:
    clipped = np.clip(audio, -1.0, 1.0)
    pcm16 = (clipped * 32767.0).astype(np.int16)
    return pcm16.tobytes()


def build_wav_bytes(pcm_bytes: bytes) -> bytes:
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav_file:
        wav_file.setnchannels(CHANNELS)
        wav_file.setsampwidth(SAMPLE_WIDTH_BYTES)
        wav_file.setframerate(AUDIO_SAMPLE_RATE)
        wav_file.writeframes(pcm_bytes)
    return buffer.getvalue()


def transcribe_with_whisper_cpp(wav_bytes: bytes) -> dict[str, Any]:
    """Transcribe WAV bytes and extract speaker info from TDRZ output.
    
    Returns a dict with 'text' (transcript) and 'speaker' (speaker label if detected).
    """
    if not WHISPER_CPP_BIN.exists():
        raise FileNotFoundError(f"whisper.cpp binary not found: {WHISPER_CPP_BIN}")
    if not WHISPER_MODEL.exists():
        raise FileNotFoundError(f"whisper.cpp model not found: {WHISPER_MODEL}")

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp_wav:
        tmp_wav.write(wav_bytes)
        tmp_wav_path = Path(tmp_wav.name)

    try:
        command = [
            str(WHISPER_CPP_BIN),
            "-m",
            str(WHISPER_MODEL),
            "-f",
            str(tmp_wav_path),
            "-l",
            WHISPER_LANG,
        ]
        command.extend(WHISPER_EXTRA_ARGS)

        logger.debug("Running whisper.cpp: %s", " ".join(command))
        completed = subprocess.run(
            command,
            check=True,
            capture_output=True,
            text=True,
        )

        # Save command and output for diagnostics
        try:
            diag_log = DIAGNOSTICS_DIR / f"whisper_cli_{tmp_wav_path.stem}.log"
            with diag_log.open("w", encoding="utf-8") as fh:
                fh.write("COMMAND:\n" + " ".join(command) + "\n\n")
                fh.write("STDOUT:\n" + (completed.stdout or "") + "\n\n")
                fh.write("STDERR:\n" + (completed.stderr or "") + "\n")
        except Exception:
            logger.debug("Failed to write whisper-cli diagnostics log")

        # Parse transcript and speaker labels from output
        # TDRZ format: [Speaker X] followed by text
        transcript_lines = []
        current_speaker = None
        
        for line in completed.stdout.splitlines():
            if "[Speaker" in line:
                # Extract speaker label (e.g., "[Speaker 0]" -> "Speaker 0")
                speaker_start = line.find("[Speaker")
                speaker_end = line.find("]", speaker_start)
                if speaker_end > speaker_start:
                    current_speaker = line[speaker_start + 1 : speaker_end]
                # Get text after speaker label
                text_part = line[speaker_end + 1:].strip() if speaker_end > 0 else ""
                if text_part:
                    transcript_lines.append(text_part)
            elif "]" in line:
                # Fallback for other bracketed content
                transcript_lines.append(line.split("]", 1)[-1].strip())
            elif line.strip():
                transcript_lines.append(line.strip())

        transcript = " ".join(part for part in transcript_lines if part)
        if not transcript:
            transcript = completed.stdout.strip() or completed.stderr.strip()

        return {
            "text": transcript,
            "speaker": current_speaker,
        }
    finally:
        tmp_wav_path.unlink(missing_ok=True)


def make_transcript_event(text: str, event_type: str = "final", speaker: Optional[str] = None) -> TranscriptEvent:
    return TranscriptEvent(
        type=event_type,
        text=text,
        full_transcript=full_transcript,
        timestamp=datetime.now().isoformat(),
        segment_index=segment_index,
        speaker=speaker,
    )


async def broadcast_payload(payload: dict[str, Any]) -> None:
    if not connected_clients:
        return

    stale_clients: list[WebSocket] = []
    for client in list(connected_clients):
        try:
            await client.send_json(payload)
        except Exception:
            stale_clients.append(client)

    for client in stale_clients:
        connected_clients.discard(client)


async def forward_to_dgx(payload: dict[str, Any]) -> None:
    if not DGX_OUTPUT_WS_URL:
        return

    try:
        async with websockets.connect(DGX_OUTPUT_WS_URL) as socket:
            await socket.send(json.dumps(payload, ensure_ascii=False))
    except Exception as exc:
        logger.warning("Failed to forward transcript to DGX: %s", exc)


def queue_audio_chunk(chunk: bytes) -> None:
    try:
        audio_queue.put_nowait(chunk)
    except asyncio.QueueFull:
        logger.warning("Audio queue full, dropping chunk")


def microphone_callback(indata: np.ndarray, frames: int, time_info: Any, status: sd.CallbackFlags) -> None:
    if status:
        logger.debug("Microphone status: %s", status)

    if capture_loop is None:
        return

    mono_audio = indata[:, 0] if indata.ndim > 1 else indata
    pcm_bytes = float32_audio_to_pcm16_bytes(np.asarray(mono_audio, dtype=np.float32))
    capture_loop.call_soon_threadsafe(queue_audio_chunk, pcm_bytes)


def start_microphone_capture() -> None:
    global capture_stream

    if capture_stream is not None:
        return

    capture_stream = sd.InputStream(
        channels=CHANNELS,
        samplerate=AUDIO_SAMPLE_RATE,
        dtype="float32",
        blocksize=CAPTURE_BLOCKSIZE,
        callback=microphone_callback,
    )
    capture_stream.start()
    logger.info("Microphone capture started at %s Hz", AUDIO_SAMPLE_RATE)


def stop_microphone_capture() -> None:
    global capture_stream

    if capture_stream is None:
        return

    capture_stream.stop()
    capture_stream.close()
    capture_stream = None
    logger.info("Microphone capture stopped")


async def process_segment(session_id: str, segment_bytes: bytes) -> None:
    global full_transcript, segment_index

    if len(segment_bytes) < MIN_AUDIO_BYTES:
        return

    # Optionally run a light noise-reduction pass (if enabled and library available)
    try:
        if ENABLE_NOISE_REDUCTION and _HAS_NOISEREDUCE:
            pcm = np.frombuffer(segment_bytes, dtype=np.int16).astype(np.float32) / 32767.0
            reduced = nr.reduce_noise(y=pcm, sr=AUDIO_SAMPLE_RATE)
            pcm16 = (np.clip(reduced, -1.0, 1.0) * 32767.0).astype(np.int16)
            wav_bytes = build_wav_bytes(pcm16.tobytes())
        else:
            wav_bytes = build_wav_bytes(segment_bytes)
    except Exception as exc:
        logger.warning("Noise reduction failed or unavailable: %s", exc)
        wav_bytes = build_wav_bytes(segment_bytes)

    # Save the processed segment for offline diagnostics
    try:
        diag_wav = DIAGNOSTICS_DIR / f"session_{session_id}_segment_{segment_index + 1}.wav"
        with diag_wav.open("wb") as fh:
            fh.write(wav_bytes)
    except Exception:
        logger.debug("Failed to save diagnostic WAV for segment %s", segment_index + 1)

    try:
        result = await asyncio.to_thread(transcribe_with_whisper_cpp, wav_bytes)
    except Exception as exc:
        error_event = {
            "type": "error",
            "error": str(exc),
            "timestamp": datetime.now().isoformat(),
            "session_id": session_id,
        }
        await broadcast_payload(error_event)
        save_transcript_to_json(error_event, session_id)
        return

    transcript_text = result["text"].strip()
    speaker = result.get("speaker")
    
    if not transcript_text:
        return

    segment_index += 1
    full_transcript = f"{full_transcript} {transcript_text}".strip()
    event = make_transcript_event(transcript_text, speaker=speaker)
    payload = event.to_dict() | {"session_id": session_id}

    await broadcast_payload(payload)
    save_transcript_to_json(payload, session_id)
    await forward_to_dgx(payload)


async def transcription_pipeline() -> None:
    session_id = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
    buffer = bytearray()
    last_audio_at = asyncio.get_running_loop().time()
    window_bytes = int(CHUNK_WINDOW_SECONDS * AUDIO_SAMPLE_RATE * SAMPLE_WIDTH_BYTES)
    overlap_bytes = int(CHUNK_OVERLAP_SECONDS * AUDIO_SAMPLE_RATE * SAMPLE_WIDTH_BYTES)

    logger.info("Transcription pipeline started: %s", session_id)

    while True:
        timeout = max(0.1, SILENCE_TIMEOUT_SECONDS - (asyncio.get_running_loop().time() - last_audio_at))

        try:
            chunk = await asyncio.wait_for(audio_queue.get(), timeout=timeout)
        except asyncio.TimeoutError:
            if buffer:
                await process_segment(session_id, bytes(buffer))
                buffer.clear()
            continue

        if chunk is None:
            if buffer:
                await process_segment(session_id, bytes(buffer))
            break

        buffer.extend(chunk)
        last_audio_at = asyncio.get_running_loop().time()

        if len(buffer) >= window_bytes:
            await process_segment(session_id, bytes(buffer))
            if overlap_bytes > 0 and overlap_bytes < len(buffer):
                buffer = bytearray(buffer[-overlap_bytes:])
            else:
                buffer.clear()


@app.on_event("startup")
async def on_startup() -> None:
    global capture_loop, pipeline_task

    capture_loop = asyncio.get_running_loop()
    start_microphone_capture()
    pipeline_task = asyncio.create_task(transcription_pipeline())


@app.on_event("shutdown")
async def on_shutdown() -> None:
    global pipeline_task

    stop_microphone_capture()

    if pipeline_task is not None:
        await audio_queue.put(None)
        await pipeline_task
        pipeline_task = None


@app.websocket("/ws/transcript")
async def websocket_transcript(websocket: WebSocket) -> None:
    await websocket.accept()
    connected_clients.add(websocket)
    await websocket.send_json(
        {
            "type": "sync",
            "full_transcript": full_transcript,
            "timestamp": datetime.now().isoformat(),
        }
    )
    logger.info("Transcript client connected")

    try:
        while True:
            message = await websocket.receive_text()
            if message.strip().lower() == "ping":
                await websocket.send_text("pong")
    except WebSocketDisconnect:
        logger.info("Transcript client disconnected")
    finally:
        connected_clients.discard(websocket)


@app.get("/health")
def health_check() -> dict[str, Any]:
    return {
        "status": "ok",
        "backend": "whisper.cpp",
        "microphone_rate_hz": AUDIO_SAMPLE_RATE,
        "whisper_cpp_bin": str(WHISPER_CPP_BIN),
        "whisper_model": str(WHISPER_MODEL),
    }


if __name__ == "__main__":
    logger.info("Starting local whisper.cpp transcription server")
    logger.info("Send transcript WebSocket clients to ws://localhost:8000%s", PHONE_WS_PATH)
    uvicorn.run(app, host="0.0.0.0", port=8000, log_level="info")