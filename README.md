# EdgeVision — see video differently

Video in → clean edge-detection video out, original audio untouched (stream copy when the codec is MP4-compatible: AAC/MP3/AC3; otherwise 256k AAC fallback).

## Requirements
Python 3.10+, Node 18+, **FFmpeg + FFprobe on PATH** (the API reports a clear error if missing).

## Run
    cd backend && pip install -r requirements.txt && uvicorn app.main:app --reload     # :8000
    cd frontend && npm install && npm run dev                                           # :5173 (proxies /api)

## Pipeline
ffprobe → ffmpeg decode (streamed raw frames, never whole video in RAM) → bilateral + Gaussian denoise → CLAHE → Canny
→ morphological close → small-component removal → motion-aware temporal EMA + cross-frame hysteresis → thickness
→ ffmpeg x264 encode + original audio mux. Code: `backend/app/cv/pipeline.py`. Add modes via `PROFILES`.

## Notes
Single worker (one job at a time), in-memory job store, CPU only. Uploads: extension + MIME + ffprobe validation, 2 GB cap, UUID filenames, argument-array subprocess calls only.
