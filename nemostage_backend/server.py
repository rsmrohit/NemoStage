import asyncio
import json
import os
import subprocess
import tempfile
import time
from typing import Any, Set

from fastapi import FastAPI, File, Form, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse
from pydantic import BaseModel, Field

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

SANDBOX_DEST = "/sandbox/uploads"
OPENCLAW_GATEWAY_URL = "ws://127.0.0.1:18790"
OPENCLAW_GATEWAY_TOKEN = "3f34f9ef7832494ab392baedf419b9515a1b9da0dbb429f6"
OPENCLAW_BIN = "/home/asus/.npm-global/bin/openclaw"

ALLOWED_SIGNALS = {"confused", "interested", "lost"}
REGISTERED_AGENTS = {"main", "livetranscript", "audience"}
MAX_AGENT_SLIDE_TEXT_CHARS = 1200


class PresentationSlide(BaseModel):
    slide_index: int
    title: str = ""
    summary: str = ""
    speaker_notes: str = ""


class PresentationStartRequest(BaseModel):
    session_id: str
    file_name: str = ""
    slide_count: int = Field(ge=0)
    current_slide: int = Field(ge=0)
    slides: list[PresentationSlide] = Field(default_factory=list)


class PresentationSlideRequest(BaseModel):
    presentation_id: str
    current_slide: int = Field(ge=0)


class PresentationTranscriptRequest(BaseModel):
    presentation_id: str
    transcript: str


class PresentationSession(BaseModel):
    presentation_id: str
    file_name: str = ""
    slide_count: int
    current_slide: int
    slides: list[PresentationSlide] = Field(default_factory=list)
    started_at: float
    updated_at: float
    last_agent_result: Any = None
    slide_generation_needed: bool = False
    coverage_status: str = "unknown"


presentation_sessions: dict[str, PresentationSession] = {}


class PresenterHub:
    def __init__(self):
        self.connections: Set[WebSocket] = set()
        self.lock = asyncio.Lock()

    async def connect(self, ws: WebSocket):
        await ws.accept()
        async with self.lock:
            self.connections.add(ws)

    async def disconnect(self, ws: WebSocket):
        async with self.lock:
            self.connections.discard(ws)

    async def broadcast(self, message: dict):
        async with self.lock:
            targets = list(self.connections)
        dead = []
        for ws in targets:
            try:
                await ws.send_json(message)
            except Exception:
                dead.append(ws)
        if dead:
            async with self.lock:
                for ws in dead:
                    self.connections.discard(ws)


hub = PresenterHub()
signal_counts: dict = {s: 0 for s in ALLOWED_SIGNALS}


def get_nemostage_container() -> str:
    result = subprocess.run(
        ["docker", "ps", "--filter", "name=openshell-nemostage", "--format", "{{.Names}}"],
        capture_output=True, text=True
    )
    names = [n for n in result.stdout.strip().split("\n") if n]
    if not names:
        raise HTTPException(status_code=503, detail="nemostage sandbox container not running")
    return names[0]


def validate_pptx_filename(filename: str) -> str:
    safe_name = os.path.basename(filename)
    if not safe_name.endswith(".pptx"):
        raise HTTPException(status_code=400, detail="Only .pptx files are accepted")
    if not safe_name or "/" in safe_name or "\\" in safe_name or ".." in safe_name:
        raise HTTPException(status_code=400, detail="Invalid filename")
    return safe_name


def save_pptx_to_sandbox(filename: str, content: bytes) -> dict:
    safe_name = validate_pptx_filename(filename)
    container = get_nemostage_container()

    with tempfile.NamedTemporaryFile(suffix=".pptx", delete=False) as tmp:
        tmp.write(content)
        tmp_path = tmp.name

    try:
        subprocess.run(
            ["docker", "exec", container, "mkdir", "-p", SANDBOX_DEST],
            check=True
        )
        dest = f"{SANDBOX_DEST}/{safe_name}"
        subprocess.run(
            ["docker", "cp", tmp_path, f"{container}:{dest}"],
            check=True
        )
        subprocess.run(
            ["docker", "exec", container, "chown", "sandbox:sandbox", dest],
            check=True
        )
    finally:
        os.unlink(tmp_path)

    return {
        "filename": safe_name,
        "sandbox_path": dest,
        "container": container,
        "size_bytes": len(content),
    }


