"""Edge-detection pipeline. Each mode = parameter profile over one shared, tunable pipeline.
CPU only; every stage works on numpy/cv2 arrays so a CUDA backend can replace stages later."""
from dataclasses import dataclass
import cv2, numpy as np

@dataclass
class Params:
    mode: str = "clean_canny"
    low: int = 50
    high: int = 150
    noise_removal: int = 50
    detail: int = 50
    thickness: int = 30
    stability: int = 60

PROFILES = {
    "clean_canny":  dict(sigma=1.2, bil=7, area=1.0, close=1, tscale=1.0),
    "ultra_clean":  dict(sigma=2.0, bil=9, area=3.0, close=3, tscale=1.25),
    "fine_detail":  dict(sigma=0.8, bil=5, area=0.4, close=1, tscale=0.7),
    "architecture": dict(sigma=1.6, bil=9, area=2.0, close=3, tscale=1.0),
}

class EdgeProcessor:
    def __init__(self, p: Params):
        self.p, self.prof = p, PROFILES[p.mode]
        self.prev_gray = None; self.state = None; self.prev_on = None
        self.clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))

    def _edges(self, bgr):
        p, f = self.p, self.prof
        gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
        gray = cv2.bilateralFilter(gray, f["bil"], 40, 5)             # denoise, keep edges
        gray = cv2.GaussianBlur(gray, (0, 0), f["sigma"] * (0.6 + p.noise_removal / 100 * 0.8))
        l = self.clahe.apply(gray)                                    # contrast normalisation
        k = f["tscale"] * (1.3 - p.detail / 100 * 0.6)
        e = cv2.Canny(l, max(1, p.low * k), max(2, p.high * k), L2gradient=True)
        if f["close"] > 1: e = cv2.morphologyEx(e, cv2.MORPH_CLOSE, np.ones((2, 2), np.uint8))
        return e, gray

    def _remove_small(self, e):
        h, w = e.shape
        min_area = int((h * w) / 1e6 * 6 * self.prof["area"] * (0.2 + self.p.noise_removal / 100 * 1.8))
        if min_area < 2: return e
        n, lab, st, _ = cv2.connectedComponentsWithStats(e, connectivity=8)
        keep = np.zeros(n, np.uint8); keep[1:] = st[1:, cv2.CC_STAT_AREA] >= min_area
        return (keep[lab] * 255).astype(np.uint8)

    def _temporal(self, e, gray):
        """Motion-aware EMA of edge map + cross-frame hysteresis; history is trusted less where pixels move (no trails)."""
        cur = e.astype(np.float32) / 255; s = self.p.stability / 100 * 0.8
        if self.state is None or s == 0:
            self.state = cur; self.prev_on = e > 0; self.prev_gray = gray; return e
        motion = cv2.dilate(cv2.absdiff(gray, self.prev_gray), np.ones((5, 5), np.uint8)) > 14
        a = np.where(motion, s * 0.25, s).astype(np.float32)
        self.state = a * self.state + (1 - a) * cur
        on = (self.state > 0.5) | ((self.state > 0.28) & self.prev_on)
        self.prev_on, self.prev_gray = on, gray
        return (on * 255).astype(np.uint8)

    def process(self, bgr):
        e, gray = self._edges(bgr)
        e = self._temporal(self._remove_small(e), gray)
        t = int(self.p.thickness / 100 * 3)
        if t: e = cv2.dilate(e, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (t * 2 + 1,) * 2))
        return e
