import json, time, urllib.request, re

MODELS = [
    ("nemotron-3-nano:4b", "http://127.0.0.1:11434"),
    ("gemma4:26b",         "http://127.0.0.1:11436"),
]

# Style spec from a real EEG presentation deck
STYLE_SPEC = {
    "bg_color": "#1a1a2e",
    "accent_color": "#4f8ef7",
    "font_family": "Calibri",
}

# Templates extracted from pres2 (EEG deck) - simplified
TEMPLATE_CHOICES = [
    {
        "id": "tmpl_title",
        "description": "Title slide with large header and subtitle area",
        "source_slide_number": 1,
        "image_count": 0,
        "bg_color": "#1a1a2e",
        "colors": ["#ffffff", "#4f8ef7"],
        "text_boxes": [
            {"id": "tb_title", "role": "title", "x": 0.1, "y": 0.3, "w": 0.8, "h": 0.2, "font_size": 36, "align": "center"},
            {"id": "tb_subtitle", "role": "subtitle", "x": 0.1, "y": 0.55, "w": 0.8, "h": 0.15, "font_size": 20, "align": "center"},
        ],
    },
    {
        "id": "tmpl_content",
        "description": "Content slide with title and bullet points body",
        "source_slide_number": 3,
        "image_count": 0,
        "bg_color": "#1a1a2e",
        "colors": ["#ffffff", "#4f8ef7", "#2a2a4e"],
        "text_boxes": [
            {"id": "tb_heading", "role": "title", "x": 0.05, "y": 0.05, "w": 0.9, "h": 0.15, "font_size": 28, "align": "left"},
            {"id": "tb_body", "role": "body", "x": 0.05, "y": 0.22, "w": 0.9, "h": 0.65, "font_size": 18, "align": "left"},
        ],
    },
    {
        "id": "tmpl_two_col",
        "description": "Two-column layout with title, left and right content areas",
        "source_slide_number": 7,
        "image_count": 0,
        "bg_color": "#1a1a2e",
        "colors": ["#ffffff", "#4f8ef7"],
        "text_boxes": [
            {"id": "tb_top", "role": "title", "x": 0.05, "y": 0.05, "w": 0.9, "h": 0.12, "font_size": 26, "align": "center"},
            {"id": "tb_left", "role": "body", "x": 0.05, "y": 0.2, "w": 0.43, "h": 0.65, "font_size": 16, "align": "left"},
            {"id": "tb_right", "role": "body", "x": 0.52, "y": 0.2, "w": 0.43, "h": 0.65, "font_size": 16, "align": "left"},
        ],
    },
]

VECTOR_CONTEXT = """\
slide_index=2, title: WHAT IS EEG?
EEG or electroencephalogram is a method used to record nerve signals coming from the brain. Electrodes placed on the scalp.

slide_index=8, title: Noise
Types of noise: movement/blinking of eyes. Biopotentials. Wavelet transform, notch filter and bandstop filter for noise removal.

slide_index=16, title: Preprocessing the Data
THE FFT ALGORITHM. Collecting EEG Brain Signals. Feature extraction from channels."""

GENERATION_PROMPT_TEMPLATE = """\
You are generating a supplemental slide for a live presentation. \
The speaker just covered a topic not in their deck. \
Create a slide that matches the deck style and depth.

Topic not covered: {topic}

Relevant slide context from the deck:
{vector_context}

Deck style spec: bg_color={bg_color}, accent_color={accent_color}, font_family={font_family}

Clean slide templates extracted from the user's deck. Choose the template whose layout best fits the topic:
{templates}

Return EXACTLY one JSON object:
{{"template_id": "<one template id or null>", "title": "<5-8 word title>", \
"text_boxes": [{{"id": "<box id>", "text": "<text for that box>"}}], \
"bullets": ["<fallback point 1>", "<fallback point 2>", "<fallback point 3>"], \
"notes": "<1-2 sentence speaker notes>", \
"style_hint": {{"bg": "<hex>", "accent": "<hex>", "font": "<family>"}}}}
Use concise slide text. Fill every useful content box. Return only the JSON. No markdown, no explanation."""

