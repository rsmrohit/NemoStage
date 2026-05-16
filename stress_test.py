"""Concurrent transcript stress test against the running nemostage server."""
import asyncio
import json
import time
import urllib.request
import urllib.error

BASE = "http://169.233.123.64:8000"

TRANSCRIPTS = [
    # current_slide territory
    "EEG stands for electroencephalogram, it records nerve signals from the brain using electrodes on the scalp",
    "High-frequency filters allow higher frequency waves to pass through while blocking lower ones",
    "We collected data from five participants over seven days in three mental states",
    "The brainwaves captured include alpha, beta, gamma, and theta waves from different brain regions",
    "Preprocessing steps include removing outliers and experimenting with machine learning models",
    # other_slide territory
    "The notch filter removes 60 hertz line frequency noise from the signal",
    "Using the FFT algorithm we extract features from different EEG channels",
    "During the focused state we observe much higher frequencies than in the unfocused state",
    "The band-pass filter includes a range of frequencies while band-stop excludes them",
    "The 10-20 system defines standard electrode placement positions on the scalp",
    # not_covered territory (should trigger generation)
    "FDA approval for clinical EEG devices typically takes two to three years",
    "Transfer learning from pre-trained models can dramatically reduce EEG training data requirements",
    "The cost of consumer EEG headsets ranges from one hundred to five hundred dollars",
    "Real-time BCI applications require latency under fifty milliseconds for effective control",
    "HIPAA compliance is essential when storing patient EEG data in cloud environments",
]

PRESENTATION_ID = "stress-test-001"


def post_json(path: str, body: dict, timeout: int = 5) -> dict:
    data = json.dumps(body).encode()
    req = urllib.request.Request(
        f"{BASE}{path}",
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read())


def get_json(path: str, timeout: int = 5) -> dict:
    with urllib.request.urlopen(f"{BASE}{path}", timeout=timeout) as resp:
        return json.loads(resp.read())


async def send_transcript(session: asyncio.Semaphore, idx: int, transcript: str) -> dict:
    async with session:
        loop = asyncio.get_event_loop()
        t0 = time.time()
        try:
            result = await loop.run_in_executor(
                None,
                lambda: post_json(
                    "/presentation/transcript",
                    {"presentation_id": PRESENTATION_ID, "transcript": transcript},
                    timeout=60,
                ),
            )
            elapsed = time.time() - t0
            coverage = result.get("coverage_status", "?")
            gen = result.get("generation_queued", False)
            return {"idx": idx, "elapsed": elapsed, "coverage": coverage, "gen_queued": gen, "ok": True}
        except Exception as e:
            elapsed = time.time() - t0
            return {"idx": idx, "elapsed": elapsed, "error": str(e)[:80], "ok": False}


async def main():
    # Step 1: check server
    try:
        s = get_json("/status")
        print(f"Server OK — container: {s.get('container','?')}")
    except Exception as e:
        print(f"Server unreachable: {e}")
        return

    # Step 2: find an existing presentation session or start one
    try:
        presentations = get_json("/presentations")
        pptx_list = presentations.get("presentations", [])
        if not pptx_list:
            print("No presentations in sandbox — upload a pptx first")
            return
        filename = pptx_list[0]["filename"]
        print(f"Using presentation: {filename}")
    except Exception as e:
        print(f"Could not list presentations: {e}")
        return

    # Step 3: start session
    try:
        start = post_json("/presentation/start", {
            "session_id": PRESENTATION_ID,
            "file_name": filename,
            "slide_count": 18,
            "current_slide": 4,
            "slides": [],
        })
        print(f"Session started — vectorization: {start.get('vectorization_status')} "
              f"({start.get('chunks_indexed')} chunks)")
    except Exception as e:
        print(f"Failed to start session: {e}")
        return

    # Step 4: fire all transcripts concurrently (max 15 in-flight at once)
    print(f"\nFiring {len(TRANSCRIPTS)} concurrent transcript requests...\n")
    sem = asyncio.Semaphore(15)
    t_start = time.time()
    tasks = [
        send_transcript(sem, i, t)
        for i, t in enumerate(TRANSCRIPTS)
    ]
    results = await asyncio.gather(*tasks)
    total_elapsed = time.time() - t_start

    # Step 5: print results
    ok = [r for r in results if r.get("ok")]
    fail = [r for r in results if not r.get("ok")]

    print(f"{'#':<4} {'coverage':<16} {'time':>6}  {'gen?':<6}  transcript[:60]")
    print("-" * 80)
    for r in sorted(results, key=lambda x: x["idx"]):
        t = TRANSCRIPTS[r["idx"]][:60]
        if r.get("ok"):
            gen = "YES" if r.get("gen_queued") else "-"
            print(f"{r['idx']:<4} {r['coverage']:<16} {r['elapsed']:>5.1f}s  {gen:<6}  {t}")
        else:
            print(f"{r['idx']:<4} {'ERROR':<16} {r['elapsed']:>5.1f}s  -       {r.get('error','?')}")

    print(f"\n{'='*80}")
    print(f"Total wall time:  {total_elapsed:.1f}s")
    print(f"Requests OK:      {len(ok)}/{len(results)}")
    if ok:
        latencies = [r["elapsed"] for r in ok]
        print(f"Latency avg:      {sum(latencies)/len(latencies):.1f}s")
        print(f"Latency p50:      {sorted(latencies)[len(latencies)//2]:.1f}s")
        print(f"Latency p90:      {sorted(latencies)[int(len(latencies)*0.9)]:.1f}s")
        print(f"Latency max:      {max(latencies):.1f}s")
        gen_count = sum(1 for r in ok if r.get("gen_queued"))
        print(f"Slides queued:    {gen_count}")
    if fail:
        print(f"\nFailed: {[r.get('error') for r in fail]}")

    # Step 6: wait a moment then check generated slides
    if any(r.get("gen_queued") for r in ok):
        print("\nWaiting 15s for background slide generation...")
        await asyncio.sleep(15)
        try:
            slides_resp = get_json(f"/presentation/{PRESENTATION_ID}/generated-slides")
            slides = slides_resp.get("slides", [])
            print(f"Generated slides: {len(slides)}")
            for s in slides:
                print(f"  [{s.get('template_id','?')}] \"{s.get('title','?')}\" — topic: {s.get('topic','?')}")
        except Exception as e:
            print(f"Could not fetch slides: {e}")


if __name__ == "__main__":
    asyncio.run(main())
