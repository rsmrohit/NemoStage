# Engagement Analyzer Implementation Plan

## Goal

Build a 5-second audience engagement scoring pipeline for NemoClaw.

The analyzer should continue to inspect individual audience members internally, but the main dispatched output should be one compact engagement score per 5-second bucket. This gives NemoClaw enough spacing to reason about what changed during the presentation without receiving a large per-frame JSON payload.

## Current Baseline

The current `engagement_analyzer.py` already provides:

- Per-frame face detection.
- Simple centroid-based person tracking.
- YOLO-based phone detection.
- Per-person `PersonState` objects.
- Rule-based states such as `engaged`, `looking_down`, `on_phone`, `asleep`, `distracted`, `absent`, and `neutral`.
- JSONL logging with full per-person frame details.

The main gap is that the current output is detailed per-person JSON, while NemoClaw needs a compact 5-second engagement score. The second gap is that OpenCV temporal behavior is not yet being used enough to distinguish note-taking, nodding, stillness, and other engagement patterns.

## Proposed Architecture

Add two layers on top of the existing analyzer:

1. `EngagementAnalyzer`
   - Keeps producing per-person states.
   - Adds OpenCV-derived temporal signals per tracked person.
   - Remains the detailed internal analysis layer.

2. `EngagementAggregator`
   - Receives per-frame `PersonState` values.
   - Maintains 5-second buckets.
   - Computes one room-level engagement score.
   - Emits compact summaries for NemoClaw.

3. `EngagementLogger`
   - Keeps optional full-detail logs for debugging.
   - Adds summary logs for compact score output.

4. `AudienceMemberEngagementTracker`
   - Maintains session-local member identities.
   - Maps analyzer `track_id` values to stable `memberN` files.
   - Uses OpenCV face-crop signatures to reconnect returning faces to existing members.
   - Writes per-member 5-second engagement histories.

## Approval Decisions

Please approve or adjust these before implementation.

Status: approved on 2026-05-16.

### Decision 1: Bucket Interval

Approval: approved.

Use fixed 5-second buckets.

Reasoning:

- NemoClaw gets enough time to observe meaningful change.
- The score is less noisy than frame-level output.
- It aligns with the intended reasoning cadence for adapting a presentation.

Proposed output cadence:

```json
{
  "timestamp_ms": 45000,
  "engagement_score": 0.73
}
```

### Decision 2: Internal Detail vs Dispatched Output

Approval: approved. Production dispatch should use the compact format instead of full per-person payloads.

Keep detailed per-person analysis internally, but dispatch compact summaries.

Proposed debug summary format:

```json
{
  "timestamp_ms": 45000,
  "engagement_score": 0.73,
  "audience_count": 18,
  "confidence": 0.81,
  "change": -0.08,
  "dominant_signals": ["more_looking_down", "less_forward_attention"]
}
```

Proposed production dispatch format:

```json
{
  "timestamp_ms": 45000,
  "engagement_score": 0.73
}
```

Recommendation:

- Use debug summary logs during development.
- Send only `timestamp_ms` and `engagement_score` to NemoClaw unless NemoClaw explicitly needs explanations.

### Decision 3: OpenCV Responsibility

Approval: approved.

Use OpenCV for temporal behavior and motion analysis.

OpenCV should handle:

- Person/face movement history.
- Head movement over time.
- Nodding-like vertical oscillation.
- Stillness and sleep-like behavior.
- Hand/table-region motion as a note-taking hint.
- 5-second change detection.

OpenCV should not be the only tool for:

- Phone recognition.
- Precise facial landmarks.
- Reliable gaze estimation.
- Confirming that someone asked a question.

Recommendation:

- Keep YOLO for phone detection.
- Use MediaPipe or another landmark source for face landmarks when available.
- Use OpenCV to turn those detections into temporal behavior signals.

### Decision 4: Engagement Score Range

Approval: approved. Use `0.0` to `1.0`; percentages can be derived later if needed.

Use a normalized score from `0.0` to `1.0`.

Interpretation:

- `0.0`: fully disengaged.
- `0.5`: mixed or uncertain engagement.
- `1.0`: strongly engaged.

Room-level scores should be confidence-weighted averages of per-person scores.

### Decision 5: Smoothing

Approval: approved.

Smooth the room score across buckets.

Proposed formula:

```python
smoothed_score = 0.7 * previous_bucket_score + 0.3 * current_bucket_score
```

Reasoning:

- Prevents sudden jumps from one missed detection.
- Still allows meaningful changes to show up over multiple buckets.

## Proposed Data Model Additions

### `PersonTemporalSignals`

Add an internal structure for OpenCV-derived signals:

```python
@dataclass
class PersonTemporalSignals:
    track_id: int
    head_motion: float
    vertical_head_motion: float
    body_motion: float
    hand_region_motion: float
    looking_down_duration_s: float
    stillness_duration_s: float
    phone_duration_s: float
    nodding_detected: bool
    note_taking_likely: bool
    sleep_like: bool
```

These values do not need to be sent to NemoClaw. They are used to improve each person's engagement score.

