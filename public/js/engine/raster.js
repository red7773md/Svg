// Anti-aliased polygon filling by signed-area accumulation (the approach used
// by font rasterizers). Winding contributions add up, and coverage is the
// absolute accumulated value clamped to 1, which gives non-zero winding fill.

export class AARaster {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.stride = w + 2;
    this.acc = new Float64Array(this.stride * h);
    this.minY = h;
    this.maxY = -1;
    this.minX = w;
    this.maxX = -1;
  }

  /** Clear whatever the previous shape wrote. */
  reset() {
    if (this.maxY >= this.minY) this.acc.fill(0, this.minY * this.stride, (this.maxY + 1) * this.stride);
    this.minY = this.h;
    this.maxY = -1;
    this.minX = this.w;
    this.maxX = -1;
  }

  /** Add one directed edge. x is clamped to the image so area to the left still counts. */
  line(x0, y0, x1, y1) {
    if (y0 === y1) return;
    let dir = 1;
    if (y0 > y1) {
      dir = -1;
      let t = x0; x0 = x1; x1 = t;
      t = y0; y0 = y1; y1 = t;
    }
    const h = this.h;
    if (y1 <= 0 || y0 >= h) return;
    // remember the horizontal extent so emit() only sweeps the columns used
    const w0 = this.w;
    let lo = x0 < x1 ? x0 : x1;
    let hi = x0 < x1 ? x1 : x0;
    lo = lo < 0 ? 0 : lo > w0 ? w0 : lo;
    hi = hi < 0 ? 0 : hi > w0 ? w0 : hi;
    const loI = Math.floor(lo);
    const hiI = Math.ceil(hi);
    if (loI < this.minX) this.minX = loI;
    if (hiI > this.maxX) this.maxX = hiI;
    const dxdy = (x1 - x0) / (y1 - y0);
    let x = x0;
    let y = Math.floor(y0);
    if (y0 < 0) {
      x -= y0 * dxdy;
      y = 0;
    }
    const yEnd = Math.min(h, Math.ceil(y1));
    if (y < this.minY) this.minY = y;
    if (yEnd - 1 > this.maxY) this.maxY = yEnd - 1;
    const acc = this.acc;
    const stride = this.stride;
    const w = this.w;
    for (; y < yEnd; y++) {
      const base = y * stride;
      const top = y0 > y ? y0 : y;
      const bot = y + 1 < y1 ? y + 1 : y1;
      const dy = bot - top;
      const xn = x + dxdy * dy;
      const d = dy * dir;
      const a = x < 0 ? 0 : x > w ? w : x;
      const b = xn < 0 ? 0 : xn > w ? w : xn;
      const xl = a < b ? a : b;
      const xr = a < b ? b : a;
      const xli = Math.floor(xl);
      const xri = Math.ceil(xr);
      if (xri <= xli + 1) {
        const xmf = 0.5 * (a + b) - xli;
        acc[base + xli] += d - d * xmf;
        acc[base + xli + 1] += d * xmf;
      } else {
        const s = 1 / (xr - xl);
        const x0f = xl - xli;
        const a0 = 0.5 * s * (1 - x0f) * (1 - x0f);
        const x1f = xr - xri + 1;
        const am = 0.5 * s * x1f * x1f;
        acc[base + xli] += d * a0;
        if (xri === xli + 2) {
          acc[base + xli + 1] += d * (1 - a0 - am);
        } else {
          const a1 = s * (1.5 - x0f);
          acc[base + xli + 1] += d * (a1 - a0);
          for (let xi = xli + 2; xi < xri - 1; xi++) acc[base + xi] += d * s;
          const a2 = a1 + (xri - xli - 3) * s;
          acc[base + xri - 1] += d * (1 - a2 - am);
        }
        acc[base + xri] += d * am;
      }
      x = xn;
    }
  }

  /** Add a closed polygon given as separate x and y arrays. */
  polygonXY(xs, ys) {
    const n = xs.length;
    for (let i = 0, j = n - 1; i < n; j = i++) this.line(xs[j], ys[j], xs[i], ys[i]);
  }

  /** Add a closed polygon given as [x0, y0, x1, y1, ...]. */
  polygon(pts) {
    const n = pts.length;
    for (let i = 0; i < n; i += 2) {
      const j = (i + 2) % n;
      this.line(pts[i], pts[i + 1], pts[j], pts[j + 1]);
    }
  }

  /** Turn the accumulated coverage into scanlines (runs of equal alpha). */
  emit(lines) {
    const acc = this.acc;
    const stride = this.stride;
    const xStart = this.minX;
    const xEnd = Math.min(this.w - 1, this.maxX);
    for (let y = this.minY; y <= this.maxY; y++) {
      const base = y * stride;
      let sum = 0;
      let runStart = xStart;
      let runAlpha = 0;
      for (let x = xStart; x <= xEnd; x++) {
        sum += acc[base + x];
        let c = sum < 0 ? -sum : sum;
        if (c > 1) c = 1;
        const al = (c * 65535 + 0.5) | 0;
        if (al !== runAlpha) {
          if (runAlpha > 0) lines.add(y, runStart, x - 1, runAlpha);
          runStart = x;
          runAlpha = al;
        }
      }
      if (runAlpha > 0) lines.add(y, runStart, xEnd, runAlpha);
    }
  }
}
