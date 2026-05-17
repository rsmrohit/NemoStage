# Presentation Engagement Dashboard Plan

## Objective
Build a per-presentation analytics dashboard that correlates:
- slide-change timeline
- average engagement over time
- per-member engagement trajectories
- analyzer lifecycle outputs captured during the live session

The first deliverable should answer: "Which slide intervals helped or hurt engagement, and for whom?"

## Scope (MVP)
1. Ingest timeline data from `timeline.json` (already produced by NemoStage live mode).
2. Ingest engagement time series from per-member JSON:
- average engagement over time
- per-member engagement over time
3. Ingest precomputed interval-average engagement JSON.
4. Render a dashboard with:
- primary chart: avg engagement + slide-change markers
- per-member charts
- slide-interval summary table
5. Support one selected presentation/session at a time.
6. Integrate engagement analyzer lifecycle with presentation lifecycle:
- start analyzer when live presentation starts
- stop analyzer when live presentation ends
- persist analyzer outputs for dashboard consumption

Out of scope for MVP:
- cross-presentation comparisons
- model retraining/quality evaluation
- advanced anomaly detection

## Proposed Architecture
1. Backend API (FastAPI in `nemostage_backend/server.py`)
- Add analytics endpoints returning normalized time-series + interval stats.
- Compute slide intervals from timeline entries.
- Aggregate engagement metrics aligned to timeline intervals.
- Add analyzer control endpoints (start/stop/status) scoped to presentation session.

2. Frontend UI (Electron React app in `NemoStage/src/renderer/src`)
- New dashboard route/view.
- Time-series chart with:
  - X-axis = elapsed time
  - line = average engagement
  - vertical lines = slide changes
- Per-member small multiples.
- Interval metrics table.

3. Data persistence
- Use existing timeline folder/file output.
- Read per-member engagement JSON input file (source of member series + average series).
- Read precomputed interval-average engagement JSON input file.
- Persist analyzer artifacts under session/timeline directory and index by `presentationId` + `sessionId`.
- Keep schema versioned to allow safe future changes.

4. Analyzer integration layer (Electron main process)
- Add IPC handlers to start/stop engagement analyzer process.
- Manage subprocess lifecycle (PID, health, timeout, retry policy).
- Wire start/stop calls from presentation live-mode transitions.
- Ensure cleanup on crash/exit to avoid orphan processes.

## Data Contracts

### 1) Timeline input (existing)
Source: `slide_timeline_<timestamp>/timeline.json`

Expected fields (already implemented):
- `presentationId`
- `sessionId`
- `fileName`
- `startedAtMs`
- `entries[]` with:
  - `liveSlideIndex`
  - `deckSlideIndex`
  - `slideType` (`qr|deck|generated`)
  - `timestampMs`
  - `elapsedMs`

### 2) Per-member engagement input JSON (required)
Proposed file name: `member_engagement.json`

Schema:
```json
{
  "schemaVersion": 1,
  "presentationId": "string",
  "sessionId": "string",
  "startedAtMs": 0,
  "samples": [
    {
      "timestampMs": 0,
      "elapsedMs": 0,
      "averageEngagement": 0.0,
      "members": [
        { "memberId": "a", "engagement": 0.0 }
      ]
    }
  ]
}
```

### 3) Interval-average engagement input JSON (required)
Proposed file name: `interval_average_engagement.json`

Schema:
```json
{
  "schemaVersion": 1,
  "presentationId": "string",
  "sessionId": "string",
  "intervals": [
    {
      "intervalIndex": 0,
      "startMs": 0,
      "endMs": 0,
      "averageEngagement": 0.0
    }
  ]
}
```

### 4) Dashboard response (new API)
`GET /analytics/presentation/{presentation_id}`

Response shape:
- `meta`: ids, start/end, duration
- `timeline`: slide-change events
- `averageSeries`: `{elapsedMs, value}`
- `memberSeries`: list of `{memberId, points[]}`
- `intervals`: one row per slide interval with:
  - `slideLabel`
  - `startMs`, `endMs`, `durationMs`
  - `avgEngagement` (prefer interval-average JSON if present, fallback to computed from samples)
  - `peakEngagement`
  - `deltaFromPrevious`
  - `lowEngagementMemberCount`
- `analyzerLifecycle`:
  - `startedAtMs`
  - `stoppedAtMs`
  - `status` (`completed|stopped|error`)
  - `errors[]`

## UI Plan

### A) Main chart (top)
- Line: average engagement
- Vertical dashed markers: slide changes (including `qr`, `deck`, `generated`)
- Presentation interval notches: one notch/marker per slide interval boundary from timeline
- Engagement interval notches: one notch/marker per interval from interval-average JSON
- Hover: exact timestamp, slide label, engagement value
- Optional brush/zoom after MVP

