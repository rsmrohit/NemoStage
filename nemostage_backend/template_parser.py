"""
Custom slide template loader for NemoStage.

Drop numbered PPTX files (1.pptx, 2.pptx, …) into slide_templates/.
Each PPTX should contain exactly one slide.

How to design a template slide
───────────────────────────────
• Text boxes – write a descriptive placeholder as the text content:
    "Project Title", "Key Takeaways", "Supporting Detail"
  The parser reads that text as the LLM hint for what belongs there.

• Image areas – insert any image (or a plain coloured rectangle) in
  the desired position. The parser records the bounding box and treats
  it as an image slot; the actual pixels are ignored.

• Chart slots – put a text box whose content starts with "Chart:":
    "Chart: bar chart comparing GPU speeds"
  The text after the colon becomes the chart description hint.

• Slide Notes – write the template description here. The LLM reads
  this to decide which template best fits the topic being generated.

Optional slide_templates/templates.json lets you override or supplement
individual descriptions without editing the PPTX:
    { "1": "Better description for template 1", "3": "..." }
JSON descriptions take priority over slide notes.
"""

import io
import json
import os
import re
import xml.etree.ElementTree as ET
import zipfile
from typing import Any

_NS = {
    "p": "http://schemas.openxmlformats.org/presentationml/2006/main",
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
}
_DEFAULT_W = 9_144_000
_DEFAULT_H = 6_858_000
_CHART_RE = re.compile(r"^chart\s*:", re.IGNORECASE)


# ── Helpers ──────────────────────────────────────────────────────────────────

def _clamp(v: float) -> float:
    return round(max(0.0, min(1.0, v)), 4)


def _xml_text(el: ET.Element) -> str:
    return "".join(t.text or "" for t in el.iter(f"{{{_NS['a']}}}t")).strip()


def _slide_size(z: zipfile.ZipFile, names: set[str]) -> tuple[int, int]:
    if "ppt/presentation.xml" not in names:
        return _DEFAULT_W, _DEFAULT_H
    try:
        root = ET.fromstring(z.read("ppt/presentation.xml"))
        sz = root.find(".//p:sldSz", _NS)
        if sz is not None:
            return int(sz.get("cx", str(_DEFAULT_W))), int(sz.get("cy", str(_DEFAULT_H)))
    except Exception:
        pass
    return _DEFAULT_W, _DEFAULT_H


def _notes_text(z: zipfile.ZipFile, names: set[str], slide_path: str) -> str:
    """Read the Notes field of the slide, skipping auto-generated footer text."""
    # Resolve notes path from slide rels
    rels_path = (
        slide_path
        .replace("ppt/slides/", "ppt/slides/_rels/") + ".rels"
    )
    notes_path: str | None = None
    if rels_path in names:
        try:
            for rel in ET.fromstring(z.read(rels_path)):
                if "notesSlide" in rel.get("Type", ""):
                    target = rel.get("Target", "")
                    candidate = os.path.normpath(
                        os.path.join("ppt/slides", target)
                    ).replace("\\", "/")
                    if candidate in names:
                        notes_path = candidate
                    break
        except Exception:
            pass

    if not notes_path:
        notes_path = "ppt/notesSlides/notesSlide1.xml"
    if notes_path not in names:
        return ""

    try:
        root = ET.fromstring(z.read(notes_path))
        for sp in root.findall(".//p:sp", _NS):
            ph = sp.find(".//p:nvSpPr/p:nvPr/p:ph", _NS)
            ph_type = ph.get("type", "") if ph is not None else ""
            if ph_type in {"sldNum", "dt", "ftr", "hdr"}:
                continue
            text = _xml_text(sp)
            if text:
                return text
    except Exception:
        pass
    return ""


def _bbox(shape: ET.Element, w: int, h: int) -> dict[str, float] | None:
    """Return normalised {x, y, w, h} or None if too small to matter."""
    xfrm = shape.find(".//p:spPr/a:xfrm", _NS) or shape.find(".//a:xfrm", _NS)
    if xfrm is None:
        return None
    off = xfrm.find("a:off", _NS)
    ext = xfrm.find("a:ext", _NS)
    if off is None or ext is None:
        return None
    try:
        x = int(off.get("x", "0"))
        y = int(off.get("y", "0"))
        bw = int(ext.get("cx", "0"))
        bh = int(ext.get("cy", "0"))
    except ValueError:
        return None
    if bw < w * 0.02 or bh < h * 0.015:
        return None
    return {"x": _clamp(x / w), "y": _clamp(y / h), "w": _clamp(bw / w), "h": _clamp(bh / h)}


def _font_size(shape: ET.Element) -> float:
    for rpr in shape.findall(".//a:rPr", _NS):
        sz = rpr.get("sz")
        if sz:
            try:
                return round(int(sz) / 100, 1)
            except ValueError:
                pass
    return 24.0


def _align(shape: ET.Element) -> str:
    ppr = shape.find(".//a:pPr", _NS)
    if ppr is not None:
        v = ppr.get("algn", "l")
        return v if v in {"l", "ctr", "r", "just"} else "l"
    return "l"