GENERATION_TOPICS = [
    ("EEG clinical applications in epilepsy diagnosis", 8),
    ("Ethics of brain-computer interface data privacy", 2),
    ("Cost comparison of consumer vs clinical EEG devices", 4),
]


def call_ollama(model, base_url, prompt, timeout=120):
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
    return result["choices"][0]["message"]["content"], elapsed


def parse_json(text):
    text = text.strip()
    m = re.search(r'\{.*\}', text, re.DOTALL)
    if m:
        try:
            return json.loads(m.group(0))
        except Exception:
            pass
    # strip markdown fences
    text = re.sub(r'```json\s*', '', text)
    text = re.sub(r'```\s*', '', text)
    try:
        return json.loads(text)
    except Exception:
        return {}


def score_generation(parsed, topic):
    """Score quality of a generated slide 0-4."""
    score = 0
    if parsed.get("title") and 3 <= len(parsed["title"].split()) <= 12:
        score += 1
    if parsed.get("template_id"):
        score += 1
    boxes = parsed.get("text_boxes", [])
    if isinstance(boxes, list) and len(boxes) >= 1 and all("id" in b and "text" in b for b in boxes):
        score += 1
    bullets = parsed.get("bullets", [])
    if isinstance(bullets, list) and len(bullets) >= 2:
        score += 1
    return score


results = {}
for model_name, base_url in MODELS:
    print(f"\n{'='*60}", flush=True)
    print(f"MODEL: {model_name} — GENERATION BENCHMARK", flush=True)
    print(f"{'='*60}", flush=True)

    latencies = []
    quality_scores = []

    for topic, current_slide in GENERATION_TOPICS:
        prompt = GENERATION_PROMPT_TEMPLATE.format(
            topic=topic,
            vector_context=VECTOR_CONTEXT,
            bg_color=STYLE_SPEC["bg_color"],
            accent_color=STYLE_SPEC["accent_color"],
            font_family=STYLE_SPEC["font_family"],
            templates=json.dumps(TEMPLATE_CHOICES, indent=2),
        )

        try:
            reply, elapsed = call_ollama(model_name, base_url, prompt)
            parsed = parse_json(reply)
            score = score_generation(parsed, topic)
            latencies.append(elapsed)
            quality_scores.append(score)

            title = parsed.get("title", "[no title]")
            tmpl = parsed.get("template_id", "null")
            n_boxes = len(parsed.get("text_boxes", []))
            n_bullets = len(parsed.get("bullets", []))
            print(f"\n  Topic: {topic}", flush=True)
            print(f"  Time: {elapsed:.1f}s  Quality: {score}/4", flush=True)
            print(f"  Title: {title}", flush=True)
            print(f"  Template: {tmpl}  text_boxes: {n_boxes}  bullets: {n_bullets}", flush=True)
            if n_boxes > 0:
                for box in parsed["text_boxes"][:2]:
                    print(f"    [{box['id']}] {str(box.get('text',''))[:80]}", flush=True)
        except Exception as e:
            print(f"  [ERROR] {e}", flush=True)
            latencies.append(None)
            quality_scores.append(0)

    valid = [l for l in latencies if l is not None]
    avg_lat = sum(valid) / len(valid) if valid else 0
    avg_q = sum(quality_scores) / len(quality_scores) if quality_scores else 0
    results[model_name] = {"avg_latency": avg_lat, "avg_quality": avg_q, "latencies": valid}

    print(f"\n  GENERATION LATENCY: avg={avg_lat:.1f}s", flush=True)
    print(f"  AVG QUALITY SCORE: {avg_q:.1f}/4", flush=True)

print(f"\n{'='*60}")
print("GENERATION SUMMARY")
print(f"{'='*60}")
for model, r in results.items():
    print(f"{model}:")
    print(f"  avg_latency={r['avg_latency']:.1f}s  avg_quality={r['avg_quality']:.1f}/4")
    print(f"  per-run latencies: {[f'{l:.1f}s' for l in r['latencies']]}")

if len(results) == 2:
    models = list(results.keys())
    m1, m2 = models[0], models[1]
    if results[m2]["avg_latency"] > 0:
        speedup = results[m2]["avg_latency"] / results[m1]["avg_latency"]
        print(f"\nSpeedup: {m1} is {speedup:.1f}x faster than {m2} for generation")
