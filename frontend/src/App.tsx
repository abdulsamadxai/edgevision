import { useEffect, useRef, useState } from "react";

type Info = {
  width: number;
  height: number;
  fps: number;
  duration: number;
  has_audio: boolean;
  audio_codec?: string;
  video_codec: string;
};

type Job = {
  id: string;
  filename: string;
  info: Info;
  status: string;
  stage: string;
  progress: number;
  error?: string | null;
  preview?: boolean;
  mode?: string;
  out_width?: number;
  out_height?: number;
  out_info?: Info;
};

const MODES = [
  ["clean_canny", "Clean Canny"],
  ["ultra_clean", "Ultra Clean"],
  ["fine_detail", "Fine Detail"],
  ["architecture", "Architecture"]
];

const OUTPUTS = [
  ["original", "Original resolution"],
  ["1080p", "1080p"],
  ["720p", "720p"],
  ["9:16", "9:16"],
  ["16:9", "16:9"],
  ["1:1", "1:1"]
];

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

function Slider({ label, v, set, max = 100 }: { label: string; v: number; set: (n: number) => void; max?: number }) {
  return (
    <label className="block text-xs text-neutral-400">
      <div className="flex justify-between mb-1">
        <span>{label}</span>
        <span className="text-white tabular-nums">{v}</span>
      </div>
      <input type="range" min={0} max={max} value={v} onChange={(e) => set(+e.target.value)} />
    </label>
  );
}

const API_BASE = (
  import.meta.env.VITE_API_URL ||
  "https://nonmatrimonial-macy-pseudoancestrally.ngrok-free.dev"
).replace(/\/$/, "");

// Helper to append ngrok bypass query param for media tags
const mediaUrl = (path: string) => `${API_BASE}${path}${path.includes("?") ? "&" : "?"}ngrok-skip-browser-warning=true`;

const HEADERS = {
  "ngrok-skip-browser-warning": "true"
};

