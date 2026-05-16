from __future__ import annotations

import csv
import io
import logging
import os
import subprocess
import tempfile
import wave
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

try:
    from pyannote.audio import Pipeline  # type: ignore

    _HAS_PYANNOTE = True
except Exception:
    Pipeline = None  # type: ignore
    _HAS_PYANNOTE = False

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

APP_ROOT = Path(__file__).resolve().parent
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
WHISPER_MAX_LEN = int(os.getenv("WHISPER_MAX_LEN", "50"))
WHISPER_EXTRA_ARGS = os.getenv("WHISPER_EXTRA_ARGS", "").split()
PYANNOTE_MODEL = os.getenv("PYANNOTE_MODEL", "pyannote/speaker-diarization-3.1")
HF_TOKEN = os.getenv("HF_TOKEN") or os.getenv("HUGGING_FACE_HUB_TOKEN") or ""
if not HF_TOKEN:
    env_path = APP_ROOT / ".env"
    if env_path.exists():
        for raw_line in env_path.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            if key.strip() == "HF_TOKEN":
                HF_TOKEN = value.strip().strip('"').strip("'")
                break

speaker_profiles_by_session: dict[str, list["SpeakerProfile"]] = defaultdict(list)
_pyannote_pipeline: Any | None = None


@dataclass
class WhisperSegment:
    start: int
    end: int
    text: str


@dataclass
class DiarizationSegment:
    start: int
    end: int
    speaker: str


@dataclass
class LabeledSegment:
    start: int
    end: int
    text: str
    speaker: str


@dataclass
class SpeakerProfile:
    label: str
    centroid: np.ndarray
    sample_count: int = 1


def load_pyannote_pipeline() -> Any:
    global _pyannote_pipeline

    if _pyannote_pipeline is not None:
        return _pyannote_pipeline

    if not _HAS_PYANNOTE:
        raise RuntimeError("pyannote.audio is not installed")
    if not HF_TOKEN:
        raise RuntimeError("HF_TOKEN is required to load the pyannote diarization pipeline")

    _pyannote_pipeline = Pipeline.from_pretrained(PYANNOTE_MODEL, use_auth_token=HF_TOKEN)
    return _pyannote_pipeline


def build_wav_bytes(pcm_bytes: bytes) -> bytes:
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav_file:
        wav_file.setnchannels(CHANNELS)
        wav_file.setsampwidth(SAMPLE_WIDTH_BYTES)
        wav_file.setframerate(AUDIO_SAMPLE_RATE)
        wav_file.writeframes(pcm_bytes)
    return buffer.getvalue()


def slice_pcm16_bytes(pcm_bytes: bytes, start_ms: int, end_ms: int) -> bytes:
    start_sample = max(0, int(start_ms * AUDIO_SAMPLE_RATE / 1000))
    end_sample = max(start_sample, int(end_ms * AUDIO_SAMPLE_RATE / 1000))
    start_byte = start_sample * SAMPLE_WIDTH_BYTES
    end_byte = end_sample * SAMPLE_WIDTH_BYTES
    return pcm_bytes[start_byte:end_byte]


def pcm16_bytes_to_speaker_embedding(pcm_bytes: bytes) -> np.ndarray | None:
    audio = np.frombuffer(pcm_bytes, dtype=np.int16).astype(np.float32) / 32768.0
    if audio.size < int(0.25 * AUDIO_SAMPLE_RATE):
        return None

    audio = audio - float(np.mean(audio))
    rms = float(np.sqrt(np.mean(np.square(audio))))
    if not np.isfinite(rms) or rms < 0.01:
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
    embedding = np.concatenate([frame_matrix.mean(axis=0), frame_matrix.std(axis=0)]).astype(np.float32)
    norm = float(np.linalg.norm(embedding))
    if not np.isfinite(norm) or norm <= 0.0:
        return None

    return embedding / norm