def parse_json_reply(reply: str) -> Any:
    try:
        return json.loads(reply)
    except json.JSONDecodeError:
        start = reply.find("{")
        end = reply.rfind("}")
        if start >= 0 and end > start:
            try:
                return json.loads(reply[start:end + 1])
            except json.JSONDecodeError:
                return None
    return None


def ask_agent(prompt: str, agent: str = "main", timeout: int = 300, session_id: str | None = None) -> str:
    if agent not in REGISTERED_AGENTS:
        raise HTTPException(status_code=400, detail=f"unknown agent: {agent}")

    env = os.environ.copy()
    env["OPENCLAW_GATEWAY_URL"] = OPENCLAW_GATEWAY_URL
    env["OPENCLAW_GATEWAY_TOKEN"] = OPENCLAW_GATEWAY_TOKEN

    cmd = [OPENCLAW_BIN, "agent", "--agent", agent]
    if session_id:
        cmd.extend(["--session-id", session_id])
    cmd.extend(["--message", prompt, "--json"])

    result = subprocess.run(
        cmd,
        capture_output=True, text=True, env=env, timeout=timeout
    )
    if result.returncode != 0:
        raise HTTPException(
            status_code=502,
            detail=f"Agent {agent} failed: {result.stderr[:500] or result.stdout[:500]}"
        )

    # Find the JSON object in stdout (openclaw may emit log lines before it)
    for line in result.stdout.splitlines():
        line = line.strip()
        if line.startswith("{"):
            try:
                data = json.loads(line)
                payloads = data.get("result", {}).get("payloads", [])
                if payloads:
                    return payloads[0].get("text", "")
            except json.JSONDecodeError:
                pass

    # Try parsing the entire stdout as JSON
    try:
        data = json.loads(result.stdout)
        payloads = data.get("result", {}).get("payloads", [])
        if payloads:
            return payloads[0].get("text", "")
    except json.JSONDecodeError:
        pass

    raise HTTPException(status_code=502, detail=f"Agent {agent} returned no parseable response: {result.stdout[:300]}")


@app.get("/agents")
def list_registered_agents():
    return {
        "agents": [
            {
                "id": "main",
                "purpose": "general NemoClaw presentation assistant",
            },
            {
                "id": "livetranscript",
                "purpose": "standalone live transcript ingestion and slide-tracking probe",
            },
            {
                "id": "audience",
                "purpose": "standalone audience engagement analysis probe",
            },
        ]
    }


@app.post("/agents/livetranscript")
async def livetranscript_agent(
    transcript: str = Form(...),
    slide_context: str = Form(""),
    session_id: str = Form(""),
):
    transcript = transcript.strip()
    if not transcript:
        raise HTTPException(status_code=400, detail="empty transcript")

    prompt = (
        "You are the NemoStage live transcript ingestor. Analyze this live presentation transcript "
        "chunk. Use slide_context only if it is provided. Classify whether the content is on the "
        "current slide, covered by another slide, or not covered by the presentation.\n\n"
        f"slide_context:\n{slide_context.strip() or '[not provided]'}\n\n"
        f"transcript:\n{transcript}\n"
        "\nReturn exactly one JSON object and nothing else. Schema:\n"
        '{"coverage_status": "current_slide|other_slide|not_covered", '
        '"matched_slide": <int|null>, "summary_so_far": "<str>", '
        '"topic": "<str|null>", "reason": "<str>"}\n'
    )
    reply = ask_agent(
        prompt,
        agent="livetranscript",
        session_id=session_id.strip() or None,
    )
    return JSONResponse({
        "status": "ok",
        "agent": "livetranscript",
        "raw": reply,
        "parsed": parse_json_reply(reply),
    })