### `EngagementBucketSummary`

Add a compact summary object:

```python
@dataclass
class EngagementBucketSummary:
    timestamp_ms: int
    engagement_score: float
    audience_count: int
    confidence: float
    change: float
    dominant_signals: list[str]
```

For production dispatch, this can be reduced to:

```python
{
    "timestamp_ms": summary.timestamp_ms,
    "engagement_score": summary.engagement_score,
}
```

### Per-Member Engagement Files

Add a session folder:

```text
audience_engagement_<session_id>/
|-- member1.json
|-- member2.json
|-- member3.json
```

Each member file should contain 5-second bucket records:

```json
{
  "session_id": "20260516_124357_878651",
  "member_id": "member1",
  "average_engagement_score": 0.72,
  "last_seen_timestamp_ms": 45000,
  "records": [
    {
      "timestamp_ms": 40000,
      "end_timestamp_ms": 44966,
      "engagement_score": 0.74,
      "confidence": 0.81,
      "dominant_state": "engaged",
      "dominant_activity": "Facing forward with attention",
      "track_ids": [3],
      "frame_count": 150
    }
  ]
}
```

Initial implementation status: revised. It uses a lightweight OpenCV face-feature registry, not screen position and not a deep face-recognition embedding. This is suitable for session-local continuity but should not be treated as biometric identity outside the current session.

Member creation rules:

- Do not create a permanent `memberN.json` from a one-frame detection.
- Require a visible track to survive `--min-member-frames` frames before creating a new member file.
- If a new analyzer `track_id` appears, first try to reconnect it to an existing member by face signature.
- Face-feature prototypes are stored separately in `face_feature_registry.json`, mapped by `member_id`.
- A returning face must meet the configured feature similarity threshold, default `0.80`, to match by face features.
- Each member can store multiple OpenCV feature prototypes so the same person can be recognized across small pose/lighting changes.
- Do not use face box position as an identity signal. Bbox and timestamp may be kept in the registry only as debug metadata.
- Clean up short-lived pending tracks that disappear before becoming stable members.

## OpenCV Feature Plan

### 1. Motion History Per Track

For each `track_id`, store recent frame information:

- Face bounding boxes.
- Face center points.
- Cropped face region grayscale frames.
- Cropped upper-body region grayscale frames when available.
- Per-frame state and score.

Use `deque` objects with a maximum length based on frame rate and the 5-second bucket size.

### 2. Nodding Detection

Detect nodding from repeated vertical head movement.

Initial heuristic:

- Track face center `y` over the last 2-5 seconds.
- Remove slow drift with a rolling mean.
- Count directional changes in vertical motion.
- Require small but repeated vertical movement.
- Require face visibility during the pattern.

Initial rule:

```text
nodding_detected = repeated vertical oscillation and face_present
```

Score impact:

```text
+0.10 to +0.15
```

### 3. Note-Taking Detection

Detect likely note-taking as a temporal pattern.

Initial heuristic:

- Head is mildly down.
- Phone is not detected.
- There is repeated small motion in the lower face/body/table region.
- The person is not fully still.

Initial rule:

```text
note_taking_likely = looking_down and hand_region_motion and not phone_detected
```

Score impact:

```text
+0.10 to +0.20
```

This prevents all looking-down behavior from being incorrectly punished.

### 4. Sleep-Like Behavior

Detect sleep-like behavior from sustained stillness and head/eye evidence.

Initial heuristic:

- Very low face/body motion.
- Head down or eyes closed if available.
- Sustained for at least 10 seconds, not just one 5-second bucket.

Initial rule:

```text
sleep_like = sustained_stillness and (eyes_closed or head_down)
```

Score impact:

```text
-0.50 to -0.70
```

### 5. Asking Questions / Interaction

Vision-only question detection should be treated as uncertain.

Initial visual proxy:

- Hand/arm motion rising above shoulder/head region.
- Person posture becomes active.
- Optional future audio or transcript confirms speech.

Initial state name:

```text
possible_question_or_interaction
```

Score impact:

```text
+0.15 to +0.25, lower confidence unless audio confirms it
```

## Per-Person Scoring Plan

Start from a neutral baseline:

```python
score = 0.60
```

Apply signal adjustments:

```python
if facing_forward:
    score += 0.25

if nodding_detected:
    score += 0.15

if note_taking_likely:
    score += 0.15

if possible_question_or_interaction:
    score += 0.20

if looking_away:
    score -= 0.20

if looking_down_uncertain:
    score -= 0.10

if on_phone:
    score -= 0.50

if sleep_like:
    score -= 0.60
```

Clamp the result:

```python
score = max(0.0, min(1.0, score))
```

This should replace hard-coded one-state scoring over time, but the first implementation can keep the current state labels and use these adjustments to improve the numeric score.

## Room-Level Aggregation Plan

For each frame:

```python
weighted_score_sum = sum(person.engagement_score * person.confidence for person in active_people)
confidence_sum = sum(person.confidence for person in active_people)
frame_score = weighted_score_sum / confidence_sum
```

Audience handling:

