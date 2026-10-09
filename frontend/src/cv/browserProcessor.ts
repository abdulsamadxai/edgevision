import { CVParams, EdgeProcessor, VideoMeta, PROFILES } from "./pipeline";

export interface ProcessingProgress {
  progress: number;
  stage: string;
  currentFrame?: number;
  totalFrames?: number;
}

export interface ProcessingResult {
  blob: Blob;
  url: string;
  previewUrl?: string;
  duration: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  mimeType: string;
}

export function computeOutputSize(
  origW: number,
  origH: number,
  preset: string
): { width: number; height: number } {
  const ev = (n: number) => Math.max(2, Math.floor(n / 2) * 2);

  // Keep dimensions bounded for fast client-side canvas processing (max dimension ~1280)
  const maxDim = 1280;
  let w = origW;
  let h = origH;

  if (Math.max(w, h) > maxDim) {
    const scale = maxDim / Math.max(w, h);
    w = Math.round(w * scale);
    h = Math.round(h * scale);
  }

  if (preset === "720p") {
    const scale = Math.min(1.0, 720 / Math.min(w, h));
    return { width: ev(w * scale), height: ev(h * scale) };
  }
  if (preset === "1080p") {
    const scale = Math.min(1.0, 1080 / Math.min(w, h));
    return { width: ev(w * scale), height: ev(h * scale) };
  }
  if (preset === "9:16") {
    const cw = 720;
    const ch = 1280;
    const k = Math.min(1.0, Math.max(w, h) / Math.max(cw, ch));
    return { width: ev(cw * k), height: ev(ch * k) };
  }
  if (preset === "16:9") {
    const cw = 1280;
    const ch = 720;
    const k = Math.min(1.0, Math.max(w, h) / Math.max(cw, ch));
    return { width: ev(cw * k), height: ev(ch * k) };
  }
  if (preset === "1:1") {
    const cw = 720;
    const ch = 720;
    const k = Math.min(1.0, Math.max(w, h) / Math.max(cw, ch));
    return { width: ev(cw * k), height: ev(ch * k) };
  }

  return { width: ev(w), height: ev(h) };
}

export async function probeVideoFile(file: File | Blob): Promise<VideoMeta> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.preload = "metadata";
    video.src = url;
    video.muted = true;

    const timeout = setTimeout(() => {
      URL.revokeObjectURL(url);
      reject(new Error("Video probe timed out. File format may be unsupported."));
    }, 10000);

    video.onloadedmetadata = () => {
      clearTimeout(timeout);
      const w = video.videoWidth || 1280;
      const h = video.videoHeight || 720;
      const dur = Math.max(0.1, video.duration || 1);

      // Check if video might have audio tracks
      // Using Web Audio context test or webkitAudioDecodedByteCount
      const hasAudio =
        (video as any).mozHasAudio !== undefined
          ? (video as any).mozHasAudio
          : (video as any).webkitAudioDecodedByteCount !== undefined
          ? (video as any).webkitAudioDecodedByteCount > 0
          : true;

      URL.revokeObjectURL(url);
      resolve({
        width: w,
        height: h,
        duration: Math.round(dur * 100) / 100,
        fps: 30,
        has_audio: hasAudio,
        audio_codec: hasAudio ? "aac/opus" : undefined,
        video_codec: "h264/vp9"
      });
    };

    video.onerror = () => {
      clearTimeout(timeout);
      URL.revokeObjectURL(url);
      reject(new Error("Could not decode video metadata. Please try an MP4, WebM, or MOV file."));
    };
  });
}

export class ClientVideoProcessor {
  private isCancelled = false;

  public cancel(): void {
    this.isCancelled = true;
  }

