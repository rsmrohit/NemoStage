"""Local microphone transcription server.

This process captures audio from the computer's microphone, streams it to the
configured transcription backend, and broadcasts transcript events to connected
clients over WebSocket. The same events are also saved to JSONL and can be
forwarded to the DGX Spark.
"""

from __future__ import annotations

import asyncio
import contextlib
import io
import json
import logging
import os
import re
import subprocess
import tempfile
import threading
import urllib.parse
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

import diarization_pipeline

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


def load_local_env_file(env_path: Path) -> None:
    if not env_path.exists():
        return

    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


load_local_env_file(APP_ROOT / ".env")

AUDIO_SAMPLE_RATE = 16000
CHANNELS = int(os.getenv("AUDIO_CHANNELS", "1"))
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

TRANSCRIPT_BACKEND = os.getenv("TRANSCRIPT_BACKEND", "deepgram").strip().lower()
DEEPGRAM_API_KEY = os.getenv("DEEPGRAM_API_KEY", "")
DEEPGRAM_WS_URL = os.getenv("DEEPGRAM_WS_URL", "wss://api.deepgram.com/v1/listen")
DEEPGRAM_MODEL = os.getenv("DEEPGRAM_MODEL", "nova-3")
DEEPGRAM_LANGUAGE = os.getenv("DEEPGRAM_LANGUAGE", "en-US")
DEEPGRAM_ENDPOINTING_MS = int(os.getenv("DEEPGRAM_ENDPOINTING_MS", "300"))
DEEPGRAM_UTTERANCE_END_MS = int(os.getenv("DEEPGRAM_UTTERANCE_END_MS", "1000"))
DEEPGRAM_INTERIM_RESULTS = os.getenv("DEEPGRAM_INTERIM_RESULTS", "true").lower() in ("1", "true", "yes")
DEEPGRAM_EMIT_INTERIM = os.getenv("DEEPGRAM_EMIT_INTERIM", "false").lower() in ("1", "true", "yes")
DEEPGRAM_SMART_FORMAT = os.getenv("DEEPGRAM_SMART_FORMAT", "true").lower() in ("1", "true", "yes")
DEEPGRAM_PUNCTUATE = os.getenv("DEEPGRAM_PUNCTUATE", "true").lower() in ("1", "true", "yes")
DEEPGRAM_MULTICHANNEL = os.getenv("DEEPGRAM_MULTICHANNEL", "false").lower() in ("1", "true", "yes")
DEEPGRAM_EXPECTED_SPEAKERS = int(os.getenv("DEEPGRAM_EXPECTED_SPEAKERS", "0"))
DEEPGRAM_MIN_NEW_SPEAKER_SECONDS = float(os.getenv("DEEPGRAM_MIN_NEW_SPEAKER_SECONDS", "0.7"))
DEEPGRAM_MIN_NEW_SPEAKER_CONFIDENCE = float(os.getenv("DEEPGRAM_MIN_NEW_SPEAKER_CONFIDENCE", "0.55"))

DGX_OUTPUT_WS_URL = os.getenv("DGX_OUTPUT_WS_URL", "")
PHONE_WS_PATH = os.getenv("PHONE_WS_PATH", "/ws/transcript")

CHUNK_WINDOW_SECONDS = float(os.getenv("CHUNK_WINDOW_SECONDS", "4.0"))
CHUNK_OVERLAP_SECONDS = float(os.getenv("CHUNK_OVERLAP_SECONDS", "1.0"))
SILENCE_TIMEOUT_SECONDS = float(os.getenv("SILENCE_TIMEOUT_SECONDS", "2.5"))
MIN_AUDIO_SECONDS = float(os.getenv("MIN_AUDIO_SECONDS", "0.6"))
MIN_AUDIO_BYTES = int(AUDIO_SAMPLE_RATE * CHANNELS * SAMPLE_WIDTH_BYTES * MIN_AUDIO_SECONDS)
CAPTURE_BLOCKSIZE = int(os.getenv("CAPTURE_BLOCKSIZE", "1024"))
MAX_SPEAKERS = int(os.getenv("MAX_SPEAKERS", "4"))
SPEAKER_SIMILARITY_THRESHOLD = float(os.getenv("SPEAKER_SIMILARITY_THRESHOLD", "0.88"))
SPEAKER_MIN_ENERGY = float(os.getenv("SPEAKER_MIN_ENERGY", "0.01"))

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
speaker_transcript = ""
segment_index = 0
speaker_profiles_by_session: dict[str, list["SpeakerProfile"]] = {}
speaker_turn_state_by_session: dict[str, "SpeakerTurnState"] = {}

