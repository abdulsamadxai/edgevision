"""Edge-detection pipeline. Each mode = parameter profile over one shared, tunable pipeline.
CPU only; every stage works on numpy/cv2 arrays so a CUDA backend can replace stages later.
Optimized for clean, legible text and artwork contour preservation."""
from dataclasses import dataclass
import cv2, numpy as np

@dataclass
class Params:
    mode: str = "clean_canny"
    low: int = 35
    high: int = 100
    noise_removal: int = 40
    detail: int = 50
    thickness: int = 20
    stability: int = 60

PROFILES = {
    "clean_canny":  dict(bil=7, col=40, area=1.0, grad_sens=1.0, close=0),
    "ultra_clean":  dict(bil=9, col=60, area=1.5, grad_sens=0.8, close=0),
    "fine_detail":  dict(bil=5, col=28, area=0.5, grad_sens=1.3, close=0),
    "architecture": dict(bil=9, col=50, area=1.2, grad_sens=0.9, close=0),
}

class EdgeProcessor:
    def __init__(self, p: Params):
        self.p = p
        self.prof = PROFILES.get(p.mode, PROFILES["clean_canny"])
        self.prev_gray = None; self.state = None; self.prev_on = None
        self.clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))

    def _edges(self, bgr):
        p, f = self.p, self.prof
        gray_raw = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)

        # Bilateral filter preserves sharp step boundaries (text, contours) while smoothing flat grain/skin
        col_sigma = int(f["col"] + p.noise_removal * 0.3)
        gray = cv2.bilateralFilter(gray_raw, f["bil"], col_sigma, 8)

        # Contrast normalisation
        norm = self.clahe.apply(gray)

        # Adaptive Canny sensitivity
        k = (1.3 - p.detail / 100.0 * 0.5)
        low_t = max(5, int(p.low * k))
        high_t = max(low_t + 10, int(p.high * k))
        canny = cv2.Canny(norm, low_t, high_t, L2gradient=True)

        # Morphological gradient for crisp text (calligraphy, subtitles) and delicate artwork strokes
        kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
        grad = cv2.morphologyEx(gray, cv2.MORPH_GRADIENT, kernel)
        c_offset = int(-24 + (p.detail / 100.0) * 12 * f["grad_sens"])
        text_edges = cv2.adaptiveThreshold(grad, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 7, c_offset)

        # Combine Canny + text contours
        combined = cv2.bitwise_or(canny, text_edges)
        if f["close"]:
            combined = cv2.morphologyEx(combined, cv2.MORPH_CLOSE, np.ones((2, 2), np.uint8))
        return combined, gray

    def _remove_small(self, e):
        # Noise speck filter: removes isolated pixel noise while strictly protecting text dots and diacritics
        min_area = max(2, int(1 + (self.p.noise_removal / 100.0) * 3 * self.prof["area"]))
        if min_area <= 1: return e
        n, lab, st, _ = cv2.connectedComponentsWithStats(e, connectivity=8)
        keep = np.zeros(n, np.uint8); keep[1:] = st[1:, cv2.CC_STAT_AREA] >= min_area
        return (keep[lab] * 255).astype(np.uint8)

    def _temporal(self, e, gray):
        """Motion-aware EMA of edge map + cross-frame hysteresis; history is trusted less where pixels move."""
        cur = e.astype(np.float32) / 255.0; s = self.p.stability / 100.0 * 0.75
        if self.state is None or s == 0:
            self.state = cur; self.prev_on = e > 0; self.prev_gray = gray; return e
        motion = cv2.dilate(cv2.absdiff(gray, self.prev_gray), np.ones((5, 5), np.uint8)) > 14
        a = np.where(motion, s * 0.25, s).astype(np.float32)
        self.state = a * self.state + (1 - a) * cur
        on = (self.state > 0.45) | ((self.state > 0.25) & self.prev_on)
        self.prev_on, self.prev_gray = on, gray
        return (on * 255).astype(np.uint8)

    def process(self, bgr):
        e, gray = self._edges(bgr)
        e = self._temporal(self._remove_small(e), gray)
        t = int(self.p.thickness / 100.0 * 3)
        if t > 0:
            e = cv2.dilate(e, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (t * 2 + 1, t * 2 + 1)))
        return e