def assign_speaker_label(session_id: str, pcm_bytes: bytes) -> str:
    embedding = pcm16_bytes_to_speaker_embedding(pcm_bytes)
    if embedding is None:
        return "speaker_0"

    profiles = speaker_profiles_by_session[session_id]
    if not profiles:
        profiles.append(SpeakerProfile(label="speaker_0", centroid=embedding.copy()))
        return "speaker_0"

    best_profile = max(profiles, key=lambda profile: float(np.dot(embedding, profile.centroid)))
    best_similarity = float(np.dot(embedding, best_profile.centroid))

    if best_similarity < 0.88 and len(profiles) < 4:
        label = f"speaker_{len(profiles)}"
        profiles.append(SpeakerProfile(label=label, centroid=embedding.copy()))
        return label

    updated_centroid = (best_profile.centroid * best_profile.sample_count + embedding) / (best_profile.sample_count + 1)
    updated_norm = float(np.linalg.norm(updated_centroid))
    if np.isfinite(updated_norm) and updated_norm > 0.0:
        best_profile.centroid = updated_centroid / updated_norm
    best_profile.sample_count += 1
    return best_profile.label


def parse_whisper_csv_file(csv_path: Path) -> list[WhisperSegment]:
    segments: list[WhisperSegment] = []
    with csv_path.open("r", encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            if not row:
                continue
            text = (row.get("text") or "").strip().strip('"')
            if not text:
                continue
            try:
                start_ms = int(float(row.get("start") or "0"))
                end_ms = int(float(row.get("end") or row.get("start") or "0"))
            except ValueError:
                continue
            segments.append(WhisperSegment(start=start_ms, end=end_ms, text=text))
    return segments


def wav_bytes_to_waveform(wav_bytes: bytes) -> tuple[np.ndarray, int]:
    with wave.open(io.BytesIO(wav_bytes), "rb") as wav_file:
        sample_rate = wav_file.getframerate()
        channel_count = wav_file.getnchannels()
        frame_bytes = wav_file.readframes(wav_file.getnframes())

    waveform = np.frombuffer(frame_bytes, dtype=np.int16).astype(np.float32) / 32768.0
    if channel_count > 1:
        waveform = waveform.reshape(-1, channel_count).mean(axis=1)
    waveform = np.asarray(waveform, dtype=np.float32).reshape(1, -1)
    return waveform, sample_rate


def diarize_wav_bytes(wav_bytes: bytes) -> list[DiarizationSegment]:
    pipeline = load_pyannote_pipeline()
    waveform, sample_rate = wav_bytes_to_waveform(wav_bytes)
    annotation = pipeline({"waveform": waveform, "sample_rate": sample_rate})
    segments: list[DiarizationSegment] = []
    for segment, _, label in annotation.itertracks(yield_label=True):
        segments.append(
            DiarizationSegment(
                start=int(segment.start * 1000),
                end=int(segment.end * 1000),
                speaker=str(label),
            )
        )
    return segments


def best_overlapping_speaker(segment: WhisperSegment, diarized_segments: list[DiarizationSegment]) -> str | None:
    best_speaker: str | None = None
    best_overlap = 0
    for diarized_segment in diarized_segments:
        overlap_ms = max(0, min(segment.end, diarized_segment.end) - max(segment.start, diarized_segment.start))
        if overlap_ms > best_overlap:
            best_overlap = overlap_ms
            best_speaker = diarized_segment.speaker
    return best_speaker


def merge_labeled_segments(segments: list[LabeledSegment]) -> list[LabeledSegment]:
    merged: list[LabeledSegment] = []
    for segment in segments:
        if merged and merged[-1].speaker == segment.speaker:
            merged[-1].end = segment.end
            merged[-1].text = f"{merged[-1].text} {segment.text}".strip()
        else:
            merged.append(segment)
    return merged


def transcribe_with_whisper_cpp(wav_bytes: bytes) -> tuple[list[WhisperSegment], str]:
    if not WHISPER_CPP_BIN.exists():
        raise FileNotFoundError(f"whisper.cpp binary not found: {WHISPER_CPP_BIN}")
    if not WHISPER_MODEL.exists():
        raise FileNotFoundError(f"whisper.cpp model not found: {WHISPER_MODEL}")

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp_wav:
        tmp_wav.write(wav_bytes)
        tmp_wav_path = Path(tmp_wav.name)
    csv_path = tmp_wav_path.with_suffix(".csv")
    try:
        command = [
            str(WHISPER_CPP_BIN),
            "-m",
            str(WHISPER_MODEL),
            "-ocsv",
            "-of",
            str(tmp_wav_path.with_suffix("")),
            "-ml",
            str(WHISPER_MAX_LEN),
            "-f",
            str(tmp_wav_path),
            "-l",
            WHISPER_LANG,
        ]
        command.extend(WHISPER_EXTRA_ARGS)
        completed = subprocess.run(command, check=True, capture_output=True, text=True)

        try:
            diag_log = DIAGNOSTICS_DIR / f"whisper_cli_{tmp_wav_path.stem}.log"
            with diag_log.open("w", encoding="utf-8") as fh:
                fh.write("COMMAND:\n" + " ".join(command) + "\n\n")
                fh.write("STDOUT:\n" + (completed.stdout or "") + "\n\n")
                fh.write("STDERR:\n" + (completed.stderr or "") + "\n")
        except Exception:
            logger.debug("Failed to write whisper-cli diagnostics log")

        segments = parse_whisper_csv_file(csv_path)
        transcript = " ".join(segment.text for segment in segments if segment.text)
        if not transcript:
            transcript = completed.stdout.strip() or completed.stderr.strip()
            if transcript:
                segments = [WhisperSegment(start=0, end=int(len(wav_bytes) * 1000 / (CHANNELS * SAMPLE_WIDTH_BYTES * AUDIO_SAMPLE_RATE)), text=transcript)]

        return segments, transcript
    finally:
        tmp_wav_path.unlink(missing_ok=True)
        csv_path.unlink(missing_ok=True)


def analyze_segment(session_id: str, pcm_bytes: bytes, wav_bytes: bytes) -> list[LabeledSegment]:
    whisper_segments, _ = transcribe_with_whisper_cpp(wav_bytes)
    if not whisper_segments:
        return []

    diarized_segments: list[DiarizationSegment] = []
    if _HAS_PYANNOTE and HF_TOKEN:
        try:
            diarized_segments = diarize_wav_bytes(wav_bytes)
        except Exception as exc:
            logger.warning("Pyannote diarization failed, falling back to single-speaker output: %s", exc)
            diarized_segments = []

    if not diarized_segments:
        return merge_labeled_segments(
            [
                LabeledSegment(start=segment.start, end=segment.end, text=segment.text, speaker="speaker_0")
                for segment in whisper_segments
            ]
        )

    local_to_global: dict[str, str] = {}
    for diarized_segment in diarized_segments:
        if diarized_segment.speaker not in local_to_global:
            speaker_audio = slice_pcm16_bytes(pcm_bytes, diarized_segment.start, diarized_segment.end)
            local_to_global[diarized_segment.speaker] = assign_speaker_label(session_id, speaker_audio)

    labeled_segments: list[LabeledSegment] = []
    for whisper_segment in whisper_segments:
        diarized_speaker = best_overlapping_speaker(whisper_segment, diarized_segments)
        speaker = local_to_global.get(diarized_speaker or "", "speaker_0")
        labeled_segments.append(
            LabeledSegment(
                start=whisper_segment.start,
                end=whisper_segment.end,
                text=whisper_segment.text,
                speaker=speaker,
            )
        )

    return merge_labeled_segments(labeled_segments)


def _write_temp_wav(wav_bytes: bytes) -> Path:
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp_wav:
        tmp_wav.write(wav_bytes)
        return Path(tmp_wav.name)