SPEAKER_TURN_MARKER = "[SPEAKER_TURN]"
WHISPER_TIMESTAMP_LINE_RE = re.compile(
    r"^\[(?P<start>\d{2}:\d{2}:\d{2}\.\d{3})\s+-->\s+(?P<end>\d{2}:\d{2}:\d{2}\.\d{3})\]\s*(?P<text>.*)$"
)


@dataclass
class TranscriptEvent:
    type: str
    text: str
    full_transcript: str
    timestamp: str
    segment_index: int
    speaker_turn_index: int
    source: str = "whisper.cpp"
    speaker: Optional[str] = None
    channel: Optional[int] = None
    speaker_text: Optional[str] = None
    full_speaker_transcript: Optional[str] = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "type": self.type,
            "text": self.text,
            "full_transcript": self.full_transcript,
            "timestamp": self.timestamp,
            "segment_index": self.segment_index,
            "speaker_turn_index": self.speaker_turn_index,
            "source": self.source,
            "speaker": self.speaker,
            "channel": self.channel,
            "speaker_text": self.speaker_text,
            "full_speaker_transcript": self.full_speaker_transcript,
        }


@dataclass
class DeepgramTurn:
    speaker: str
    text: str
    start: Optional[float] = None
    end: Optional[float] = None
    confidence: Optional[float] = None
    channel: Optional[int] = None
    raw_speaker: Optional[str] = None


@dataclass
class DeepgramDialogueBuffer:
    speaker: Optional[str] = None
    text_parts: list[str] = None
    start: Optional[float] = None
    end: Optional[float] = None
    confidences: list[float] = None
    channel: Optional[int] = None

    def __post_init__(self) -> None:
        if self.text_parts is None:
            self.text_parts = []
        if self.confidences is None:
            self.confidences = []

    def append(self, turn: DeepgramTurn) -> None:
        if self.speaker is None:
            self.speaker = turn.speaker
        if self.start is None:
            self.start = turn.start
        if self.channel is None:
            self.channel = turn.channel
        if turn.end is not None:
            self.end = turn.end
        if turn.confidence is not None:
            self.confidences.append(turn.confidence)
        self.text_parts.append(turn.text)

    def preview(self) -> Optional[DeepgramTurn]:
        text = " ".join(part.strip() for part in self.text_parts if part.strip()).strip()
        if not text:
            return None

        confidence = None
        if self.confidences:
            confidence = sum(self.confidences) / len(self.confidences)

        return DeepgramTurn(
            speaker=self.speaker or "speaker_0",
            text=text,
            start=self.start,
            end=self.end,
            confidence=confidence,
            channel=self.channel,
            raw_speaker=self.speaker,
        )

    def flush(self) -> Optional[DeepgramTurn]:
        turn = self.preview()
        self.clear()
        return turn

    def clear(self) -> None:
        self.speaker = None
        self.text_parts = []
        self.start = None
        self.end = None
        self.confidences = []
        self.channel = None


@dataclass
class DeepgramSpeakerStabilizer:
    known_speakers: set[str] = None
    previous_speaker: Optional[str] = None

    def __post_init__(self) -> None:
        if self.known_speakers is None:
            self.known_speakers = set()

    def stabilize(self, turn: DeepgramTurn) -> DeepgramTurn:
        raw_speaker = turn.speaker
        if raw_speaker in self.known_speakers:
            self.previous_speaker = raw_speaker
            return turn

        if not self.known_speakers:
            self.known_speakers.add(raw_speaker)
            self.previous_speaker = raw_speaker
            return turn

        duration = None
        if turn.start is not None and turn.end is not None:
            duration = max(0.0, turn.end - turn.start)

        expected_speakers_reached = (
            DEEPGRAM_EXPECTED_SPEAKERS > 0 and len(self.known_speakers) >= DEEPGRAM_EXPECTED_SPEAKERS
        )
        too_short = duration is not None and duration < DEEPGRAM_MIN_NEW_SPEAKER_SECONDS
        too_uncertain = turn.confidence is not None and turn.confidence < DEEPGRAM_MIN_NEW_SPEAKER_CONFIDENCE

        if self.previous_speaker and (expected_speakers_reached or too_short or too_uncertain):
            return DeepgramTurn(
                speaker=self.previous_speaker,
                text=turn.text,
                start=turn.start,
                end=turn.end,
                confidence=turn.confidence,
                channel=turn.channel,
                raw_speaker=raw_speaker,
            )

        self.known_speakers.add(raw_speaker)
        self.previous_speaker = raw_speaker
        return turn


