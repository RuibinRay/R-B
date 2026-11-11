"""R&B separation server.

A small FastAPI service that runs the Demucs source-separation model for the
"AI Stem Separator" page. Uploads are size-limited, processed one at a time in a
background worker, and deleted after download (or after an hour).

Run:  uvicorn main:app --port 8000
"""

from __future__ import annotations

import importlib.util
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

MAX_BYTES = int(os.environ.get("RNB_MAX_MB", "100")) * 1024 * 1024
MAX_MINUTES = int(os.environ.get("RNB_MAX_MINUTES", "10"))
JOB_TTL_SECONDS = 60 * 60
ALLOWED_EXTENSIONS = {".mp3", ".wav", ".flac", ".ogg", ".oga", ".m4a", ".aac", ".aif", ".aiff", ".wma", ".opus"}
MODELS = {2: "htdemucs", 4: "htdemucs", 6: "htdemucs_6s"}
WORK_DIR = Path(os.environ.get("RNB_WORK_DIR", tempfile.gettempdir())) / "rnb-stems"
WORK_DIR.mkdir(parents=True, exist_ok=True)

# Any localhost port is allowed (the dev server picks its own); add deployed
# front-end origins with RNB_ALLOWED_ORIGINS="https://you.github.io,https://example.com".
EXTRA_ORIGINS = [o.strip() for o in os.environ.get("RNB_ALLOWED_ORIGINS", "").split(",") if o.strip()]

app = FastAPI(title="R&B separation server", version="1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=EXTRA_ORIGINS,
    allow_origin_regex=r"https?://(localhost|127\.0\.0\.1)(:\d+)?",
    allow_methods=["GET", "POST", "DELETE"],
    allow_headers=["*"],
)

jobs: dict[str, dict] = {}
jobs_lock = threading.Lock()
worker = ThreadPoolExecutor(max_workers=1)  # one separation at a time keeps memory bounded


def demucs_available() -> bool:
    return importlib.util.find_spec("demucs") is not None


_device: str | None = None


def pick_device() -> str:
    """cuda when present, otherwise cpu. Set RNB_DEVICE=mps to try Apple GPU acceleration."""
    global _device
    if _device is None:
        _device = os.environ.get("RNB_DEVICE") or "cpu"
        if not os.environ.get("RNB_DEVICE"):
            try:
                import torch  # slow to import the first time, so the answer is cached

                if torch.cuda.is_available():
                    _device = "cuda"
            except Exception:
                pass
    return _device


def probe_duration(path: Path) -> float | None:
    """Length in seconds via ffprobe, or None when ffprobe is not installed or cannot read the file."""
    if not shutil.which("ffprobe"):
        return None
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
            capture_output=True, text=True, timeout=30, check=True,
        )
        return float(out.stdout.strip())
    except Exception:
        return None


def public(job: dict) -> dict:
    return {k: job[k] for k in ("id", "status", "progress", "message", "error", "stems")}


def update(job_id: str, **fields) -> None:
    with jobs_lock:
        if job_id in jobs:
            jobs[job_id].update(fields)


def remove(job_id: str) -> None:
    with jobs_lock:
        job = jobs.pop(job_id, None)
    if job:
        proc = job.get("proc")
        if proc and proc.poll() is None:
            proc.kill()
        shutil.rmtree(job["dir"], ignore_errors=True)


