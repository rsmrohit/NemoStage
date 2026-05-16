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
    """Log engagement data to JSON."""

    def __init__(self, output_dir: Path = Path("engagement_logs")):
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.session_id = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
        self.output_file = self.output_dir / f"engagement_{self.session_id}.jsonl"

    def log_frame(self, frame_id: int, person_states: List[PersonState]) -> None:
        """Log a frame's engagement data."""
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
