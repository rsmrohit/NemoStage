# NemoStage — System Architecture

## Overview

NemoStage is a two-process system: an Electron desktop app on the presenter's laptop, and a FastAPI server running on an NVIDIA DGX Spark with local GPU inference.

```
┌─────────────────────────────────────────────────────────────────────┐
│  Presenter's Laptop                                                  │
│                                                                      │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │  Electron Main Process                                       │    │
│  │    • IPC handlers (extract, workspace, transcript)           │    │
│  │    • nemostage-media:// protocol (sandboxed file serving)    │    │
│  │    • Docling CLI (PPTX → JSON manifest)                      │    │
│  └────────────────────┬────────────────────────────────────────┘    │
│                       │ IPC                                          │
│  ┌────────────────────▼────────────────────────────────────────┐    │
│  │  React Renderer                                              │    │
│  │    FileSelector → SlideCanvas → SlideGallery                 │    │
│  │    NavigationControls, TextOverlay, ImageOverlay, TableOverlay│    │
│  │    GeneratedSlideCard, QAOverlay, AudienceQrSlide            │    │
│  │    Zustand store  ←→  nemostageApi.ts                        │    │
│  └────────────────────┬────────────────────────────────────────┘    │
└───────────────────────┼─────────────────────────────────────────────┘
                        │ HTTP / WebSocket
┌───────────────────────▼─────────────────────────────────────────────┐
│  DGX Spark  (gx10-d8fb, 169.233.123.64)                             │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  FastAPI  :8000                                               │   │
│  │    /uploadpptx  /presentation/*  /audience/*  /ws/presenter  │   │
│  └───────┬──────────────────┬───────────────────┬───────────────┘   │
│          │                  │                   │                    │
│  ┌───────▼───────┐  ┌───────▼───────┐  ┌───────▼────────────────┐  │
│  │  ChromaDB      │  │  Brev Ollama  │  │  OpenClaw gateway :18790│  │
│  │  (persistent)  │  │  nemotron-3- │  │  NemoClaw sandbox       │  │
│  │  embeddings    │  │  nano:4b ×4   │  │  Gemma4 26b             │  │
│  │  per deck      │  │  classify +   │  │  main / audience /      │  │
│  │                │  │  generate     │  │  slidegen agents        │  │
│  └───────────────┘  └───────────────┘  └────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Frontend

### Process model

Electron splits into two OS processes:

**Main process** (`src/main/index.ts`) — Node.js, no DOM:
- Manages the BrowserWindow lifecycle
- Registers the custom `nemostage-media://` scheme so rendered images and fonts bypass CORS
- Spawns the Docling CLI binary (bundled with the installer) to parse PPTX into JSON
- Registers IPC channels that the renderer calls via the preload bridge

**Renderer process** (`renderer/src/`) — Chromium, no Node:
- React 19 SPA, communicates with main via the preload context bridge
- Manages three app modes: `select`, `gallery`, `live`
- Zustand store holds session state (slide data, extraction status, fonts)

### IPC channels

| Direction | Channel | Payload |
|---|---|---|
| Renderer → Main | `selectFile` | — |
| Renderer → Main | `extractFile` | `{ filePath }` |
| Renderer → Main | `getRecentSessions` | — |
| Renderer → Main | `clearSession` | `{ sessionId }` |
| Renderer → Main | `startTranscriptListener` | `{ filePath, sessionId }` |
| Main → Renderer | `extraction:progress` | `{ status, slide, total }` |
| Main → Renderer | `docling:ready` | `{ slideData[], fonts[] }` |
| Main → Renderer | `transcript:update` | JSONL event |

### Slide rendering pipeline

```
.pptx file
    │
    ▼ Docling CLI (runs in main process)
JSON manifest  (DoclingElement[]: text, image, table, shape with bbox)
    │
    ▼ pptxXmlParser.ts
SlideData[]  (normalized coords, speaker notes, background, dimensions)
    │
    ▼ SlideCanvas.tsx
    ├── TextOverlay.tsx   (positioned text, font, color from TextRun[])
    ├── ImageOverlay.tsx  (crop-aware image placement)
    └── TableOverlay.tsx  (cell styling, col widths)
```

All media served via `nemostage-media://` to preserve CORS in Electron.

### Merged slide sequence

The frontend computes a single ordered sequence on every render:

```
[QR audience slide] ++ [deck slides interleaved with generated slides]
```

Generated slides are inserted at the `after_slide` index returned by the backend and displayed as `GeneratedSlideCard` components with template previews.

---

## Backend

### PPTX ingestion (`POST /sandbox/uploadpptx`)

```
Client ──upload PPTX──► validate filename
                        save to /sandbox/uploads/
                        extract slide text (XML parse)
                        embed texts (all-MiniLM-L6-v2, 384-dim)
                        upsert into ChromaDB collection
                        persist deck_index.json
                        return { deck_id, collection_name, chunks_indexed }
```

Deck ID = SHA-256 of raw PPTX bytes. Idempotent: re-uploading the same file reuses the collection.

### Material ingestion (`POST /sandbox/presentation-materials`)