@dataclass
class SpeakerProfile:
    label: str
    centroid: np.ndarray
    sample_count: int = 1


@dataclass
class SpeakerTurnState:
    speaker: Optional[str] = None
    text_parts: list[str] = None
    start_segment_index: int = 0

    def __post_init__(self) -> None:
        if self.text_parts is None:
            self.text_parts = []

    def clear(self) -> None:
        self.speaker = None
        self.text_parts = []
        self.start_segment_index = 0

    def add_text(self, speaker: str, text: str, current_segment_index: int) -> list[tuple[str, str, int, int]]:
        flushed: list[tuple[str, str, int, int]] = []
        if self.speaker is None:
            self.speaker = speaker
            self.start_segment_index = current_segment_index

        if speaker != self.speaker:
            flushed.append((self.speaker, " ".join(self.text_parts).strip(), self.start_segment_index, current_segment_index - 1))
            self.speaker = speaker
            self.text_parts = [text]
            self.start_segment_index = current_segment_index
            return flushed

        self.text_parts.append(text)
        return flushed

    def flush(self, current_segment_index: int) -> tuple[str, str, int, int] | None:
        if self.speaker is None or not self.text_parts:
            return None
        return (
            self.speaker,
            " ".join(self.text_parts).strip(),
            self.start_segment_index,
            current_segment_index,
        )


def save_transcript_to_json(transcript_data: dict[str, Any], session_id: str) -> None:
    output_file = OUTPUT_JSON_DIR / f"transcript_{session_id}.jsonl"
    with output_file.open("a", encoding="utf-8") as handle:
        json.dump(transcript_data, handle, ensure_ascii=False)
        handle.write("\n")


def save_speaker_dialog_to_json(transcript_data: dict[str, Any], session_id: str, speaker: str) -> None:
    speaker_dir = OUTPUT_JSON_DIR / "speaker_dialogs" / session_id
    speaker_dir.mkdir(parents=True, exist_ok=True)
    output_file = speaker_dir / f"{speaker}.jsonl"
    with output_file.open("a", encoding="utf-8") as handle:
        json.dump(transcript_data, handle, ensure_ascii=False)
        handle.write("\n")


def get_speaker_turn_state(session_id: str) -> SpeakerTurnState:
    state = speaker_turn_state_by_session.get(session_id)
    if state is None:
        state = SpeakerTurnState()
        speaker_turn_state_by_session[session_id] = state
    return state


def format_speaker_text(speaker: Optional[str], text: str) -> str:
    label = speaker or "speaker_unknown"
    return f"[{label}] {text.strip()}"


async def emit_speaker_turn(
    session_id: str,
    speaker: str,
    text: str,
    start_segment_index: int,
    end_segment_index: int,
) -> None:
    global full_transcript, speaker_transcript

    cleaned_text = text.strip()
    if not cleaned_text:
        return

    speaker_text = format_speaker_text(speaker, cleaned_text)
    full_transcript = f"{full_transcript} {cleaned_text}".strip()
    speaker_transcript = f"{speaker_transcript}\n{speaker_text}".strip()
    event = TranscriptEvent(
        type="final",
        text=cleaned_text,
        full_transcript=full_transcript,
        timestamp=datetime.now().isoformat(),
        segment_index=end_segment_index,
        speaker_turn_index=start_segment_index,
        speaker=speaker,
        channel=None,
        speaker_text=speaker_text,
        full_speaker_transcript=speaker_transcript,
    )
    payload = event.to_dict() | {"session_id": session_id}
    await broadcast_payload(payload)
    save_transcript_to_json(payload, session_id)
    save_speaker_dialog_to_json(payload, session_id, speaker)
    await forward_to_dgx(payload)


