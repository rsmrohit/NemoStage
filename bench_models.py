import json, time, urllib.request, sys

MODELS = [
    ("nemotron-3-nano:4b", "http://127.0.0.1:11434"),
    ("gemma4:26b",         "http://127.0.0.1:11436"),
]

# Ground-truth test cases derived from pres2 (EEG ML deck)
TEST_CASES = [
    # current_slide: transcript clearly matches the current slide
    (
        "So EEG stands for electroencephalogram, its a method to record nerve signals from the brain using electrodes on the scalp",
        2, "current_slide",
    ),
    (
        "The high-frequency filter lets higher frequency waves pass through while blocking lower frequencies",
        4, "current_slide",
    ),
    (
        "We collected data from five participants over seven days, recording three mental states: focused, unfocused, and drowsed",
        10, "current_slide",
    ),
    (
        "The brainwaves captured by EEG electrodes include alpha, beta, gamma, and theta waves from different brain regions",
        3, "current_slide",
    ),
    (
        "Preprocessing steps include removing outliers, experimenting with different machine learning models",
        17, "current_slide",
    ),
    # other_slide: transcript is in the deck but not on the current slide
    (
        "EEG uses electrodes on the scalp to capture electrical activity from the brain",
        4, "other_slide",
    ),
    (
        "The notch filter removes line frequency noise, its a special type of band-stop filter",
        10, "other_slide",
    ),
    (
        "We used the FFT algorithm and preprocessing steps to extract features from the different channels",
        3, "other_slide",
    ),
    (
        "The focused state shows much higher frequencies than both the unfocused and drowsed states",
        4, "other_slide",
    ),
    # not_covered: content genuinely not in the deck
    (
        "Lets talk about the ethical implications of using EEG data for commercial brain-computer interfaces",
        2, "not_covered",
    ),
    (
        "The cost of clinical EEG equipment ranges from ten to fifty thousand dollars",
        4, "not_covered",
    ),
    (
        "Deep learning transformers like BERT have been applied to EEG classification tasks recently",
        8, "not_covered",
    ),
    (
        "FDA approval process for medical EEG devices typically takes two to three years",
        6, "not_covered",
    ),
]

SLIDE_CONTEXTS = {
    0:  "slide_index=0, title: EEG Signal Analysis\nEEG Signal Analysis - Using Machine Learning to Streamline EEG Readings. Authors: Rohit M, Aaryaansh G, Sanjana.",
    1:  "slide_index=1, title: TABLE OF CONTENTS\nRemoving noise and unwanted signals. Conclusion. Moving forward employing the use of ML.",
    2:  "slide_index=2, title: WHAT IS EEG?\nEEG or electroencephalogram is a method used to record nerve signals coming from the brain. Electrodes placed on the scalp detect electrical signals.",
    3:  "slide_index=3, title: MEET THE BRAINWAVES\nElectrodes capture electrical activity. Brainwaves: alpha, beta, gamma, theta, delta from frontal, occipital, temporal, parietal lobes.",
    4:  "slide_index=4, title: FILTERS\nHigh-frequency filter allows higher frequency waves to pass through, filters out lower frequencies. Low frequency filter.",
    5:  "slide_index=5, title: FILTERS\nBand-pass filter includes a range of frequencies. Band-stop filter excludes a range of frequencies.",
    6:  "slide_index=6, title: SPECIAL FILTERS\nNotch filter is a special type of band-stop filter used to remove line frequency noise (60Hz).",
    7:  "slide_index=7, title: Channels\nFrontal Lobe - Gamma Wave. Occipital Lobe. Temporal Lobe. Parietal Lobe - Beta Wave, Alpha Wave collection.",
    8:  "slide_index=8, title: Noise\nTypes of noise: movement/blinking of eyes. Sources: biopotentials. Wavelet transform, notch filter and bandstop filter for noise removal.",
    9:  "slide_index=9, title: 10-20 System\nInternational 10-20 system for EEG electrode placement.",
    10: "slide_index=10, title: EXPERIMENTATION DATA\n5 people, 7 days, 3 states: unfocused 10 min, focused 10 min, drowsed 20 min.",
    11: "slide_index=11, title: Frequency observations\nDuring focused state much higher frequencies than unfocused and drowsed. Drowsed state exhibits lowest frequencies.",
    12: "slide_index=12, title: PIC results\nOriginal data, unexpected result using HFF of 10Hz, truncated data, data using different filter settings.",
    13: "slide_index=13, title: PIC LFF results\nOriginal data, unexpected result using LFF of 0.0001, truncated data.",
    14: "slide_index=14, title: BANDPASS & GAUSSIAN\nBandpass and Gaussian filter results.",
    15: "slide_index=15, title: SEARCHING FOR FEATURES\nTo extract features from different channels, need to ensure signals are properly preprocessed.",
    16: "slide_index=16, title: Preprocessing the Data\nTHE FFT ALGORITHM. Collecting EEG Brain Signals. Feature extraction from channels.",
    17: "slide_index=17, title: More preprocessing\nRemoving outliers in the data. Experimenting with different machine learning models. What is next? Thank you.",
}

