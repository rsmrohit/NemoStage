# NemoStage

**Live presentation co-pilot for high-stakes technical demos.**

NemoStage turns a static PowerPoint deck into an adaptive, AI-powered presentation assistant. It watches what you say in real time, detects when you go off-script, and silently generates supplemental slides to support the detour — all on local hardware.

---

## What it does

| Capability | How |
|---|---|
| Slide rendering | Parses PPTX XML with Docling; renders text, images, and tables on a pixel-accurate canvas |
| Off-script detection | Embeds slide text with SentenceTransformers; classifies live transcript against the index |
| Supplemental slide generation | Fires a background agent (Gemma4 26b via NemoClaw) when coverage status = `not_covered` |
| Audience Q&A | Audience scans QR → submits question → agent answers with deck context → broadcast to presenter |
| Material RAG | Upload supporting docs (DOCX/PDF/TXT) alongside the deck; answers draw on both |

---

## Architecture at a glance

```
Laptop (Electron/React)
  └── nemostageApi.ts ─── HTTP ──► FastAPI backend (DGX Spark, port 8000)
                                      ├── ChromaDB  (vector index, local)
                                      ├── Brev Ollama pool  (nemotron-3-nano:4b × 4)
                                      └── OpenClaw gateway (ws://127.0.0.1:18790)
                                            └── NemoClaw sandbox
                                                  └── Gemma4 26b (main / audience / slidegen)
```

---

## Hardware

- **Frontend:** Any laptop (macOS/Windows/Linux)
- **Backend:** ASUS Ascent GX10 (DGX Spark) — Blackwell GPU, local inference
- **Network:** ucscguest Wi-Fi or Tailscale VPN

---

## Quick start

### Frontend (laptop)

```bash
cd NemoStage
npm install
npm run dev          # hot-reload dev build
npm run build:mac    # production installer
```

### Backend (DGX Spark)

```bash
source /home/asus/nemostage-venv/bin/activate
cd /home/asus
uvicorn nemostage-server:app --host 0.0.0.0 --port 8000

# or via systemd
sudo systemctl restart nemostage
sudo journalctl -u nemostage -f
```

Deploy changes from local:

```bash
# SFTP server.py to /home/asus/nemostage-server.py, then:
sudo systemctl restart nemostage
```

---

## Key endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/status` | Health check |
| POST | `/sandbox/uploadpptx` | Upload PPTX, build vector index |
| POST | `/sandbox/presentation-materials` | Upload supporting docs |
| POST | `/presentation/start` | Create session |
| POST | `/presentation/transcript` | Analyze live transcript chunk |
| GET | `/presentation/{id}/generated-slides` | Poll for generated slides |
| POST | `/audience/question` | Audience submits question |
| GET | `/audience/qa/recent` | Fetch answered Q&A pairs |
| WS | `/ws/presenter` | Real-time Q&A broadcast |

---

## Tech stack

| Layer | Technology |
|---|---|
| Desktop shell | Electron 39 |
| UI | React 19 + TypeScript 5 |
| Build | electron-vite + Vite 6 |
| State | Zustand 5 |
| Backend | FastAPI (Python 3.11) |
| Embeddings | sentence-transformers/all-MiniLM-L6-v2 |
| Vector DB | ChromaDB (persistent, local) |
| LLM inference | Brev Ollama (nemotron-3-nano:4b), NemoClaw (Gemma4 26b) |
| Agent runtime | NemoClaw / OpenShell sandbox |
| Slide parsing | Docling + custom PPTX XML parser |

---

## Project layout

```
NemoStage/                    # Electron app
  src/main/                   # Main process, IPC, media protocol
  src/preload/                # Context bridge
  renderer/src/               # React UI
    components/               # 13 UI components
    services/nemostageApi.ts  # Backend HTTP client
    store/presentationStore.ts # Zustand state
nemostage_backend/
  server.py                   # FastAPI server (2300 lines)
  slide_templates/            # Curated template library
backend/transcript/           # Legacy Whisper.cpp integration
PROJECT.md                    # Vision & roadmap
AGENTS.md                     # NemoClaw agent reference
ARCHITECTURE.md               # Full system architecture
```