async def flush_speaker_turn(session_id: str, current_segment_index: int) -> None:
    state = speaker_turn_state_by_session.get(session_id)
    if state is None:
        return

    flushed = state.flush(current_segment_index)
    if flushed is None:
        return

    speaker, text, start_segment_index, end_segment_index = flushed
    await emit_speaker_turn(session_id, speaker, text, start_segment_index, end_segment_index)
    state.clear()


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


def pcm16_bytes_to_speaker_embedding(pcm_bytes: bytes) -> np.ndarray | None:
    audio = np.frombuffer(pcm_bytes, dtype=np.int16).astype(np.float32) / 32768.0
    if audio.size < int(0.25 * AUDIO_SAMPLE_RATE):
        return None

    audio = audio - float(np.mean(audio))
    rms = float(np.sqrt(np.mean(np.square(audio))))
    if not np.isfinite(rms) or rms < SPEAKER_MIN_ENERGY:
        return None

    frame_size = int(0.025 * AUDIO_SAMPLE_RATE)
    hop_size = int(0.010 * AUDIO_SAMPLE_RATE)
    if frame_size <= 0 or hop_size <= 0 or audio.size < frame_size:
        return None

    window = np.hanning(frame_size).astype(np.float32)
    freq_bins = np.fft.rfftfreq(frame_size, d=1.0 / AUDIO_SAMPLE_RATE)
    nyquist = AUDIO_SAMPLE_RATE / 2.0
    voiced_frames: list[list[float]] = []

    for start in range(0, audio.size - frame_size + 1, hop_size):
        frame = audio[start : start + frame_size]
        frame_rms = float(np.sqrt(np.mean(np.square(frame))))
        if not np.isfinite(frame_rms) or frame_rms < rms * 0.35:
            continue

        framed = frame * window
        spectrum = np.abs(np.fft.rfft(framed)) + 1e-8
        spectral_sum = float(np.sum(spectrum))
        if spectral_sum <= 0.0:
            continue

        centroid = float(np.sum(freq_bins * spectrum) / spectral_sum)
        bandwidth = float(np.sqrt(np.sum(np.square(freq_bins - centroid) * spectrum) / spectral_sum))

        cumulative = np.cumsum(spectrum)
        rolloff_index = int(np.searchsorted(cumulative, 0.85 * cumulative[-1], side="left"))
        rolloff_index = min(max(rolloff_index, 0), freq_bins.size - 1)
        rolloff = float(freq_bins[rolloff_index])

        flatness = float(np.exp(np.mean(np.log(spectrum))) / np.mean(spectrum))
        zcr = float(np.mean(np.abs(np.diff(np.signbit(frame).astype(np.int8)))))
        dominant = float(freq_bins[int(np.argmax(spectrum))])

        pitch = 0.0
        autocorr = np.correlate(frame, frame, mode="full")[frame_size - 1 :]
        min_lag = max(1, int(AUDIO_SAMPLE_RATE / 400.0))
        max_lag = min(autocorr.size - 1, int(AUDIO_SAMPLE_RATE / 60.0))
        if max_lag > min_lag:
            pitch_region = autocorr[min_lag:max_lag]
            if pitch_region.size > 0:
                pitch_lag = min_lag + int(np.argmax(pitch_region))
                if pitch_lag > 0 and autocorr[pitch_lag] > 0:
                    pitch = float(AUDIO_SAMPLE_RATE / pitch_lag)

        voiced_frames.append(
            [
                frame_rms,
                centroid / nyquist,
                bandwidth / nyquist,
                rolloff / nyquist,
                flatness,
                zcr,
                dominant / nyquist,
                pitch / 400.0,
            ]
        )

    if not voiced_frames:
        return None

    frame_matrix = np.asarray(voiced_frames, dtype=np.float32)
    means = frame_matrix.mean(axis=0)
    stds = frame_matrix.std(axis=0)
    embedding = np.concatenate([means, stds]).astype(np.float32)
    norm = float(np.linalg.norm(embedding))
    if not np.isfinite(norm) or norm <= 0.0:
        return None

    return embedding / norm