CLASSIFICATION_PROMPT_TEMPLATE = """\
You are tracking a live presentation. Classify the speaker transcript into exactly one coverage_status:
- current_slide: covered by the current slide
- other_slide: not on current slide but covered by another retrieved deck slide
- not_covered: not covered by any retrieved deck slide

Current slide_index: {current_slide}

Vector-retrieved slide context:
{vector_context}

Transcript chunk:
{transcript}

Return EXACTLY one JSON object:
{{"coverage_status": "current_slide|other_slide|not_covered", "matched_slide": <int|null>, "topic": "<str|null>", "reason": "<str>"}}
"""


def call_ollama(model, base_url, prompt, timeout=90):
    payload = json.dumps({
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "stream": False,
    }).encode()
    req = urllib.request.Request(
        f"{base_url}/v1/chat/completions",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        result = json.loads(resp.read())
    elapsed = time.time() - t0
    text = result["choices"][0]["message"]["content"]
    return text, elapsed


def parse_json(text):
    import re
    text = text.strip()
    m = re.search(r'\{.*\}', text, re.DOTALL)
    if m:
        try:
            return json.loads(m.group(0))
        except Exception:
            pass
    return {}


def build_vector_context(current_slide):
    # Return all slide context (mirrors real production behavior)
    return "\n\n".join(SLIDE_CONTEXTS[k] for k in sorted(SLIDE_CONTEXTS.keys()))


results = {}
for model_name, base_url in MODELS:
    print(f"\n{'='*60}", flush=True)
    print(f"MODEL: {model_name}", flush=True)
    print(f"{'='*60}", flush=True)

    correct = 0
    total = len(TEST_CASES)
    latencies = []
    label_stats = {"current_slide": [0, 0], "other_slide": [0, 0], "not_covered": [0, 0]}

    for transcript, current_slide, expected in TEST_CASES:
        vector_context = build_vector_context(current_slide)
        prompt = CLASSIFICATION_PROMPT_TEMPLATE.format(
            current_slide=current_slide,
            vector_context=vector_context,
            transcript=transcript,
        )

        try:
            reply, elapsed = call_ollama(model_name, base_url, prompt)
            parsed = parse_json(reply)
            got = parsed.get("coverage_status", "PARSE_ERROR")
            hit = got == expected
            correct += int(hit)
            latencies.append(elapsed)
            label_stats[expected][1] += 1
            if hit:
                label_stats[expected][0] += 1

            status = "OK   " if hit else "WRONG"
            print(f"  [{status}] slide={current_slide:2d} expected={expected:<14s} got={got:<14s} ({elapsed:.1f}s)", flush=True)
            if not hit:
                print(f"          reason: {parsed.get('reason', '')[:100]}", flush=True)
        except Exception as e:
            print(f"  [ERROR] {e}", flush=True)
            latencies.append(None)

    valid = [l for l in latencies if l is not None]
    avg_lat = sum(valid) / len(valid) if valid else 0
    p50 = sorted(valid)[len(valid) // 2] if valid else 0
    p90 = sorted(valid)[int(len(valid) * 0.9)] if valid else 0

    results[model_name] = {
        "correct": correct, "total": total,
        "avg_latency": avg_lat, "p50": p50, "p90": p90,
        "label_stats": label_stats,
    }
    print(f"\n  ACCURACY: {correct}/{total} ({100 * correct / total:.0f}%)", flush=True)
    print(f"  LATENCY: avg={avg_lat:.1f}s  p50={p50:.1f}s  p90={p90:.1f}s", flush=True)
    for label, (c, t) in label_stats.items():
        print(f"    {label}: {c}/{t}", flush=True)

print(f"\n{'='*60}")
print("FINAL SUMMARY")
print(f"{'='*60}")
for model, r in results.items():
    speedup = ""
    print(f"{model}:")
    print(f"  accuracy={r['correct']}/{r['total']} ({100*r['correct']/r['total']:.0f}%)")
    print(f"  avg={r['avg_latency']:.1f}s  p50={r['p50']:.1f}s  p90={r['p90']:.1f}s")

if len(results) == 2:
    models = list(results.keys())
    m1, m2 = models[0], models[1]
    if results[m2]["avg_latency"] > 0:
        speedup = results[m2]["avg_latency"] / results[m1]["avg_latency"]
        print(f"\n{m1} is {speedup:.1f}x faster than {m2}")