Accepts DOCX, PPTX, TXT, MD, CSV, JSON, HTML, YAML (max 25 MB each).

Chunks at 1600 chars with 160-char overlap, embeds and stores in a separate collection `presentation_materials_{deck_id}`.

### Live transcript analysis (`POST /presentation/transcript`)

```
transcript chunk
    │
    ▼ ChromaDB query (top-5, cosine distance ≤ 0.45)
vector matches  →  coverage_status: current_slide | other_slide | not_covered
    │
    ▼ Build classify prompt (slide context + transcript)
    │
    ▼ Brev Ollama pool  (round-robin, 4 workers, nemotron-3-nano:4b)
JSON response { coverage_status, matched_slide, topic, reason }
    │
    ├─ if not_covered: asyncio.create_task(generate_slide_background())
    └─ return analysis to client
```

Model pool is thread-safe round-robin using `itertools.cycle` behind a lock.

### Slide generation (background task)

```
topic + current slide + deck context
    │
    ▼ extract up to 3 templates from PPTX theme + curated library
    │
    ▼ build generation prompt (brand colors, font, layout hints)
    │
    ▼ Brev Ollama (nemotron-3-nano:4b, 180s timeout)
JSON { template_id, title, text_boxes[], bullets[], style_hint }
    │
    ▼ store in memory  ←  client polls GET /presentation/{id}/generated-slides
```

### Audience Q&A (`POST /audience/question` + `WS /ws/presenter`)

```
Audience phone ──POST question──► PresenterHub.broadcast(question)  →  Presenter WebSocket
                                  async task:
                                    query ChromaDB (deck + materials)
                                    call `audience` agent (Gemma4 26b, 120s)
                                    PresenterHub.broadcast(qa_pair)  →  Presenter WebSocket
Presenter polls GET /audience/qa/recent (4s interval as fallback)
```

### Agent calls (OpenClaw)

All agent invocations run as subprocesses on the DGX host (not inside the container):

```python
subprocess.run(
    ["/home/asus/.npm-global/bin/openclaw", "agent",
     "--agent", agent_name, "--message", prompt, "--json"],
    env={**os.environ,
         "OPENCLAW_GATEWAY_URL": "ws://127.0.0.1:18790",
         "OPENCLAW_GATEWAY_TOKEN": "..."},
    timeout=300
)
```

The sandbox gateway runs on port `18790` (SSH-tunneled from inside the container). Port `18789/18080` is the host gateway — do not use it for agent calls.

---

## Data models

### Frontend (TypeScript)

```typescript
interface SlideData {
  slideIndex: number
  elements: DoclingElement[]
  speakerNotes?: string
  background?: string
  slideWidth?: number
  slideHeight?: number
}

interface DoclingElement {
  type: 'text' | 'image' | 'shape' | 'table'
  bbox: { x: number; y: number; width: number; height: number }
  content: string
  style?: { font: string; fontSize: number; color: string }
  textRuns?: TextRun[]
  tableRows?: TableRow[]
  crop?: ImageCrop
}

interface GeneratedSlide {
  index: number
  title: string
  bullets: string[]
  template?: GeneratedSlideTemplate
  text_boxes?: { id: string; text: string }[]
  notes: string
  style_hint: { bg: string; accent: string; font: string }
  after_slide: number
  topic: string
  created_at: number
}
```

### Backend (Python / Pydantic)

```python
class PresentationSession(BaseModel):
    presentation_id: str
    file_name: str
    slide_count: int
    current_slide: int
    slides: list[PresentationSlide]
    deck_id: str | None
    collection_name: str | None
    vectorization_status: str       # 'ready' | 'failed' | 'unavailable'
    chunks_indexed: int
    material_chunks_indexed: int
    coverage_status: str
    last_agent_result: Any
    slide_generation_needed: bool
```

---

## Registered NemoClaw agents

| Agent | Model | System prompt purpose |
|---|---|---|
| `main` | Gemma4 26b | General presentation assistant; answers off-script questions |
| `audience` | Gemma4 26b | Answers audience Q&A with deck context in 2-3 sentences |
| `slidegen` | Gemma4 26b | Generates supplemental slide JSON given topic + template |
| `livetranscript` | Gemma4 26b | (Legacy) Classifies transcript coverage |

---

## Key design decisions

**Why local inference?** Privacy. Project files and live transcripts stay on-device; no data leaves the ucscguest network.

**Why two model tiers?** `nemotron-3-nano:4b` handles latency-sensitive classify/generate loops (target < 10s). `Gemma4 26b` handles quality-sensitive agent turns (30-90s is acceptable for Q&A).

**Why Chroma over a hosted vector DB?** Zero cloud dependency; persists at `/home/asus/nemostage-chroma/` and survives service restarts.

**Why `nemostage-media://` protocol?** Electron's default `file://` scheme blocks cross-origin requests for local assets. A custom privileged scheme lets the renderer load fonts and images without disabling web security globally.

**Why polling for generated slides?** Background generation is genuinely async (up to 180s). WebSocket push would be cleaner but polling at 4s is sufficient and simpler to reason about when debugging timeout failures.
