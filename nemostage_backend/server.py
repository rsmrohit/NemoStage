import asyncio
import hashlib
import io
import json
import os
import re
import subprocess
import tempfile
import time
import urllib.request
import zipfile
import xml.etree.ElementTree as ET
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
REGISTERED_AGENTS = {"main", "slidegen", "audience"}
MAX_AGENT_SLIDE_TEXT_CHARS = 1200
CHROMA_ROOT = "/home/asus/nemostage-chroma"
BREV_OLLAMA_URL = "http://127.0.0.1:11436"
BREV_OLLAMA_MODEL = "gemma4:26b"
MAX_RECENT_QA = 20
DECK_INDEX_PATH = os.path.join(CHROMA_ROOT, "decks.json")
MATERIAL_MAX_FILE_BYTES = 25 * 1024 * 1024
MATERIAL_TEXT_MAX_CHARS = 80_000
MATERIAL_CHUNK_CHARS = 1600
MATERIAL_CHUNK_OVERLAP = 160
EMBEDDING_MODEL_NAME = "sentence-transformers/all-MiniLM-L6-v2"
VECTOR_TOP_K = 5
VECTOR_RELEVANCE_DISTANCE_THRESHOLD = 0.45

_embedding_model = None
_chroma_client = None

generated_slides: dict[str, list[dict]] = {}
recent_qa: list[dict] = []


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
    deck_id: str | None = None
    collection_name: str | None = None
    vectorization_status: str = "unavailable"
    chunks_indexed: int = 0
    vectorization_error: str | None = None
    material_chunks_indexed: int = 0
    material_files_indexed: int = 0
    material_sandbox_dir: str = ""


class DeckIndexInfo(BaseModel):
    deck_id: str
    collection_name: str
    filename: str
    sandbox_path: str = ""
    sandbox_dir: str = ""
    vectorization_status: str
    chunks_indexed: int = 0
    material_chunks_indexed: int = 0
    material_files_indexed: int = 0
    vectorization_error: str | None = None
    material_index_error: str | None = None
    updated_at: float
    style_spec: dict | None = None


presentation_sessions: dict[str, PresentationSession] = {}
deck_indexes_by_filename: dict[str, DeckIndexInfo] = {}


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


def safe_path_component(value: str, fallback: str = "presentation") -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "-", value).strip(".-_")
    return cleaned[:80] or fallback


def presentation_subdir_for(filename: str, deck_id: str) -> str:
    stem = os.path.splitext(os.path.basename(filename))[0]
    return f"{safe_path_component(stem)}-{deck_id[:12]}"


def validate_material_filename(filename: str) -> str:
    safe_name = os.path.basename(filename)
    if not safe_name or "/" in safe_name or "\\" in safe_name or ".." in safe_name:
        raise HTTPException(status_code=400, detail=f"Invalid material filename: {filename}")
    return safe_path_component(safe_name, "material")


def save_pptx_to_sandbox(filename: str, content: bytes) -> dict:
    safe_name = validate_pptx_filename(filename)
    deck_id = hashlib.sha256(content).hexdigest()
    sandbox_dir = f"{SANDBOX_DEST}/{presentation_subdir_for(safe_name, deck_id)}"
    container = get_nemostage_container()

    with tempfile.NamedTemporaryFile(suffix=".pptx", delete=False) as tmp:
        tmp.write(content)
        tmp_path = tmp.name

    try:
        subprocess.run(
            ["docker", "exec", container, "mkdir", "-p", sandbox_dir],
            check=True
        )
        dest = f"{sandbox_dir}/{safe_name}"
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
        "sandbox_dir": sandbox_dir,
        "container": container,
        "size_bytes": len(content),
    }


def save_material_to_sandbox(deck_info: DeckIndexInfo, filename: str, content: bytes) -> dict:
    if len(content) > MATERIAL_MAX_FILE_BYTES:
        raise HTTPException(status_code=400, detail=f"{filename} is larger than 25MB")
    safe_name = validate_material_filename(filename)
    container = get_nemostage_container()
    sandbox_dir = deck_info.sandbox_dir or os.path.dirname(deck_info.sandbox_path)
    material_dir = f"{sandbox_dir}/materials"

    with tempfile.NamedTemporaryFile(delete=False) as tmp:
        tmp.write(content)
        tmp_path = tmp.name

    try:
        subprocess.run(["docker", "exec", container, "mkdir", "-p", material_dir], check=True)
        dest = f"{material_dir}/{safe_name}"
        subprocess.run(["docker", "cp", tmp_path, f"{container}:{dest}"], check=True)
        subprocess.run(["docker", "exec", container, "chown", "sandbox:sandbox", dest], check=True)
    finally:
        os.unlink(tmp_path)

    return {
        "filename": safe_name,
        "sandbox_path": dest,
        "size_bytes": len(content),
    }


def load_deck_index_manifest() -> None:
    if deck_indexes_by_filename or not os.path.exists(DECK_INDEX_PATH):
        return
    try:
        with open(DECK_INDEX_PATH, "r", encoding="utf-8") as f:
            raw = json.load(f)
        for filename, data in raw.items():
            deck_indexes_by_filename[filename] = DeckIndexInfo(**data)
    except Exception:
        # The server can still run without the manifest; upload will rebuild it.
        return


def persist_deck_index_manifest() -> None:
    os.makedirs(CHROMA_ROOT, exist_ok=True)
    with open(DECK_INDEX_PATH, "w", encoding="utf-8") as f:
        json.dump(
            {name: info.dict() for name, info in deck_indexes_by_filename.items()},
            f,
            indent=2,
            sort_keys=True,
        )