def run_separation(job_id: str, source: Path, stems: int) -> None:
    job_dir = source.parent
    out_dir = job_dir / "out"
    model = MODELS[stems]
    cmd = [sys.executable, "-m", "demucs", "-n", model, "-o", str(out_dir), "--filename", "{stem}.{ext}", "-d", pick_device()]
    if stems == 2:
        cmd += ["--two-stems", "vocals"]
    cmd.append(str(source))
    update(job_id, status="running", message="Loading the model (the first run downloads it)…")
    try:
        proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        update(job_id, proc=proc)
        tail = bytearray()
        chunk = bytearray()
        assert proc.stderr is not None
        # Demucs reports progress with a tqdm bar on stderr, redrawn with carriage returns.
        while True:
            byte = proc.stderr.read(1)
            if not byte:
                break
            tail += byte
            del tail[:-4000]
            if byte in (b"\r", b"\n"):
                match = re.search(rb"(\d+)%\|", bytes(chunk))
                if match:
                    update(job_id, progress=min(0.99, int(match.group(1)) / 100), message="Separating…")
                chunk.clear()
            else:
                chunk += byte
        code = proc.wait()
        if job_id not in jobs:
            return  # cancelled and cleaned up
        if code != 0:
            lines = [l for l in tail.decode("utf-8", "ignore").replace("\r", "\n").splitlines() if l.strip() and "%|" not in l]
            raise RuntimeError(lines[-1] if lines else f"Demucs exited with code {code}")
        produced = sorted((out_dir / model).glob("*.wav"))
        if not produced:
            raise RuntimeError("Demucs finished but wrote no stems.")
        order = ["vocals", "no_vocals", "drums", "bass", "guitar", "piano", "other"]
        produced.sort(key=lambda p: order.index(p.stem) if p.stem in order else len(order))
        source.unlink(missing_ok=True)
        update(
            job_id, status="done", progress=1.0, message="Done",
            stems=[{"name": p.stem, "url": f"/api/jobs/{job_id}/stems/{p.stem}"} for p in produced],
            files={p.stem: p for p in produced},
        )
    except Exception as exc:  # noqa: BLE001 - report every failure to the client
        update(job_id, status="error", error=str(exc)[:500], message="Failed")


def sweep() -> None:
    while True:
        time.sleep(300)
        cutoff = time.time() - JOB_TTL_SECONDS
        for job_id in [j for j, job in list(jobs.items()) if job["created"] < cutoff]:
            remove(job_id)


threading.Thread(target=sweep, daemon=True).start()
threading.Thread(target=pick_device, daemon=True).start()  # warm up so /api/health answers quickly


@app.get("/api/health")
def health() -> dict:
    return {
        "ok": True,
        "demucs": demucs_available(),
        "device": pick_device(),
        "ffmpeg": shutil.which("ffmpeg") is not None,
        "max_minutes": MAX_MINUTES,
        "detail": None if demucs_available() else "run: pip install -r requirements.txt",
    }


@app.post("/api/separate")
async def separate(file: UploadFile = File(...), stems: int = Form(4)) -> dict:
    if stems not in MODELS:
        raise HTTPException(400, "stems must be 2, 4 or 6.")
    ext = Path(file.filename or "").suffix.lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(415, "Unsupported file type. Upload MP3, WAV, FLAC, OGG or M4A audio.")
    if not demucs_available():
        raise HTTPException(503, "Demucs is not installed on the server. Run: pip install -r requirements.txt")

    job_id = uuid.uuid4().hex
    job_dir = WORK_DIR / job_id
    job_dir.mkdir(parents=True)
    source = job_dir / f"input{ext}"  # never trust the client's file name for a path
    size = 0
    try:
        with source.open("wb") as fh:
            while chunk := await file.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_BYTES:
                    raise HTTPException(413, f"File is larger than {MAX_BYTES // (1024 * 1024)} MB.")
                fh.write(chunk)
        if size == 0:
            raise HTTPException(400, "The uploaded file is empty.")
        duration = probe_duration(source)
        if duration is not None and duration > MAX_MINUTES * 60:
            raise HTTPException(413, f"Songs longer than {MAX_MINUTES} minutes are not accepted.")
    except HTTPException:
        shutil.rmtree(job_dir, ignore_errors=True)
        raise

    job = {"id": job_id, "status": "queued", "progress": 0.0, "message": "Waiting in the queue…", "error": None, "stems": None,
           "dir": job_dir, "created": time.time(), "proc": None, "files": {}}
    with jobs_lock:
        jobs[job_id] = job
    worker.submit(run_separation, job_id, source, stems)
    return public(job)


@app.get("/api/jobs/{job_id}")
def job_status(job_id: str) -> dict:
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(404, "Unknown or expired job.")
    return public(job)


@app.get("/api/jobs/{job_id}/stems/{name}")
def stem(job_id: str, name: str) -> FileResponse:
    job = jobs.get(job_id)
    path = job["files"].get(name) if job else None  # only names the job produced; no path input
    if not path or not Path(path).exists():
        raise HTTPException(404, "Stem not found.")
    return FileResponse(path, media_type="audio/wav", filename=f"{name}.wav")


@app.delete("/api/jobs/{job_id}")
def delete_job(job_id: str) -> dict:
    remove(job_id)
    return {"ok": True}