def _bold(shape: ET.Element) -> bool:
    for rpr in shape.findall(".//a:rPr", _NS):
        if rpr.get("b") == "1":
            return True
    return False


# ── Public API ────────────────────────────────────────────────────────────────

def parse_pptx_template(
    pptx_path: str,
    template_id: str,
    description: str = "",
) -> dict[str, Any] | None:
    """
    Parse one single-slide PPTX into a template dict that GeneratedSlideCard
    and generate_slide_background can consume directly.
    """
    try:
        content = open(pptx_path, "rb").read()
    except OSError:
        return None

    try:
        with zipfile.ZipFile(io.BytesIO(content)) as z:
            names = set(z.namelist())
            ws, hs = _slide_size(z, names)

            slide_paths = sorted(
                [n for n in names if re.match(r"ppt/slides/slide\d+\.xml$", n)],
                key=lambda p: int(re.search(r"\d+", p.split("/")[-1]).group(0)),  # type: ignore[union-attr]
            )
            if not slide_paths:
                return None

            slide_path = slide_paths[0]
            root = ET.fromstring(z.read(slide_path))

            if not description:
                description = _notes_text(z, names, slide_path)

            # ── Collect text shapes ──────────────────────────────────
            raw_shapes: list[dict[str, Any]] = []
            for sp in root.findall(".//p:sp", _NS):
                if sp.find("p:txBody", _NS) is None:
                    continue
                box = _bbox(sp, ws, hs)
                if box is None:
                    continue
                ph = sp.find(".//p:nvSpPr/p:nvPr/p:ph", _NS)
                raw_shapes.append({
                    **box,
                    "text": _xml_text(sp),
                    "ph_type": ph.get("type", "") if ph is not None else "",
                    "el": sp,
                })

            raw_shapes.sort(key=lambda s: (s["y"], s["x"]))

            slots: list[dict[str, Any]] = []
            t_counter = 0
            chart_counter = 0
            title_assigned = False

            for s in raw_shapes:
                text = s["text"]
                fs = _font_size(s["el"])
                al = _align(s["el"])
                bd = _bold(s["el"])
                geom = {k: s[k] for k in ("x", "y", "w", "h")}

                if _CHART_RE.match(text):
                    chart_counter += 1
                    slots.append({
                        "id": f"chart{chart_counter}",
                        "role": "chart",
                        "hint": text.split(":", 1)[1].strip() or "data chart",
                        **geom,
                        "font_size": fs, "align": al, "bold": bd, "italic": False,
                    })
                    continue

                is_title = (
                    s["ph_type"] in {"title", "ctrTitle", "subTitle"}
                    or (not title_assigned and s["y"] < 0.3 and s["h"] < 0.3)
                )
                role = "title" if is_title and not title_assigned else "body"
                if role == "title":
                    title_assigned = True
                t_counter += 1
                slots.append({
                    "id": f"t{t_counter}",
                    "role": role,
                    "hint": text or role.capitalize(),
                    **geom,
                    "font_size": fs, "align": al, "bold": bd, "italic": False,
                })

            # ── Collect image shapes ─────────────────────────────────
            img_counter = 0
            for pic in root.findall(".//p:pic", _NS):
                box = _bbox(pic, ws, hs)
                if box is None:
                    continue
                img_counter += 1
                slots.append({
                    "id": f"img{img_counter}",
                    "role": "image",
                    "hint": "image",
                    **box,
                    "font_size": 0, "align": "l", "bold": False, "italic": False,
                })

            if not slots:
                return None

            slots.sort(key=lambda s: (s["y"], s["x"]))

            return {
                "id": template_id,
                "description": description or f"Custom template {template_id}",
                "text_boxes": slots,
                "bg_color": "#1a1a2e",   # overridden at generation time with deck color
                "colors": [],
                "source": "custom",
                "image_count": img_counter,
                "source_slide_number": 0,
            }

    except Exception as exc:
        print(f"[template_parser] Error parsing {pptx_path}: {exc}")
        return None


def load_custom_templates(templates_dir: str) -> list[dict[str, Any]]:
    """
    Load all numbered PPTX templates from templates_dir in ascending order.
    Returns an empty list if the directory does not exist.
    """
    if not os.path.isdir(templates_dir):
        return []

    # Optional description overrides: { "1": "...", "2": "..." }
    json_desc: dict[str, str] = {}
    json_path = os.path.join(templates_dir, "templates.json")
    if os.path.exists(json_path):
        try:
            data = json.loads(open(json_path, encoding="utf-8").read())
            if isinstance(data, dict):
                json_desc = {str(k): str(v) for k, v in data.items() if isinstance(v, str)}
        except Exception:
            pass

    pptx_files = sorted(
        [f for f in os.listdir(templates_dir) if f.lower().endswith(".pptx")],
        key=lambda f: int(m.group()) if (m := re.search(r"\d+", f)) else 9999,
    )

    results: list[dict[str, Any]] = []
    for filename in pptx_files:
        m = re.search(r"\d+", filename)
        if not m:
            continue
        num = m.group()
        tmpl = parse_pptx_template(
            os.path.join(templates_dir, filename),
            template_id=f"custom_{num}",
            description=json_desc.get(num, ""),
        )
        if tmpl:
            results.append(tmpl)

    return results