def get_embedding_model():
    global _embedding_model
    if _embedding_model is None:
        from sentence_transformers import SentenceTransformer

        _embedding_model = SentenceTransformer(EMBEDDING_MODEL_NAME)
    return _embedding_model


def get_chroma_client():
    global _chroma_client
    if _chroma_client is None:
        import chromadb

        os.makedirs(CHROMA_ROOT, exist_ok=True)
        _chroma_client = chromadb.PersistentClient(path=CHROMA_ROOT)
    return _chroma_client


def collection_name_for_deck(deck_id: str) -> str:
    return f"presentation_{deck_id[:40]}"


def material_collection_name_for_deck(deck_id: str) -> str:
    return f"presentation_materials_{deck_id[:40]}"


def extract_xml_text(xml: bytes) -> str:
    try:
        root = ET.fromstring(xml)
    except ET.ParseError:
        return ""
    parts = []
    for node in root.iter():
        if node.tag.endswith("}t") and node.text:
            parts.append(node.text)
    return "\n".join(part.strip() for part in parts if part.strip())


def slide_number_from_path(path: str) -> int:
    match = re.search(r"slide(\d+)\.xml$", path)
    return int(match.group(1)) if match else 0


def extract_pptx_slide_documents(content: bytes) -> list[dict]:
    documents = []
    with zipfile.ZipFile(io.BytesIO(content)) as z:
        names = set(z.namelist())
        slide_paths = sorted(
            [
                name
                for name in names
                if re.match(r"ppt/slides/slide\d+\.xml$", name)
            ],
            key=slide_number_from_path,
        )
        for slide_path in slide_paths:
            slide_number = slide_number_from_path(slide_path)
            slide_text = extract_xml_text(z.read(slide_path))
            notes_path = f"ppt/notesSlides/notesSlide{slide_number}.xml"
            notes_text = extract_xml_text(z.read(notes_path)) if notes_path in names else ""
            combined = "\n".join(
                part
                for part in [
                    f"Slide {slide_number}",
                    slide_text.strip(),
                    f"Speaker notes:\n{notes_text.strip()}" if notes_text.strip() else "",
                ]
                if part
            ).strip()
            if not combined:
                continue
            title = next((line.strip() for line in slide_text.splitlines() if line.strip()), "")
            documents.append(
                {
                    "slide_index": slide_number - 1,
                    "slide_number": slide_number,
                    "title": title[:200],
                    "text": combined,
                }
            )

    return documents


def extract_docx_text(content: bytes) -> str:
    try:
        with zipfile.ZipFile(io.BytesIO(content)) as z:
            parts = []
            for name in sorted(z.namelist()):
                if name == "word/document.xml" or name.startswith("word/header") or name.startswith("word/footer"):
                    text = extract_xml_text(z.read(name))
                    if text:
                        parts.append(text)
            return "\n\n".join(parts)
    except Exception:
        return ""


