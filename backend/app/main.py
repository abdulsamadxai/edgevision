import logging, re, subprocess
from pathlib import Path
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from .cv.pipeline import Params, PROFILES
from .services import ffmpeg_service as ff, jobs as J
import os
logging.basicConfig(level=logging.INFO)
app = FastAPI(title="EdgeVision")
allowed_origins = os.getenv("ALLOWED_ORIGINS", "*").split(",")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"] if "*" in allowed_origins else allowed_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)
MAX_BYTES = 2 * 1024**3; EXTS = {".mp4", ".mov", ".avi", ".webm", ".mkv", ".m4v"}

class ProcessRequest(BaseModel):
    mode: str = "clean_canny"; low: int = Field(50, ge=0, le=255); high: int = Field(150, ge=1, le=500)
    noise_removal: int = Field(50, ge=0, le=100); detail: int = Field(50, ge=0, le=100)
    thickness: int = Field(30, ge=0, le=100); stability: int = Field(60, ge=0, le=100)
    output: str = "original"; preview: bool = False

def job_or_404(jid):
    if not re.fullmatch(r"[0-9a-f]{32}", jid) or jid not in J.JOBS: raise HTTPException(404, "Job not found")
    return J.JOBS[jid]

def public(j):
    return {k: v for k, v in j.items() if k not in ("src", "cancel")}

@app.on_event("startup")
def check(): ff.require_ffmpeg()

@app.get("/api/health")
def health():
    try: ff.require_ffmpeg(); return {"ok": True, "modes": list(PROFILES)}
    except ff.MediaError as e: return {"ok": False, "error": str(e)}

@app.post("/api/videos/upload")
async def upload(file: UploadFile = File(...)):
    ext = Path(file.filename or "").suffix.lower()           # filename never used on disk
    if ext not in EXTS: raise HTTPException(415, f"Unsupported format. Allowed: {', '.join(sorted(EXTS))}")
    if file.content_type and not file.content_type.startswith(("video/", "application/octet-stream")): raise HTTPException(415, "Not a video file.")
    jid_tmp = __import__("uuid").uuid4().hex; dest = J.ROOT / "uploads" / f"{jid_tmp}{ext}"; size = 0
    with dest.open("wb") as f:
        while chunk := await file.read(1 << 20):
            size += len(chunk)
            if size > MAX_BYTES: f.close(); dest.unlink(missing_ok=True); raise HTTPException(413, "File exceeds 2 GB limit.")
            f.write(chunk)
    try: info = ff.probe(str(dest))
    except ff.MediaError as e: dest.unlink(missing_ok=True); raise HTTPException(422, str(e))
    except subprocess.TimeoutExpired: dest.unlink(missing_ok=True); raise HTTPException(422, "File took too long to inspect (corrupted?).")
    job = J.new_job(dest, info, re.sub(r"[^\w.\- ]", "_", file.filename or "video")[:80])
    return public(job)

@app.post("/api/videos/{jid}/process")
def process(jid: str, req: ProcessRequest):
    job = job_or_404(jid)
    if req.mode not in PROFILES: raise HTTPException(422, "Unknown mode")
    if req.output not in ("original", "720p", "1080p", "9:16", "16:9", "1:1"): raise HTTPException(422, "Unknown output preset")
    if job["status"] == "processing": raise HTTPException(409, "Already processing")
    p = Params(req.mode, req.low, max(req.high, req.low + 1), req.noise_removal, req.detail, req.thickness, req.stability)
    job.update(status="queued", progress=0, stage="Queued", preset=req.output)
    J.POOL.submit(J.run, job, p, req.output, req.preview)
    return public(job)

@app.get("/api/videos/{jid}/status")
def status(jid: str): return public(job_or_404(jid))

@app.get("/api/videos/{jid}/original")
def original(jid: str): return FileResponse(job_or_404(jid)["src"])

@app.get("/api/videos/{jid}/preview")
def preview(jid: str):
    job_or_404(jid); f = J.ROOT / "previews" / f"{jid}.mp4"
    if not f.exists(): raise HTTPException(404, "No preview yet")
    return FileResponse(f, media_type="video/mp4")

@app.get("/api/videos/{jid}/download")
def download(jid: str):
    job_or_404(jid); f = J.ROOT / "outputs" / f"{jid}.mp4"
    if not f.exists(): raise HTTPException(404, "Output not ready")
    return FileResponse(f, media_type="video/mp4", filename="edgevision.mp4")

@app.delete("/api/videos/{jid}")
def delete(jid: str):
    job = job_or_404(jid); job["cancel"] = True; J.cleanup(jid); return {"deleted": True}
