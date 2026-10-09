import { useEffect, useRef, useState } from "react";
import {
  CVParams,
  PROFILES,
  VideoMeta
} from "./cv/pipeline";
import {
  ClientVideoProcessor,
  probeVideoFile,
  createDemoVideo,
  ProcessingProgress
} from "./cv/browserProcessor";

interface JobState {
  id: string;
  filename: string;
  file?: File;
  info: VideoMeta;
  status: "idle" | "uploaded" | "processing" | "done" | "failed";
  stage: string;
  progress: number;
  error?: string | null;
  preview?: boolean;
  mode?: string;
  out_width?: number;
  out_height?: number;
  resultUrl?: string;
  originalUrl?: string;
  engine: "browser" | "cloud";
}

const MODES = [
  { id: "clean_canny", name: "Clean Canny", desc: "Balanced contours with adaptive contrast" },
  { id: "ultra_clean", name: "Ultra Clean", desc: "High noise suppression with bold strokes" },
  { id: "fine_detail", name: "Fine Detail", desc: "Captures intricate textures & micro-edges" },
  { id: "architecture", name: "Architecture", desc: "Emphasizes geometric lines & structures" }
];

const OUTPUTS = [
  { id: "original", label: "Original resolution" },
  { id: "1080p", label: "1080p Full HD" },
  { id: "720p", label: "720p HD (Faster)" },
  { id: "9:16", label: "9:16 (Reels/TikTok)" },
  { id: "16:9", label: "16:9 (Landscape)" },
  { id: "1:1", label: "1:1 (Square)" }
];

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

function Slider({
  label,
  value,
  onChange,
  max = 100,
  min = 0,
  suffix = ""
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  max?: number;
  min?: number;
  suffix?: string;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex justify-between items-center text-xs">
        <span className="text-slate-300 font-medium">{label}</span>
        <span className="text-sky-400 font-mono text-xs tabular-nums bg-sky-950/60 px-2 py-0.5 rounded border border-sky-800/40">
          {value}{suffix}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(+e.target.value)}
        className="w-full cursor-pointer"
      />
    </div>
  );
}