def extract_material_text(filename: str, content: bytes) -> str:
    ext = os.path.splitext(filename)[1].lower()
    if ext == ".docx":
        text = extract_docx_text(content)
    elif ext == ".pptx":
        docs = extract_pptx_slide_documents(content)
        text = "\n\n".join(doc["text"] for doc in docs)
    elif ext in {".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".jsonl", ".html", ".htm", ".xml", ".yaml", ".yml"}:
        text = content.decode("utf-8", errors="replace")
        if ext in {".html", ".htm", ".xml"}:
            text = re.sub(r"<[^>]+>", " ", text)
    else:
        return ""

    text = re.sub(r"\r\n?", "\n", text)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    return text[:MATERIAL_TEXT_MAX_CHARS]


def chunk_material_text(text: str) -> list[str]:
    if not text:
        return []
    chunks = []
    start = 0
    while start < len(text):
        chunk = text[start:start + MATERIAL_CHUNK_CHARS].strip()
        if chunk:
            chunks.append(chunk)
        if start + MATERIAL_CHUNK_CHARS >= len(text):
            break
        start += MATERIAL_CHUNK_CHARS - MATERIAL_CHUNK_OVERLAP
    return chunks


def extract_deck_style(content: bytes) -> dict:
    style: dict = {"bg_color": "#1a1a2e", "accent_color": "#4f8ef7", "font_family": "Calibri"}
    try:
        with zipfile.ZipFile(io.BytesIO(content)) as z:
            names = set(z.namelist())
            if "ppt/theme/theme1.xml" in names:
                tree = ET.fromstring(z.read("ppt/theme/theme1.xml"))
                ns = {"a": "http://schemas.openxmlformats.org/drawingml/2006/main"}
                accent = tree.find(".//a:accent1/a:srgbClr", ns)
                if accent is not None:
                    val = accent.get("val", "")
                    if val:
                        style["accent_color"] = "#" + val
                font_el = tree.find(".//a:latin", ns)
                if font_el is not None:
                    typeface = font_el.get("typeface", "")
                    if typeface and typeface not in ("+mj-lt", "+mn-lt"):
                        style["font_family"] = typeface
            slide_paths = sorted(
                [n for n in names if re.match(r"ppt/slides/slide\d+\.xml$", n)],
                key=slide_number_from_path,
            )
            if slide_paths:
                tree = ET.fromstring(z.read(slide_paths[0]))
                ns2 = {"p": "http://schemas.openxmlformats.org/presentationml/2006/main",
                       "a": "http://schemas.openxmlformats.org/drawingml/2006/main"}
                bg = tree.find(".//a:solidFill/a:srgbClr", ns2)
                if bg is not None:
                    val = bg.get("val", "")
                    if val:
                        style["bg_color"] = "#" + val
    except Exception:
        pass
    return style


def embed_texts(texts: list[str]) -> list[list[float]]:
    model = get_embedding_model()
    embeddings = model.encode(texts, normalize_embeddings=True)
    return embeddings.tolist()


def rebuild_deck_vector_index(
    filename: str,
    sandbox_path: str,
    content: bytes,
    sandbox_dir: str = "",
) -> DeckIndexInfo:
    deck_id = hashlib.sha256(content).hexdigest()
    collection_name = collection_name_for_deck(deck_id)
    now = time.time()
    style_spec = extract_deck_style(content)

    try:
        slide_documents = extract_pptx_slide_documents(content)
        if not slide_documents:
            raise ValueError("No slide text found to vectorize")

        client = get_chroma_client()
        try:
            client.delete_collection(collection_name)
        except Exception:
            pass
        try:
            client.delete_collection(material_collection_name_for_deck(deck_id))
        except Exception:
            pass

        collection = client.create_collection(
            name=collection_name,
            metadata={"deck_id": deck_id, "filename": filename, "hnsw:space": "cosine"},
        )
        texts = [doc["text"] for doc in slide_documents]
        embeddings = embed_texts(texts)
        collection.add(
            ids=[f"{deck_id[:12]}-slide-{doc['slide_index']}" for doc in slide_documents],
            documents=texts,
            embeddings=embeddings,
            metadatas=[
                {
                    "deck_id": deck_id,
                    "filename": filename,
                    "slide_index": doc["slide_index"],
                    "slide_number": doc["slide_number"],
                    "title": doc["title"],
                }
                for doc in slide_documents
            ],
        )
        info = DeckIndexInfo(
            deck_id=deck_id,
            collection_name=collection_name,
            filename=filename,
            sandbox_path=sandbox_path,
            sandbox_dir=sandbox_dir or os.path.dirname(sandbox_path),
            vectorization_status="ready",
            chunks_indexed=len(slide_documents),
            updated_at=now,
            style_spec=style_spec,
        )
    except Exception as exc:
        info = DeckIndexInfo(
            deck_id=deck_id,
            collection_name=collection_name,
            filename=filename,
            sandbox_path=sandbox_path,
            sandbox_dir=sandbox_dir or os.path.dirname(sandbox_path),
            vectorization_status="failed",
            chunks_indexed=0,
            vectorization_error=str(exc),
            updated_at=now,
            style_spec=style_spec,
        )

    deck_indexes_by_filename[filename] = info
    persist_deck_index_manifest()
    return info


def index_presentation_materials(deck_info: DeckIndexInfo, saved_files: list[dict[str, Any]]) -> dict:
    collection_name = material_collection_name_for_deck(deck_info.deck_id)
    indexed_files = 0
    indexed_chunks = 0
    errors = []

    try:
        client = get_chroma_client()
        try:
            collection = client.get_collection(collection_name)
        except Exception:
            collection = client.create_collection(
                name=collection_name,
                metadata={
                    "deck_id": deck_info.deck_id,
                    "filename": deck_info.filename,
                    "hnsw:space": "cosine",
                },
            )

        for saved in saved_files:
            content = saved.get("content", b"")
            source_filename = saved["filename"]
            text = extract_material_text(source_filename, content)
            chunks = chunk_material_text(text)
            if not chunks:
                errors.append(f"{source_filename}: no supported text extracted")
                continue

            embeddings = embed_texts(chunks)
            file_hash = hashlib.sha256(content).hexdigest()[:16]
            upload_stamp = int(time.time() * 1000)
            ids = [
                f"{deck_info.deck_id[:12]}-mat-{file_hash}-{upload_stamp}-{index}"
                for index, _chunk in enumerate(chunks)
            ]
            metadatas = [
                {
                    "deck_id": deck_info.deck_id,
                    "presentation_filename": deck_info.filename,
                    "source_type": "material",
                    "source_filename": source_filename,
                    "sandbox_path": saved["sandbox_path"],
                    "chunk_index": index,
                }
                for index, _chunk in enumerate(chunks)
            ]
            collection.add(ids=ids, documents=chunks, embeddings=embeddings, metadatas=metadatas)
            indexed_files += 1
            indexed_chunks += len(chunks)

        deck_info.material_files_indexed += indexed_files
        deck_info.material_chunks_indexed += indexed_chunks
        deck_info.material_index_error = "; ".join(errors) if errors else None
        deck_info.updated_at = time.time()
        deck_indexes_by_filename[deck_info.filename] = deck_info
        persist_deck_index_manifest()
    except Exception as exc:
        deck_info.material_index_error = str(exc)
        deck_indexes_by_filename[deck_info.filename] = deck_info
        persist_deck_index_manifest()
        raise

    return {
        "collection_name": collection_name,
        "material_files_indexed": indexed_files,
        "material_chunks_indexed": indexed_chunks,
        "errors": errors,
    }


def find_deck_index(filename: str) -> DeckIndexInfo | None:
    load_deck_index_manifest()
    if filename in deck_indexes_by_filename:
        return deck_indexes_by_filename[filename]
    return None


def query_deck_vectors(session: PresentationSession, transcript: str) -> dict:
    if not session.deck_id or not session.collection_name:
        return {
            "status": "unavailable",
            "error": "No vector index is bound to this presentation session",
            "matches": [],
        }
    if session.vectorization_status != "ready":
        return {
            "status": session.vectorization_status,
            "error": session.vectorization_error or "Vector index is not ready",
            "matches": [],
        }

    try:
        client = get_chroma_client()
        collection = client.get_collection(session.collection_name)
        query_embedding = embed_texts([transcript])[0]
        result = collection.query(
            query_embeddings=[query_embedding],
            n_results=VECTOR_TOP_K,
            where={"deck_id": session.deck_id},
            include=["documents", "metadatas", "distances"],
        )
        documents = result.get("documents", [[]])[0]
        metadatas = result.get("metadatas", [[]])[0]
        distances = result.get("distances", [[]])[0]
        matches = []
        for document, metadata, distance in zip(documents, metadatas, distances):
            matches.append(
                {
                    "document": document,
                    "metadata": metadata or {},
                    "distance": float(distance),
                    "strong_match": float(distance) <= VECTOR_RELEVANCE_DISTANCE_THRESHOLD,
                }
            )
        return {
            "status": "ready",
            "collection_name": session.collection_name,
            "deck_id": session.deck_id,
            "matches": matches,
            "best_distance": matches[0]["distance"] if matches else None,
            "threshold": VECTOR_RELEVANCE_DISTANCE_THRESHOLD,
        }
    except Exception as exc:
        return {"status": "failed", "error": str(exc), "matches": []}


def query_material_vectors(deck_info: DeckIndexInfo | None, question: str, top_k: int = 4) -> dict:
    if not deck_info or deck_info.material_chunks_indexed <= 0:
        return {"status": "unavailable", "matches": []}

    try:
        client = get_chroma_client()
        collection = client.get_collection(material_collection_name_for_deck(deck_info.deck_id))
        query_embedding = embed_texts([question])[0]
        result = collection.query(
            query_embeddings=[query_embedding],
            n_results=top_k,
            where={"deck_id": deck_info.deck_id},
            include=["documents", "metadatas", "distances"],
        )
        documents = result.get("documents", [[]])[0]
        metadatas = result.get("metadatas", [[]])[0]
        distances = result.get("distances", [[]])[0]
        matches = []
        for document, metadata, distance in zip(documents, metadatas, distances):
            matches.append(
                {
                    "document": document,
                    "metadata": metadata or {},
                    "distance": float(distance),
                }
            )
        return {
            "status": "ready",
            "collection_name": material_collection_name_for_deck(deck_info.deck_id),
            "deck_id": deck_info.deck_id,
            "matches": matches,
        }
    except Exception as exc:
        return {"status": "failed", "error": str(exc), "matches": []}


def format_vector_matches_for_agent(vector_search: dict, current_slide: int) -> str:
    matches = vector_search.get("matches", [])
    if not matches:
        return "[no vector matches]"
    blocks = []
    for match in matches:
        metadata = match.get("metadata", {})
        marker = "CURRENT" if metadata.get("slide_index") == current_slide else "OTHER"
        strength = "strong" if match.get("strong_match") else "weak"
        text = compact_agent_text(match.get("document", ""), 1800)
        blocks.append(
            f"[{marker} {strength}_vector_match distance={match.get('distance'):.4f}] "
            f"slide_index={metadata.get('slide_index')}, slide_number={metadata.get('slide_number')}\n"
            f"title: {metadata.get('title') or '[empty]'}\n"
            f"text: {text or '[empty]'}"
        )
    return "\n\n".join(blocks)


def format_material_matches_for_agent(material_search: dict) -> str:
    matches = material_search.get("matches", [])
    if not matches:
        return "[no retrieved supporting-material matches]"
    blocks = []
    for match in matches:
        metadata = match.get("metadata", {})
        text = compact_agent_text(match.get("document", ""), 1800)
        blocks.append(
            f"[supporting_material distance={match.get('distance'):.4f}] "
            f"file={metadata.get('source_filename') or '[unknown]'} "
            f"chunk={metadata.get('chunk_index')}\n"
            f"path: {metadata.get('sandbox_path') or '[unknown]'}\n"
            f"text: {text or '[empty]'}"
        )
    return "\n\n".join(blocks)


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


def _sync_brev_call(prompt: str, timeout: int) -> str:
    payload = json.dumps({
        "model": BREV_OLLAMA_MODEL,
        "messages": [{"role": "user", "content": prompt}],
        "stream": False,
    }).encode()
    req = urllib.request.Request(
        f"{BREV_OLLAMA_URL}/v1/chat/completions",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        result = json.loads(resp.read())
    return result["choices"][0]["message"]["content"]


async def ask_brev_ollama(prompt: str, timeout: int = 120) -> str:
    loop = asyncio.get_event_loop()
    try:
        return await loop.run_in_executor(None, _sync_brev_call, prompt, timeout)
    except urllib.error.URLError as exc:
        raise HTTPException(status_code=502, detail=f"Brev Ollama unreachable: {exc}")
    except (KeyError, IndexError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=502, detail=f"Brev Ollama bad response: {exc}")


async def ask_agent_async(
    prompt: str,
    agent: str = "main",
    timeout: int = 300,
    session_id: str | None = None,
) -> str:
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, ask_agent, prompt, agent, timeout, session_id)


async def generate_slide_background(
    presentation_id: str, topic: str, after_slide: int, session: "PresentationSession"
) -> None:
    deck_info = find_deck_index(session.file_name)
    style_spec = (deck_info.style_spec or {}) if deck_info else {}

    fake_session = type("_S", (), {
        "deck_id": session.deck_id,
        "collection_name": session.collection_name,
        "vectorization_status": session.vectorization_status,
        "vectorization_error": session.vectorization_error,
    })()
    vector_search = query_deck_vectors(fake_session, topic)  # type: ignore[arg-type]
    top_matches = (vector_search.get("matches") or [])[:2]
    context_block = "\n\n".join(
        f"slide_index={m['metadata'].get('slide_index')}, title: {m['metadata'].get('title')}\n{m['document'][:600]}"
        for m in top_matches
    ) if top_matches else "[no slide context available]"

    prompt = (
        "You are generating a supplemental slide for a live presentation. "
        "The speaker just covered a topic not in their deck. "
        "Create a slide that matches the deck's style and depth.\n\n"
        f"Topic not covered: {topic}\n\n"
        f"Relevant slide context from the deck:\n{context_block}\n\n"
        f"Deck style spec: bg_color={style_spec.get('bg_color', '#1a1a2e')}, "
        f"accent_color={style_spec.get('accent_color', '#4f8ef7')}, "
        f"font_family={style_spec.get('font_family', 'Calibri')}\n\n"
        "Return EXACTLY one JSON object:\n"
        '{"title": "<5-8 word title>", "bullets": ["<point 1>", "<point 2>", "<point 3>"], '
        '"notes": "<1-2 sentence speaker notes>", '
        '"style_hint": {"bg": "<hex>", "accent": "<hex>", "font": "<family>"}}\n'
        "Return only the JSON. No markdown, no explanation."
    )

    try:
        reply = await ask_brev_ollama(prompt, timeout=90)
        parsed = parse_json_reply(reply)
        if not isinstance(parsed, dict) or "title" not in parsed:
            return
        entry = {
            "index": len(generated_slides.get(presentation_id, [])),
            "title": parsed.get("title", topic),
            "bullets": parsed.get("bullets", []),
            "notes": parsed.get("notes", ""),
            "style_hint": parsed.get("style_hint", style_spec),
            "after_slide": after_slide,
            "topic": topic,
            "created_at": time.time(),
        }
        generated_slides.setdefault(presentation_id, []).append(entry)
    except Exception:
        pass


@app.get("/agents")
def list_registered_agents():
    return {
        "agents": [
            {"id": "main", "purpose": "general NemoClaw presentation assistant"},
            {"id": "slidegen", "purpose": "generates supplemental slides for off-slide topics"},
            {"id": "audience", "purpose": "audience engagement analysis probe"},
        ]
    }


@app.post("/agents/livetranscript")
async def livetranscript_agent(
    transcript: str = Form(...),
    slide_context: str = Form(""),
    session_id: str = Form(""),
):
    """Kept for backward compatibility. Now routes to slidegen agent."""
    transcript = transcript.strip()
    if not transcript:
        raise HTTPException(status_code=400, detail="empty transcript")

    prompt = (
        "Classify this live presentation transcript chunk. "
        "Use slide_context only if provided.\n\n"
        f"slide_context:\n{slide_context.strip() or '[not provided]'}\n\n"
        f"transcript:\n{transcript}\n"
        "\nReturn exactly one JSON object:\n"
        '{"coverage_status": "current_slide|other_slide|not_covered", '
        '"matched_slide": <int|null>, "summary_so_far": "<str>", '
        '"topic": "<str|null>", "reason": "<str>"}\n'
    )
    reply = ask_agent(prompt, agent="slidegen", session_id=session_id.strip() or None)
    return JSONResponse({
        "status": "ok",
        "agent": "slidegen",
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
    deck_index = find_deck_index(payload.file_name)
    session = PresentationSession(
        presentation_id=session_id,
        file_name=payload.file_name,
        slide_count=payload.slide_count,
        current_slide=payload.current_slide,
        slides=payload.slides,
        started_at=now,
        updated_at=now,
        deck_id=deck_index.deck_id if deck_index else None,
        collection_name=deck_index.collection_name if deck_index else None,
        vectorization_status=deck_index.vectorization_status if deck_index else "unavailable",
        chunks_indexed=deck_index.chunks_indexed if deck_index else 0,
        material_chunks_indexed=deck_index.material_chunks_indexed if deck_index else 0,
        material_files_indexed=deck_index.material_files_indexed if deck_index else 0,
        material_sandbox_dir=(
            f"{deck_index.sandbox_dir}/materials"
            if deck_index and deck_index.sandbox_dir
            else ""
        ),
        vectorization_error=(
            deck_index.vectorization_error
            if deck_index
            else f"No vector index found for uploaded file: {payload.file_name}"
        ),
    )
    presentation_sessions[session_id] = session
    return {
        "status": "ok",
        "presentation_id": session_id,
        "deck_id": session.deck_id,
        "collection_name": session.collection_name,
        "vectorization_enabled": session.vectorization_status == "ready",
        "vectorization_status": session.vectorization_status,
        "chunks_indexed": session.chunks_indexed,
        "vectorization_error": session.vectorization_error,
        "material_files_indexed": session.material_files_indexed,
        "material_chunks_indexed": session.material_chunks_indexed,
        "material_sandbox_dir": session.material_sandbox_dir,
    }


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

    vector_search = query_deck_vectors(session, transcript)
    if vector_search.get("status") != "ready":
        session.last_agent_result = {"vector_error": vector_search.get("error", "Vector search unavailable")}
        session.slide_generation_needed = False
        session.coverage_status = "unknown"
        session.updated_at = time.time()
        presentation_sessions[payload.presentation_id] = session
        return JSONResponse({
            "status": "ok",
            "presentation_id": payload.presentation_id,
            "current_slide": session.current_slide,
            "agent_result": session.last_agent_result,
            "coverage_status": "unknown",
            "slide_generation_needed": False,
            "vector_search": vector_search,
        })

    if not vector_search.get("matches"):
        session.last_agent_result = {"vector_error": "No vector matches returned for transcript"}
        session.slide_generation_needed = False
        session.coverage_status = "unknown"
        session.updated_at = time.time()
        presentation_sessions[payload.presentation_id] = session
        return JSONResponse({
            "status": "ok",
            "presentation_id": payload.presentation_id,
            "current_slide": session.current_slide,
            "agent_result": session.last_agent_result,
            "coverage_status": "unknown",
            "slide_generation_needed": False,
            "vector_search": vector_search,
        })

    vector_context = format_vector_matches_for_agent(vector_search, session.current_slide)
    prompt = (
        "You are tracking a live presentation. Use only the vector-retrieved slide context below; "
        "do not open files, run tools, or assume content from slides that were not retrieved. "
        "Classify the speaker's transcript chunk into exactly "
        "one coverage_status:\n"
        "- current_slide: the content is covered by the current slide.\n"
        "- other_slide: the content is not covered by the current slide, but is covered by one "
        "of the retrieved slides from this same presentation, including a future slide.\n"
        "- not_covered: the content is not covered by the retrieved slide context, or the only "
        "matches are weak and do not actually support the transcript topic.\n\n"
        "If coverage_status is other_slide, set matched_slide to the best matching slide_index. "
        "If not_covered, set matched_slide to null and topic to the missing topic.\n\n"
        f"Current slide_index: {session.current_slide}\n"
        f"Vector search threshold: distance <= {VECTOR_RELEVANCE_DISTANCE_THRESHOLD} is strong; higher is weak.\n\n"
        f"Vector-retrieved slide context:\n{vector_context}\n\n"
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
        "vector_search": {
            "status": vector_search.get("status"),
            "collection_name": vector_search.get("collection_name"),
            "deck_id": vector_search.get("deck_id"),
            "best_distance": vector_search.get("best_distance"),
            "threshold": vector_search.get("threshold"),
            "matches": [
                {
                    "metadata": match.get("metadata", {}),
                    "distance": match.get("distance"),
                    "strong_match": match.get("strong_match"),
                }
                for match in vector_search.get("matches", [])
            ],
        },
    })


@app.post("/brev/transcript")
async def brev_transcript(payload: PresentationTranscriptRequest):
    """Same vector search as /presentation/transcript but inference runs on Brev Ollama directly."""
    session = get_presentation_session(payload.presentation_id)
    transcript = payload.transcript.strip()
    if not transcript:
        raise HTTPException(status_code=400, detail="empty transcript")

    vector_search = query_deck_vectors(session, transcript)
    if vector_search.get("status") != "ready" or not vector_search.get("matches"):
        return JSONResponse({
            "status": "ok",
            "presentation_id": payload.presentation_id,
            "current_slide": session.current_slide,
            "agent_result": {"vector_error": vector_search.get("error", "Vector search unavailable")},
            "coverage_status": "unknown",
            "slide_generation_needed": False,
            "vector_search": vector_search,
            "backend": "brev",
        })

    vector_context = format_vector_matches_for_agent(vector_search, session.current_slide)
    prompt = (
        "You are tracking a live presentation. Use only the vector-retrieved slide context below; "
        "do not open files, run tools, or assume content from slides that were not retrieved. "
        "Classify the speaker's transcript chunk into exactly one coverage_status:\n"
        "- current_slide: the content is covered by the current slide.\n"
        "- other_slide: the content is not covered by the current slide, but is covered by one "
        "of the retrieved slides from this same presentation, including a future slide.\n"
        "- not_covered: the content is not covered by the retrieved slide context, or the only "
        "matches are weak and do not actually support the transcript topic.\n\n"
        "If coverage_status is other_slide, set matched_slide to the best matching slide_index. "
        "If not_covered, set matched_slide to null and topic to the missing topic.\n\n"
        f"Current slide_index: {session.current_slide}\n"
        f"Vector search threshold: distance <= {VECTOR_RELEVANCE_DISTANCE_THRESHOLD} is strong; higher is weak.\n\n"
        f"Vector-retrieved slide context:\n{vector_context}\n\n"
        f"Transcript chunk:\n{transcript}\n\n"
        "Return exactly one JSON object and nothing else. Schema:\n"
        '{"coverage_status": "current_slide|other_slide|not_covered", '
        '"matched_slide": <int|null>, "summary_so_far": "<str>", '
        '"topic": "<str|null>", "reason": "<str>"}\n'
    )

    reply = await ask_brev_ollama(prompt)
    parsed = parse_json_reply(reply)
    agent_result = parsed if isinstance(parsed, dict) else {"raw": reply}

    coverage_status = "unknown"
    if isinstance(agent_result, dict):
        raw_status = agent_result.get("coverage_status")
        if raw_status in {"current_slide", "other_slide", "not_covered"}:
            coverage_status = raw_status
    slide_generation_needed = coverage_status == "not_covered"

    generation_queued = False
    if slide_generation_needed and session.deck_id:
        topic = (agent_result.get("topic") or "unknown topic") if isinstance(agent_result, dict) else "unknown topic"
        asyncio.create_task(generate_slide_background(payload.presentation_id, topic, session.current_slide, session))
        generation_queued = True
        slide_generation_needed = False

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
        "generation_queued": generation_queued,
        "backend": "brev",
        "backend_model": BREV_OLLAMA_MODEL,
        "vector_search": {
            "status": vector_search.get("status"),
            "collection_name": vector_search.get("collection_name"),
            "deck_id": vector_search.get("deck_id"),
            "best_distance": vector_search.get("best_distance"),
            "threshold": vector_search.get("threshold"),
            "matches": [
                {
                    "metadata": match.get("metadata", {}),
                    "distance": match.get("distance"),
                    "strong_match": match.get("strong_match"),
                }
                for match in vector_search.get("matches", [])
            ],
        },
    })


