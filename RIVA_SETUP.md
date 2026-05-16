# Riva Transcription Pipeline Setup

## Architecture Overview

```
Browser (HTML/WebSocket)
    ↓ (audio chunks via WebSocket)
Backend FastAPI Server (Python)
    ↓ (gRPC to Riva ASR)
Riva ASR Server (GPU)
    ↓ (transcripts)
Backend
    ├→ Send transcript back to browser
    ├→ Save to JSON file
    └→ Forward to external service/app
```

## Prerequisites

- **DGX Spark** with:
  - NVIDIA NGC access
  - Riva server deployed and running on port 50051
  - GPU support

- **Python 3.10+** on DGX with:
  - `fastapi`, `uvicorn`, `websockets` (already in requirements.txt)
  - `riva` or `nvidia-riva-client` (already installed)
  - `numpy` (already in requirements.txt)

## Deployment Steps

### 1. Setup Riva Server on DGX

Follow the [Riva Quick Start](https://docs.nvidia.com/deeplearning/riva/user-guide/docs/quick-start-guide.html):

```bash
# Download Riva Quick Start (on DGX)
# From NGC: https://catalog.ngc.nvidia.com/orgs/nvidia/teams/riva/resources/riva_quickstart

cd riva_quickstart_v2.19.0

# Edit config.sh if needed (choose models, GPU, etc.)
# nano config.sh

# Initialize (downloads ~15-30GB of models)
bash riva_init.sh

# Start the Riva server
bash riva_start.sh

# Verify it's running:
# curl http://localhost:50051 should not error
# or test with:
# bash riva_start_client.sh
# riva_streaming_asr_client --audio_file=/opt/riva/wav/en-US_sample.wav
```

### 2. Deploy Backend on DGX

```bash
cd /path/to/NemoStage/backend/transcript

# Install dependencies (if not already done)
python -m pip install -r /path/to/NemoStage/requirements.txt

# Run the server
python main.py

# Or with custom host/port:
# RIVA_SERVER_HOST=dgx-internal python main.py
```

The backend will start on `http://0.0.0.0:8000`

### 3. Deploy Frontend

**Option A: Serve via FastAPI**

Add to your `main.py` or create a separate endpoint:

```python
from fastapi.staticfiles import StaticFiles

app.mount("/static", StaticFiles(directory="../../frontend"), name="static")

@app.get("/")
def root():
    with open("../../frontend/transcription_client.html") as f:
        return f.read()
```

Then access: `http://dgx-ip:8000/`

**Option B: Standalone HTML file**

Simply open `frontend/transcription_client.html` in a browser, and update the server URL to match your DGX:

```javascript
// In the HTML, change:
value="ws://localhost:8000/ws/transcribe"
// to:
value="ws://dgx-ip:8000/ws/transcribe"
```

**Option C: Embed in Electron App**

Copy `transcription_client.html` into your Electron `renderer/src/components/` and load it in a window.

### 4. Test the Pipeline

1. Open the web interface
2. Click **Start Recording**
3. Speak into your microphone
4. Watch real-time transcript appear
5. Click **Stop Recording**

Check the backend console for confirmation and look for JSON files in:
```
backend/transcript/transcripts/transcript_*.json
```

## Output Format

### JSON File Output

Each transcript is saved in JSONL format (one JSON object per line):

```json
{"type": "interim", "text": "Hello w", "full_transcript": "", "timestamp": "2026-05-15T10:30:45.123456"}
{"type": "final", "text": "Hello world", "full_transcript": "Hello world", "timestamp": "2026-05-15T10:30:46.456789"}
{"type": "interim", "text": "How are", "full_transcript": "Hello world", "timestamp": "2026-05-15T10:30:47.789012"}
{"type": "final", "text": "How are you?", "full_transcript": "Hello world How are you?", "timestamp": "2026-05-15T10:30:48.012345"}
```

### WebSocket Message Format

**Client → Server (audio):**
```json
{
  "type": "audio",
  "data": "base64-encoded PCM data",
  "format": "base64"
}
```

**Server → Client (transcript):**
```json
{
  "type": "interim|final|error",
  "text": "transcribed text",
  "full_transcript": "cumulative transcript",
  "timestamp": "2026-05-15T10:30:45.123456"
}
```

## Connecting to External Service

To forward transcripts to another application (e.g., a database, another WebSocket, HTTP endpoint):

### Example: Send to External HTTP API

In `main.py`, uncomment and implement the TODO:

```python
async def forward_to_external_service(transcript):
    """Send transcript to external service."""
    async with aiohttp.ClientSession() as session:
        async with session.post(
            "http://external-service:port/api/transcript",
            json=transcript
        ) as resp:
            if resp.status != 200:
                logger.error(f"External service error: {await resp.text()}")

# Then in save_transcript_to_json:
save_transcript_to_json(transcript, session_id)
await forward_to_external_service(transcript)  # Add this line
```

### Example: Send to External WebSocket

```python
async def forward_to_websocket(transcript):
    """Send transcript to another WebSocket service."""
    try:
        async with aiohttp.ClientSession() as session:
            async with session.ws_connect("ws://external-service:port/ws") as ws:
                await ws.send_json(transcript)
    except Exception as e:
        logger.error(f"Failed to forward to external WebSocket: {e}")
```

## Configuration

Edit these in `main.py`:

```python
RIVA_SERVER_HOST = "localhost"        # Change if Riva is on different host
RIVA_SERVER_PORT = 50051              # Riva gRPC port
AUDIO_SAMPLE_RATE = 16000             # Must be 16 kHz for Riva
OUTPUT_JSON_DIR = Path("./transcripts")  # Where to save JSON files
```

## Troubleshooting

### "Failed to connect to Riva server"

- Verify Riva is running: `docker ps | grep riva`
- Check firewall: Riva uses port 50051 (gRPC)
- Verify network connectivity: `curl http://riva-host:50051`

### WebSocket connection refused

- Ensure backend is running: `ps aux | grep uvicorn`
- Check CORS settings if frontend is on different domain
- Verify firewall allows port 8000

### Audio not transcribing

- Check sample rate in browser (should be 16000 Hz)
- Verify audio is being sent (check browser console for errors)
- Look at backend logs for gRPC errors
- Ensure microphone permissions are granted

### "Package protobuf incompatibility"

This is a known issue with conflicting dependencies. The server will still work.

## Next Steps

1. ✅ Deploy Riva server on DGX
2. ✅ Start backend (main.py)
3. ✅ Test with frontend HTML
4. 📝 Customize JSON output structure if needed
5. 🔗 Integrate with your "different application"
6. 🔐 Add authentication/authorization
7. 🚀 Deploy to production (add HTTPS, proper CORS, etc.)

## Performance Notes

- Streaming transcription is real-time with ~100-200ms latency
- Each session creates a separate Riva connection; consider connection pooling for scale
- Audio is buffer at 4096 samples (~250ms chunks at 16 kHz)
- JSON files grow with each session; consider archiving old ones

## References

- [Riva Docs](https://docs.nvidia.com/deeplearning/riva/user-guide/docs/index.html)
- [Riva Python Client](https://docs.nvidia.com/deeplearning/riva/user-guide/docs/apis/development-python.html)
- [FastAPI WebSocket](https://fastapi.tiangolo.com/advanced/websockets/)
- [Web Audio API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API)