@app.post("/agents/audience")
async def audience_agent(
    confused: int = Form(0),
    interested: int = Form(0),
    lost: int = Form(0),
    questions: str = Form(""),
    session_id: str = Form(""),
):
    prompt = (
        "You are the NemoStage live audience engagement analyst. Analyze this live audience "
        "engagement snapshot for the presenter.\n\n"
        f"reaction_counts: confused={confused}, interested={interested}, lost={lost}\n"
        f"questions:\n{questions.strip() or '[none]'}\n"
        "\nReturn exactly one JSON object and nothing else. Schema:\n"
        '{"engagement_level": "high|medium|low", '
        '"dominant_signal": "confused|interested|lost|neutral", '
        '"summary": "<1-2 sentence insight>", '
        '"suggested_action": "<concrete thing presenter should do now>"}\n'
    )
    reply = ask_agent(
        prompt,
        agent="audience",
        session_id=session_id.strip() or None,
    )
    return JSONResponse({
        "status": "ok",
        "agent": "audience",
        "raw": reply,
        "parsed": parse_json_reply(reply),
    })


def get_presentation_session(presentation_id: str) -> PresentationSession:
    session = presentation_sessions.get(presentation_id)
    if not session:
        raise HTTPException(status_code=404, detail=f"presentation not found: {presentation_id}")
    return session


def get_current_slide(session: PresentationSession) -> PresentationSlide | None:
    for slide in session.slides:
        if slide.slide_index == session.current_slide:
            return slide
    if 0 <= session.current_slide < len(session.slides):
        return session.slides[session.current_slide]
    return None


def compact_agent_text(value: str, limit: int = MAX_AGENT_SLIDE_TEXT_CHARS) -> str:
    text = " ".join(value.split())
    if len(text) <= limit:
        return text
    return text[:limit].rstrip() + "..."


def format_slide_for_agent(slide: PresentationSlide, current_slide: int) -> str:
    marker = "CURRENT" if slide.slide_index == current_slide else "OTHER"
    summary = compact_agent_text(slide.summary)
    notes = compact_agent_text(slide.speaker_notes, 500)
    return (
        f"[{marker}] slide_index={slide.slide_index}, slide_number={slide.slide_index + 1}\n"
        f"title: {slide.title}\n"
        f"summary: {summary or '[empty]'}\n"
        f"speaker_notes: {notes or '[empty]'}"
    )


def build_presentation_outline(session: PresentationSession) -> str:
    slides = sorted(session.slides, key=lambda item: item.slide_index)
    current = [slide for slide in slides if slide.slide_index == session.current_slide]
    future = [slide for slide in slides if slide.slide_index > session.current_slide]
    previous = [slide for slide in slides if slide.slide_index < session.current_slide]

    sections = []
    if current:
        sections.append("CURRENT SLIDE\n" + "\n\n".join(format_slide_for_agent(slide, session.current_slide) for slide in current))
    else:
        sections.append(f"CURRENT SLIDE\n[missing summary for slide_index={session.current_slide}]")
    if future:
        sections.append("FUTURE SLIDES\n" + "\n\n".join(format_slide_for_agent(slide, session.current_slide) for slide in future))
    if previous:
        sections.append("PREVIOUS SLIDES\n" + "\n\n".join(format_slide_for_agent(slide, session.current_slide) for slide in previous))
    return "\n\n".join(sections)


def presentation_status(session: PresentationSession) -> dict:
    data = session.dict()
    data["status"] = "ok"
    return data


@app.post("/presentation/start")
async def start_presentation(payload: PresentationStartRequest):
    session_id = payload.session_id.strip()
    if not session_id:
        raise HTTPException(status_code=400, detail="session_id is required")
    if payload.slide_count and payload.current_slide >= payload.slide_count:
        raise HTTPException(status_code=400, detail="current_slide is outside slide_count")

    now = time.time()
    session = PresentationSession(
        presentation_id=session_id,
        file_name=payload.file_name,
        slide_count=payload.slide_count,
        current_slide=payload.current_slide,
        slides=payload.slides,
        started_at=now,
        updated_at=now,
    )
    presentation_sessions[session_id] = session
    return {"status": "ok", "presentation_id": session_id}