def assign_speaker_label(session_id: str, pcm_bytes: bytes) -> str:
    embedding = pcm16_bytes_to_speaker_embedding(pcm_bytes)
    if embedding is None:
        return "speaker_0"

    profiles = speaker_profiles_by_session.setdefault(session_id, [])
    if not profiles:
        profiles.append(SpeakerProfile(label="speaker_0", centroid=embedding.copy()))
        return "speaker_0"

    best_profile = max(profiles, key=lambda profile: float(np.dot(embedding, profile.centroid)))
    best_similarity = float(np.dot(embedding, best_profile.centroid))

    if best_similarity < SPEAKER_SIMILARITY_THRESHOLD and len(profiles) < MAX_SPEAKERS:
        label = f"speaker_{len(profiles)}"
        profiles.append(SpeakerProfile(label=label, centroid=embedding.copy()))
        return label

    updated_centroid = (best_profile.centroid * best_profile.sample_count + embedding) / (best_profile.sample_count + 1)
    updated_norm = float(np.linalg.norm(updated_centroid))
    if np.isfinite(updated_norm) and updated_norm > 0.0:
        best_profile.centroid = updated_centroid / updated_norm
    best_profile.sample_count += 1
    return best_profile.label


def parse_whisper_cli_output(stdout: str) -> list[dict[str, Any]]:
    turns: list[dict[str, Any]] = []
    current_speaker_index = 0

    for raw_line in stdout.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        if line.startswith("main:") or line.startswith("system:"):
            continue

        speaker_turn_next = line.endswith(SPEAKER_TURN_MARKER)
        if speaker_turn_next:
            line = line[: -len(SPEAKER_TURN_MARKER)].rstrip()

        timestamp_match = WHISPER_TIMESTAMP_LINE_RE.match(line)
        if timestamp_match:
            line = timestamp_match.group("text").strip()

        if not line:
            continue

        turns.append(
            {
                "speaker": f"speaker_{current_speaker_index}",
                "text": line,
                "speaker_turn_next": speaker_turn_next,
            }
        )

        if speaker_turn_next:
            current_speaker_index = 1 - current_speaker_index

    return turns