  public async process(
    file: File | Blob,
    params: CVParams,
    preset = "original",
    preview = false,
    onProgress: (p: ProcessingProgress) => void,
    previewCanvas?: HTMLCanvasElement | null
  ): Promise<ProcessingResult> {
    this.isCancelled = false;
    const objectUrl = URL.createObjectURL(file);

    try {
      onProgress({ progress: 0.05, stage: "Reading video stream" });

      const video = document.createElement("video");
      video.src = objectUrl;
      video.crossOrigin = "anonymous";
      video.muted = false; // required for AudioContext routing
      video.playsInline = true;
      video.setAttribute("playsinline", "true");

      await new Promise<void>((resolve, reject) => {
        video.onloadedmetadata = () => resolve();
        video.onerror = () => reject(new Error("Failed to load video data"));
      });

      const origW = video.videoWidth || 1280;
      const origH = video.videoHeight || 720;
      const fullDuration = video.duration || 5;
      const targetDuration = preview ? Math.min(8, fullDuration) : fullDuration;

      const { width: outW, height: outH } = computeOutputSize(origW, origH, preset);

      // Setup processing and output canvases
      const workCanvas = document.createElement("canvas");
      workCanvas.width = outW;
      workCanvas.height = outH;
      const workCtx = workCanvas.getContext("2d", { willReadFrequently: true });
      if (!workCtx) throw new Error("Could not initialize 2D canvas context");

      const outCanvas = document.createElement("canvas");
      outCanvas.width = outW;
      outCanvas.height = outH;
      const outCtx = outCanvas.getContext("2d");
      if (!outCtx) throw new Error("Could not initialize output canvas context");

      const edgeProcessor = new EdgeProcessor(params);

      // Setup Audio Stream from the video if available
      let audioTrack: MediaStreamTrack | null = null;
      let audioCtx: AudioContext | null = null;
      try {
        const AudioCtxClass = window.AudioContext || (window as any).webkitAudioContext;
        if (AudioCtxClass) {
          audioCtx = new AudioCtxClass();
          const source = audioCtx.createMediaElementSource(video);
          const dest = audioCtx.createMediaStreamDestination();
          source.connect(dest);
          const tracks = dest.stream.getAudioTracks();
          if (tracks.length > 0) {
            audioTrack = tracks[0];
          }
        }
      } catch (err) {
        console.warn("Audio extraction fallback:", err);
      }

      // Check supported recording MIME types
      const mimeTypes = [
        "video/mp4;codecs=avc1,mp4a.40.2",
        "video/mp4",
        "video/webm;codecs=vp9,opus",
        "video/webm;codecs=vp8,opus",
        "video/webm"
      ];
      let selectedMime = "";
      for (const m of mimeTypes) {
        if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m)) {
          selectedMime = m;
          break;
        }
      }

      const fps = 30;
      const canvasStream = outCanvas.captureStream(fps);
      const combinedTracks = [...canvasStream.getVideoTracks()];
      if (audioTrack && !preview) {
        combinedTracks.push(audioTrack);
      }
      const combinedStream = new MediaStream(combinedTracks);

      const recordedChunks: Blob[] = [];
      const recorder = new MediaRecorder(
        combinedStream,
        selectedMime ? { mimeType: selectedMime } : undefined
      );

      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) recordedChunks.push(e.data);
      };

      recorder.start(100);

      // Frame stepping approach
      const totalFrames = Math.max(1, Math.round(targetDuration * fps));
      const frameDelta = 1 / fps;
      let currentFrame = 0;

      onProgress({ progress: 0.1, stage: "Analyzing frames" });

      // Calculate letterboxing/scaling dimensions for aspect presets
      const scale = Math.min(outW / origW, outH / origH);
      const scaledW = Math.round(origW * scale);
      const scaledH = Math.round(origH * scale);
      const offsetX = Math.round((outW - scaledW) / 2);
      const offsetY = Math.round((outH - scaledH) / 2);

      // Process frames in batches to keep UI responsive
      for (let t = 0; t < targetDuration; t += frameDelta) {
        if (this.isCancelled) {
          recorder.stop();
          if (audioCtx) await audioCtx.close();
          throw new Error("Processing cancelled by user");
        }

        video.currentTime = t;
        await new Promise<void>((r) => {
          const onSeek = () => {
            video.removeEventListener("seeked", onSeek);
            r();
          };
          video.addEventListener("seeked", onSeek);
        });

        // 1. Draw source video into work canvas
        workCtx.fillStyle = "#000000";
        workCtx.fillRect(0, 0, outW, outH);
        workCtx.drawImage(video, offsetX, offsetY, scaledW, scaledH);

        // 2. Extract image data and process with EdgeProcessor
        const inputData = workCtx.getImageData(0, 0, outW, outH);
        const edgeData = edgeProcessor.process(inputData);

        // 3. Draw processed edges to output canvas (feeding MediaRecorder)
        outCtx.putImageData(edgeData, 0, 0);

        // 4. Also mirror to live preview canvas if provided
        if (previewCanvas) {
          const prevCtx = previewCanvas.getContext("2d");
          if (prevCtx) {
            if (previewCanvas.width !== outW || previewCanvas.height !== outH) {
              previewCanvas.width = outW;
              previewCanvas.height = outH;
            }
            prevCtx.putImageData(edgeData, 0, 0);
          }
        }

        currentFrame++;
        const pRatio = currentFrame / totalFrames;

        let stageName = "Detecting edges";
        if (pRatio < 0.25) stageName = "Removing noise & enhancing";
        else if (pRatio < 0.65) stageName = "Extracting edge vectors";
        else if (pRatio < 0.9) stageName = "Stabilizing cross-frame edges";
        else stageName = "Preserving original audio & muxing";

        onProgress({
          progress: Math.min(0.96, 0.1 + pRatio * 0.85),
          stage: stageName,
          currentFrame,
          totalFrames
        });

        // Yield to browser event loop every 3 frames
        if (currentFrame % 3 === 0) {
          await new Promise((r) => setTimeout(r, 0));
        }
      }

      onProgress({ progress: 0.98, stage: "Finalizing video" });

      // Stop recorder and retrieve final Blob
      const finalBlob = await new Promise<Blob>((resolve) => {
        recorder.onstop = () => {
          const type = selectedMime || "video/webm";
          resolve(new Blob(recordedChunks, { type }));
        };
        recorder.stop();
      });

      if (audioCtx) {
        try {
          await audioCtx.close();
        } catch {
          // ignore
        }
      }

      onProgress({ progress: 1.0, stage: "Done", currentFrame: totalFrames, totalFrames });

      const finalUrl = URL.createObjectURL(finalBlob);

      return {
        blob: finalBlob,
        url: finalUrl,
        duration: targetDuration,
        width: outW,
        height: outH,
        fps,
        hasAudio: !!audioTrack,
        mimeType: finalBlob.type || "video/mp4"
      };
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }
}