@app.post("/presentation/slide")
async def update_presentation_slide(payload: PresentationSlideRequest):
    session = get_presentation_session(payload.presentation_id)
    if session.slide_count and payload.current_slide >= session.slide_count:
        raise HTTPException(status_code=400, detail="current_slide is outside slide_count")

    session.current_slide = payload.current_slide
    session.updated_at = time.time()
    presentation_sessions[payload.presentation_id] = session
    return presentation_status(session)


@app.post("/presentation/transcript")
async def analyze_presentation_transcript(payload: PresentationTranscriptRequest):
    session = get_presentation_session(payload.presentation_id)
    transcript = payload.transcript.strip()
    if not transcript:
        raise HTTPException(status_code=400, detail="empty transcript")

    presentation_outline = build_presentation_outline(session)
    prompt = (
        "You are tracking a live presentation. Use the in-memory presentation outline below; "
        "do not open files or run tools. Classify the speaker's transcript chunk into exactly "
        "one coverage_status:\n"
        "- current_slide: the content is covered by the current slide.\n"
        "- other_slide: the content is not covered by the current slide, but is covered by a "
        "different slide in the presentation, including a future slide.\n"
        "- not_covered: the content is not covered by any slide in the presentation.\n\n"
        "If coverage_status is other_slide, set matched_slide to the best matching slide_index. "
        "If not_covered, set matched_slide to null and topic to the missing topic.\n\n"
        f"Presentation outline:\n{presentation_outline}\n\n"
        f"Transcript chunk:\n{transcript}\n\n"
        "Return exactly one JSON object and nothing else. Schema:\n"
        '{"coverage_status": "current_slide|other_slide|not_covered", '
        '"matched_slide": <int|null>, "summary_so_far": "<str>", '
        '"topic": "<str|null>", "reason": "<str>"}\n'
    )
    reply = ask_agent(
        prompt,
        agent="livetranscript",
        session_id=f"presentation-{payload.presentation_id}",
    )
    parsed = parse_json_reply(reply)
    agent_result = parsed if isinstance(parsed, dict) else {"raw": reply}
    coverage_status = "unknown"
    if isinstance(agent_result, dict):
        raw_status = agent_result.get("coverage_status")
        if raw_status in {"current_slide", "other_slide", "not_covered"}:
            coverage_status = raw_status
        elif agent_result.get("off_slide") is True:
            coverage_status = "not_covered"
        elif agent_result.get("off_slide") is False:
            coverage_status = "current_slide"
    slide_generation_needed = coverage_status == "not_covered"

    session.last_agent_result = agent_result
    session.slide_generation_needed = slide_generation_needed
    session.coverage_status = coverage_status
    session.updated_at = time.time()
    presentation_sessions[payload.presentation_id] = session

    return JSONResponse({
        "status": "ok",
        "presentation_id": payload.presentation_id,
        "current_slide": session.current_slide,
        "agent_result": agent_result,
        "coverage_status": coverage_status,
        "slide_generation_needed": slide_generation_needed,
    })


@app.get("/presentation/{presentation_id}")
async def get_presentation(presentation_id: str):
    return presentation_status(get_presentation_session(presentation_id))


@app.post("/sandbox/uploadpptx")
async def upload_pptx_to_sandbox(file: UploadFile = File(...)):
    content = await file.read()
    upload = save_pptx_to_sandbox(file.filename, content)
    return JSONResponse({
        "status": "ok",
        **upload,
    })


@app.post("/uploadpptx")
async def upload_pptx(file: UploadFile = File(...)):
    content = await file.read()
    upload = save_pptx_to_sandbox(file.filename, content)
    dest = upload["sandbox_path"]

    prompt = (
        f"Run this command and summarize the output in plain text — no code, no function calls:\n\n"
        f"python3 -c \"\n"
        f"import zipfile, re\n"
        f"z = zipfile.ZipFile('{dest}')\n"
        f"texts = []\n"
        f"for name in z.namelist():\n"
        f"    if 'slides/slide' in name and name.endswith('.xml'):\n"
        f"        xml = z.read(name).decode('utf-8', errors='replace')\n"
        f"        texts.append(re.sub(r'<[^>]+>', ' ', xml))\n"
        f"print('\\n---\\n'.join(texts))\n"
        f"\"\n\n"
        f"Once you have the slide text, reply with a concise summary: key topics, structure, and main points. "
        f"Plain prose only — no code blocks, no function calls in your reply."
    )
    summary = ask_agent(prompt)

    return JSONResponse({
        "status": "ok",
        "filename": upload["filename"],
        "sandbox_path": dest,
        "container": upload["container"],
        "summary": summary,
    })