### B) Interval summary (middle)
- Sortable table, default by chronological order
- Highlight intervals with largest drop

### C) Per-member panel (bottom)
- Multi-select member picker
- Selected members are overlaid on the main chart as additional lines
- Shared time scale with average engagement line and interval markers

## Computation Plan
1. Build interval boundaries from timeline entries:
- interval i = `[slide_i.timestamp, slide_{i+1}.timestamp)`
- last interval ends at last engagement sample timestamp

2. Assign each per-member sample to interval by timestamp.

3. Merge interval-average input:
- if interval-average JSON exists, map by `(intervalIndex)` or `(startMs/endMs)` and use as `avgEngagement`
- if missing for any interval, compute from sample data for that interval

4. Compute remaining metrics:
- peak engagement per interval
- change vs previous interval
- number of members below threshold (configurable, default `0.4`)

5. Compute per-member summaries:
- mean
- variance
- max drop window

6. Validate analyzer lifecycle completeness before dashboard aggregation:
- if analyzer output missing, show partial-data state in UI
- if analyzer stopped with error, expose lifecycle error metadata

## Implementation Phases

### Phase 1: Backend analytics foundation
- Add per-member JSON loader + validation.
- Add interval-average JSON loader + validation.
- Add analytics compute module for interval metrics.
- Add `/analytics/presentation/{presentation_id}` endpoint.
- Add tests for interval assignment and metric calculations.

### Phase 2: Analyzer lifecycle integration
- Add Electron main IPC for analyzer `start/stop/status`.
- Trigger analyzer start in live presentation start flow.
- Trigger analyzer stop in live presentation end/exit flow.
- Persist analyzer output paths/metadata for analytics lookup.
- Add guards for double-start, double-stop, and process failure.

### Phase 3: Frontend dashboard MVP
- Add dashboard view component and API client.
- Implement main chart + dashed slide interval markers + engagement interval notches.
- Implement interval summary table.
- Implement member multi-select and selected-member line overlays.

### Phase 4: Quality and UX
- Empty-state and partial-data handling.
- Timezone/format consistency.
- Performance checks for large sessions.
- Add "previous sessions for this PPTX" list below dashboard, each with quick trend sparkline.

### Phase 5: Enhancements (post-MVP)
- Event overlays (Q&A, transcript intent/off-slide signals).
- Multi-session comparison.
- Export CSV/JSON snapshot.

## Risks and Mitigations
1. Sparse or irregular engagement samples:
- Mitigation: render gaps and avoid fake interpolation by default.

2. Timeline/engagement clock skew:
- Mitigation: rely on `elapsedMs` anchored to `startedAtMs`.

3. Member ID instability:
- Mitigation: treat IDs as session-scoped in MVP.

4. Large sessions causing UI slowdown:
- Mitigation: downsample for chart rendering only, keep raw data for stats.

## Decisions Requiring Your Approval
Approved:
1. Engagement threshold default: `0.4` for "low engagement" classification.
2. Include non-deck slides (`qr`, `generated`) as full intervals in MVP.
3. Session-scoped member IDs (no cross-session identity stitching) for MVP.
4. Build dashboard inside existing Electron app; when a PPTX is opened, show previous sessions and engagement trends below.
5. Show both interval systems on chart:
- presentation timeline intervals (dashed vertical lines for slide boundaries/time spent)
- engagement interval notches from interval-average input.
6. Keep data as-is (no normalization/resampling in MVP beyond fallback average computation when interval-average data is missing).
7. Source-of-truth precedence:
- interval averages from `interval_average_engagement.json` override computed averages
- computed averages used only as fallback for missing intervals.
8. Engagement analyzer must be orchestrated by the Electron app lifecycle:
- auto-start on live presentation start
- auto-stop on live presentation end/exit.

Open implementation detail to confirm:
- Visual encoding for engagement interval notches:
  - default proposal: short ticks on x-axis plus lighter vertical guides on hover only
  - avoids clutter against dashed slide boundary lines.
- Analyzer execution host/path:
  - default proposal: run existing analyzer module from `backend/engagement_analyzer` as subprocess from Electron main process.
  - if this should run on DGX instead, we need the exact command/endpoint contract.

## Acceptance Criteria
1. For any presentation with timeline + engagement samples, dashboard loads without manual data edits.
2. Main chart shows average engagement and correctly placed slide-change markers.
3. Interval table reflects computed durations and engagement deltas.
4. Per-member charts render and allow quick identification of disengagement patterns.
5. API returns stable, documented response schema.

## Proposed Next Step After Approval
Implement Phase 1 first (backend analytics foundation + endpoint + tests), then share schema and sample response before frontend work starts.