- Include visible people normally.
- Include briefly absent tracks with reduced weight.
- Drop stale tracks after the existing missed-frame TTL.
- Avoid letting one missed detection collapse the whole room score.

For each 5-second bucket:

```python
bucket_score = average(frame_scores_in_bucket)
bucket_confidence = average(frame_confidences_in_bucket)
```

Then smooth:

```python
final_score = 0.7 * previous_score + 0.3 * bucket_score
```

## Implementation Phases

### Phase 1: Aggregator and 5-Second Summary Output

Add:

- `EngagementBucketSummary`.
- `EngagementAggregator`.
- Summary JSONL logging.
- CLI option to choose full, summary, or both logs.

Implementation status: complete. The CLI now defaults to compact summary logs, with detailed per-person logs available through `--log-mode detail` or `--log-mode both`.

### Phase 1B: Per-Audience-Member Engagement Files

Add:

- Session folder named `audience_engagement_<session_id>`.
- Stable member files named `member1.json`, `member2.json`, etc.
- Track-to-member mapping.
- OpenCV face-crop signature matching for returning faces.
- Per-member 5-second bucket summaries.

Implementation status: complete.

Revision status: updated after validation showed too many member files. New member creation now waits for stable detections, checks an averaged pending-track feature against the member registry before creating a new file, stores member face features separately, defaults face-feature matching to `0.80`, and no longer uses screen position for identity matching.

Acceptance criteria:

- A returning face within the same session should append to the same member file when its face crop matches above the configured threshold.
- If the analyzer creates a new `track_id` for a previously seen face, the member tracker can still reconnect it to the existing member.
- Per-member files avoid full per-frame payloads and store 5-second engagement records.

Acceptance criteria:

- The analyzer still supports current detailed logs.
- A new summary log emits one engagement score every 5 seconds.
- Summary output does not include full per-person payloads.

### Phase 2: OpenCV Temporal Motion Signals

Add:

- Per-track motion history.
- Face-center movement features.
- Basic stillness detection.
- Basic vertical head motion detection.

Acceptance criteria:

- Each track has temporal motion features available internally.
- Nodding-like motion can increase engagement.
- Sustained stillness can lower engagement.

### Phase 3: Note-Taking and Looking-Down Improvements

Add:

- Lower-region motion estimation.
- Looking-down duration tracking.
- Note-taking heuristic.
- Less aggressive penalty for looking down when note-taking is likely.

Acceptance criteria:

- Looking down is not automatically treated as disengagement.
- Looking down plus phone remains strongly negative.
- Looking down plus repeated hand/table motion becomes neutral-positive.

### Phase 4: Better Landmark Source

Current code uses face detection and synthetic landmarks, which makes `pose_reliable` false in many cases.

Upgrade options:

1. MediaPipe Face Landmarker / Face Mesh.
2. OpenCV DNN face detector plus an external landmark model.

Recommendation:

- Prefer MediaPipe Face Landmarker if dependency availability is acceptable.
- Keep OpenCV fallback when landmarks are unavailable.

Acceptance criteria:

- Head pose is reliable enough for pitch/yaw decisions.
- `pose_reliable` becomes true for real landmark detections.
- Current fallback behavior remains available.

### Phase 5: NemoClaw Integration

Add a dispatch boundary for NemoClaw.

Possible forms:

- Write summary JSONL for polling.
- Expose summary events through an API route.
- Publish events through an internal queue or websocket.

Initial recommendation:

- Start with summary JSONL for local validation.
- Move to API/websocket once score quality is acceptable.

## Testing Strategy

### Unit Tests

Add tests for:

- Weighted score aggregation.
- Empty audience handling.
- Brief absent tracks.
- 5-second bucket emission timing.
- Smoothing behavior.
- Score clamping.

### Replay Tests

Use recorded JSONL or video snippets to verify:

- Summary logs are emitted every 5 seconds.
- Scores do not jump sharply from brief detection misses.
- Phone use lowers score.
- More forward-facing people raises score.

### Manual Validation

Use `--display` overlays to inspect:

- Per-person states.
- Track stability.
- Nodding detection.
- Note-taking detection.
- Sleep-like stillness detection.

## Risks and Mitigations

### Risk: OpenCV-only semantics are limited

Mitigation:

- Use OpenCV for temporal patterns.
- Keep YOLO for phones.
- Use landmarks for head pose when possible.

### Risk: Looking down is ambiguous

Mitigation:

- Do not score looking down as strongly negative by default.
- Use phone detection and hand/table motion to disambiguate.

### Risk: Missed detections create score drops

Mitigation:

- Use reduced-weight absent tracks.
- Smooth scores across buckets.
- Drop stale tracks only after TTL.

### Risk: Nodding false positives

Mitigation:

- Require repeated vertical oscillation.
- Require visible face.
- Keep score boost modest.

## Recommended First Implementation

Start with Phase 1.

This produces the product shape NemoClaw needs without changing the core analyzer too much:

- One 5-second score.
- Optional debug details.
- Existing per-person logs preserved.

After Phase 1 is stable, implement Phase 2 and Phase 3 to improve score quality with OpenCV temporal behavior.