@app.get("/presentations")
def list_presentations():
    container = get_nemostage_container()
    result = subprocess.run(
        [
            "docker", "exec", container, "python3", "-c",
            (
                "import json, os, datetime\n"
                f"root = {SANDBOX_DEST!r}\n"
                "files = []\n"
                "if os.path.isdir(root):\n"
                "    for entry in os.scandir(root):\n"
                "        if entry.is_file() and entry.name.endswith('.pptx'):\n"
                "            stat = entry.stat()\n"
                "            files.append({\n"
                "                'filename': entry.name,\n"
                "                'size_bytes': stat.st_size,\n"
                "                'uploaded_at': datetime.datetime.utcfromtimestamp(stat.st_mtime).strftime('%Y-%m-%dT%H:%M:%SZ'),\n"
                "                'sandbox_path': os.path.join(root, entry.name),\n"
                "            })\n"
                "files.sort(key=lambda item: item['uploaded_at'], reverse=True)\n"
                "print(json.dumps(files))\n"
            )
        ],
        capture_output=True, text=True
    )
    if result.returncode != 0:
        raise HTTPException(status_code=502, detail=f"Could not list sandbox presentations: {result.stderr[:300]}")

    try:
        files = json.loads(result.stdout)
    except json.JSONDecodeError:
        raise HTTPException(status_code=502, detail=f"Could not parse sandbox presentations: {result.stdout[:300]}")

    return JSONResponse({"presentations": files})


@app.delete("/presentations/{filename}")
def delete_presentation(filename: str):
    if not filename.endswith(".pptx"):
        raise HTTPException(status_code=400, detail="Only .pptx files can be deleted")
    if "/" in filename or ".." in filename:
        raise HTTPException(status_code=400, detail="Invalid filename")

    container = get_nemostage_container()
    target = f"{SANDBOX_DEST}/{filename}"

    check = subprocess.run(
        ["docker", "exec", container, "test", "-f", target],
        capture_output=True
    )
    if check.returncode != 0:
        raise HTTPException(status_code=404, detail=f"{filename} not found in sandbox")

    subprocess.run(
        ["docker", "exec", container, "rm", target],
        check=True
    )
    return JSONResponse({"status": "ok", "deleted": filename, "sandbox_path": target})


@app.get("/status")
def status():
    try:
        container = get_nemostage_container()
        return {"status": "ok", "container": container}
    except HTTPException as e:
        return {"status": "error", "detail": e.detail}


@app.websocket("/ws/presenter")
async def presenter_ws(ws: WebSocket):
    await hub.connect(ws)
    try:
        await ws.send_json({"type": "hello", "signal_counts": signal_counts, "ts": time.time()})
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        await hub.disconnect(ws)
    except Exception:
        await hub.disconnect(ws)


@app.post("/audience/question")
async def audience_question(text: str = Form(...)):
    text = text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="empty question")
    if len(text) > 1000:
        raise HTTPException(status_code=400, detail="question too long (max 1000 chars)")
    msg = {"type": "question", "text": text, "ts": time.time()}
    await hub.broadcast(msg)
    return {"status": "ok"}


@app.post("/audience/signal")
async def audience_signal(signal: str = Form(...)):
    if signal not in ALLOWED_SIGNALS:
        raise HTTPException(status_code=400, detail=f"signal must be one of {sorted(ALLOWED_SIGNALS)}")
    signal_counts[signal] += 1
    msg = {
        "type": "signal",
        "signal": signal,
        "count": signal_counts[signal],
        "counts": dict(signal_counts),
        "ts": time.time(),
    }
    await hub.broadcast(msg)
    return {"status": "ok", "count": signal_counts[signal]}