/**
 * Generates an instant high-tech demo video in memory with moving 3D wireframe solids
 * so users can test EdgeVision immediately with 0 downloads!
 */
export async function createDemoVideo(): Promise<File> {
  const w = 640;
  const h = 360;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;

  const fps = 30;
  const dur = 5; // 5 seconds
  const totalFrames = fps * dur;

  // Web Audio synth tone
  const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
  let audioCtx: AudioContext | null = null;
  let audioTrack: MediaStreamTrack | null = null;

  try {
    if (AudioCtx) {
      audioCtx = new AudioCtx();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      const dest = audioCtx.createMediaStreamDestination();
      osc.type = "sawtooth";
      osc.frequency.setValueAtTime(140, audioCtx.currentTime);
      gain.gain.setValueAtTime(0.08, audioCtx.currentTime);
      osc.connect(gain);
      gain.connect(dest);
      osc.start();
      audioTrack = dest.stream.getAudioTracks()[0] || null;
    }
  } catch {
    // optional audio
  }

  const stream = canvas.captureStream(fps);
  if (audioTrack) stream.addTrack(audioTrack);

  const mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
    ? "video/webm;codecs=vp9"
    : "video/webm";

  const recorder = new MediaRecorder(stream, { mimeType: mime });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data);

  recorder.start();

  // Draw 3D rotating wireframe cube and spheres
  for (let f = 0; f < totalFrames; f++) {
    const angle = (f / fps) * Math.PI * 0.8;
    ctx.fillStyle = "#0a0c14";
    ctx.fillRect(0, 0, w, h);

    // Glowing background grid
    ctx.strokeStyle = "rgba(45, 75, 115, 0.4)";
    ctx.lineWidth = 1;
    for (let x = 0; x < w; x += 40) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
    for (let y = 0; y < h; y += 40) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    // Rotating 3D Cube vertices
    const size = 90;
    const cx = w / 2;
    const cy = h / 2;

    const vertices = [
      [-1, -1, -1],
      [1, -1, -1],
      [1, 1, -1],
      [-1, 1, -1],
      [-1, -1, 1],
      [1, -1, 1],
      [1, 1, 1],
      [-1, 1, 1]
    ];

    const edges = [
      [0, 1], [1, 2], [2, 3], [3, 0],
      [4, 5], [5, 6], [6, 7], [7, 4],
      [0, 4], [1, 5], [2, 6], [3, 7]
    ];

    // Project 3D to 2D
    const projected = vertices.map(([vx, vy, vz]) => {
      // Rotate Y and X
      const radY = angle;
      const radX = angle * 0.6;
      let x1 = vx * Math.cos(radY) + vz * Math.sin(radY);
      let z1 = -vx * Math.sin(radY) + vz * Math.cos(radY);

      let y2 = vy * Math.cos(radX) - z1 * Math.sin(radX);
      let z2 = vy * Math.sin(radX) + z1 * Math.cos(radX);

      const d = 3.5;
      const fov = 300 / (z2 + d);
      return [cx + x1 * size * fov * 0.01, cy + y2 * size * fov * 0.01];
    });

    // Draw cube faces with soft gradient
    ctx.strokeStyle = "#38bdf8";
    ctx.lineWidth = 3;
    for (const [i1, i2] of edges) {
      ctx.beginPath();
      ctx.moveTo(projected[i1][0], projected[i1][1]);
      ctx.lineTo(projected[i2][0], projected[i2][1]);
      ctx.stroke();
    }

    // Moving pulsating concentric radar circle
    const pulse = (Math.sin(angle * 2) + 1) * 0.5;
    ctx.strokeStyle = `rgba(244, 63, 94, ${0.4 + pulse * 0.5})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, 110 + pulse * 25, 0, Math.PI * 2);
    ctx.stroke();

    // Floating text label
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 16px monospace";
    ctx.textAlign = "center";
    ctx.fillText("EDGEVISION · TEST RUNNER", cx, h - 35);

    await new Promise((r) => setTimeout(r, 1000 / fps));
  }

  const blob = await new Promise<Blob>((resolve) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: mime }));
    recorder.stop();
  });

  if (audioCtx) {
    try {
      await audioCtx.close();
    } catch {}
  }

  return new File([blob], "edgevision_sample_drone.webm", { type: mime });
}
