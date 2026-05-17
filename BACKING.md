# NemoStage — Backing Data & Inspiration

## The problem in numbers

- **80%** of business professionals shifted focus away from the speaker during a presentation.  
  *WebinarCare, 2024*

- **79%** of people agree that most presentations are boring.  
  *WebinarCare, 2024*

- Average audience attention span during a business presentation: **10–15 minutes**.  
  *SlideUpLift, 2025*

- Venture capitalists spend an average of **2 minutes 12 seconds** reviewing a pre-seed pitch deck.  
  *DocSend fundraising data, cited by Visme, 2025*

- People remember **65%** of what they see and hear combined, but only **10%** of what they hear alone.  
  *Cognitive science research, cited by SlideUpLift, 2025*

- Incorporating live Q&A increases audience attention by **30%**.  
  *Gitnux Presenting Statistics Report, 2025*

---

## Why live adaptation matters

Static decks fail because presentations are not static. Judges ask hard questions. Speakers explore tangents. The slides fall behind the conversation. No commercial tool addresses this — Gamma, Beautiful.ai, Tome, and Canva AI all generate slides *before* the presentation, with no awareness of what is actually being said on stage. NemoStage is the only system that operates in real time, during a live session, triggering supplemental slide generation from the speaker's actual words.

---

## AI and enterprise context

- The AI presentation tools market was valued at **$1.54 billion in 2024**, growing at **25.7% CAGR**, projected to reach **$4.79 billion by 2029**.  
  *Research and Markets, 2025*

- Enterprise generative AI adoption more than doubled in one year: **33% → 71%** (2023 to 2024).  
  *McKinsey Global Survey, 2024*

- **63%** of organizations using generative AI apply it to create text or content.  
  *SecondTalent industry roundup, 2025*

---

## Why local inference

- **95%+** of senior executives say private and sovereign AI is important — but only **29%** are actively prioritizing it.  
  *NTT DATA Global AI Report, 2026 (survey of ~5,000 decision-makers across 30+ markets)*

- Nearly **60%** of AI leaders report that cross-border data restrictions are a significant challenge.  
  *Same source*

- GDPR, CCPA, HIPAA, and Quebec's Law 25 now apply explicitly to AI inference, not just data storage.  
  *TechTarget, 2024*

NemoStage runs entirely on the local network. No transcript, no slide content, and no audience question ever leaves the building.

---

## The hardware: ASUS Ascent GX10 (NVIDIA GB10 Grace Blackwell)

- **1 petaFLOP** (1,000 TOPS) of FP4 AI compute.  
  *NVIDIA official announcement, January 2025*

- **128 GB** unified LPDDR5X memory at **273 GB/s** bandwidth.  
  *Same source*

- **600 GB/s** bidirectional NVLink chip-to-chip interconnect.  
  *Same source*

- Supports fine-tuning models up to **200 billion parameters**.  
  *Same source*

- Inference throughput (vLLM benchmarks): Llama 3.1 8B at **~70 tok/s** single-stream, **~2,750 tok/s** batched.  
  *StorageReview, 2025*

This is a desktop-class supercomputer. It fits on a desk, runs on 240W USB-C, and outperforms cloud inference for sustained private workloads.

---

## Why RAG works

- RAG reduces LLM hallucination rates to near zero in domain-specific tasks. One 2024 clinical study (JMIR Cancer) showed hallucination drop from **6% → 0%** with RAG over curated sources.  
  *JMIR Cancer, 2024*

- Canonical reference: *"Retrieval-Augmented Generation for Large Language Models: A Survey"* (Gao et al., 2024). arXiv:2312.10997.

NemoStage uses ChromaDB with `all-MiniLM-L6-v2` embeddings to ground every agent response in the presenter's actual slides and uploaded supporting materials.

---

## Related academic work

All of these systems generate slides *before* the presentation. None operate live.

| System | What it does | Gap |
|---|---|---|
| **PPTAgent** (2024) | Multi-agent pre-generation from documents | No live triggering |
| **Auto-Slides** (arXiv:2509.11062, 2025) | Interactive multi-agent deck builder from papers | No live triggering |
| **SlideTailor** (arXiv:2512.20292, 2025) | Personalized slide generation from research papers | No live triggering |
| **Paper2Slide** (OpenReview, 2024) | Multi-agent scientific slide generation | No live triggering |

**The gap NemoStage fills:** real-time, mid-presentation slide generation triggered by speaker deviation and live audience questions. This niche is unaddressed in both commercial tools and the academic literature.

---

## Inspiration

- **NVIDIA NIM and NemoClaw** — the idea that agents should run in policy-enforced sandboxes with hardware-backed privacy, not in cloud APIs.
- **Retrieval-Augmented Generation** (Lewis et al., 2020) — grounding generative AI in real documents to eliminate hallucination.
- **DocSend pitch deck research** — investors spend under 2.5 minutes on a deck. Every second the presenter spends fumbling for the right slide is a second of credibility lost.
- **The Feynman Technique** — the best presentations are conversations, not recitations. NemoStage is built for speakers who think out loud and go where the audience takes them.