export default function App() {
  const [job, setJob] = useState<JobState | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [engine, setEngine] = useState<"browser" | "cloud">("browser");
  const [customApiUrl, setCustomApiUrl] = useState(() => {
    return localStorage.getItem("edgevision_api_url") || import.meta.env.VITE_API_URL || "";
  });
  const [apiOnline, setApiOnline] = useState<boolean | null>(null);
  const [showSettings, setShowSettings] = useState(false);

  // Settings
  const [s, setS] = useState<CVParams>({
    mode: "clean_canny",
    low: 50,
    high: 150,
    noise_removal: 50,
    detail: 50,
    thickness: 30,
    stability: 60,
    output: "original"
  });

  const [rev, setRev] = useState(0);
  const origVideo = useRef<HTMLVideoElement>(null);
  const edgeVideo = useRef<HTMLVideoElement>(null);
  const livePreviewCanvas = useRef<HTMLCanvasElement>(null);
  const browserProcessorRef = useRef<ClientVideoProcessor | null>(null);

  const cleanApiUrl = customApiUrl.replace(/\/$/, "");

  // Check health of cloud API if configured
  useEffect(() => {
    if (!cleanApiUrl) {
      setApiOnline(false);
      return;
    }
    let active = true;
    fetch(`${cleanApiUrl}/api/health`, { method: "GET", signal: AbortSignal.timeout(3000) })
      .then((r) => r.ok)
      .then((ok) => {
        if (active) setApiOnline(ok);
      })
      .catch(() => {
        if (active) setApiOnline(false);
      });
    return () => {
      active = false;
    };
  }, [cleanApiUrl]);

  // Cloud polling for job status
  useEffect(() => {
    if (!job || job.engine !== "cloud" || !["uploaded", "processing"].includes(job.status)) return;
    if (job.status === "uploaded") return;

    let failCount = 0;
    const t = setInterval(async () => {
      try {
        const r = await fetch(`${cleanApiUrl}/api/videos/${job.id}/status`);
        if (r.ok) {
          const j = await r.json();
          setJob((prev) => (prev ? { ...prev, ...j } : null));
          if (j.status === "done") setRev((x) => x + 1);
        } else {
          failCount++;
          if (failCount > 10) {
            clearInterval(t);
            setErr("Connection to cloud backend lost. Try using the Standalone Browser Engine.");
          }
        }
      } catch {
        failCount++;
        if (failCount > 10) {
          clearInterval(t);
          setErr("Network error communicating with backend.");
        }
      }
    }, 800);
    return () => clearInterval(t);
  }, [job?.id, job?.status, job?.engine, cleanApiUrl]);

  const setParam = (k: keyof CVParams) => (v: any) => setS((p) => ({ ...p, [k]: v }));

  async function handleFile(file: File) {
    setErr(null);
    setBusy(true);

    if (engine === "cloud" && cleanApiUrl && apiOnline) {
      // Cloud API upload
      try {
        const fd = new FormData();
        fd.append("file", file);
        const r = await fetch(`${cleanApiUrl}/api/videos/upload`, { method: "POST", body: fd });
        if (!r.ok) {
          const errData = await r.json().catch(() => ({}));
          throw new Error(errData.detail || `Server returned error (${r.status})`);
        }
        const data = await r.json();
        setJob({
          id: data.id,
          filename: data.filename,
          file,
          info: data.info,
          status: "uploaded",
          stage: "Ready for processing",
          progress: 0,
          originalUrl: `${cleanApiUrl}/api/videos/${data.id}/original`,
          engine: "cloud"
        });
      } catch (e: any) {
        console.warn("Cloud upload failed, switching to in-browser engine:", e);
        setErr(`Cloud backend unreachable (${e.message}). Switched to Standalone Browser Engine.`);
        setEngine("browser");
        // Fallback to local probe
        await probeLocal(file);
      } finally {
        setBusy(false);
      }
    } else {
      // Standalone In-Browser engine
      await probeLocal(file);
      setBusy(false);
    }
  }

  async function probeLocal(file: File) {
    try {
      const meta = await probeVideoFile(file);
      const originalUrl = URL.createObjectURL(file);
      const jid = "local_" + Math.random().toString(36).substring(2, 10);
      setJob({
        id: jid,
        filename: file.name,
        file,
        info: meta,
        status: "uploaded",
        stage: "Video loaded. Ready for edge synthesis.",
        progress: 0,
        originalUrl,
        engine: "browser"
      });
    } catch (e: any) {
      setErr(e.message || "Failed to inspect video file.");
    }
  }

  async function loadDemoVideo() {
    setBusy(true);
    setErr(null);
    try {
      const demoFile = await createDemoVideo();
      await probeLocal(demoFile);
    } catch (e: any) {
      setErr("Failed to create demo video: " + e.message);
    } finally {
      setBusy(false);
    }
  }

  async function startProcessing(preview: boolean) {
    if (!job || !job.file) return;
    setErr(null);

    if (job.engine === "cloud" && cleanApiUrl) {
      // Cloud API Processing
      try {
        const r = await fetch(`${cleanApiUrl}/api/videos/${job.id}/process`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...s, preview, output: s.output || "original" })
        });
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          throw new Error(j.detail || "Failed to start cloud processing.");
        }
        setJob((prev) => prev ? { ...prev, status: "processing", preview } : null);
      } catch (e: any) {
        setErr(e.message + " — You can switch to the Standalone Browser Engine above.");
      }
      return;
    }

    // In-Browser Processing
    const processor = new ClientVideoProcessor();
    browserProcessorRef.current = processor;

    setJob((prev) =>
      prev
        ? {
            ...prev,
            status: "processing",
            stage: "Initializing computer vision pipeline…",
            progress: 0.05,
            preview
          }
        : null
    );

    try {
      const result = await processor.process(
        job.file,
        { ...s, preview },
        s.output || "original",
        preview,
        (progressInfo: ProcessingProgress) => {
          setJob((prev) =>
            prev
              ? {
                  ...prev,
                  progress: progressInfo.progress,
                  stage: progressInfo.stage
                }
              : null
          );
        },
        livePreviewCanvas.current
      );

      setJob((prev) =>
        prev
          ? {
              ...prev,
              status: "done",
              stage: "Done",
              progress: 1.0,
              resultUrl: result.url,
              out_width: result.width,
              out_height: result.height,
              preview
            }
          : null
      );
      setRev((x) => x + 1);
    } catch (e: any) {
      if (e.message?.includes("cancelled")) {
        setJob((prev) => (prev ? { ...prev, status: "uploaded", stage: "Cancelled" } : null));
      } else {
        console.error("Browser processing failed:", e);
        setJob((prev) =>
          prev ? { ...prev, status: "failed", error: e.message || "Processing failed" } : null
        );
        setErr(e.message || "Failed to process video.");
      }
    }
  }

  function cancelProcessing() {
    if (browserProcessorRef.current) {
      browserProcessorRef.current.cancel();
    }
    if (job?.engine === "cloud" && cleanApiUrl) {
      fetch(`${cleanApiUrl}/api/videos/${job.id}`, { method: "DELETE" }).catch(() => {});
    }
    setJob(null);
  }

  // Synchronized playback controls
  const syncPlayers = (action: "play" | "pause" | "seek") => {
    const o = origVideo.current;
    const e = edgeVideo.current;
    if (!o || !e) return;
    if (action === "play") {
      e.currentTime = o.currentTime;
      e.play().catch(() => {});
    } else if (action === "pause") {
      e.pause();
    } else if (action === "seek") {
      e.currentTime = o.currentTime;
    }
  };

  const isWorking = job && ["processing"].includes(job.status);
  const isDone = job?.status === "done";

  return (
    <div className="min-h-screen grid-bg flex flex-col selection:bg-sky-500/30 selection:text-sky-200">
      {/* Top Navbar */}
      <header className="border-b border-white/10 glass-panel sticky top-0 z-50">
        <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-tr from-sky-500 to-indigo-500 flex items-center justify-center shadow-lg shadow-sky-500/20">
              <span className="font-mono font-black text-black text-sm">EV</span>
            </div>
            <div>
              <span className="font-bold tracking-wider text-sm bg-gradient-to-r from-white to-slate-400 bg-clip-text text-transparent">
                EDGEVISION
              </span>
              <span className="hidden sm:inline text-[11px] text-slate-500 ml-2 font-mono">
                v2.0 • Computer Vision
              </span>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {/* Engine Status Pill */}
            <div
              className={`flex items-center gap-2 px-3 py-1 rounded-full text-xs font-medium border transition-all ${
                engine === "browser"
                  ? "bg-sky-950/40 border-sky-500/30 text-sky-300"
                  : apiOnline
                  ? "bg-emerald-950/40 border-emerald-500/30 text-emerald-300"
                  : "bg-amber-950/40 border-amber-500/30 text-amber-300"
              }`}
            >
              <span
                className={`w-2 h-2 rounded-full ${
                  engine === "browser"
                    ? "bg-sky-400 animate-pulse"
                    : apiOnline
                    ? "bg-emerald-400"
                    : "bg-amber-400"
                }`}
              />
              <span>
                {engine === "browser"
                  ? "⚡ In-Browser Engine"
                  : apiOnline
                  ? "🟢 Cloud API Active"
                  : "⚠️ Cloud Offline"}
              </span>
            </div>

            <button
              onClick={() => setShowSettings(!showSettings)}
              className="p-1.5 rounded-lg border border-white/10 hover:border-white/30 text-slate-400 hover:text-white transition-colors"
              title="Configure API Engine"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </button>
          </div>
        </div>

        {/* Settings Drawer */}
        {showSettings && (
          <div className="border-t border-white/10 bg-slate-950/90 px-6 py-4 animate-in fade-in slide-in-from-top-2 duration-200">
            <div className="max-w-6xl mx-auto flex flex-wrap items-center justify-between gap-4 text-xs">
              <div className="flex items-center gap-3">
                <span className="text-slate-400 font-medium">Processing Engine:</span>
                <button
                  onClick={() => setEngine("browser")}
                  className={`px-3 py-1 rounded font-medium transition-all ${
                    engine === "browser"
                      ? "bg-sky-500 text-black shadow-lg shadow-sky-500/20"
                      : "bg-slate-800 text-slate-300 hover:bg-slate-700"
                  }`}
                >
                  ⚡ In-Browser (Instant, Zero Server, No Cost)
                </button>
                <button
                  onClick={() => setEngine("cloud")}
                  className={`px-3 py-1 rounded font-medium transition-all ${
                    engine === "cloud"
                      ? "bg-sky-500 text-black shadow-lg shadow-sky-500/20"
                      : "bg-slate-800 text-slate-300 hover:bg-slate-700"
                  }`}
                >
                  🌐 Cloud API (FastAPI + OpenCV)
                </button>
              </div>

              {engine === "cloud" && (
                <div className="flex items-center gap-2 flex-1 max-w-md">
                  <input
                    type="url"
                    placeholder="https://your-backend.railway.app or http://localhost:8000"
                    value={customApiUrl}
                    onChange={(e) => {
                      setCustomApiUrl(e.target.value);
                      localStorage.setItem("edgevision_api_url", e.target.value);
                    }}
                    className="flex-1 bg-black/60 border border-white/20 rounded px-3 py-1.5 text-white placeholder-slate-600 font-mono text-xs focus:outline-none focus:border-sky-400"
                  />
                  <span
                    className={`px-2 py-1 rounded text-[11px] font-mono ${
                      apiOnline ? "bg-emerald-950 text-emerald-400" : "bg-rose-950 text-rose-400"
                    }`}
                  >
                    {apiOnline ? "ONLINE" : "OFFLINE"}
                  </span>
                </div>
              )}
            </div>
          </div>
        )}
      </header>

      {/* Hero Banner */}
      <div className="max-w-4xl mx-auto px-6 pt-12 pb-6 text-center">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-sky-500/10 border border-sky-500/20 text-sky-400 text-xs font-mono uppercase tracking-wider mb-5">
          <span className="w-1.5 h-1.5 rounded-full bg-sky-400 animate-ping" />
          Autonomous Video Edge Synthesizer
        </div>
        <h1 className="text-4xl sm:text-6xl font-extrabold tracking-tight gradient-text">
          Turn any video into clean computer-vision edge art.
        </h1>
        <p className="text-slate-400 mt-4 text-base sm:text-lg max-w-2xl mx-auto leading-relaxed">
          Upload any clip. Every frame is processed with sub-pixel edge detection, motion-aware
          temporal smoothing, and authentic audio preservation.
        </p>
      </div>

      {/* Main Content Area */}
      <main className="max-w-6xl mx-auto px-6 py-6 flex-1 w-full space-y-6">
        {err && (
          <div className="bg-rose-950/60 border border-rose-500/40 rounded-xl p-4 text-sm text-rose-200 flex items-start gap-3 shadow-lg shadow-rose-950/30">
            <svg className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <div className="flex-1">
              <span className="font-semibold block mb-0.5">Notice</span>
              {err}
            </div>
            <button onClick={() => setErr(null)} className="text-slate-400 hover:text-white text-xs underline">
              Dismiss
            </button>
          </div>
        )}

        {/* Upload Zone */}
        {!job && (
          <div className="space-y-4">
            <label
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
              }}
              className="block glass-panel hover:glass-panel-glow border-2 border-dashed border-white/20 hover:border-sky-400/60 rounded-2xl p-16 sm:p-20 text-center cursor-pointer transition-all duration-300 group"
            >
              <div className="w-16 h-16 mx-auto rounded-2xl bg-sky-500/10 border border-sky-500/20 flex items-center justify-center mb-6 group-hover:scale-110 group-hover:bg-sky-500/20 transition-transform">
                <svg className="w-8 h-8 text-sky-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                </svg>
              </div>

              <div className="text-xl sm:text-2xl font-bold text-white mb-2">
                {busy ? "Loading video file…" : "Drop your video file here"}
              </div>
              <div className="text-slate-400 text-sm">
                or <span className="text-sky-400 underline underline-offset-4 font-medium group-hover:text-sky-300">browse files</span> on your computer
              </div>

              <div className="flex justify-center items-center gap-2 mt-8 text-xs font-mono text-slate-500 tracking-wider">
                <span className="px-2 py-1 bg-white/5 rounded border border-white/10">MP4</span>
                <span className="px-2 py-1 bg-white/5 rounded border border-white/10">MOV</span>
                <span className="px-2 py-1 bg-white/5 rounded border border-white/10">WEBM</span>
                <span className="px-2 py-1 bg-white/5 rounded border border-white/10">AVI</span>
                <span className="px-2 py-1 bg-white/5 rounded border border-white/10">MKV</span>
              </div>

              <input
                type="file"
                hidden
                accept=".mp4,.mov,.avi,.webm,.mkv,.m4v,video/*"
                onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
              />
            </label>

            {/* Instant Demo Video Button */}
            <div className="flex items-center justify-center gap-3 pt-2">
              <span className="text-xs text-slate-500">Don't have a video handy?</span>
              <button
                type="button"
                onClick={loadDemoVideo}
                disabled={busy}
                className="text-xs font-medium text-sky-400 hover:text-sky-300 underline underline-offset-4 flex items-center gap-1.5 transition-colors disabled:opacity-50"
              >
                <span>Try with instant animated 3D demo video</span>
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" />
                </svg>
              </button>
            </div>
          </div>
        )}

        {/* Video Workspace */}
        {job && (
          <div className="grid lg:grid-cols-[1fr_340px] gap-6 items-start">
            {/* Left Column: Player & Progress */}
            <section className="space-y-5">
              {/* File Info Bar */}
              <div className="glass-panel rounded-xl p-4 flex flex-wrap items-center justify-between gap-3 text-xs border border-white/10">
                <div className="flex items-center gap-2 text-slate-300 font-medium">
                  <span className="w-2 h-2 rounded-full bg-sky-400" />
                  <span className="truncate max-w-xs text-white font-semibold">{job.filename}</span>
                </div>

                <div className="flex items-center gap-3 text-slate-400 font-mono">
                  <span>{job.info.width}×{job.info.height}</span>
                  <span>•</span>
                  <span>{job.info.fps} fps</span>
                  <span>•</span>
                  <span>{fmt(job.info.duration)}</span>
                  <span>•</span>
                  <span className="text-emerald-400">
                    {job.info.has_audio ? "✓ Audio Track" : "No Audio"}
                  </span>
                </div>

                <button
                  onClick={cancelProcessing}
                  className="text-slate-400 hover:text-rose-400 transition-colors ml-auto text-xs underline font-medium"
                >
                  {isWorking ? "Cancel Job" : "Choose New Video"}
                </button>
              </div>

              {/* Processing Progress Bar & Live Canvas */}
              {isWorking ? (
                <div className="glass-panel-glow rounded-2xl p-8 space-y-6 text-center border border-sky-500/30">
                  <div className="space-y-2">
                    <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-sky-500/10 border border-sky-500/20 text-sky-400 text-xs font-mono">
                      <span className="w-2 h-2 rounded-full bg-sky-400 animate-ping" />
                      {job.engine === "browser" ? "CLIENT-SIDE CV PIPELINE" : "CLOUD COMPUTE WORKER"}
                    </div>
                    <h3 className="text-2xl font-bold text-white">Synthesizing Edge Art…</h3>
                    <p className="text-slate-400 text-sm font-mono">{job.stage}</p>
                  </div>

                  {/* Progress track */}
                  <div className="space-y-2 max-w-lg mx-auto">
                    <div className="h-2.5 w-full bg-slate-800/80 rounded-full overflow-hidden p-0.5 border border-white/10">
                      <div
                        className="h-full bg-gradient-to-r from-sky-400 to-indigo-500 rounded-full transition-all duration-300 shadow-lg shadow-sky-500/50"
                        style={{ width: `${Math.round(job.progress * 100)}%` }}
                      />
                    </div>
                    <div className="flex justify-between text-xs font-mono text-slate-500">
                      <span>Analyzing sub-pixel gradients</span>
                      <span className="text-sky-400 font-bold">{Math.round(job.progress * 100)}%</span>
                    </div>
                  </div>

                  {/* Live Render Canvas */}
                  <div className="mt-4 border border-white/10 rounded-xl overflow-hidden bg-black max-w-lg mx-auto aspect-video flex items-center justify-center relative shadow-2xl">
                    <canvas
                      ref={livePreviewCanvas}
                      className="w-full h-full object-contain"
                    />
                    <div className="absolute top-2 left-2 px-2 py-0.5 rounded bg-black/80 border border-white/20 text-[10px] font-mono text-slate-300">
                      LIVE RENDER BUFFER
                    </div>
                  </div>
                </div>
              ) : (
                /* Side-by-Side Synced Video Player */
                <div className="space-y-4">
                  <div className="grid sm:grid-cols-2 gap-4">
                    {/* Original Source */}
                    <div className="space-y-2">
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-slate-400 font-mono tracking-wider font-semibold">ORIGINAL SOURCE</span>
                        <span className="text-[10px] text-slate-500 font-mono">{job.info.width}×{job.info.height}</span>
                      </div>
                      <div className="relative rounded-xl overflow-hidden border border-white/10 bg-black aspect-video shadow-xl">
                        <video
                          ref={origVideo}
                          src={job.originalUrl}
                          controls
                          className="w-full h-full object-contain"
                          onPlay={() => syncPlayers("play")}
                          onPause={() => syncPlayers("pause")}
                          onSeeked={() => syncPlayers("seek")}
                        />
                      </div>
                    </div>

                    {/* Edge Art Result */}
                    <div className="space-y-2">
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-sky-400 font-mono tracking-wider font-semibold">
                          EDGEVISION {job.preview && isDone ? "· 8s PREVIEW" : isDone ? "· FINAL ART" : ""}
                        </span>
                        {isDone && (
                          <span className="text-[10px] text-emerald-400 font-mono">
                            READY {job.out_width && `(${job.out_width}×${job.out_height})`}
                          </span>
                        )}
                      </div>

                      <div className="relative rounded-xl overflow-hidden border border-sky-500/20 bg-black aspect-video shadow-xl flex items-center justify-center">
                        {isDone && (job.resultUrl || (job.engine === "cloud" && cleanApiUrl)) ? (
                          <video
                            ref={edgeVideo}
                            key={rev}
                            src={
                              job.resultUrl ||
                              (job.preview
                                ? `${cleanApiUrl}/api/videos/${job.id}/preview?v=${rev}`
                                : `${cleanApiUrl}/api/videos/${job.id}/download?v=${rev}`)
                            }
                            controls
                            className="w-full h-full object-contain"
                          />
                        ) : (
                          <div className="text-center p-6 space-y-2">
                            <div className="w-10 h-10 mx-auto rounded-full bg-white/5 border border-white/10 flex items-center justify-center text-slate-500">
                              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                              </svg>
                            </div>
                            <div className="text-slate-400 text-xs font-medium">Ready for rendering</div>
                            <div className="text-slate-600 text-[11px]">Adjust edge parameters on the right and click Process</div>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Ready Banner & Download */}
                  {isDone && (
                    <div className="glass-panel-glow rounded-xl p-5 border border-emerald-500/30 flex flex-wrap items-center justify-between gap-4">
                      <div>
                        <div className="text-emerald-400 font-semibold text-sm flex items-center gap-2">
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                          </svg>
                          <span>Edge art render completed successfully!</span>
                        </div>
                        <div className="text-xs text-slate-400 mt-1 font-mono">
                          {job.out_width}×{job.out_height} • {MODES.find((m) => m.id === s.mode)?.name} • Original audio preserved
                        </div>
                      </div>

                      <div className="flex items-center gap-3">
                        <a
                          href={
                            job.resultUrl ||
                            `${cleanApiUrl}/api/videos/${job.id}/download`
                          }
                          download={`edgevision_${job.filename.replace(/\.[^/.]+$/, "")}.webm`}
                          className="bg-white hover:bg-slate-200 text-black px-5 py-2 rounded-lg text-xs font-bold transition-all shadow-lg hover:shadow-white/20 flex items-center gap-2"
                        >
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                          </svg>
                          <span>Download Edge Video</span>
                        </a>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </section>

            {/* Right Column: Algorithm & Parameter Controls */}
            <aside className="glass-panel rounded-2xl p-6 space-y-6 border border-white/10 sticky top-24">
              <div>
                <h3 className="text-sm font-bold text-white uppercase tracking-wider mb-1 flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-sky-400" />
                  Algorithm Parameters
                </h3>
                <p className="text-[11px] text-slate-400">Fine-tune edge sensitivity, noise thresholds & geometry.</p>
              </div>

              {/* Edge Mode Preset */}
              <div className="space-y-1.5">
                <label className="text-xs text-slate-300 font-medium block">Edge Mode Profile</label>
                <select
                  value={s.mode}
                  onChange={(e) => setParam("mode")(e.target.value)}
                  className="w-full bg-slate-900 border border-white/15 rounded-lg px-3 py-2 text-white text-xs font-medium focus:outline-none focus:border-sky-400 transition-colors"
                >
                  {MODES.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
                <p className="text-[11px] text-slate-500 italic">
                  {MODES.find((m) => m.id === s.mode)?.desc}
                </p>
              </div>

              {/* Sliders */}
              <div className="space-y-4 pt-2 border-t border-white/5">
                <Slider
                  label="Low Threshold"
                  value={s.low}
                  onChange={setParam("low")}
                  max={255}
                />
                <Slider
                  label="High Threshold"
                  value={s.high}
                  onChange={setParam("high")}
                  max={255}
                />
                <Slider
                  label="Noise Removal"
                  value={s.noise_removal}
                  onChange={setParam("noise_removal")}
                  suffix="%"
                />
                <Slider
                  label="Edge Detail"
                  value={s.detail}
                  onChange={setParam("detail")}
                  suffix="%"
                />
                <Slider
                  label="Edge Stroke Thickness"
                  value={s.thickness}
                  onChange={setParam("thickness")}
                  suffix="%"
                />
                <Slider
                  label="Temporal Stability (EMA)"
                  value={s.stability}
                  onChange={setParam("stability")}
                  suffix="%"
                />
              </div>

              {/* Output Resolution Presets */}
              <div className="space-y-1.5 pt-2 border-t border-white/5">
                <label className="text-xs text-slate-300 font-medium block">Output Resolution Preset</label>
                <select
                  value={s.output}
                  onChange={(e) => setParam("output")(e.target.value)}
                  className="w-full bg-slate-900 border border-white/15 rounded-lg px-3 py-2 text-white text-xs font-medium focus:outline-none focus:border-sky-400 transition-colors"
                >
                  {OUTPUTS.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>

              {/* Action Buttons */}
              <div className="space-y-2 pt-2 border-t border-white/10">
                <div className="flex gap-2">
                  <button
                    disabled={!!isWorking}
                    onClick={() => startProcessing(true)}
                    className="flex-1 border border-white/20 hover:border-white/40 text-slate-200 py-2.5 rounded-lg text-xs font-semibold disabled:opacity-40 transition-colors"
                  >
                    Preview (8s)
                  </button>
                  <button
                    disabled={!!isWorking}
                    onClick={() => startProcessing(false)}
                    className="flex-1 bg-gradient-to-r from-sky-400 to-indigo-500 hover:from-sky-300 hover:to-indigo-400 text-black py-2.5 rounded-lg text-xs font-bold disabled:opacity-40 transition-all shadow-lg shadow-sky-500/20"
                  >
                    Full Process
                  </button>
                </div>
                <div className="text-center">
                  <span className="text-[10px] text-slate-500 font-mono">
                    ✓ Original audio track preserved automatically
                  </span>
                </div>
              </div>
            </aside>
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-white/5 py-8 text-center text-xs text-slate-600 font-mono">
        EDGEVISION · Precision Computer Vision & Video Processing · Vercel Ready
      </footer>
    </div>
  );
}