@app.get("/presentation/{presentation_id}/generated-slides")
async def get_generated_slides(presentation_id: str):
    return JSONResponse({
        "presentation_id": presentation_id,
        "slides": generated_slides.get(presentation_id, []),
    })


@app.get("/presentation/{presentation_id}")
async def get_presentation(presentation_id: str):
    return presentation_status(get_presentation_session(presentation_id))


@app.post("/sandbox/uploadpptx")
async def upload_pptx_to_sandbox(file: UploadFile = File(...)):
    content = await file.read()
    upload = save_pptx_to_sandbox(file.filename, content)
    deck_index = rebuild_deck_vector_index(
        upload["filename"],
        upload["sandbox_path"],
        content,
        upload["sandbox_dir"],
    )
    return JSONResponse({
        "status": "ok",
        **upload,
        "deck_id": deck_index.deck_id,
        "collection_name": deck_index.collection_name,
        "vectorization_enabled": deck_index.vectorization_status == "ready",
        "vectorization_status": deck_index.vectorization_status,
        "chunks_indexed": deck_index.chunks_indexed,
        "vectorization_error": deck_index.vectorization_error,
        "material_files_indexed": deck_index.material_files_indexed,
        "material_chunks_indexed": deck_index.material_chunks_indexed,
        "material_sandbox_dir": f"{deck_index.sandbox_dir}/materials",
    })


