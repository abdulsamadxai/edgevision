export interface CVParams {
  mode: "clean_canny" | "ultra_clean" | "fine_detail" | "architecture";
  low: number;
  high: number;
  noise_removal: number;
  detail: number;
  thickness: number;
  stability: number;
  output?: string;
  preview?: boolean;
}

export interface VideoMeta {
  width: number;
  height: number;
  duration: number;
  fps: number;
  has_audio: boolean;
  audio_codec?: string;
  video_codec: string;
}

export const PROFILES: Record<
  string,
  { sigma: number; bil: number; area: number; close: number; tscale: number; label: string; desc: string }
> = {
  clean_canny: {
    sigma: 1.2,
    bil: 7,
    area: 1.0,
    close: 1,
    tscale: 1.0,
    label: "Clean Canny",
    desc: "Balanced contours with adaptive contrast normalization"
  },
  ultra_clean: {
    sigma: 2.0,
    bil: 9,
    area: 3.0,
    close: 3,
    tscale: 1.25,
    label: "Ultra Clean",
    desc: "Heavy noise suppression with bold, pristine outlines"
  },
  fine_detail: {
    sigma: 0.8,
    bil: 5,
    area: 0.4,
    close: 1,
    tscale: 0.7,
    label: "Fine Detail",
    desc: "High sensitivity capturing intricate textures and edges"
  },
  architecture: {
    sigma: 1.6,
    bil: 9,
    area: 2.0,
    close: 3,
    tscale: 1.0,
    label: "Architecture",
    desc: "Reinforced straight lines and structural vector aesthetics"
  }
};

/**
 * High-performance Computer Vision Edge Detection in pure TypeScript
 * Reproduces the Python OpenCV + Canny + Temporal EMA stabilization pipeline
 */
export class EdgeProcessor {
  private p: CVParams;
  private prevGray: Float32Array | null = null;
  private prevOn: Uint8Array | null = null;
  private state: Float32Array | null = null;
  private width = 0;
  private height = 0;

  constructor(p: CVParams) {
    this.p = p;
  }

  public reset(): void {
    this.prevGray = null;
    this.prevOn = null;
    this.state = null;
    this.width = 0;
    this.height = 0;
  }

  public updateParams(p: CVParams): void {
    this.p = p;
  }