def transcribe_with_whisper_cpp(wav_bytes: bytes) -> dict[str, Any]:
    """Transcribe WAV bytes and extract speaker info from TDRZ output.
    
    Returns a dict with 'text' (combined transcript), 'speaker' (current speaker label if detected),
    and 'turns' (parsed dialog turns).
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
        if "tdrz" in WHISPER_MODEL.name and "-tdrz" not in WHISPER_EXTRA_ARGS:
            command.append("-tdrz")
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

        turns = parse_whisper_cli_output(completed.stdout)
        transcript = " ".join(turn["text"] for turn in turns if turn["text"])
        if not transcript:
            transcript = completed.stdout.strip() or completed.stderr.strip()

        return {
            "text": transcript,
            "speaker": turns[-1]["speaker"] if turns else None,
            "turns": turns,
        }
    finally:
        tmp_wav_path.unlink(missing_ok=True)


def make_transcript_event(text: str, event_type: str = "final", speaker: Optional[str] = None) -> TranscriptEvent:
    speaker_text = format_speaker_text(speaker, text) if speaker else None
    return TranscriptEvent(
        type=event_type,
        text=text,
        full_transcript=full_transcript,
        timestamp=datetime.now().isoformat(),
        segment_index=segment_index,
        speaker_turn_index=segment_index,
        speaker=speaker,
        channel=None,
        speaker_text=speaker_text,
        full_speaker_transcript=speaker_transcript,
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


def build_deepgram_url() -> str:
    params = {
        "model": DEEPGRAM_MODEL,
        "language": DEEPGRAM_LANGUAGE,
        "encoding": "linear16",
        "sample_rate": str(AUDIO_SAMPLE_RATE),
        "channels": str(CHANNELS),
        "diarize": "true",
        "punctuate": str(DEEPGRAM_PUNCTUATE).lower(),
        "smart_format": str(DEEPGRAM_SMART_FORMAT).lower(),
        "interim_results": str(DEEPGRAM_INTERIM_RESULTS).lower(),
        "endpointing": str(DEEPGRAM_ENDPOINTING_MS),
        "utterance_end_ms": str(DEEPGRAM_UTTERANCE_END_MS),
    }
    if DEEPGRAM_MULTICHANNEL:
        params["multichannel"] = "true"
    return f"{DEEPGRAM_WS_URL}?{urllib.parse.urlencode(params)}"


async def connect_deepgram_socket() -> Any:
    headers = {"Authorization": f"Token {DEEPGRAM_API_KEY}"}
    url = build_deepgram_url()

    try:
        return await websockets.connect(url, additional_headers=headers)
    except TypeError:
        return await websockets.connect(url, extra_headers=headers)


def speaker_label(raw_speaker: Any, channel: Optional[int] = None) -> str:
    if DEEPGRAM_MULTICHANNEL and channel is not None:
        if raw_speaker is None:
            return f"channel_{channel}"
        return f"channel_{channel}_speaker_{raw_speaker}"

    if raw_speaker is None:
        return "speaker_0"
    return f"speaker_{raw_speaker}"


def deepgram_words_to_turns(words: list[dict[str, Any]], channel: Optional[int] = None) -> list[DeepgramTurn]:
    turns: list[DeepgramTurn] = []

    for word in words:
        token = str(word.get("punctuated_word") or word.get("word") or "").strip()
        if not token:
            continue

        speaker = speaker_label(word.get("speaker"), channel)
        start = word.get("start")
        end = word.get("end")
        confidence = word.get("confidence")

        if turns and turns[-1].speaker == speaker:
            turns[-1].text = f"{turns[-1].text} {token}".strip()
            turns[-1].end = end if isinstance(end, (int, float)) else turns[-1].end
            continue

        turns.append(
            DeepgramTurn(
                speaker=speaker,
                text=token,
                start=float(start) if isinstance(start, (int, float)) else None,
                end=float(end) if isinstance(end, (int, float)) else None,
                confidence=float(confidence) if isinstance(confidence, (int, float)) else None,
                channel=channel,
                raw_speaker=speaker,
            )
        )

    return turns


def extract_deepgram_turns(message: dict[str, Any]) -> tuple[list[DeepgramTurn], str, bool, bool]:
    channel = message.get("channel") or {}
    channel_index = message.get("channel_index") or []
    current_channel = channel_index[0] if isinstance(channel_index, list) and channel_index else None
    current_channel = int(current_channel) if isinstance(current_channel, int) else None
    alternatives = channel.get("alternatives") or []
    alternative = alternatives[0] if alternatives else {}
    transcript = str(alternative.get("transcript") or "").strip()
    words = alternative.get("words") or []
    turns = deepgram_words_to_turns(words, current_channel) if isinstance(words, list) else []

    if not turns and transcript:
        speaker = speaker_label(None, current_channel)
        turns = [DeepgramTurn(speaker=speaker, text=transcript, channel=current_channel, raw_speaker=speaker)]

    is_final = bool(message.get("is_final"))
    speech_final = bool(message.get("speech_final"))
    return turns, transcript, is_final, speech_final


async def emit_deepgram_turn(
    session_id: str,
    turn: DeepgramTurn,
    event_type: str,
    is_final: bool,
    speech_final: bool,
    reason: str = "result",
) -> None:
    global full_transcript, speaker_transcript, segment_index

    cleaned_text = turn.text.strip()
    if not cleaned_text:
        return

    speaker_text = format_speaker_text(turn.speaker, cleaned_text)
    if is_final:
        segment_index += 1
        full_transcript = f"{full_transcript} {cleaned_text}".strip()
        speaker_transcript = f"{speaker_transcript}\n{speaker_text}".strip()

    event = TranscriptEvent(
        type=event_type,
        text=cleaned_text,
        full_transcript=full_transcript,
        timestamp=datetime.now().isoformat(),
        segment_index=segment_index,
        speaker_turn_index=segment_index,
        source="deepgram",
        speaker=turn.speaker,
        channel=turn.channel,
        speaker_text=speaker_text,
        full_speaker_transcript=speaker_transcript,
    )
    payload = event.to_dict() | {
        "session_id": session_id,
        "is_final": is_final,
        "speech_final": speech_final,
        "final_reason": reason,
        "start": turn.start,
        "end": turn.end,
        "confidence": turn.confidence,
        "channel_index": turn.channel,
        "raw_speaker": turn.raw_speaker,
    }

    await broadcast_payload(payload)

    if is_final:
        save_transcript_to_json(payload, session_id)
        save_speaker_dialog_to_json(payload, session_id, turn.speaker)
        await forward_to_dgx(payload)


async def flush_deepgram_dialogue(
    session_id: str,
    dialogue_buffer: DeepgramDialogueBuffer,
    reason: str,
) -> None:
    turn = dialogue_buffer.flush()
    if turn is None:
        return

    await emit_deepgram_turn(
        session_id=session_id,
        turn=turn,
        event_type="final",
        is_final=True,
        speech_final=True,
        reason=reason,
    )


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

    if CHANNELS == 1:
        audio = indata[:, 0] if indata.ndim > 1 else indata
    else:
        audio = indata[:, :CHANNELS] if indata.ndim > 1 else indata.reshape(-1, 1)
    pcm_bytes = float32_audio_to_pcm16_bytes(np.asarray(audio, dtype=np.float32))
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
    if DEEPGRAM_MULTICHANNEL and CHANNELS < 2:
        logger.warning("DEEPGRAM_MULTICHANNEL=true requires AUDIO_CHANNELS>=2 to separate speakers by channel")


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

    try:
        if ENABLE_NOISE_REDUCTION and _HAS_NOISEREDUCE:
            pcm = np.frombuffer(segment_bytes, dtype=np.int16).astype(np.float32) / 32767.0
            reduced = nr.reduce_noise(y=pcm, sr=AUDIO_SAMPLE_RATE)
            processed_pcm_bytes = (np.clip(reduced, -1.0, 1.0) * 32767.0).astype(np.int16).tobytes()
        else:
            processed_pcm_bytes = segment_bytes
    except Exception as exc:
        logger.warning("Noise reduction failed or unavailable: %s", exc)
        processed_pcm_bytes = segment_bytes

    wav_bytes = build_wav_bytes(processed_pcm_bytes)

    try:
        diag_wav = DIAGNOSTICS_DIR / f"session_{session_id}_segment_{segment_index + 1}.wav"
        with diag_wav.open("wb") as fh:
            fh.write(wav_bytes)
    except Exception:
        logger.debug("Failed to save diagnostic WAV for segment %s", segment_index + 1)

    try:
        labeled_segments = await asyncio.to_thread(
            diarization_pipeline.analyze_segment,
            session_id,
            processed_pcm_bytes,
            wav_bytes,
        )
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

    if not labeled_segments:
        return

    state = get_speaker_turn_state(session_id)

    for labeled_segment in labeled_segments:
        transcript_text = labeled_segment.text.strip()
        if not transcript_text:
            continue

        segment_index += 1
        flushed = state.add_text(labeled_segment.speaker, transcript_text, segment_index)
        for speaker, text, start_segment_index, end_segment_index in flushed:
            await emit_speaker_turn(session_id, speaker, text, start_segment_index, end_segment_index)


async def local_transcription_pipeline() -> None:
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


async def deepgram_audio_sender(socket: Any) -> None:
    while True:
        try:
            chunk = await asyncio.wait_for(audio_queue.get(), timeout=5.0)
        except asyncio.TimeoutError:
            await socket.send(json.dumps({"type": "KeepAlive"}))
            continue

        if chunk is None:
            await socket.send(json.dumps({"type": "CloseStream"}))
            return

        if chunk:
            await socket.send(chunk)


async def deepgram_result_receiver(session_id: str, socket: Any) -> None:
    dialogue_buffer = DeepgramDialogueBuffer()
    speaker_stabilizer = DeepgramSpeakerStabilizer()

    async for raw_message in socket:
        try:
            message = json.loads(raw_message)
        except json.JSONDecodeError:
            logger.debug("Ignoring non-JSON Deepgram message: %s", raw_message)
            continue

        message_type = message.get("type")
        if message_type == "UtteranceEnd":
            await flush_deepgram_dialogue(session_id, dialogue_buffer, reason="utterance_end")
            continue

        if message_type != "Results":
            logger.debug("Deepgram control message: %s", message_type)
            continue

        turns, transcript, is_final, speech_final = extract_deepgram_turns(message)
        if not transcript and not turns:
            continue

        if not is_final:
            if DEEPGRAM_EMIT_INTERIM:
                preview = turns[-1] if turns else DeepgramTurn(speaker="speaker_0", text=transcript)
                await emit_deepgram_turn(
                    session_id=session_id,
                    turn=preview,
                    event_type="interim",
                    is_final=False,
                    speech_final=False,
                    reason="interim",
                )
            continue

        for raw_turn in turns:
            turn = speaker_stabilizer.stabilize(raw_turn)
            if dialogue_buffer.speaker is not None and turn.speaker != dialogue_buffer.speaker:
                await flush_deepgram_dialogue(session_id, dialogue_buffer, reason="speaker_change")
            dialogue_buffer.append(turn)

        if speech_final:
            await flush_deepgram_dialogue(session_id, dialogue_buffer, reason="speech_final")

    await flush_deepgram_dialogue(session_id, dialogue_buffer, reason="socket_closed")


async def deepgram_transcription_pipeline() -> None:
    session_id = datetime.now().strftime("%Y%m%d_%H%M%S_%f")

    if not DEEPGRAM_API_KEY:
        error_event = {
            "type": "error",
            "error": "DEEPGRAM_API_KEY is required when TRANSCRIPT_BACKEND=deepgram",
            "timestamp": datetime.now().isoformat(),
            "session_id": session_id,
        }
        logger.error(error_event["error"])
        await broadcast_payload(error_event)
        save_transcript_to_json(error_event, session_id)
        return

    logger.info("Deepgram transcription pipeline started: %s", session_id)

    socket = await connect_deepgram_socket()
    try:
        sender = asyncio.create_task(deepgram_audio_sender(socket))
        receiver = asyncio.create_task(deepgram_result_receiver(session_id, socket))
        done, pending = await asyncio.wait({sender, receiver}, return_when=asyncio.FIRST_COMPLETED)

        for task in done:
            exception = task.exception()
            if exception is not None:
                raise exception

        if sender in done and receiver in pending:
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(receiver, timeout=3.0)
            pending.discard(receiver)

        for task in pending:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
    except Exception as exc:
        error_event = {
            "type": "error",
            "error": f"Deepgram transcription failed: {exc}",
            "timestamp": datetime.now().isoformat(),
            "session_id": session_id,
        }
        logger.exception("Deepgram transcription failed")
        await broadcast_payload(error_event)
        save_transcript_to_json(error_event, session_id)
    finally:
        with contextlib.suppress(Exception):
            await socket.close()


async def transcription_pipeline() -> None:
    if TRANSCRIPT_BACKEND == "deepgram":
        await deepgram_transcription_pipeline()
        return

    if TRANSCRIPT_BACKEND not in {"local", "whisper", "whisper.cpp"}:
        logger.warning("Unknown TRANSCRIPT_BACKEND=%s; falling back to local whisper.cpp", TRANSCRIPT_BACKEND)

    await local_transcription_pipeline()


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
        if not pipeline_task.done():
            await audio_queue.put(None)
        await pipeline_task
        pipeline_task = None

    for session_id in list(speaker_turn_state_by_session.keys()):
        await flush_speaker_turn(session_id, segment_index)


@app.websocket("/ws/transcript")
async def websocket_transcript(websocket: WebSocket) -> None:
    await websocket.accept()
    connected_clients.add(websocket)
    await websocket.send_json(
        {
            "type": "sync",
            "full_transcript": full_transcript,
            "full_speaker_transcript": speaker_transcript,
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
        "backend": TRANSCRIPT_BACKEND,
        "microphone_rate_hz": AUDIO_SAMPLE_RATE,
        "audio_channels": CHANNELS,
        "deepgram_model": DEEPGRAM_MODEL if TRANSCRIPT_BACKEND == "deepgram" else None,
        "deepgram_configured": bool(DEEPGRAM_API_KEY),
        "deepgram_multichannel": DEEPGRAM_MULTICHANNEL if TRANSCRIPT_BACKEND == "deepgram" else None,
        "deepgram_expected_speakers": DEEPGRAM_EXPECTED_SPEAKERS if TRANSCRIPT_BACKEND == "deepgram" else None,
        "whisper_cpp_bin": str(WHISPER_CPP_BIN),
        "whisper_model": str(WHISPER_MODEL),
    }


if __name__ == "__main__":
    logger.info("Starting transcription server with backend=%s", TRANSCRIPT_BACKEND)
    logger.info("Send transcript WebSocket clients to ws://localhost:8000%s", PHONE_WS_PATH)
    uvicorn.run(app, host="0.0.0.0", port=8000, log_level="info")