@app.post("/sandbox/presentation-materials")
async def upload_presentation_materials(
    presentation_filename: str = Form(...),
    files: list[UploadFile] = File(...),
):
    safe_presentation_filename = validate_pptx_filename(presentation_filename)
    deck_index = find_deck_index(safe_presentation_filename)
    if not deck_index:
        raise HTTPException(status_code=404, detail=f"presentation not indexed: {safe_presentation_filename}")
    if not files:
        raise HTTPException(status_code=400, detail="no material files provided")

    saved_files = []
    for file in files:
        content = await file.read()
        saved = save_material_to_sandbox(deck_index, file.filename, content)
        saved["content"] = content
        saved_files.append(saved)

    index_result = index_presentation_materials(deck_index, saved_files)
    response_files = [
        {key: value for key, value in saved.items() if key != "content"}
        for saved in saved_files
    ]
    return JSONResponse({
        "status": "ok",
        "presentation_filename": safe_presentation_filename,
        "sandbox_dir": deck_index.sandbox_dir,
        "material_sandbox_dir": f"{deck_index.sandbox_dir}/materials",
        "files": response_files,
        **index_result,
    })


@app.post("/uploadpptx")
async def upload_pptx(file: UploadFile = File(...)):
    content = await file.read()
    upload = save_pptx_to_sandbox(file.filename, content)
    deck_index = rebuild_deck_vector_index(
        upload["filename"],
        upload["sandbox_path"],
        content,
        upload["sandbox_dir"],
    )
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
        "deck_id": deck_index.deck_id,
        "collection_name": deck_index.collection_name,
        "vectorization_enabled": deck_index.vectorization_status == "ready",
        "vectorization_status": deck_index.vectorization_status,
        "chunks_indexed": deck_index.chunks_indexed,
        "vectorization_error": deck_index.vectorization_error,
        "material_files_indexed": deck_index.material_files_indexed,
        "material_chunks_indexed": deck_index.material_chunks_indexed,
        "material_sandbox_dir": f"{deck_index.sandbox_dir}/materials",
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
                "    for current_root, dirs, names in os.walk(root):\n"
                "        if os.path.basename(current_root) == 'materials':\n"
                "            continue\n"
                "        for name in names:\n"
                "            if name.endswith('.pptx'):\n"
                "                path = os.path.join(current_root, name)\n"
                "                stat = os.stat(path)\n"
                "                files.append({\n"
                "                    'filename': name,\n"
                "                    'size_bytes': stat.st_size,\n"
                "                    'uploaded_at': datetime.datetime.utcfromtimestamp(stat.st_mtime).strftime('%Y-%m-%dT%H:%M:%SZ'),\n"
                "                    'sandbox_path': path,\n"
                "                })\n"
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
    deck_index = find_deck_index(filename)
    target = deck_index.sandbox_path if deck_index and deck_index.sandbox_path else f"{SANDBOX_DEST}/{filename}"

    check = subprocess.run(
        ["docker", "exec", container, "test", "-f", target],
        capture_output=True
    )
    if check.returncode != 0:
        finder = subprocess.run(
            [
                "docker", "exec", container, "python3", "-c",
                (
                    "import json, os, sys\n"
                    f"root = {SANDBOX_DEST!r}\n"
                    f"name = {filename!r}\n"
                    "for current_root, dirs, names in os.walk(root):\n"
                    "    if name in names:\n"
                    "        print(os.path.join(current_root, name))\n"
                    "        sys.exit(0)\n"
                    "sys.exit(1)\n"
                ),
            ],
            capture_output=True, text=True,
        )
        if finder.returncode != 0 or not finder.stdout.strip():
            raise HTTPException(status_code=404, detail=f"{filename} not found in sandbox")
        target = finder.stdout.strip().splitlines()[0]

    delete_target = target
    if deck_index and os.path.basename(os.path.dirname(target)).endswith(deck_index.deck_id[:12]):
        delete_target = os.path.dirname(target)
    subprocess.run(
        ["docker", "exec", container, "rm", "-rf", delete_target],
        check=True
    )
    deck_indexes_by_filename.pop(filename, None)
    persist_deck_index_manifest()
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
    ts = time.time()
    msg = {"type": "question", "text": text, "ts": ts}
    await hub.broadcast(msg)
    asyncio.create_task(_answer_audience_question(text, ts))
    return {"status": "ok", "ts": ts}


