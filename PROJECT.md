# NemoStage: Technical Strategy & Implementation Roadmap

NemoStage is a live presentation co-pilot designed for high-stakes technical environments.

Unlike static slide generators, it functions as a real-time reactive agent that tracks speaker flow, monitors audience engagement, and provides secure, context-aware assistance through the NVIDIA stack.

---

# Vision: The Live Presentation Co-Pilot

The project moves away from "AI-generated slides" toward a **Live Presentation State Engine**.

The goal is to solve the "static deck" pain point: slides that cannot adapt when a speaker goes off-script or when a judge asks a complex question.

---

# Core Architecture Flow

## Live Input Layer

- Streaming ASR (NVIDIA Riva)
- Voice activity detection
- Converts speech into timestamped events

## Presentation State Engine

- Tracks current slides
- Monitors elapsed time
- Computes coverage scores
- Predicts transitions

## NemoClaw Agent Runtime

A secure sandbox using OpenShell containers with policy-based privacy guardrails.

This allows the agent to interact with sensitive project files and transcripts without compromising security.

## Tool & Presentation Layer

A custom web-based presenter app (React) that enables:

- Real-time slide injection
- Manual overrides

---

# Tech Stack & Component Breakdown

The implementation will leverage local inference on the ASUS Ascent GX10 (NVIDIA DGX Spark) to ensure privacy and low-latency performance.

| Component        | Technology           | Primary Role                                             |
| ---------------- | -------------------- | -------------------------------------------------------- |
| Agent Runtime    | NemoClaw / OpenShell | Enforces privacy policies and secure data access         |
| Audio Processing | NVIDIA Riva ASR      | Provides streaming transcription and speaker diarization |
| Hardware         | ASUS Ascent GX10     | Local Blackwell GPU inference for agentic workflows      |
| Frontend         | React / Vite         | Web-based presenter and audience engagement UIs          |
| Slide Export     | PptxGenJS            | Generates standard PPTX files post-demo for stakeholders |
| Computer Vision  | MediaPipe (Stretch)  | Estimates coarse audience engagement signals             |

---

# Data Security Policies

NemoClaw will enforce strict scoped access to prevent unauthorized data leaks:

- **Filesystem:** Restricted to approved project and deck directories
- **Network:** Only trusted documentation and search endpoints allowed
- **Display:** Generated slides and web-sourced claims require human-in-the-loop approval

---

# Team Roles & Responsibilities

| Owner             | Primary Domain          | Key Deliverables                                         |
| ----------------- | ----------------------- | -------------------------------------------------------- |
| Rachit Verma      | Architecture & Security | NemoClaw policies, agent tool schemas, and core pitch    |
| Anirudh Sivakumar | Backend & State         | WebSocket event bus, slide controller, and injection API |
| Rohit Mamidipaka  | Product UX & Polish     | Presenter UI, QR flow, and judge-facing demo experience  |
| Shiva Ravinutala  | Input Systems           | Riva ASR integration, question detection, and analytics  |

---

# MVP Development Phases

The build order focuses on making the core sync reliable before adding generative features.

## Phase 1: Fundamental Sync

Build the web presenter app with:

- Manual slides
- Live transcript feed
- Slide dwell time tracking

## Phase 2: Off-Slide Detection

Implement embedding-based comparison to detect when the speaker references topics not covered in the current slide.

## Phase 3: Support Generation

Enable the agent to generate template-constrained:

- Support Slides
- Speaker Notes

All outputs require presenter approval.

## Phase 4: RAG Integration

Allow the agent to answer judge questions by retrieving data from project files via NemoClaw’s secure file tools.

## Phase 5: Audience Engagement

Deploy the QR code interaction page for:

- Real-time feedback
- Confusion signals
- Interest signals

---

# The Winning Pitch

NemoStage turns a static slide deck into a live, secure presentation agent.

It listens to the speaker, tracks the current slide, detects when the conversation leaves the deck, and uses project context plus trusted sources to generate approved speaker notes or support slides in real time.

By leveraging NemoClaw, the agent runs with scoped access to transcripts and local files, making live AI assistance safe for technical and corporate environments.
