// Fast seedable random numbers (sfc32) with the few helpers the search needs.

export class Rng {
  /** @param {number} [seed] 32-bit seed; random when omitted. */
  constructor(seed) {
    if (seed === undefined || seed === null) {
      const buf = new Uint32Array(1);
      if (globalThis.crypto && globalThis.crypto.getRandomValues) globalThis.crypto.getRandomValues(buf);
      else buf[0] = (Math.random() * 4294967296) >>> 0;
      seed = buf[0];
    }
    let s = seed >>> 0;
    const next = () => {
      // splitmix32, used only to spread the seed over the 128-bit state
      s = (s + 0x9e3779b9) | 0;
      let t = s ^ (s >>> 16);
      t = Math.imul(t, 0x21f0aaad);
      t ^= t >>> 15;
      t = Math.imul(t, 0x735a2d97);
      t ^= t >>> 15;
      return t >>> 0;
    };
    this.a = next();
    this.b = next();
    this.c = next();
    this.d = next();
    this.spare = null;
    for (let i = 0; i < 12; i++) this.uint32();
  }

  uint32() {
    let a = this.a, b = this.b, c = this.c, d = this.d;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    this.a = a; this.b = b; this.c = c; this.d = d;
    return t >>> 0;
  }

  /** Uniform float in [0, 1). */
  float() { return this.uint32() / 4294967296; }

  /** Uniform integer in [0, n). */
  intn(n) { return Math.floor(this.float() * n); }

  /** Standard normal variate (polar Box-Muller). */
  norm() {
    if (this.spare !== null) {
      const v = this.spare;
      this.spare = null;
      return v;
    }
    let u, v, s;
    do {
      u = this.float() * 2 - 1;
      v = this.float() * 2 - 1;
      s = u * u + v * v;
    } while (s >= 1 || s === 0);
    const m = Math.sqrt((-2 * Math.log(s)) / s);
    this.spare = v * m;
    return u * m;
  }
}
