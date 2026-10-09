// A growable list of scanlines stored in one typed array.
// Each line is four ints: y, x1, x2 (inclusive), alpha (0..0xffff coverage).

export class Lines {
  constructor(capacity = 1024) {
    this.data = new Int32Array(capacity * 4);
    this.n = 0;
  }

  clear() { this.n = 0; }

  add(y, x1, x2, alpha) {
    const i = this.n << 2;
    if (i + 4 > this.data.length) this.grow();
    const d = this.data;
    d[i] = y;
    d[i + 1] = x1;
    d[i + 2] = x2;
    d[i + 3] = alpha;
    this.n++;
  }

  grow() {
    const next = new Int32Array(this.data.length * 2);
    next.set(this.data);
    this.data = next;
  }

  /** Clip every line to a w x h image, dropping lines that fall outside. */
  crop(w, h) {
    const d = this.data;
    let out = 0;
    for (let k = 0; k < this.n; k++) {
      const i = k << 2;
      const y = d[i];
      let x1 = d[i + 1];
      let x2 = d[i + 2];
      if (y < 0 || y >= h || x1 >= w || x2 < 0) continue;
      if (x1 < 0) x1 = 0;
      if (x2 > w - 1) x2 = w - 1;
      if (x1 > x2) continue;
      const o = out << 2;
      d[o] = y;
      d[o + 1] = x1;
      d[o + 2] = x2;
      d[o + 3] = d[i + 3];
      out++;
    }
    this.n = out;
  }
}
