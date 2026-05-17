# NemoStage — Project Summary

## What is NemoStage?

NemoStage is a live presentation co-pilot built for high-stakes technical demos. It is a desktop application that runs on the presenter's laptop and connects to an AI backend running on a local NVIDIA DGX Spark (ASUS Ascent GX10 with Blackwell GPU). The system watches what a presenter says in real time, detects when the speaker goes off-script, and silently generates supplemental slides to support the detour — all without leaving the local network.

## The problem it solves

Static slide decks cannot adapt. When a speaker goes off-script to answer a judge's question or explore a deeper topic, the slides become irrelevant. The audience sees the wrong content. NemoStage fixes this by treating the presentation as a live state machine: it tracks what has been covered, what the speaker is currently saying, and what needs a visual aid — then generates and injects new slides automatically.

## Core capabilities

**Off-script detection.** Slide text is embedded using sentence transformers (all-MiniLM-L6-v2) and stored in a local ChromaDB vector index. As the presenter speaks, transcript chunks are compared against the index. If cosine distance exceeds the threshold, the system flags coverage as "not covered" and queues slide generation.

**Supplemental slide generation.** A background agent (Gemma4 26b running in a NemoClaw sandbox) receives the topic, the speaker's exact words, and the deck's brand colors and fonts. It returns a structured slide in JSON format that is immediately injected into the slide sequence on the presenter's screen.

**Audience Q&A.** The audience scans a QR code shown at the start of the presentation, submits questions from their phones, and receives AI-generated answers drawn from the slide deck and any uploaded supporting materials. The presenter sees questions and answers appear in real time on a WebSocket-connected overlay.

**Material RAG.** The presenter can upload supporting documents (papers, reports, data sheets) alongside the deck. These are chunked and embedded into a separate vector collection. Agent answers draw on both sources.

## Technical architecture

The system has two main components:

The **Electron desktop app** (React 19, TypeScript, Zustand) renders the presentation on the presenter's laptop. It parses PPTX files using the Docling CLI, renders slides pixel-accurately from a JSON manifest, and communicates with the backend via HTTP and WebSocket. A custom `nemostage-media://` Electron protocol serves local media files with correct CORS headers.

The **FastAPI backend** runs on the DGX Spark (port 8000, accessible across the ucscguest network). It handles PPTX ingestion, vector indexing, transcript classification, slide generation, and audience Q&A. Two model tiers handle different latency requirements: `nemotron-3-nano:4b` via a 4-worker Brev Ollama pool handles fast classification and generation loops (target under 10 seconds); `Gemma4 26b` via the NemoClaw OpenClaw gateway handles quality-sensitive agent turns (30-90 seconds for Q&A is acceptable).

## Why NVIDIA hardware matters

All inference runs locally on the DGX Spark. No data — slides, transcripts, or audience questions — leaves the local network. The Blackwell GPU enables running a 26-billion-parameter model (Gemma4 26b) for high-quality agent responses while simultaneously running the smaller classification model for real-time transcript analysis. This privacy-first, local-inference architecture is a core design constraint of the project.

## NemoClaw and the sandbox

NemoClaw is NVIDIA's agent runtime. NemoStage runs three registered agents inside a NemoClaw OpenShell sandbox container on the DGX: a general presentation assistant, an audience engagement analyzer, and a slide generator. The sandbox enforces policy-based privacy guardrails so agents can access uploaded project files and live transcripts without risk of data exfiltration.

## Current state

The system supports the full presentation flow: upload a PPTX, start a session, feed live transcript chunks, receive coverage classifications, and watch supplemental slides appear automatically. Audience Q&A is fully functional via WebSocket broadcast. Vector search against both slide content and uploaded supporting materials is working. The slide generation pipeline uses extracted deck templates (brand colors, fonts, layout) plus a curated template library to produce visually consistent supplemental slides.

## Team and context

NemoStage was built as a demonstration of what is possible when local GPU inference, agent sandboxing, and real-time vector search are combined in a single presentation workflow. The target audience is technical judges and reviewers who will push a presenter with hard questions that go beyond the prepared slides.