  public process(imageData: ImageData): ImageData {
    const w = imageData.width;
    const h = imageData.height;
    const size = w * h;
    const rgba = imageData.data;

    if (this.width !== w || this.height !== h) {
      this.width = w;
      this.height = h;
      this.prevGray = null;
      this.prevOn = null;
      this.state = null;
    }

    const prof = PROFILES[this.p.mode] || PROFILES.clean_canny;

    // 1. Convert to Luminance (Grayscale)
    const gray = new Float32Array(size);
    for (let i = 0; i < size; i++) {
      const idx = i << 2;
      gray[i] = 0.299 * rgba[idx] + 0.587 * rgba[idx + 1] + 0.114 * rgba[idx + 2];
    }

    // 2. Contrast Normalization (CLAHE-like adaptive stretch)
    let minG = 255;
    let maxG = 0;
    for (let i = 0; i < size; i += 4) {
      const val = gray[i];
      if (val < minG) minG = val;
      if (val > maxG) maxG = val;
    }
    const range = Math.max(1, maxG - minG);
    const contrastScaled = new Float32Array(size);
    for (let i = 0; i < size; i++) {
      contrastScaled[i] = ((gray[i] - minG) / range) * 255;
    }

    // 3. Gaussian Blur Smoothing for noise reduction
    const sigma = prof.sigma * (0.6 + (this.p.noise_removal / 100) * 0.8);
    const smoothed = this.separableGaussianBlur(contrastScaled, w, h, sigma);

    // 4. Sobel Gradients
    const gx = new Float32Array(size);
    const gy = new Float32Array(size);
    const mag = new Float32Array(size);
    const dir = new Uint8Array(size); // 0: 0°, 1: 45°, 2: 90°, 3: 135°

    const k = prof.tscale * (1.3 - (this.p.detail / 100) * 0.6);
    const lowThresh = Math.max(1, this.p.low * k);
    const highThresh = Math.max(lowThresh + 1, this.p.high * k);

    for (let y = 1; y < h - 1; y++) {
      const yRow = y * w;
      const yPrev = (y - 1) * w;
      const yNext = (y + 1) * w;

      for (let x = 1; x < w - 1; x++) {
        const idx = yRow + x;

        // Sobel kernels
        const valX =
          -smoothed[yPrev + x - 1] +
          smoothed[yPrev + x + 1] -
          2 * smoothed[yRow + x - 1] +
          2 * smoothed[yRow + x + 1] -
          smoothed[yNext + x - 1] +
          smoothed[yNext + x + 1];

        const valY =
          -smoothed[yPrev + x - 1] -
          2 * smoothed[yPrev + x] -
          smoothed[yPrev + x + 1] +
          smoothed[yNext + x - 1] +
          2 * smoothed[yNext + x] +
          smoothed[yNext + x + 1];

        gx[idx] = valX;
        gy[idx] = valY;
        const m = Math.sqrt(valX * valX + valY * valY);
        mag[idx] = m;

        // Quantized direction: 0, 45, 90, 135
        let angle = (Math.atan2(valY, valX) * 180) / Math.PI;
        if (angle < 0) angle += 180;

        if ((angle >= 0 && angle < 22.5) || (angle >= 157.5 && angle <= 180)) {
          dir[idx] = 0; // horizontal
        } else if (angle >= 22.5 && angle < 67.5) {
          dir[idx] = 1; // 45 degree
        } else if (angle >= 67.5 && angle < 112.5) {
          dir[idx] = 2; // vertical
        } else {
          dir[idx] = 3; // 135 degree
        }
      }
    }

    // 5. Non-Maximum Suppression (NMS)
    const nms = new Float32Array(size);
    for (let y = 1; y < h - 1; y++) {
      const yRow = y * w;
      for (let x = 1; x < w - 1; x++) {
        const idx = yRow + x;
        const m = mag[idx];
        if (m < lowThresh) continue;

        let n1 = 0;
        let n2 = 0;
        const d = dir[idx];

        if (d === 0) {
          n1 = mag[idx - 1];
          n2 = mag[idx + 1];
        } else if (d === 1) {
          n1 = mag[idx - w + 1];
          n2 = mag[idx + w - 1];
        } else if (d === 2) {
          n1 = mag[idx - w];
          n2 = mag[idx + w];
        } else if (d === 3) {
          n1 = mag[idx - w - 1];
          n2 = mag[idx + w + 1];
        }

        if (m >= n1 && m >= n2) {
          nms[idx] = m;
        }
      }
    }

    // 6. Double Threshold Hysteresis
    const edges = new Uint8Array(size);
    const queue: number[] = [];

    for (let i = 0; i < size; i++) {
      const m = nms[i];
      if (m >= highThresh) {
        edges[i] = 255;
        queue.push(i);
      } else if (m >= lowThresh) {
        edges[i] = 100; // weak edge candidate
      }
    }

    // 8-way flood connectivity for weak edges
    let head = 0;
    while (head < queue.length) {
      const curr = queue[head++];
      const cy = Math.floor(curr / w);
      const cx = curr % w;

      for (let dy = -1; dy <= 1; dy++) {
        const ny = cy + dy;
        if (ny < 0 || ny >= h) continue;
        const nRow = ny * w;
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = cx + dx;
          if (nx < 0 || nx >= w) continue;
          const nIdx = nRow + nx;
          if (edges[nIdx] === 100) {
            edges[nIdx] = 255;
            queue.push(nIdx);
          }
        }
      }
    }

    // Zero out unconfirmed weak edges
    for (let i = 0; i < size; i++) {
      if (edges[i] !== 255) edges[i] = 0;
    }

