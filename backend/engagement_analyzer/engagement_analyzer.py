"""Audience Engagement Analyzer using MediaPipe Tasks + YOLO + simple tracking."""

import cv2
import numpy as np
import json
import logging
from pathlib import Path
from dataclasses import dataclass, asdict
from datetime import datetime
from collections import defaultdict, deque
from typing import Optional, Dict, List, Tuple
import math

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


@dataclass
class FaceSignals:
    """Facial signals extracted from landmarks and head pose."""
    face_present: bool
    head_pitch_deg: float  # Positive = looking down
    head_yaw_deg: float    # Positive = looking right
    head_roll_deg: float
    eyes_open: bool
    eye_aspect_ratio: float
    gaze_forward: bool
    blink_detected: bool
    pose_reliable: bool


@dataclass
class PersonState:
    """Per-person engagement state."""
    track_id: int
    bbox: Tuple[int, int, int, int]  # x, y, w, h
    state: str  # engaged, looking_down, on_phone, asleep, distracted, absent
    engagement_score: float  # 0.0 to 1.0
    confidence: float
    likely_activity: str
    signals: Dict


@dataclass
class EngagementBucketSummary:
    """Room-level engagement summary for one time bucket."""
    timestamp_ms: int
    engagement_score: float
    audience_count: int
    confidence: float
    change: float
    dominant_signals: List[str]