export default function App() {
  const [job, setJob] = useState<Job | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [s, setS] = useState({
    mode: "clean_canny",
    low: 50,
    high: 150,
    noise_removal: 50,
    detail: 50,
    thickness: 30,
    stability: 60,
    output: "original"
  });
  const [localSrc, setLocalSrc] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [rev, setRev] = useState(0);
  const orig = useRef<HTMLVideoElement>(null);
  const edge = useRef<HTMLVideoElement>(null);
  const set = (k: string) => (v: number) => setS((p) => ({ ...p, [k]: v }));

  useEffect(() => {
    // Real progress: poll backend status
    if (!job || !["queued", "processing"].includes(job.status)) return;
    let failCount = 0;
    const t = setInterval(async () => {
      try {
        const r = await fetch(`${API_BASE}/api/videos/${job.id}/status`, { headers: HEADERS });
        if (r.ok) {
          const j = await r.json();
          setJob(j);
          if (j.status === "done") setRev((x) => x + 1);
        } else if (r.status === 404) {
          clearInterval(t);
          setErr("Job not found or session expired. Please re-upload your video.");
          setJob(null);
        } else {
          failCount++;
          if (failCount > 10) {
            clearInterval(t);
            setErr("Connection to backend lost while checking status.");
          }
        }
      } catch {
        failCount++;
        if (failCount > 10) {
          clearInterval(t);
          setErr("Network error while communicating with backend.");
        }
      }
    }, 600);
    return () => clearInterval(t);
  }, [job?.id, job?.status]);

  async function upload(f: File) {
    setErr(null);
    setBusy(true);
    setJob(null);
    if (localSrc) {
      URL.revokeObjectURL(localSrc);
    }
    const blobUrl = URL.createObjectURL(f);
    setLocalSrc(blobUrl);
    try {
      const fd = new FormData();
      fd.append("file", f);
      const r = await fetch(`${API_BASE}/api/videos/upload`, {
        method: "POST",
        body: fd,
        headers: HEADERS
      });
      const contentType = r.headers.get("content-type") || "";
      let j: any = null;
      if (contentType.includes("application/json")) {
        j = await r.json();
      } else {
        const text = await r.text();
        throw new Error(
          r.status === 502
            ? "Backend is offline (502 Bad Gateway). Please ensure the backend server is running."
            : `Server error (${r.status}): ${text.slice(0, 100)}`
        );
      }
      if (r.ok) {
        setJob(j);
      } else {
        setErr(j?.detail || "Upload failed");
      }
    } catch (e: any) {
      setErr(e.message || "Upload failed. Could not reach server.");
    } finally {
      setBusy(false);
    }
  }

  async function start(preview: boolean) {
    if (!job) return;
    setErr(null);
    setShowPreview(preview);
    try {
      const r = await fetch(`${API_BASE}/api/videos/${job.id}/process`, {
        method: "POST",
        headers: { "content-type": "application/json", ...HEADERS },
        body: JSON.stringify({ ...s, preview })
      });
      const contentType = r.headers.get("content-type") || "";
      let j: any = null;
      if (contentType.includes("application/json")) {
        j = await r.json();
      } else {
        const text = await r.text();
        throw new Error(`Server error (${r.status}): ${text.slice(0, 100)}`);
      }
      if (r.ok) {
        setJob(j);
      } else {
        setErr(typeof j?.detail === "string" ? j.detail : "Invalid settings");
      }
    } catch (e: any) {
      setErr(e.message || "Failed to start processing.");
    }
  }

  const cancel = () => {
    if (localSrc) URL.revokeObjectURL(localSrc);
    setLocalSrc(null);
    if (job) {
      fetch(`${API_BASE}/api/videos/${job.id}`, { method: "DELETE", headers: HEADERS }).catch(() => {});
      setJob(null);
    }
  };

  const sync = (a: "play" | "pause" | "seek") => {
    const o = orig.current;
    const e = edge.current;
    if (!o || !e) return;
    if (a === "play") {
      e.currentTime = o.currentTime;
      e.play().catch(() => {});
    } else if (a === "pause") {
      e.pause();
    } else {
      e.currentTime = o.currentTime;
    }
  };

  const working = job && ["queued", "processing"].includes(job.status);
  const done = job?.status === "done";

  return (
    <div className="min-h-screen grid-bg">
      <header className="max-w-5xl mx-auto px-6 pt-10 text-center">
        <div className="text-xs tracking-[0.4em] text-neutral-500">EDGEVISION</div>
        <h1 className="text-4xl md:text-6xl font-semibold mt-4 tracking-tight">
          Turn any video into clean computer-vision edge art.
        </h1>
        <p className="text-neutral-400 mt-4">
          Upload a video. Preserve the original audio. Transform the visuals.
        </p>
      </header>
      <main className="max-w-5xl mx-auto px-6 py-10 space-y-6">
        {err && <div className="border border-white/30 p-3 text-sm text-red-300">{err}</div>}
        {!job && (
          <label
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              e.dataTransfer.files[0] && upload(e.dataTransfer.files[0]);
            }}
            className="block border border-dashed border-white/30 hover:border-white p-16 text-center cursor-pointer bg-black/60"
          >
            <div className="text-xl">{busy ? "Uploading…" : "Drop your video here"}</div>
            <div className="text-neutral-500 text-sm mt-2">or click to browse</div>
            <div className="text-neutral-600 text-xs mt-6 tracking-widest">MP4 • MOV • AVI • WEBM</div>
            <input
              type="file"
              hidden
              accept=".mp4,.mov,.avi,.webm,.mkv,.m4v,video/*"
              onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])}
            />
          </label>
        )}
        {job && (
          <div className="grid md:grid-cols-[1fr_320px] gap-6">
            <section className="space-y-4">
              <div className="border border-white/15 p-4 text-sm flex flex-wrap gap-x-6 gap-y-1 text-neutral-400">
                <span className="text-white">{job.filename}</span>
                <span>
                  {job.info.width}×{job.info.height}
                </span>
                <span>{job.info.fps} fps</span>
                <span>{fmt(job.info.duration)}</span>
                <span>
                  {job.info.has_audio ? `✓ audio (${job.info.audio_codec || "aac"})` : "no audio track"}
                </span>
                <button onClick={cancel} className="ml-auto underline text-neutral-500 hover:text-white">
                  {working ? "Cancel" : "Remove"}
                </button>
              </div>
              {working ? (
                <div className="border border-white/15 p-8">
                  <div className="text-lg">Processing video…</div>
                  <div className="text-neutral-400 text-sm mt-1">{job.stage}</div>
                  <div className="h-1 bg-white/10 mt-5">
                    <div
                      className="h-1 bg-white transition-all"
                      style={{ width: `${job.progress * 100}%` }}
                    />
                  </div>
                  <div className="text-right text-xs text-neutral-500 mt-1">
                    {Math.round(job.progress * 100)}%
                  </div>
                </div>
              ) : (
                <div className="grid sm:grid-cols-2 gap-3">
                  <div>
                    <div className="text-xs tracking-widest text-neutral-500 mb-1">ORIGINAL</div>
                    <video
                      ref={orig}
                      src={localSrc || mediaUrl(`/api/videos/${job.id}/original`)}
                      controls
                      playsInline
                      preload="auto"
                      className="w-full bg-black border border-white/15"
                      onPlay={() => sync("play")}
                      onPause={() => sync("pause")}
                      onSeeked={() => sync("seek")}
                    />
                  </div>
                  <div>
                    <div className="text-xs tracking-widest text-neutral-500 mb-1">
                      EDGEVISION{showPreview && done ? " · 8s PREVIEW" : ""}
                    </div>
                    {done ? (
                      <video
                        ref={edge}
                        key={rev}
                        muted={!!showPreview}
                        playsInline
                        preload="auto"
                        src={mediaUrl(
                          `/api/videos/${job.id}/${job.preview ? "preview" : "download"}?v=${rev}`
                        )}
                        controls
                        className="w-full bg-black border border-white/15"
                      />
                    ) : (
                      <div className="aspect-video border border-white/15 grid place-items-center text-neutral-600 text-sm">
                        Not processed yet
                      </div>
                    )}
                  </div>
                </div>
              )}
              {done && !job.preview && job.out_info && (
                <div className="border border-white/15 p-5">
                  <div className="text-lg">Your video is ready.</div>
                  <div className="text-sm text-neutral-400 mt-2">
                    {job.out_width}×{job.out_height} · {fmt(job.out_info.duration)} ·{" "}
                    {MODES.find((m) => m[0] === job.mode)?.[1]} ·{" "}
                    {job.info.has_audio ? "✓ original audio preserved" : "no audio in source"}
                  </div>
                  <a
                    href={mediaUrl(`/api/videos/${job.id}/download`)}
                    download="edgevision.mp4"
                    className="inline-block mt-4 bg-white text-black px-5 py-2 text-sm font-medium"
                  >
                    Download Edge Video
                  </a>
                </div>
              )}
              {done && job.preview && (
                <div className="text-xs text-neutral-500">
                  Preview shows the first 8 seconds. Run the full render when happy.
                </div>
              )}
            </section>
            <aside className="border border-white/15 p-5 space-y-4 bg-black/70 h-fit">
              <label className="block text-xs text-neutral-400">
                Edge Algorithm
                <select
                  value={s.mode}
                  onChange={(e) => setS({ ...s, mode: e.target.value })}
                  className="w-full mt-1 bg-black border border-white/30 p-2 text-white text-sm"
                >
                  {MODES.map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </select>
              </label>
              <Slider label="Low threshold" v={s.low} set={set("low")} max={255} />
              <Slider label="High threshold" v={s.high} set={set("high")} max={255} />
              <Slider label="Noise removal" v={s.noise_removal} set={set("noise_removal")} />
              <Slider label="Edge detail" v={s.detail} set={set("detail")} />
              <Slider label="Edge thickness" v={s.thickness} set={set("thickness")} />
              <Slider label="Temporal stability" v={s.stability} set={set("stability")} />
              <label className="block text-xs text-neutral-400">
                Output
                <select
                  value={s.output}
                  onChange={(e) => setS({ ...s, output: e.target.value })}
                  className="w-full mt-1 bg-black border border-white/30 p-2 text-white text-sm"
                >
                  {OUTPUTS.map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </select>
              </label>
              <div className="text-xs text-neutral-300">✓ Original audio will be preserved</div>
              <div className="flex gap-2">
                <button
                  disabled={!!working}
                  onClick={() => start(true)}
                  className="flex-1 border border-white/40 py-2 text-sm disabled:opacity-40"
                >
                  Preview 8s
                </button>
                <button
                  disabled={!!working}
                  onClick={() => start(false)}
                  className="flex-1 bg-white text-black py-2 text-sm font-medium disabled:opacity-40"
                >
                  Process
                </button>
              </div>
              {job.status === "failed" && <div className="text-xs text-red-300">{job.error}</div>}
            </aside>
          </div>
        )}
      </main>
      <footer className="text-center text-xs text-neutral-600 pb-8">
        See video differently. · Every frame. Every edge.
      </footer>
    </div>
  );
}