    // 7. Temporal Stability (EMA & Motion Mask)
    const s = (this.p.stability / 100) * 0.8;
    const stabilized = new Uint8Array(size);

    if (this.prevGray && this.state && this.prevOn && s > 0) {
      for (let i = 0; i < size; i++) {
        const diff = Math.abs(gray[i] - this.prevGray[i]);
        const motion = diff > 14;
        const alpha = motion ? s * 0.25 : s;
        const curNorm = edges[i] > 0 ? 1.0 : 0.0;

        this.state[i] = alpha * this.state[i] + (1 - alpha) * curNorm;
        const on = this.state[i] > 0.5 || (this.state[i] > 0.28 && this.prevOn[i] === 1);
        stabilized[i] = on ? 255 : 0;
        this.prevOn[i] = on ? 1 : 0;
      }
      this.prevGray.set(gray);
    } else {
      this.state = new Float32Array(size);
      this.prevOn = new Uint8Array(size);
      this.prevGray = new Float32Array(size);

      for (let i = 0; i < size; i++) {
        const on = edges[i] > 0;
        this.state[i] = on ? 1.0 : 0.0;
        this.prevOn[i] = on ? 1 : 0;
        stabilized[i] = on ? 255 : 0;
      }
      this.prevGray.set(gray);
    }

    // 8. Edge Thickness (Dilation)
    const thickness = Math.floor((this.p.thickness / 100) * 3);
    let finalEdges = stabilized;

    if (thickness > 0) {
      const dilated = new Uint8Array(size);
      for (let y = thickness; y < h - thickness; y++) {
        const yRow = y * w;
        for (let x = thickness; x < w - thickness; x++) {
          const idx = yRow + x;
          if (stabilized[idx] === 255) {
            for (let dy = -thickness; dy <= thickness; dy++) {
              const nyRow = (y + dy) * w;
              for (let dx = -thickness; dx <= thickness; dx++) {
                dilated[nyRow + (x + dx)] = 255;
              }
            }
          }
        }
      }
      finalEdges = dilated;
    }

    // 9. Render Back to RGBA Image Data (White edges on true black background)
    const out = new ImageData(new Uint8ClampedArray(rgba.length), w, h);
    const outData = out.data;

    for (let i = 0; i < size; i++) {
      const idx = i << 2;
      const v = finalEdges[i];
      outData[idx] = v;     // R
      outData[idx + 1] = v; // G
      outData[idx + 2] = v; // B
      outData[idx + 3] = 255; // Alpha
    }

    return out;
  }

  /**
   * Fast separable 1D Gaussian blur filter
   */
  private separableGaussianBlur(
    src: Float32Array,
    w: number,
    h: number,
    sigma: number
  ): Float32Array {
    const radius = Math.min(4, Math.max(1, Math.round(sigma * 2)));
    const kernelSize = radius * 2 + 1;
    const kernel = new Float32Array(kernelSize);

    let sum = 0;
    const twoSigmaSq = 2 * sigma * sigma;
    for (let i = -radius; i <= radius; i++) {
      const g = Math.exp(-(i * i) / twoSigmaSq);
      kernel[i + radius] = g;
      sum += g;
    }
    for (let i = 0; i < kernelSize; i++) {
      kernel[i] /= sum;
    }

    const temp = new Float32Array(w * h);
    const result = new Float32Array(w * h);

    // Horizontal pass
    for (let y = 0; y < h; y++) {
      const yRow = y * w;
      for (let x = 0; x < w; x++) {
        let val = 0;
        for (let r = -radius; r <= radius; r++) {
          const nx = Math.min(w - 1, Math.max(0, x + r));
          val += src[yRow + nx] * kernel[r + radius];
        }
        temp[yRow + x] = val;
      }
    }

    // Vertical pass
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) {
        let val = 0;
        for (let r = -radius; r <= radius; r++) {
          const ny = Math.min(h - 1, Math.max(0, y + r));
          val += temp[ny * w + x] * kernel[r + radius];
        }
        result[y * w + x] = val;
      }
    }

    return result;
  }
}
