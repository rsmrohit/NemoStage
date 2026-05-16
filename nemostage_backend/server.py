import subprocess
import tempfile
import os
import json
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.responses import JSONResponse

app = FastAPI()

SANDBOX_DEST = "/sandbox/uploads"
OPENCLAW_GATEWAY_URL = "ws://127.0.0.1:18790"
OPENCLAW_GATEWAY_TOKEN = "3f34f9ef7832494ab392baedf419b9515a1b9da0dbb429f6"
OPENCLAW_BIN = "/home/asus/.npm-global/bin/openclaw"


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