class EngagementAggregator:
    """Aggregate per-person frame scores into smoothed room-level buckets."""

    def __init__(
        self,
        fps: float = 30.0,
        bucket_seconds: float = 5.0,
        previous_weight: float = 0.7,
        current_weight: float = 0.3,
    ):
        self.fps = fps if fps > 0 else 30.0
        self.bucket_seconds = bucket_seconds if bucket_seconds > 0 else 5.0
        self.previous_weight = previous_weight
        self.current_weight = current_weight
        self.bucket_frame_scores: List[float] = []
        self.bucket_confidences: List[float] = []
        self.bucket_audience_counts: List[int] = []
        self.bucket_state_counts: Dict[str, int] = defaultdict(int)
        self.current_bucket_index: Optional[int] = None
        self.previous_smoothed_score: Optional[float] = None

    def add_frame(self, frame_id: int, person_states: List[PersonState]) -> Optional[EngagementBucketSummary]:
        """Add one frame and return a completed bucket summary when available."""
        timestamp_ms = self._frame_to_ms(frame_id)
        bucket_index = int((timestamp_ms / 1000.0) // self.bucket_seconds)

        if self.current_bucket_index is None:
            self.current_bucket_index = bucket_index

        completed_summary = None
        if bucket_index != self.current_bucket_index and self.bucket_frame_scores:
            completed_summary = self._build_summary(self.current_bucket_index)
            self._reset_bucket(bucket_index)

        frame_score, frame_confidence, audience_count, state_counts = self._score_frame(person_states)
        self.bucket_frame_scores.append(frame_score)
        self.bucket_confidences.append(frame_confidence)
        self.bucket_audience_counts.append(audience_count)
        for state, count in state_counts.items():
            self.bucket_state_counts[state] += count

        return completed_summary

    def flush(self) -> Optional[EngagementBucketSummary]:
        """Return the current partial bucket summary, if any frames were collected."""
        if self.current_bucket_index is None or not self.bucket_frame_scores:
            return None
        summary = self._build_summary(self.current_bucket_index)
        self._reset_bucket(None)
        return summary

    def _score_frame(self, person_states: List[PersonState]) -> Tuple[float, float, int, Dict[str, int]]:
        """Compute one confidence-weighted room score from the current people."""
        if not person_states:
            fallback_score = self.previous_smoothed_score if self.previous_smoothed_score is not None else 0.0
            return fallback_score, 0.0, 0, {}

        weighted_score_sum = 0.0
        weight_sum = 0.0
        state_counts: Dict[str, int] = defaultdict(int)
        audience_count = 0

        for person in person_states:
            state_counts[person.state] += 1
            presence_weight = 0.2 if person.state == "absent" else 1.0
            confidence = max(0.0, min(1.0, float(person.confidence)))
            weight = confidence * presence_weight
            weighted_score_sum += float(person.engagement_score) * weight
            weight_sum += weight

            if person.state != "absent":
                audience_count += 1

        if weight_sum <= 0:
            fallback_score = self.previous_smoothed_score if self.previous_smoothed_score is not None else 0.0
            return fallback_score, 0.0, audience_count, state_counts

        frame_score = weighted_score_sum / weight_sum
        frame_confidence = min(1.0, weight_sum / max(len(person_states), 1))
        return frame_score, frame_confidence, audience_count, state_counts

    def _build_summary(self, bucket_index: int) -> EngagementBucketSummary:
        raw_score = sum(self.bucket_frame_scores) / len(self.bucket_frame_scores)
        confidence = sum(self.bucket_confidences) / len(self.bucket_confidences)
        audience_count = round(sum(self.bucket_audience_counts) / len(self.bucket_audience_counts))

        if self.previous_smoothed_score is None:
            smoothed_score = raw_score
            change = 0.0
        else:
            smoothed_score = (
                self.previous_weight * self.previous_smoothed_score
                + self.current_weight * raw_score
            )
            change = smoothed_score - self.previous_smoothed_score

        self.previous_smoothed_score = smoothed_score
        dominant_signals = self._dominant_signals()

        return EngagementBucketSummary(
            timestamp_ms=int(bucket_index * self.bucket_seconds * 1000),
            engagement_score=max(0.0, min(1.0, smoothed_score)),
            audience_count=int(audience_count),
            confidence=max(0.0, min(1.0, confidence)),
            change=change,
            dominant_signals=dominant_signals,
        )

    def _dominant_signals(self) -> List[str]:
        state_to_signal = {
            "engaged": "forward_attention",
            "looking_down": "looking_down",
            "on_phone": "phone_use",
            "asleep": "sleep_like",
            "distracted": "looking_away",
            "absent": "brief_absence",
            "neutral": "neutral_attention",
        }
        sorted_states = sorted(self.bucket_state_counts.items(), key=lambda item: item[1], reverse=True)
        signals = []
        for state, _count in sorted_states:
            signal = state_to_signal.get(state, state)
            if signal not in signals:
                signals.append(signal)
            if len(signals) == 3:
                break
        return signals

    def _reset_bucket(self, bucket_index: Optional[int]) -> None:
        self.current_bucket_index = bucket_index
        self.bucket_frame_scores = []
        self.bucket_confidences = []
        self.bucket_audience_counts = []
        self.bucket_state_counts = defaultdict(int)

    def _frame_to_ms(self, frame_id: int) -> int:
        return int((frame_id / self.fps) * 1000)


class AudienceMemberEngagementTracker:
    """Track recurring audience members and write per-member engagement JSON."""

    def __init__(
        self,
        output_dir: Path,
        session_id: str,
        fps: float = 30.0,
        bucket_seconds: float = 5.0,
        recognition_threshold: float = 0.80,
        min_member_frames: int = 10,
        max_feature_prototypes: int = 5,
    ):
        self.fps = fps if fps > 0 else 30.0
        self.bucket_seconds = bucket_seconds if bucket_seconds > 0 else 5.0
        self.recognition_threshold = recognition_threshold
        self.min_member_frames = max(1, min_member_frames)
        self.max_feature_prototypes = max(1, max_feature_prototypes)
        self.session_id = session_id
        self.output_dir = Path(output_dir) / f"audience_engagement_{session_id}"
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.member_feature_file = self.output_dir / "face_feature_registry.json"

        self.next_member_index = 1
        self.track_to_member: Dict[int, str] = {}
        self.member_signatures: Dict[str, np.ndarray] = {}
        self.member_feature_prototypes: Dict[str, List[np.ndarray]] = {}
        self.member_last_bbox: Dict[str, Tuple[int, int, int, int]] = {}
        self.member_last_seen_ms: Dict[str, int] = {}
        self.member_files: Dict[str, Path] = {}
        self.member_payloads: Dict[str, Dict] = {}
        self.member_buckets: Dict[str, Dict] = {}
        self.pending_tracks: Dict[int, Dict] = {}

    def add_frame(self, frame_id: int, frame: np.ndarray, person_states: List[PersonState]) -> None:
        """Assign current people to stable members and collect per-member bucket stats."""
        timestamp_ms = self._frame_to_ms(frame_id)
        bucket_index = int((timestamp_ms / 1000.0) // self.bucket_seconds)
        used_visible_members = set()

        for person in person_states:
            member_id = self._resolve_member(frame, person, timestamp_ms, used_visible_members)
            if member_id is None:
                continue
            if person.state != "absent":
                used_visible_members.add(member_id)
            self._add_member_state(member_id, bucket_index, timestamp_ms, person)
        self._cleanup_pending_tracks(timestamp_ms)

    def flush(self) -> None:
        """Write any partial per-member buckets."""
        for member_id in list(self.member_buckets.keys()):
            self._finalize_member_bucket(member_id)
        self._write_feature_registry()

    def _resolve_member(
        self,
        frame: np.ndarray,
        person: PersonState,
        timestamp_ms: int,
        used_visible_members: set,
    ) -> Optional[str]:
        if person.track_id in self.track_to_member:
            member_id = self.track_to_member[person.track_id]
            if person.state != "absent":
                self._update_member_signature(member_id, frame, person.bbox)
                self._remember_member_position(member_id, person.bbox, timestamp_ms)
            return member_id

        if person.state == "absent":
            return None

        signature = self._face_signature(frame, person.bbox)
        member_id, similarity = self._find_matching_member(
            signature,
            used_visible_members,
        )
        if member_id is not None:
            self._merge_signature(member_id, signature)
            self._remember_member_position(member_id, person.bbox, timestamp_ms)
            self.track_to_member[person.track_id] = member_id
            self.pending_tracks.pop(person.track_id, None)
            return member_id

        member_id = self._resolve_pending_track(
            person.track_id,
            signature,
            person.bbox,
            timestamp_ms,
            used_visible_members,
        )
        if member_id is None:
            return None

        if signature is not None:
            self.member_signatures[member_id] = signature
        self._remember_member_position(member_id, person.bbox, timestamp_ms)
        self.track_to_member[person.track_id] = member_id
        return member_id

    def _add_member_state(
        self,
        member_id: str,
        bucket_index: int,
        timestamp_ms: int,
        person: PersonState,
    ) -> None:
        bucket = self.member_buckets.get(member_id)
        if bucket is None:
            bucket = self._new_bucket(bucket_index)
            self.member_buckets[member_id] = bucket
        elif bucket["bucket_index"] != bucket_index:
            self._finalize_member_bucket(member_id)
            bucket = self._new_bucket(bucket_index)
            self.member_buckets[member_id] = bucket

        bucket["scores"].append(float(person.engagement_score))
        bucket["confidences"].append(float(person.confidence))
        bucket["states"][person.state] += 1
        bucket["activities"][person.likely_activity] += 1
        bucket["track_ids"].add(int(person.track_id))
        bucket["last_timestamp_ms"] = int(timestamp_ms)

    def _finalize_member_bucket(self, member_id: str) -> None:
        bucket = self.member_buckets.pop(member_id, None)
        if bucket is None or not bucket["scores"]:
            return

        score = sum(bucket["scores"]) / len(bucket["scores"])
        confidence = sum(bucket["confidences"]) / len(bucket["confidences"])
        dominant_state = self._top_key(bucket["states"])
        dominant_activity = self._top_key(bucket["activities"])
        record = {
            "timestamp_ms": int(bucket["bucket_index"] * self.bucket_seconds * 1000),
            "end_timestamp_ms": int(bucket["last_timestamp_ms"]),
            "engagement_score": max(0.0, min(1.0, score)),
            "confidence": max(0.0, min(1.0, confidence)),
            "dominant_state": dominant_state,
            "dominant_activity": dominant_activity,
            "track_ids": sorted(bucket["track_ids"]),
            "frame_count": len(bucket["scores"]),
        }

        payload = self.member_payloads[member_id]
        payload["records"].append(record)
        payload["last_seen_timestamp_ms"] = record["end_timestamp_ms"]
        payload["average_engagement_score"] = self._average_member_score(payload["records"])
        self._write_member_file(member_id)

    def _resolve_pending_track(
        self,
        track_id: int,
        signature: Optional[np.ndarray],
        bbox: Tuple[int, int, int, int],
        timestamp_ms: int,
        used_visible_members: set,
    ) -> Optional[str]:
        pending = self.pending_tracks.get(track_id)
        if pending is None:
            pending = {
                "first_timestamp_ms": timestamp_ms,
                "last_timestamp_ms": timestamp_ms,
                "frames": 0,
                "signatures": [],
                "last_bbox": bbox,
            }
            self.pending_tracks[track_id] = pending

        pending["frames"] += 1
        pending["last_timestamp_ms"] = timestamp_ms
        pending["last_bbox"] = bbox
        if signature is not None:
            pending["signatures"].append(signature)

        if pending["frames"] < self.min_member_frames:
            return None

        averaged_signature = None
        if pending["signatures"]:
            averaged_signature = self._average_signatures(pending["signatures"])
            member_id, _similarity = self._find_matching_member(
                averaged_signature,
                used_visible_members,
            )
            if member_id is not None:
                self._add_member_feature(member_id, averaged_signature)
                self.pending_tracks.pop(track_id, None)
                return member_id

        member_id = self._create_member()
        if averaged_signature is not None:
            self._add_member_feature(member_id, averaged_signature)
        self.pending_tracks.pop(track_id, None)
        return member_id

    def _cleanup_pending_tracks(self, timestamp_ms: int) -> None:
        max_pending_age_ms = int(max(self.bucket_seconds * 1000, 2000))
        stale_track_ids = [
            track_id
            for track_id, pending in self.pending_tracks.items()
            if timestamp_ms - pending["last_timestamp_ms"] > max_pending_age_ms
        ]
        for track_id in stale_track_ids:
            self.pending_tracks.pop(track_id, None)

    def _create_member(self) -> str:
        member_id = f"member{self.next_member_index}"
        self.next_member_index += 1
        self.member_files[member_id] = self.output_dir / f"{member_id}.json"
        self.member_payloads[member_id] = {
            "session_id": self.session_id,
            "member_id": member_id,
            "created_at": datetime.now().isoformat(),
            "average_engagement_score": None,
            "last_seen_timestamp_ms": None,
            "records": [],
        }
        self._write_member_file(member_id)
        self._write_feature_registry()
        return member_id

    def _find_matching_member(
        self,
        signature: Optional[np.ndarray],
        used_visible_members: set,
    ) -> Tuple[Optional[str], float]:
        if signature is None:
            return None, -1.0

        best_member_id = None
        best_similarity = -1.0

        candidate_member_ids = set(self.member_feature_prototypes) | set(self.member_signatures)
        for member_id in candidate_member_ids:
            if member_id in used_visible_members:
                continue
            similarity = self._best_feature_similarity(signature, member_id)
            if similarity < self.recognition_threshold:
                continue

            if similarity > best_similarity:
                best_similarity = similarity
                best_member_id = member_id

        return best_member_id, best_similarity

    def _update_member_signature(self, member_id: str, frame: np.ndarray, bbox: Tuple[int, int, int, int]) -> None:
        signature = self._face_signature(frame, bbox)
        if signature is None:
            return
        if member_id not in self.member_signatures:
            self._add_member_feature(member_id, signature)
        else:
            self._merge_signature(member_id, signature)

    def _merge_signature(self, member_id: str, signature: Optional[np.ndarray]) -> None:
        if signature is None:
            return
        self._add_member_feature(member_id, signature)

    def _face_signature(self, frame: np.ndarray, bbox: Tuple[int, int, int, int]) -> Optional[np.ndarray]:
        x, y, w, h = bbox
        frame_h, frame_w = frame.shape[:2]
        pad_x = int(w * 0.15)
        pad_y = int(h * 0.15)
        x1 = max(0, x - pad_x)
        y1 = max(0, y - pad_y)
        x2 = min(frame_w, x + w + pad_x)
        y2 = min(frame_h, y + h + pad_y)
        if x2 <= x1 or y2 <= y1:
            return None

        crop = frame[y1:y2, x1:x2]
        if crop.size == 0:
            return None

        gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
        gray = cv2.equalizeHist(gray)
        resized = cv2.resize(gray, (16, 16), interpolation=cv2.INTER_AREA)
        texture_source = cv2.resize(gray, (32, 32), interpolation=cv2.INTER_AREA)

        appearance = resized.astype(np.float32).reshape(-1)
        appearance -= float(appearance.mean())
        appearance_norm = np.linalg.norm(appearance)
        if appearance_norm > 0:
            appearance = appearance / appearance_norm

        texture = self._lbp_histogram(texture_source)
        signature = np.concatenate([appearance * 0.65, texture * 0.35]).astype(np.float32)
        norm = np.linalg.norm(signature)
        if norm <= 0:
            return None
        return signature / norm

    def _add_member_feature(self, member_id: str, signature: np.ndarray) -> None:
        prototypes = self.member_feature_prototypes.setdefault(member_id, [])
        if not prototypes:
            prototypes.append(signature)
        else:
            similarities = [self._cosine_similarity(signature, prototype) for prototype in prototypes]
            best_index = int(np.argmax(similarities))
            if similarities[best_index] >= 0.95:
                merged = 0.80 * prototypes[best_index] + 0.20 * signature
                norm = np.linalg.norm(merged)
                prototypes[best_index] = merged / norm if norm > 0 else signature
            elif len(prototypes) < self.max_feature_prototypes:
                prototypes.append(signature)
            else:
                prototypes[best_index] = signature

        self.member_signatures[member_id] = self._average_signatures(prototypes)

    def _best_feature_similarity(self, signature: np.ndarray, member_id: str) -> float:
        prototypes = self.member_feature_prototypes.get(member_id, [])
        if not prototypes and member_id in self.member_signatures:
            prototypes = [self.member_signatures[member_id]]
        if not prototypes:
            return -1.0
        return max(self._cosine_similarity(signature, prototype) for prototype in prototypes)

    @staticmethod
    def _lbp_histogram(gray: np.ndarray) -> np.ndarray:
        center = gray[1:-1, 1:-1]
        codes = np.zeros_like(center, dtype=np.uint8)
        offsets = [
            (-1, -1), (-1, 0), (-1, 1), (0, 1),
            (1, 1), (1, 0), (1, -1), (0, -1),
        ]
        for bit, (dy, dx) in enumerate(offsets):
            neighbor = gray[1 + dy: gray.shape[0] - 1 + dy, 1 + dx: gray.shape[1] - 1 + dx]
            codes |= ((neighbor >= center).astype(np.uint8) << bit)

        hist = cv2.calcHist([codes], [0], None, [32], [0, 256]).flatten().astype(np.float32)
        total = float(hist.sum())
        return hist / total if total > 0 else hist

    def _remember_member_position(
        self,
        member_id: str,
        bbox: Tuple[int, int, int, int],
        timestamp_ms: int,
    ) -> None:
        self.member_last_bbox[member_id] = tuple(int(value) for value in bbox)
        self.member_last_seen_ms[member_id] = int(timestamp_ms)

    @staticmethod
    def _average_signatures(signatures: List[np.ndarray]) -> np.ndarray:
        average = np.mean(np.stack(signatures), axis=0)
        norm = np.linalg.norm(average)
        return average / norm if norm > 0 else signatures[-1]

    @staticmethod
    def _cosine_similarity(first: np.ndarray, second: np.ndarray) -> float:
        return float(np.dot(first, second))

    @staticmethod
    def _new_bucket(bucket_index: int) -> Dict:
        return {
            "bucket_index": bucket_index,
            "scores": [],
            "confidences": [],
            "states": defaultdict(int),
            "activities": defaultdict(int),
            "track_ids": set(),
            "last_timestamp_ms": int(bucket_index),
        }

    @staticmethod
    def _top_key(counts: Dict[str, int]) -> Optional[str]:
        if not counts:
            return None
        return max(counts.items(), key=lambda item: item[1])[0]

    @staticmethod
    def _average_member_score(records: List[Dict]) -> Optional[float]:
        if not records:
            return None
        return sum(float(record["engagement_score"]) for record in records) / len(records)

    def _write_member_file(self, member_id: str) -> None:
        path = self.member_files[member_id]
        with path.open("w", encoding="utf-8") as fh:
            json.dump(self.member_payloads[member_id], fh, ensure_ascii=False, indent=2)
            fh.write("\n")

    def _write_feature_registry(self) -> None:
        members = {}
        for member_id, prototypes in self.member_feature_prototypes.items():
            members[member_id] = {
                "feature_version": "opencv_lbp_appearance_v1",
                "similarity_threshold": float(self.recognition_threshold),
                "prototype_count": len(prototypes),
                "prototypes": [
                    [round(float(value), 6) for value in prototype.tolist()]
                    for prototype in prototypes
                ],
                "last_bbox": (
                    [int(value) for value in self.member_last_bbox[member_id]]
                    if member_id in self.member_last_bbox
                    else None
                ),
                "last_seen_timestamp_ms": (
                    int(self.member_last_seen_ms[member_id])
                    if member_id in self.member_last_seen_ms
                    else None
                ),
            }

        payload = {
            "session_id": self.session_id,
            "feature_version": "opencv_lbp_appearance_v1",
            "similarity_threshold": float(self.recognition_threshold),
            "members": members,
        }

        with self.member_feature_file.open("w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False, indent=2)
            fh.write("\n")

    def _frame_to_ms(self, frame_id: int) -> int:
        return int((frame_id / self.fps) * 1000)


class EngagementAnalyzer:
    """Main engagement analyzer combining face detection, YOLO, and rules-based scoring."""

    def __init__(self, yolo_model: str = "yolov8n.pt"):
        """Initialize with MediaPipe Face Detector and YOLO models."""
        try:
            from mediapipe.tasks import vision
            from mediapipe.framework.formats import landmark_pb2
            
            BaseOptions = vision.BaseOptions
            FaceDetectorOptions = vision.FaceDetectorOptions
            VisionRunningMode = vision.VisionRunningMode
            
            # Face detector using MediaPipe Tasks API
            face_detector_options = FaceDetectorOptions(
                base_options=BaseOptions(model_asset_path=None),  # Use default model
                running_mode=VisionRunningMode.IMAGE,
                max_num_faces=10,
                min_detection_confidence=0.5,
                min_suppression_threshold=0.3,
            )
            self.face_detector = vision.FaceDetector.create_from_options(face_detector_options)
            self.mp_vision_available = True
        except Exception as e:
            logger.warning(f"MediaPipe Tasks not available: {e}. Using fallback face detection.")
            self.mp_vision_available = False
            self.face_detector = None
        
        # YOLO for phone detection
        try:
            from ultralytics import YOLO
            self.yolo = YOLO(yolo_model)
            self.yolo_available = True
        except Exception as e:
            logger.warning(f"YOLO unavailable: {e}. Phone detection disabled.")
            self.yolo_available = False

        # Simple tracking: separate position history and signal history
        self.position_history: Dict[int, deque] = defaultdict(lambda: deque(maxlen=30))  # Store (x, y) tuples
        self.signal_history: Dict[int, deque] = defaultdict(lambda: deque(maxlen=30))    # Store signal dicts
        self.last_bbox_by_track: Dict[int, Tuple[int, int, int, int]] = {}
        self.missed_frames_by_track: Dict[int, int] = defaultdict(int)
        self.max_missed_frames = 15
        self.next_track_id = 0
        self.max_track_distance = 100  # pixels for track matching

    def _detect_faces_mediapipe(self, rgb_frame: np.ndarray) -> List[Tuple[np.ndarray, Tuple[int, int, int, int], bool]]:
        """Detect faces using MediaPipe and extract landmarks."""
        try:
            from mediapipe.framework.formats import image as image_module
            
            # Convert numpy array to MediaPipe Image
            mp_image = image_module.Image(image_format=image_module.ImageFormat.SRGB, data=rgb_frame)
            
            # Run face detection
            detection_result = self.face_detector.detect(mp_image)
            
            faces = []
            frame_h, frame_w = rgb_frame.shape[:2]
            
            if detection_result.detections:
                for detection in detection_result.detections:
                    # Get bounding box
                    bbox = detection.bounding_box
                    x_min = int(bbox.origin_x)
                    y_min = int(bbox.origin_y)
                    x_max = int(bbox.origin_x + bbox.width)
                    y_max = int(bbox.origin_y + bbox.height)
                    
                    # Extract landmarks if available
                    landmarks = []
                    if detection.keypoints:
                        for keypoint in detection.keypoints:
                            landmarks.append([keypoint.x, keypoint.y, 0.0])  # Add dummy z
                        landmarks = np.array(landmarks)
                        is_synthetic = True
                    else:
                        # Fallback: create synthetic landmarks from bbox
                        landmarks = self._create_synthetic_landmarks(x_min, y_min, x_max, y_max, frame_w, frame_h)
                        is_synthetic = True
                    
                    faces.append((landmarks, (x_min, y_min, x_max - x_min, y_max - y_min), is_synthetic))
            
            return faces
        except Exception as e:
            logger.debug(f"MediaPipe face detection failed: {e}")
            return self._detect_faces_opencv(rgb_frame)

    def _detect_faces_opencv(self, rgb_frame: np.ndarray) -> List[Tuple[np.ndarray, Tuple[int, int, int, int], bool]]:
        """Fallback face detection using OpenCV Haar Cascade."""
        bgr_frame = cv2.cvtColor(rgb_frame, cv2.COLOR_RGB2BGR)
        gray = cv2.cvtColor(bgr_frame, cv2.COLOR_BGR2GRAY)
        
        # Load Haar Cascade classifier
        cascade_path = cv2.data.haarcascades + 'haarcascade_frontalface_default.xml'
        face_cascade = cv2.CascadeClassifier(cascade_path)
        
        # Detect faces
        faces = face_cascade.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=5, minSize=(30, 30))
        
        result_faces = []
        frame_h, frame_w = rgb_frame.shape[:2]
        
        for (x, y, w, h) in faces:
            # Create synthetic landmarks
            landmarks = self._create_synthetic_landmarks(x, y, x + w, y + h, frame_w, frame_h)
            result_faces.append((landmarks, (x, y, w, h), True))
        
        return result_faces

    @staticmethod
    def _create_synthetic_landmarks(x_min: int, y_min: int, x_max: int, y_max: int, frame_w: int, frame_h: int) -> np.ndarray:
        """Create synthetic landmarks from bounding box when landmarks unavailable."""
        # Create 468 landmarks (MediaPipe face mesh default) arranged around the face
        landmarks = []
        center_x = (x_min + x_max) / 2 / frame_w
        center_y = (y_min + y_max) / 2 / frame_h
        width = (x_max - x_min) / frame_w
        height = (y_max - y_min) / frame_h
        
        # Eyes (rough positions)
        left_eye_x = center_x - width * 0.2
        right_eye_x = center_x + width * 0.2
        eye_y = center_y - height * 0.15
        
        # Nose
        nose_x = center_x
        nose_y = center_y
        
        # Mouth
        mouth_y = center_y + height * 0.2
        
        # Create 468 points (enough for MediaPipe format)
        for i in range(468):
            if i == 1:  # Nose
                landmarks.append([nose_x, nose_y, 0.0])
            elif i == 33:  # Left eye
                landmarks.append([left_eye_x, eye_y, 0.0])
            elif i == 263:  # Right eye
                landmarks.append([right_eye_x, eye_y, 0.0])
            elif i == 152:  # Mouth
                landmarks.append([nose_x, mouth_y, 0.0])
            elif i == 9:  # Forehead
                landmarks.append([center_x, center_y - height * 0.4, 0.0])
            else:
                # Distribute other landmarks around the face
                angle = (i / 468) * 2 * np.pi
                r = width * (0.8 + 0.2 * np.sin(i / 100))
                landmarks.append([
                    center_x + r * np.cos(angle),
                    center_y + r * np.sin(angle),
                    0.0
                ])
        
        return np.array(landmarks)

    def _estimate_head_pose(self, landmarks: np.ndarray, image_h: int, image_w: int) -> Tuple[float, float, float]:
        """Estimate head pose (pitch, yaw, roll) from face landmarks."""
        # Normalize landmarks if they're in pixel space
        if landmarks.max() > 1.0:
            landmarks = landmarks.copy()
            landmarks[:, 0] /= image_w
            landmarks[:, 1] /= image_h
        
        # Use specific landmarks for pose estimation
        # Landmark indices: 1=nose, 33=left eye, 263=right eye, 152=mouth, 9=forehead
        try:
            nose = landmarks[1]
            left_eye = landmarks[33]
            right_eye = landmarks[263]
            chin = landmarks[152]
            forehead = landmarks[9]
        except (IndexError, AttributeError):
            return 0.0, 0.0, 0.0
        
        # Convert to pixel coordinates for calculation
        left_eye_px = left_eye[:2] * np.array([image_w, image_h])
        right_eye_px = right_eye[:2] * np.array([image_w, image_h])
        chin_px = chin[:2] * np.array([image_w, image_h])
        forehead_px = forehead[:2] * np.array([image_w, image_h])
        nose_px = nose[:2] * np.array([image_w, image_h])
        
        # Pitch: angle between forehead and chin
        head_vector = chin_px - forehead_px
        pitch = np.arctan2(head_vector[1], np.linalg.norm(head_vector[:1]) + 1e-6) * 180 / np.pi
        
        # Yaw: horizontal angle using eye center
        eye_center = (left_eye_px + right_eye_px) / 2
        eye_nose_vector = nose_px - eye_center
        yaw = np.arctan2(eye_nose_vector[0], np.linalg.norm(eye_nose_vector[:1]) + 1e-6) * 180 / np.pi
        
        # Roll: tilt angle
        eye_vector = right_eye_px - left_eye_px
        roll = np.arctan2(eye_vector[1], eye_vector[0]) * 180 / np.pi
        
        return float(pitch), float(yaw), float(roll)

    def _estimate_eye_aspect_ratio(self, landmarks: np.ndarray) -> float:
        """Estimate eye openness from eye landmarks (EAR - Eye Aspect Ratio)."""
        try:
            # Normalize if needed
            if landmarks.max() > 1.0:
                landmarks = landmarks / np.array([landmarks.shape[1], landmarks.shape[1], 1])
            
            # Eye landmarks: left_eye = 33-133, right_eye = 362-466
            left_eye_indices = [33, 160, 158, 133, 153, 144]
            right_eye_indices = [362, 385, 387, 386, 380, 374]
            
            # Validate indices
            max_idx = len(landmarks) - 1
            left_eye_indices = [i for i in left_eye_indices if i <= max_idx]
            right_eye_indices = [i for i in right_eye_indices if i <= max_idx]
            
            if len(left_eye_indices) < 4 or len(right_eye_indices) < 4:
                return 0.2  # Default to open
            
            left_eye = landmarks[left_eye_indices]
            right_eye = landmarks[right_eye_indices]
            
            def eye_aspect_ratio(eye):
                A = np.linalg.norm(eye[1] - eye[5])
                B = np.linalg.norm(eye[2] - eye[4])
                C = np.linalg.norm(eye[0] - eye[3])
                ear = (A + B) / (2.0 * C + 1e-6)
                return ear
            
            left_ear = eye_aspect_ratio(left_eye)
            right_ear = eye_aspect_ratio(right_eye)
            return float((left_ear + right_ear) / 2.0)
        except Exception as e:
            logger.debug(f"EAR calculation failed: {e}")
            return 0.2  # Default to open

    def _detect_phones(self, frame: np.ndarray) -> List[Tuple[int, int, int, int]]:
        """Detect phones using YOLO."""
        if not self.yolo_available:
            return []
        
        try:
            results = self.yolo(frame, verbose=False)
            phones = []
            
            for result in results:
                if hasattr(result, 'boxes'):
                    for box in result.boxes:
                        # Check if detected class is "cell phone" (class 67 in COCO)
                        if int(box.cls) in [67, 76, 77]:  # phone, laptop, mouse
                            x1, y1, x2, y2 = box.xyxy[0].int().tolist()
                            phones.append((x1, y1, x2 - x1, y2 - y1))
            
            return phones
        except Exception as e:
            logger.debug(f"YOLO inference failed: {e}")
            return []

    def _match_tracks(self, current_faces: List[Tuple[float, float]], frame_h: int, frame_w: int) -> Dict[int, int]:
        """Simple centroid tracking: match current faces to existing tracks."""
        if not current_faces:
            return {}
        
        matches = {}
        used_tracks = set()
        
        for face_x, face_y in current_faces:
            best_track_id = None
            best_dist = self.max_track_distance
            
            for track_id, history in self.position_history.items():
                if track_id in used_tracks:
                    continue
                
                if history:
                    prev_x, prev_y = history[-1]
                    dist = math.sqrt((face_x - prev_x) ** 2 + (face_y - prev_y) ** 2)
                    
                    if dist < best_dist:
                        best_dist = dist
                        best_track_id = track_id
            
            if best_track_id is None:
                best_track_id = self.next_track_id
                self.next_track_id += 1
            
            matches[len(matches)] = best_track_id
            used_tracks.add(best_track_id)
            self.position_history[best_track_id].append((face_x, face_y))
        
        return matches

    def _score_engagement(self, signals: FaceSignals, phone_detected: bool, history: deque) -> Tuple[str, float, float, str]:
        """Score engagement based on signals and temporal patterns."""
        
        # Determine state and score
        if not signals.face_present:
            return "absent", 0.0, 0.0, "No face detected"
        
        # Check for sleep (eyes closed for >1 second)
        recent_not_open = sum(1 for s in list(history)[-30:] if isinstance(s, dict) and not s.get("eyes_open", False))
        if recent_not_open > 25:  # ~1 second at 30 fps
            return "asleep", 0.1, 0.85, "Eyes closed for sustained period"
        
        # Check for phone use
        if phone_detected:
            return "on_phone", 0.15, 0.9, "Phone detected near face"
        
        # Only trust pose-driven states if pose is reliable (not synthetic landmarks).
        if signals.pose_reliable:
            if signals.head_pitch_deg > 25:  # Looking down significantly
                return "looking_down", 0.35, 0.8, "Looking down at phone or notes"

            if abs(signals.head_yaw_deg) > 30:
                return "distracted", 0.45, 0.75, "Looking away from stage/screen"
        
        # Check for engagement (forward-facing, eyes open)
        if signals.pose_reliable:
            if signals.eyes_open and signals.gaze_forward and abs(signals.head_pitch_deg) < 15 and abs(signals.head_yaw_deg) < 20:
                return "engaged", 0.95, 0.9, "Facing forward with attention"
        elif signals.eyes_open and not phone_detected:
            return "neutral", 0.6, 0.6, "Face present, pose unavailable"
        
        # Default: neutral/uncertain
        return "neutral", 0.6, 0.65, "Mixed signals"

    def process_frame(self, frame: np.ndarray) -> List[PersonState]:
        """Process a single frame and return per-person engagement states."""
        frame_h, frame_w = frame.shape[:2]
        rgb_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        
        # Run face detection
        faces_with_landmarks = self._detect_faces_mediapipe(rgb_frame)
        
        if not faces_with_landmarks:
            # No detections this frame: emit recent tracks as absent for a short TTL.
            person_states = []
            stale_track_ids = []
            for track_id in list(self.last_bbox_by_track.keys()):
                self.missed_frames_by_track[track_id] += 1
                missed = self.missed_frames_by_track[track_id]
                if missed <= self.max_missed_frames:
                    last_bbox = self.last_bbox_by_track[track_id]
                    person_states.append(
                        PersonState(
                            track_id=track_id,
                            bbox=last_bbox,
                            state="absent",
                            engagement_score=0.0,
                            confidence=0.8,
                            likely_activity="Face not detected",
                            signals={
                                "face_present": False,
                                "head_pitch_deg": 0.0,
                                "head_yaw_deg": 0.0,
                                "head_roll_deg": 0.0,
                                "eyes_open": False,
                                "eye_aspect_ratio": 0.0,
                                "gaze_forward": False,
                                "blink_detected": False,
                                "pose_reliable": False,
                            },
                        )
                    )
                else:
                    stale_track_ids.append(track_id)

            for track_id in stale_track_ids:
                self.last_bbox_by_track.pop(track_id, None)
                self.missed_frames_by_track.pop(track_id, None)
                self.position_history.pop(track_id, None)
                self.signal_history.pop(track_id, None)

            return person_states
        
        # Detect phones
        phones = self._detect_phones(frame)
        phone_bboxes = phones
        
        # Extract face centers and landmarks
        current_faces = []
        all_landmarks = []
        
        for landmarks, bbox, _is_synthetic in faces_with_landmarks:
            all_landmarks.append(landmarks)
            
            # Face bounding box
            x, y, w, h = bbox
            face_center_x = x + w / 2
            face_center_y = y + h / 2
            current_faces.append((face_center_x, face_center_y))
        
        # Match to tracks
        face_to_track = self._match_tracks(current_faces, frame_h, frame_w)
        
        # Process each face
        person_states = []
        active_track_ids = set()
        
        for face_idx, (landmarks, bbox, is_synthetic) in enumerate(faces_with_landmarks):
            track_id = face_to_track.get(face_idx, self.next_track_id)
            active_track_ids.add(track_id)
            
            # Compute signals
            if is_synthetic:
                pitch, yaw, roll = 0.0, 0.0, 0.0
            else:
                pitch, yaw, roll = self._estimate_head_pose(landmarks, frame_h, frame_w)
            ear = self._estimate_eye_aspect_ratio(landmarks)
            
            # Determine if eyes are open (EAR threshold ~0.2)
            eyes_open = ear > 0.15
            
            # Check if gaze is forward (yaw and pitch small)
            gaze_forward = abs(yaw) < 20 and abs(pitch) < 15
            
            # Blink detection (simple: low EAR for one frame)
            blink = ear < 0.1
            
            signals = FaceSignals(
                face_present=True,
                head_pitch_deg=pitch,
                head_yaw_deg=yaw,
                head_roll_deg=roll,
                eyes_open=eyes_open,
                eye_aspect_ratio=ear,
                gaze_forward=gaze_forward,
                blink_detected=blink,
                pose_reliable=not is_synthetic,
            )
            
            # Check if phone near face
            x, y, w, h = bbox
            face_bbox = (x, y, w, h)
            self.last_bbox_by_track[track_id] = face_bbox
            self.missed_frames_by_track[track_id] = 0
            
            phone_near_face = any(
                self._bbox_overlap(face_bbox, phone_bbox) > 0.3
                for phone_bbox in phone_bboxes
            )
            
            # Score engagement
            history = self.signal_history[track_id]
            state, engagement_score, confidence, activity = self._score_engagement(
                signals, phone_near_face, history
            )
            
            # Store signals in history for temporal analysis
            history.append(asdict(signals))
            
            person_states.append(PersonState(
                track_id=track_id,
                bbox=face_bbox,
                state=state,
                engagement_score=engagement_score,
                confidence=confidence,
                likely_activity=activity,
                signals=asdict(signals)
            ))

        # For tracks not detected in this frame, emit temporary "absent" states.
        stale_track_ids = []
        for track_id in list(self.last_bbox_by_track.keys()):
            if track_id in active_track_ids:
                continue

            self.missed_frames_by_track[track_id] += 1
            missed = self.missed_frames_by_track[track_id]
            if missed <= self.max_missed_frames:
                last_bbox = self.last_bbox_by_track[track_id]
                person_states.append(
                    PersonState(
                        track_id=track_id,
                        bbox=last_bbox,
                        state="absent",
                        engagement_score=0.0,
                        confidence=0.8,
                        likely_activity="Face not detected",
                        signals={
                            "face_present": False,
                            "head_pitch_deg": 0.0,
                            "head_yaw_deg": 0.0,
                            "head_roll_deg": 0.0,
                            "eyes_open": False,
                            "eye_aspect_ratio": 0.0,
                            "gaze_forward": False,
                            "blink_detected": False,
                            "pose_reliable": False,
                        },
                    )
                )
            else:
                stale_track_ids.append(track_id)

        for track_id in stale_track_ids:
            self.last_bbox_by_track.pop(track_id, None)
            self.missed_frames_by_track.pop(track_id, None)
            self.position_history.pop(track_id, None)
            self.signal_history.pop(track_id, None)
        
        return person_states

    @staticmethod
    def _bbox_overlap(bbox1: Tuple, bbox2: Tuple) -> float:
        """Compute IOU between two bounding boxes."""
        x1_min, y1_min, w1, h1 = bbox1
        x2_min, y2_min, w2, h2 = bbox2
        
        x1_max, y1_max = x1_min + w1, y1_min + h1
        x2_max, y2_max = x2_min + w2, y2_min + h2
        
        x_min = max(x1_min, x2_min)
        y_min = max(y1_min, y2_min)
        x_max = min(x1_max, x2_max)
        y_max = min(y1_max, y2_max)
        
        if x_max < x_min or y_max < y_min:
            return 0.0
        
        intersection = (x_max - x_min) * (y_max - y_min)
        union = w1 * h1 + w2 * h2 - intersection
        
        return intersection / union if union > 0 else 0.0


class EngagementLogger:
    """Log detailed frame data and compact engagement summaries to JSON."""

    def __init__(
        self,
        output_dir: Path = Path("engagement_logs"),
        log_details: bool = True,
        log_summaries: bool = True,
        summary_format: str = "production",
    ):
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.session_id = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
        self.log_details = log_details
        self.log_summaries = log_summaries
        self.summary_format = summary_format
        self.output_file = self.output_dir / f"engagement_{self.session_id}.jsonl" if log_details else None
        self.summary_output_file = (
            self.output_dir / f"engagement_summary_{self.session_id}.jsonl"
            if log_summaries
            else None
        )

    def log_frame(self, frame_id: int, person_states: List[PersonState]) -> None:
        """Log a frame's engagement data."""
        if not self.log_details or self.output_file is None:
            return

        audience_data = []
        for ps in person_states:
            # Convert numpy types to Python types for JSON serialization
            bbox = tuple(int(x) for x in ps.bbox)
            signals = {k: (float(v) if isinstance(v, (np.floating, float)) else bool(v) if isinstance(v, (np.bool_, bool)) else int(v) if isinstance(v, (np.integer, int)) else v) 
                      for k, v in ps.signals.items()}
            
            audience_data.append({
                "track_id": int(ps.track_id),
                "bbox": bbox,
                "state": str(ps.state),
                "engagement_score": float(ps.engagement_score),
                "confidence": float(ps.confidence),
                "likely_activity": str(ps.likely_activity),
                "signals": signals
            })
        
        record = {
            "timestamp": datetime.now().isoformat(),
            "frame_id": int(frame_id),
            "audience": audience_data
        }
        
        with self.output_file.open("a", encoding="utf-8") as fh:
            json.dump(record, fh, ensure_ascii=False)
            fh.write("\n")

    def log_summary(self, summary: EngagementBucketSummary) -> None:
        """Log one compact engagement summary bucket."""
        if not self.log_summaries or self.summary_output_file is None:
            return

        if self.summary_format == "debug":
            record = {
                "timestamp_ms": int(summary.timestamp_ms),
                "engagement_score": float(summary.engagement_score),
                "audience_count": int(summary.audience_count),
                "confidence": float(summary.confidence),
                "change": float(summary.change),
                "dominant_signals": list(summary.dominant_signals),
            }
        else:
            record = {
                "timestamp_ms": int(summary.timestamp_ms),
                "engagement_score": float(summary.engagement_score),
            }

        with self.summary_output_file.open("a", encoding="utf-8") as fh:
            json.dump(record, fh, ensure_ascii=False)
            fh.write("\n")
