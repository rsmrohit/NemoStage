# Audience Engagement Analyzer

Real-time audience engagement analysis using MediaPipe Face Mesh, YOLO phone detection, and rule-based temporal scoring.

## Features

- **Face Detection & Tracking**: Detects and tracks multiple people across frames using centroid tracking
- **Facial Landmarks**: Uses MediaPipe Face Mesh for precise face landmark detection
- **Head Pose Estimation**: Estimates head pitch, yaw, and roll to detect looking direction
- **Eye Tracking**: Measures eye aspect ratio to detect if eyes are open or closed
- **Phone Detection**: Uses YOLO to detect phones and other distracting objects
- **Engagement Scoring**: Rule-based temporal model to classify engagement states:
  - `engaged`: Looking forward, eyes open, head upright
  - `looking_down`: Head pitched down (likely phone or notes)
  - `on_phone`: Phone detected near face
  - `asleep`: Eyes closed for sustained period
  - `distracted`: Looking away horizontally
  - `absent`: No face detected
  - `neutral`: Mixed signals

- **Per-Person JSON Output**: Logs detailed engagement data with per-frame per-person metrics

## Installation

### 1. Install dependencies

```bash
cd /Users/shiva/Documents/NemoStage/engagement_analyzer
pip install -r requirements.txt
```

This installs:
- **opencv-python**: Video capture and drawing
- **mediapipe**: Face mesh and facial landmarks
- **ultralytics**: YOLO for object detection
- **numpy**: Numerical operations

### 2. Download YOLO model (optional, auto-downloads on first run)

The YOLO model (`yolov8n.pt`) will be downloaded automatically on first use. To pre-download:

```bash
python -c "from ultralytics import YOLO; YOLO('yolov8n.pt')"
```

## Usage

### Basic: Analyze webcam and save logs

```bash
cd /Users/shiva/Documents/NemoStage/engagement_analyzer
python run_analyzer.py
```

### Analyze video file

```bash
python run_analyzer.py --video /path/to/video.mp4
```

### Display real-time visualization

```bash
python run_analyzer.py --display
```

### Save visualization to file

```bash
python run_analyzer.py --video /path/to/video.mp4 --draw --output ./engagement_logs
```

### All options

```bash
python run_analyzer.py --help
```

Options:
- `--video`: Video file path or camera index (default: 0 = webcam)
- `--output`: Output directory for JSON logs (default: `engagement_logs`)
- `--yolo-model`: YOLO model variant (default: `yolov8n.pt`, options: `yolov8s.pt`, `yolov8m.pt`, etc.)
- `--draw`: Draw bounding boxes and labels on output video
- `--display`: Show real-time video with overlays (webcam only)
- `--fps-limit`: Target FPS (default: 30)

## Output Format

JSON logs are saved as JSONL (one record per line) with structure:

```json
{
  "timestamp": "2026-05-16T14:22:31.123456",
  "frame_id": 1842,
  "audience": [
    {
      "track_id": 7,
      "bbox": [412, 108, 188, 224],
      "state": "looking_down",
      "engagement_score": 0.35,
      "confidence": 0.8,
      "likely_activity": "Looking down at phone or notes",
      "signals": {
        "face_present": true,
        "head_pitch_deg": 38.2,
        "head_yaw_deg": 5.1,
        "head_roll_deg": -2.3,
        "eyes_open": true,
        "eye_aspect_ratio": 0.28,
        "gaze_forward": false,
        "blink_detected": false
      }
    },
    {
      "track_id": 12,
      "bbox": [812, 96, 176, 210],
      "state": "on_phone",
      "engagement_score": 0.15,
      "confidence": 0.91,
      "likely_activity": "Using phone",
      "signals": {
        "face_present": true,
        "head_pitch_deg": 12.4,
        "head_yaw_deg": -8.2,
        "head_roll_deg": 1.1,
        "eyes_open": true,
        "eye_aspect_ratio": 0.32,
        "gaze_forward": false,
        "blink_detected": false
      }
    }
  ]
}
```

### Field Descriptions

