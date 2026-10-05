import time, uuid, logging, numpy as np
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from ..cv.pipeline import EdgeProcessor, Params
from . import ffmpeg_service as ff
log = logging.getLogger("edgevision")
ROOT = Path(__file__).resolve().parents[2] / "storage"
STAGES = ["Reading video", "Analyzing frames", "Removing noise", "Detecting edges", "Stabilizing edges",
          "Reconstructing video", "Restoring original audio", "Finalizing output"]
JOBS: dict[str, dict] = {}; POOL = ThreadPoolExecutor(max_workers=1)

def new_job(path, info, name):
    jid = Path(path).stem
    JOBS[jid] = dict(id=jid, src=str(path), info=info, filename=name, status="uploaded", stage="", progress=0.0, error=None, cancel=False)
    return JOBS[jid]

def run(job, params: Params, preset: str, preview: bool):
    jid, info = job["id"], job["info"]; kind = "previews" if preview else "outputs"
    out, tmp = ROOT / kind / f"{jid}.mp4", ROOT / kind / f"{jid}.part.mp4"; limit = 8 if preview else None
    job.update(status="processing", progress=0, error=None, cancel=False, preview=preview, mode=params.mode, stage=STAGES[0])
    dec = enc = None
    try:
        ow, oh = ff.output_size(info, preset); job.update(out_width=ow, out_height=oh)
        dec = ff.decoder(job["src"], info, ow, oh, limit); enc = ff.encoder(job["src"], str(tmp), info, ow, oh, limit)
        proc, fsize, n = EdgeProcessor(params), ow * oh * 3, 0
        total = max(1, int((min(limit, info["duration"]) if limit else info["duration"]) * info["fps"]))
        while True:
            if job["cancel"]: raise InterruptedError
            buf = dec.stdout.read(fsize)
            if len(buf) < fsize: break
            enc.stdin.write(proc.process(np.frombuffer(buf, np.uint8).reshape(oh, ow, 3)).tobytes()); n += 1
            job.update(stage=STAGES[1 + min(4, int(5 * n / total))], progress=min(0.97, n / total * 0.97))
        if n == 0: raise ff.MediaError("Video has no decodable frames.")
        job.update(stage=STAGES[6], progress=0.98)
        if enc.stdin: enc.stdin.close()
        if enc.wait(300) != 0:
            err_msg = enc.stderr.read().decode("utf-8", errors="replace") if enc.stderr else ""
            log.error("FFmpeg encode error on job %s: %s", jid, err_msg)
            raise ff.MediaError(f"Encoding failed: {err_msg[:200] if err_msg else 'unknown error'}")
        job.update(stage=STAGES[7]); tmp.replace(out)
        job.update(status="done", progress=1.0, stage="Done", frames_written=n, out_info=ff.probe(str(out)))
    except InterruptedError: job.update(status="cancelled", stage="Cancelled")
    except ff.MediaError as e: job.update(status="failed", error=str(e))
    except Exception:
        log.exception("job %s failed", jid); job.update(status="failed", error="Processing failed. Details are in the server log.")
    finally:
        for p in (dec, enc):
            if p and p.poll() is None: p.kill()
        tmp.unlink(missing_ok=True)

def cleanup(jid):
    for k in ("uploads", "outputs", "previews"):
        for f in (ROOT / k).glob(f"{jid}*"): f.unlink(missing_ok=True)
    JOBS.pop(jid, None)