@app.get("/audience/pulse")
def audience_pulse():
    return {"counts": dict(signal_counts), "presenters_connected": len(hub.connections)}


AUDIENCE_HTML = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<title>NemoStage Audience</title>
<style>
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
         background: #0e0e10; color: #f4f4f5; min-height: 100vh; padding: 28px 20px; }
  h1 { font-size: 24px; margin: 0 0 6px; font-weight: 600; letter-spacing: -0.01em; }
  .sub { color: #8a8a90; font-size: 14px; margin-bottom: 28px; line-height: 1.4; }
  textarea { width: 100%; min-height: 120px; padding: 14px; border-radius: 12px; border: 1px solid #2a2a2e;
             background: #18181b; color: #f4f4f5; font-size: 16px; resize: vertical; font-family: inherit; }
  textarea:focus { outline: none; border-color: #6366f1; }
  .row { display: flex; gap: 10px; margin-top: 12px; }
  button { flex: 1; padding: 16px 12px; border-radius: 12px; border: none; font-size: 15px;
           font-weight: 600; cursor: pointer; font-family: inherit;
           transition: transform .05s ease, opacity .15s ease; }
  button:active { transform: scale(0.97); }
  button:disabled { opacity: 0.5; cursor: default; }
  .primary { background: #6366f1; color: white; }
  .signal { background: #27272a; color: #f4f4f5; }
  .signal.confused { background: #422006; color: #fbbf24; }
  .signal.interested { background: #052e16; color: #4ade80; }
  .signal.lost { background: #450a0a; color: #f87171; }
  .section-label { font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em;
                   color: #71717a; margin: 32px 0 10px; font-weight: 600; }
  .toast { position: fixed; bottom: 32px; left: 50%; transform: translateX(-50%) translateY(80px);
           background: #18181b; border: 1px solid #2a2a2e; padding: 12px 22px; border-radius: 999px;
           font-size: 14px; opacity: 0; transition: opacity .25s ease, transform .25s ease;
           pointer-events: none; }
  .toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
</style>
</head>
<body>
  <h1>Ask the speaker</h1>
  <div class="sub">Your question or reaction shows up live on the slideshow.</div>

  <form id="qform">
    <textarea id="qtext" placeholder="Type your question..." maxlength="1000"></textarea>
    <div class="row">
      <button type="submit" class="primary" id="qbtn">Send question</button>
    </div>
  </form>

  <div class="section-label">Quick reactions</div>
  <div class="row">
    <button class="signal confused" data-signal="confused">Confused</button>
    <button class="signal interested" data-signal="interested">Interesting</button>
    <button class="signal lost" data-signal="lost">Lost</button>
  </div>

  <div id="toast" class="toast"></div>

<script>
const toast = document.getElementById('toast');
let toastTimer = null;
function showToast(msg) {
  toast.textContent = msg;
  toast.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 1700);
}

document.getElementById('qform').addEventListener('submit', async (e) => {
  e.preventDefault();
  const ta = document.getElementById('qtext');
  const btn = document.getElementById('qbtn');
  const text = ta.value.trim();
  if (!text) return;
  btn.disabled = true;
  const fd = new FormData();
  fd.append('text', text);
  try {
    const r = await fetch('/audience/question', { method: 'POST', body: fd });
    if (!r.ok) throw new Error();
    ta.value = '';
    showToast('Question sent');
  } catch {
    showToast('Failed to send');
  } finally {
    btn.disabled = false;
  }
});

document.querySelectorAll('button.signal').forEach(btn => {
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    const fd = new FormData();
    fd.append('signal', btn.dataset.signal);
    try {
      const r = await fetch('/audience/signal', { method: 'POST', body: fd });
      if (!r.ok) throw new Error();
      showToast('Reaction sent');
    } catch {
      showToast('Failed to send');
    } finally {
      setTimeout(() => { btn.disabled = false; }, 400);
    }
  });
});
</script>
</body>
</html>
"""


@app.get("/audience", response_class=HTMLResponse)
def audience_page():
    return AUDIENCE_HTML