async def _answer_audience_question(question: str, ts: float) -> None:
    # Find the most recently active session with a vector index
    active = sorted(
        [s for s in presentation_sessions.values() if s.vectorization_status == "ready"],
        key=lambda s: s.updated_at,
        reverse=True,
    )
    vector_context = "[no slide context available]"
    material_context = "[no uploaded supporting-material matches]"
    material_dir = "[no presentation material directory available]"
    if active:
        session = active[0]
        deck_info = find_deck_index(session.file_name)
        vector_search = query_deck_vectors(session, question)
        matches = (vector_search.get("matches") or [])[:3]
        if matches:
            vector_context = "\n\n".join(
                f"Slide {m['metadata'].get('slide_number')}: {m['metadata'].get('title')}\n{m['document'][:500]}"
                for m in matches
            )
        if deck_info:
            material_dir = f"{deck_info.sandbox_dir}/materials"
            material_context = format_material_matches_for_agent(query_material_vectors(deck_info, question))

    prompt = (
        "You are the NemoStage presentation assistant answering a live audience question. "
        "Answer concisely in 2-3 sentences using the slide context and the uploaded "
        "supporting materials for this presentation. The supporting materials live in "
        f"this NemoClaw sandbox directory: {material_dir}. Use files in that directory "
        "as valid presentation materials when they answer the question. If neither the "
        "slides nor supporting materials cover the question, say so briefly.\n\n"
        f"Question: {question}\n\n"
        f"Slide context:\n{vector_context}\n\n"
        f"Retrieved supporting-material context:\n{material_context}\n"
    )
    try:
        answer = await ask_agent_async(prompt, agent="audience", timeout=120)
        entry = {"question": question, "answer": answer, "ts": ts}
        recent_qa.append(entry)
        if len(recent_qa) > MAX_RECENT_QA:
            recent_qa.pop(0)
        await hub.broadcast({"type": "qa_answer", "question": question, "answer": answer, "ts": ts})
    except Exception:
        pass


