import json, shutil, subprocess, logging
log = logging.getLogger("edgevision")

class MediaError(Exception): pass

def require_ffmpeg():
    if not (shutil.which("ffmpeg") and shutil.which("ffprobe")):
        raise MediaError("FFmpeg/FFprobe not found. Install it (`sudo apt install ffmpeg` / `brew install ffmpeg`) and restart.")

def probe(path: str) -> dict:
    require_ffmpeg()
    r = subprocess.run(["ffprobe", "-v", "error", "-print_format", "json", "-show_streams", "-show_format", path],
                       capture_output=True, text=True, timeout=60)
    if r.returncode: log.error("ffprobe: %s", r.stderr); raise MediaError("Could not read this file as a video.")
    d = json.loads(r.stdout); v = next((s for s in d["streams"] if s["codec_type"] == "video"), None)
    a = next((s for s in d["streams"] if s["codec_type"] == "audio"), None)
    if not v: raise MediaError("No video stream found.")
    n, dd = (v.get("avg_frame_rate") or "0/1").split("/"); fps = float(n) / float(dd) if float(dd or 0) else 0
    rot = int(v.get("tags", {}).get("rotate", 0))
    for sd in v.get("side_data_list", []): rot = int(sd.get("rotation", rot))
    w, h = int(v["width"]), int(v["height"])
    if abs(rot) in (90, 270): w, h = h, w            # display size after ffmpeg auto-rotation
    dur = float(d["format"].get("duration") or v.get("duration") or 0)
    if w <= 0 or h <= 0 or fps <= 0 or dur <= 0: raise MediaError("Video has no readable frames.")
    return dict(width=w, height=h, fps=round(fps, 3), duration=round(dur, 3), video_codec=v.get("codec_name"),
                pix_fmt=v.get("pix_fmt"), rotation=rot, bitrate=int(d["format"].get("bit_rate") or 0),
                has_audio=a is not None, audio_codec=a and a.get("codec_name"),
                sample_rate=a and int(a.get("sample_rate", 0)), channels=a and a.get("channels"),
                frames=int(v.get("nb_frames") or round(dur * fps)))

PRESETS = {"9:16": (1080, 1920), "16:9": (1920, 1080), "1:1": (1080, 1080)}

def output_size(info, preset):
    """Never upscales, never stretches (aspect presets letterbox with black)."""
    w, h = info["width"], info["height"]; ev = lambda x: max(2, int(x) // 2 * 2)
    if preset in PRESETS:
        cw, ch = PRESETS[preset]; k = min(1.0, max(w, h) / max(cw, ch)); return ev(cw * k), ev(ch * k)
    if preset in ("720p", "1080p"):
        k = min(1.0, (720 if preset == "720p" else 1080) / min(w, h)); return ev(w * k), ev(h * k)
    return ev(w), ev(h)

def decoder(path, info, ow, oh, limit=None):
    w, h = info["width"], info["height"]; k = min(ow / w, oh / h)
    sw, sh = max(2, int(w * k) // 2 * 2), max(2, int(h * k) // 2 * 2)
    vf = f"scale={sw}:{sh}:flags=lanczos,pad={ow}:{oh}:(ow-iw)/2:(oh-ih)/2:black,format=bgr24"
    cmd = ["ffmpeg", "-v", "error", "-i", path] + (["-t", str(limit)] if limit else []) + ["-an", "-vf", vf, "-f", "rawvideo", "-"]
    return subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=ow * oh * 3 * 4)

def encoder(src, out, info, ow, oh, limit=None):
    """Gray frames on stdin + original audio from src. Stream-copied when MP4-compatible, else AAC fallback."""
    audio = ["-c:a", "copy"] if info["audio_codec"] in ("aac", "mp3", "ac3", "alac") else ["-c:a", "aac", "-b:a", "256k"]
    cmd = ["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "gray", "-s", f"{ow}x{oh}", "-r", str(info["fps"]), "-i", "pipe:0"]
    if info["has_audio"]: cmd += ["-i", src] + (["-t", str(limit)] if limit else []) + ["-map", "0:v:0", "-map", "1:a:0"] + audio
    else: cmd += ["-map", "0:v:0"]
    cmd += ["-c:v", "libx264", "-preset", "medium", "-crf", "16", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out]
    return subprocess.Popen(cmd, stdin=subprocess.PIPE, stderr=subprocess.PIPE)
