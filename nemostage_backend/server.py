import asyncio
import json
import os
import subprocess
import tempfile
import time
from typing import Set

from fastapi import FastAPI, File, Form, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, JSONResponse

app = FastAPI()

SANDBOX_DEST = "/sandbox/uploads"
OPENCLAW_GATEWAY_URL = "ws://127.0.0.1:18790"
OPENCLAW_GATEWAY_TOKEN = "3f34f9ef7832494ab392baedf419b9515a1b9da0dbb429f6"
OPENCLAW_BIN = "/home/asus/.npm-global/bin/openclaw"

ALLOWED_SIGNALS = {"confused", "interested", "lost"}


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


def ask_agent(prompt: str, timeout: int = 300) -> str:
    env = os.environ.copy()
    env["OPENCLAW_GATEWAY_URL"] = OPENCLAW_GATEWAY_URL
    env["OPENCLAW_GATEWAY_TOKEN"] = OPENCLAW_GATEWAY_TOKEN

    result = subprocess.run(
        [OPENCLAW_BIN, "agent", "--agent", "main", "--message", prompt, "--json"],
        capture_output=True, text=True, env=env, timeout=timeout
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

    raise HTTPException(status_code=502, detail=f"Agent returned no parseable response: {result.stdout[:300]}")


@app.post("/uploadpptx")
async def upload_pptx(file: UploadFile = File(...)):
    if not file.filename.endswith(".pptx"):
        raise HTTPException(status_code=400, detail="Only .pptx files are accepted")

    container = get_nemostage_container()
    content = await file.read()

    with tempfile.NamedTemporaryFile(suffix=".pptx", delete=False) as tmp:
        tmp.write(content)
        tmp_path = tmp.name

    try:
        subprocess.run(
            ["docker", "exec", container, "mkdir", "-p", SANDBOX_DEST],
            check=True
        )
        dest = f"{SANDBOX_DEST}/{file.filename}"
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

    prompt = (
        f"A PowerPoint file was just uploaded to {dest} inside this sandbox. "
        f"Please read the file and give a concise summary of what it contains — "
        f"key topics, structure, and main points."
    )
    summary = ask_agent(prompt)

    return JSONResponse({
        "status": "ok",
        "filename": file.filename,
        "sandbox_path": dest,
        "container": container,
        "summary": summary,
    })


@app.get("/presentations")
def list_presentations():
    container = get_nemostage_container()
    result = subprocess.run(
        ["docker", "exec", container, "ls", "-lt", "--time-style=+%Y-%m-%dT%H:%M:%SZ", SANDBOX_DEST],
        capture_output=True, text=True
    )
    files = []
    for line in result.stdout.splitlines():
        parts = line.split()
        # ls -lt output: permissions links owner group size datetime name
        if len(parts) >= 7 and parts[-1].endswith(".pptx"):
            files.append({
                "filename": parts[-1],
                "size_bytes": int(parts[4]),
                "uploaded_at": parts[5],
                "sandbox_path": f"{SANDBOX_DEST}/{parts[-1]}",
            })
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
