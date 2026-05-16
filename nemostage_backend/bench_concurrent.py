#!/usr/bin/env python3
"""
5-concurrent gemma4:26b inference benchmark.
Run directly on the DGX: python3 /home/asus/bench_concurrent.py
Results written to /home/asus/bench_results.txt
"""
import concurrent.futures
import json
import os
import subprocess
import time
import uuid

GW = "ws://127.0.0.1:18790"
TOKEN = "3f34f9ef7832494ab392baedf419b9515a1b9da0dbb429f6"
BIN = "/home/asus/.npm-global/bin/openclaw"
PROMPT = "List exactly 3 facts about the ocean. Be concise."
RESULTS_FILE = "/home/asus/bench_results.txt"
N_WORKERS = 3
TIMEOUT = 600  # 10 min — generous for 5x parallel load


def agent_call(worker_id: int) -> dict:
    sid = str(uuid.uuid4())
    env = os.environ.copy()
    env["OPENCLAW_GATEWAY_URL"] = GW
    env["OPENCLAW_GATEWAY_TOKEN"] = TOKEN

    t0 = time.time()
    try:
        result = subprocess.run(
            [BIN, "agent", "--agent", "main", "--session-id", sid,
             "--message", PROMPT, "--json"],
            capture_output=True, text=True, env=env, timeout=TIMEOUT
        )
        elapsed = time.time() - t0

        # Parse response text out of JSON output
        reply = ""
        for line in result.stdout.splitlines():
            line = line.strip()
            if line.startswith("{"):
                try:
                    data = json.loads(line)
                    payloads = data.get("result", {}).get("payloads", [])
                    if payloads:
                        reply = payloads[0].get("text", "")
                        break
                except json.JSONDecodeError:
                    pass
        if not reply:
            try:
                data = json.loads(result.stdout)
                payloads = data.get("result", {}).get("payloads", [])
                if payloads:
                    reply = payloads[0].get("text", "")
            except Exception:
                pass

        return {
            "worker": worker_id,
            "session_id": sid,
            "duration": round(elapsed, 1),
            "reply": reply[:200] if reply else f"[empty — stderr: {result.stderr[:200]}]",
            "returncode": result.returncode,
        }
    except subprocess.TimeoutExpired:
        return {
            "worker": worker_id,
            "session_id": sid,
            "duration": round(time.time() - t0, 1),
            "reply": "[TIMEOUT]",
            "returncode": -1,
        }
    except Exception as e:
        return {
            "worker": worker_id,
            "session_id": sid,
            "duration": round(time.time() - t0, 1),
            "reply": f"[ERROR: {e}]",
            "returncode": -2,
        }


def main():
    print(f"Firing {N_WORKERS} concurrent agent calls...", flush=True)
    wall_start = time.time()

    with concurrent.futures.ThreadPoolExecutor(max_workers=N_WORKERS) as ex:
        futures = {ex.submit(agent_call, i + 1): i + 1 for i in range(N_WORKERS)}
        results = []
        for fut in concurrent.futures.as_completed(futures):
            results.append(fut.result())

    wall_time = round(time.time() - wall_start, 1)
    results.sort(key=lambda r: r["worker"])

    lines = []
    lines.append(f"=== gemma4:26b  {N_WORKERS}x concurrent benchmark ===\n")
    lines.append(f"{'Worker':<8} {'Duration':>10}  {'Response preview'}")
    lines.append("-" * 70)
    for r in results:
        preview = r["reply"].replace("\n", " ")[:55]
        lines.append(f"{r['worker']:<8} {r['duration']:>9.1f}s  {preview}")
    lines.append("-" * 70)
    lines.append(f"Total wall time: {wall_time}s")
    lines.append("")
    lines.append("Full responses:")
    for r in results:
        lines.append(f"\n--- Worker {r['worker']} ({r['duration']}s) ---")
        lines.append(r["reply"])

    output = "\n".join(lines)
    print(output, flush=True)
    with open(RESULTS_FILE, "w") as f:
        f.write(output + "\n")
    print(f"\nResults saved to {RESULTS_FILE}", flush=True)


if __name__ == "__main__":
    main()