- **track_id**: Unique ID for person across frames
- **bbox**: Bounding box as [x, y, width, height]
- **state**: Current engagement state
- **engagement_score**: 0.0 (disengaged) to 1.0 (fully engaged)
- **confidence**: How confident the model is in this classification (0.0 to 1.0)
- **likely_activity**: Human-readable description of what the person may be doing
- **signals**: Raw facial signals used for classification:
  - **head_pitch_deg**: Positive = looking down
  - **head_yaw_deg**: Positive = looking right
  - **eye_aspect_ratio**: Measure of eye openness (>0.15 = open, <0.1 = closed)
  - **gaze_forward**: Whether gaze is directed forward
  - **blink_detected**: Blink detected in this frame

## Example Analysis

### Run on webcam and display results

```bash
python run_analyzer.py --display
```

This will:
1. Open your webcam
2. Detect faces in real-time
3. Draw bounding boxes with colors:
   - **Green**: Engaged
   - **Cyan**: Looking down
   - **Orange**: On phone
   - **Red**: Asleep
   - **Magenta**: Distracted
   - **Gray**: Unknown
4. Save JSON logs to `engagement_logs/engagement_<timestamp>.jsonl`
5. Exit with 'q'

### Analyze recorded session and extract statistics

```bash
python run_analyzer.py --video my_presentation.mp4 --output ./results
```

Then analyze the JSON output:

```python
import json
from pathlib import Path
from collections import defaultdict

log_file = Path("results/engagement_<timestamp>.jsonl")
engagement_by_person = defaultdict(list)

with log_file.open() as fh:
    for line in fh:
        record = json.loads(line)
        for person in record["audience"]:
            engagement_by_person[person["track_id"]].append(person["engagement_score"])

# Compute statistics
for track_id, scores in engagement_by_person.items():
    avg_score = sum(scores) / len(scores)
    print(f"Person {track_id}: avg engagement = {avg_score:.2f}")
```

## Customization

### Adjust engagement thresholds

Edit `engagement_analyzer.py` in the `_score_engagement()` method:

```python
def _score_engagement(self, signals: FaceSignals, phone_detected: bool, history: deque) -> Tuple[str, float, float, str]:
    # Adjust these thresholds:
    if signals.head_pitch_deg > 25:  # Change to detect looking down earlier/later
        return "looking_down", 0.35, 0.8, "..."
```

### Add more facial features

Extend `FaceSignals` dataclass and compute additional metrics like:
- Mouth opening (yawning)
- Head movement velocity
- Gaze direction using iris/pupil detection
- Facial expression (smile, frown)

### Switch YOLO model

Use larger models for better accuracy:

```bash
python run_analyzer.py --yolo-model yolov8m.pt  # Medium (slower but more accurate)
python run_analyzer.py --yolo-model yolov8l.pt  # Large
```

## Performance

- **yolov8n.pt**: ~30 FPS on CPU (MacBook Air)
- **yolov8s.pt**: ~15 FPS
- **yolov8m.pt**: ~8 FPS

Face detection via MediaPipe is ~50-80 FPS on modern hardware.

## Limitations

- Accuracy decreases with side angles (>45°)
- Low light reduces landmark quality
- Occlusion (hats, glasses) affects detection
- Phone detection uses object detector; custom training could improve accuracy
- Temporal scoring uses simple rules; a learned model could be more accurate

## Future Improvements

1. **Speaker diarization integration**: Combine with audio transcripts to link engagement to speakers
2. **Learned engagement model**: Replace rules with a temporal CNN/LSTM for better accuracy
3. **Micro-expression detection**: Detect emotion indicators (interest, confusion, frustration)
4. **Gaze tracking**: Estimate gaze point (stage vs. audience vs. ground)
5. **Posture analysis**: Detect slouching, attention vs. disinterest
6. **Multi-modal fusion**: Combine engagement with audio tone, speech rate, laughter detection

## License & Attribution

- **MediaPipe**: Google (open-source)
- **YOLO**: Ultralytics (open-source)
- **OpenCV**: BSD license

## Questions?

For issues or questions, check the engagement logs in `engagement_logs/` for detailed per-frame data.