@app.get("/audience/qa/recent")
async def get_recent_qa(after: float = 0):
    return JSONResponse({"qa": [e for e in recent_qa if e["ts"] > after]})


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
  .answers { display: grid; gap: 12px; margin-top: 10px; }
  .answer-card { padding: 14px; border: 1px solid #2a2a2e; border-radius: 12px; background: #18181b; }
  .answer-card.pending { border-color: #3f3f46; color: #a1a1aa; }
  .answer-card strong { display: block; margin-bottom: 8px; color: #f4f4f5; font-size: 14px; line-height: 1.35; }
  .answer-card p { margin: 0; color: #d4d4d8; font-size: 14px; line-height: 1.45; white-space: pre-wrap; }
  .empty-answers { color: #71717a; font-size: 14px; line-height: 1.45; }
  .toast { position: fixed; bottom: 32px; left: 50%; transform: translateX(-50%) translateY(80px);
           background: #18181b; border: 1px solid #2a2a2e; padding: 12px 22px; border-radius: 999px;
           font-size: 14px; opacity: 0; transition: opacity .25s ease, transform .25s ease;
           pointer-events: none; }
  .toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
</style>
</head>
<body>
  <h1>Ask the speaker</h1>
  <div class="sub">Ask a question or send a quick reaction. Answers appear here when NemoStage responds.</div>

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

  <div class="section-label">Answers</div>
  <div id="emptyAnswers" class="empty-answers">No answered questions yet.</div>
  <div id="answers" class="answers"></div>

  <div id="toast" class="toast"></div>

<script>
const toast = document.getElementById('toast');
const answers = document.getElementById('answers');
const emptyAnswers = document.getElementById('emptyAnswers');
let toastTimer = null;
let lastQaTs = 0;
const pendingQuestions = new Map();
const renderedAnswers = new Set();

function showToast(msg) {
  toast.textContent = msg;
  toast.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 1700);
}

function setAnswersEmptyState() {
  emptyAnswers.style.display = answers.children.length ? 'none' : 'block';
}

function renderAnswer(entry, pending = false) {
  const key = String(entry.ts);
  if (!pending && renderedAnswers.has(key)) return;

  const card = document.createElement('article');
  card.className = `answer-card${pending ? ' pending' : ''}`;
  card.dataset.ts = key;

  const question = document.createElement('strong');
  question.textContent = entry.question || 'Question';
  card.appendChild(question);

  const answer = document.createElement('p');
  answer.textContent = pending ? 'Waiting for NemoStage to answer...' : entry.answer;
  card.appendChild(answer);

  const existing = Array.from(answers.children).find((child) => child.dataset.ts === key);
  if (existing) {
    existing.replaceWith(card);
  } else {
    answers.prepend(card);
  }

  if (!pending) renderedAnswers.add(key);
  while (answers.children.length > 10) answers.lastElementChild.remove();
  setAnswersEmptyState();
}

async function pollAnswers() {
  try {
    const r = await fetch(`/audience/qa/recent?after=${encodeURIComponent(lastQaTs)}`);
    if (!r.ok) throw new Error();
    const data = await r.json();
    for (const entry of data.qa || []) {
      renderAnswer(entry, false);
      pendingQuestions.delete(String(entry.ts));
      lastQaTs = Math.max(lastQaTs, entry.ts);
    }
  } catch {
    // Keep the page quiet; the next poll can recover.
  }
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
    const data = await r.json();
    ta.value = '';
    const pending = { question: text, answer: '', ts: data.ts || Date.now() / 1000 };
    pendingQuestions.set(String(pending.ts), pending);
    renderAnswer(pending, true);
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

setAnswersEmptyState();
pollAnswers();
setInterval(pollAnswers, 3000);
</script>
</body>
</html>
"""


@app.get("/audience", response_class=HTMLResponse)
def audience_page():
    return AUDIENCE_HTML
