# NemoStage

Desktop/control-plane UI for NemoClaw. Electron/React frontend on laptops, FastAPI backend on the ASUS DGX Spark.

## Project structure

```
NemoStage/             # Electron app (electron-vite + React + TypeScript)
nemostage_backend/     # FastAPI backend — edit locally, deploy to DGX via SFTP
  server.py            # deploys to /home/asus/nemostage-server.py on DGX
```

## DGX Spark

| | |
|---|---|
| Host | `gx10-d8fb` |
| ucscguest IP | `169.233.123.64` |
| Tailscale IP | `100.127.111.122` |
| User / sudo pw | `asus` / `password` |

## SSH from Claude Code (paramiko)

No interactive TTY — use paramiko. Always decode as ASCII to avoid cp1252 errors on Windows:

```python
import paramiko
client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect('gx10-d8fb', username='asus', password='password', timeout=15)

def run(cmd, timeout=30):
    stdin, stdout, stderr = client.exec_command(cmd, timeout=timeout)
    stdout.channel.settimeout(timeout)
    return (stdout.read() + stderr.read()).decode('utf-8', errors='replace').encode('ascii', errors='replace').decode('ascii')
```

**SFTP deploy pattern** (always use this to push server changes):
```python
with open(r'C:\Users\rachi\Projects\NemoStage\nemostage_backend\server.py') as f:
    content = f.read()
sftp = client.open_sftp()
with sftp.open('/home/asus/nemostage-server.py', 'w') as f:
    f.write(content)
sftp.close()
run("sudo -S systemctl restart nemostage <<< 'password'")
```

## NemoStage FastAPI server

- **Port:** `8000` on `0.0.0.0` — accessible to all ucscguest devices
- **Venv:** `/home/asus/nemostage-venv/`
- **Systemd service:** `nemostage` (auto-starts on boot)

```bash
sudo systemctl status nemostage
sudo systemctl restart nemostage
journalctl -u nemostage -f
source /home/asus/nemostage-venv/bin/activate && cd /home/asus && uvicorn nemostage-server:app --host 0.0.0.0 --port 8000
```

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/status` | Health check |
| POST | `/uploadpptx` | Upload `.pptx` → sandbox → agent summary |

Upload example: `curl -X POST http://169.233.123.64:8000/uploadpptx -F "file=@deck.pptx"`

## Triggering the NemoClaw agent

Two gateways exist on the DGX — **do not confuse them:**
- Port `8080` — OpenShell gateway (TUI only, not for agent turns)
- Port `18790` — **sandbox OpenClaw gateway** (SSH-tunneled from inside the container) ✓

**Sandbox gateway credentials:**
- URL: `ws://127.0.0.1:18790`
- Token: `3f34f9ef7832494ab392baedf419b9515a1b9da0dbb429f6`
- openclaw binary: `/home/asus/.npm-global/bin/openclaw`

**Call pattern (from server.py subprocess):**
```python
import subprocess, os, json

env = os.environ.copy()
env["OPENCLAW_GATEWAY_URL"] = "ws://127.0.0.1:18790"
env["OPENCLAW_GATEWAY_TOKEN"] = "3f34f9ef7832494ab392baedf419b9515a1b9da0dbb429f6"

result = subprocess.run(
    ["/home/asus/.npm-global/bin/openclaw", "agent", "--agent", "main", "--message", prompt, "--json"],
    capture_output=True, text=True, env=env, timeout=300
)
data = json.loads(result.stdout)
reply = data["result"]["payloads"][0]["text"]
```

Notes:
- `openclaw agent` inside the container fails (npm ENOTCACHED). Always run it on the host.
- The host openclaw binary must NOT use its own gateway (port 18789/vllm). Override with env vars.
- First response after cold start can take 30s+. Expect 30–90s per agent call.

## Nemostage sandbox

- **Container pattern:** `openshell-nemostage-*`
- **Agent home / uploads:** `/sandbox/` and `/sandbox/uploads/`
- **Model:** `qwen3.6:35b` via Ollama (`inference.local` inside container)

```bash
nemoclaw nemostage connect                          # interactive shell into sandbox
docker ps --filter name=openshell-nemostage         # find container name
CONTAINER=$(docker ps --filter name=openshell-nemostage --format '{{.Names}}' | head -1)
docker cp file.pptx $CONTAINER:/sandbox/uploads/file.pptx
docker exec $CONTAINER chown sandbox:sandbox /sandbox/uploads/file.pptx
```

## Dashboard tunnel (from laptop)

```bash
ssh -N -L 18790:127.0.0.1:18790 -L 8080:127.0.0.1:8080 asus@gx10-d8fb
# open http://127.0.0.1:18790
```
