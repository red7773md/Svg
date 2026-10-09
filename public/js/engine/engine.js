// The search engine. One Engine owns a target image and the picture built so
// far ("current"). It can search for the best next shape, apply a shape, and
// replay a saved list of shapes. It has no DOM dependency, so it runs in Web
// Workers and in Node (for tests).
//
// "Energy" is the total squared RGB error between target and current. The
// score shown to people is the RMSE derived from it. Both are exact integers
// in floating point, so partial updates never drift from a full recompute.

import { AARaster } from './raster.js';
import { Lines } from './lines.js';
import { Rng } from './rng.js';
import { clampInt } from './math.js';
import { randomShape, shapeFromSnapshot } from './shapes.js';

const M = 0xffff;

class State {
  constructor(engine, shape, alpha, mutateAlpha, energy = -1) {
    this.engine = engine;
    this.shape = shape;
    this.alpha = alpha;
    this.mutateAlpha = mutateAlpha;
    this.score = energy;
  }

  energy() {
    if (this.score < 0) this.score = this.engine.evaluate(this.shape, this.alpha);
    return this.score;
  }

  doMove() {
    const old = this.copy();
    this.shape.mutate();
    if (this.mutateAlpha) {
      this.alpha = clampInt(this.alpha + this.engine.rnd.intn(21) - 10, 1, 255);
    }
    this.score = -1;
    return old;
  }

  undoMove(old) {
    this.shape = old.shape;
    this.alpha = old.alpha;
    this.score = old.score;
  }

  copy() {
    return new State(this.engine, this.shape.copy(), this.alpha, this.mutateAlpha, this.score);
  }
}

function hillClimb(start, maxAge) {
  let state = start.copy();
  let best = state.copy();
  let bestEnergy = state.energy();
  for (let age = 0; age < maxAge; age++) {
    const undo = state.doMove();
    const energy = state.energy();
    if (energy >= bestEnergy) {
      state.undoMove(undo);
    } else {
      bestEnergy = energy;
      best = state.copy();
      age = -1;
    }
  }
  return best;
}

export class Engine {
  /**
   * @param {object} opts
   * @param {number} opts.width    target width in pixels
   * @param {number} opts.height   target height in pixels
   * @param {Uint8Array|Uint8ClampedArray} opts.target  RGBA pixels, alpha ignored
   * @param {number[]} opts.background  [r, g, b] the picture starts as
   * @param {number} [opts.seed]   makes the search repeatable
   */
  constructor({ width, height, target, background, seed }) {
    this.W = width;
    this.H = height;
    this.target = new Uint8Array(width * height * 4);
    this.target.set(target);
    this.current = new Uint8Array(width * height * 4);
    for (let i = 0; i < this.current.length; i += 4) {
      this.current[i] = background[0];
      this.current[i + 1] = background[1];
      this.current[i + 2] = background[2];
      this.current[i + 3] = 255;
      this.target[i + 3] = 255;
    }
    this.rnd = new Rng(seed);
    this.lines = new Lines(Math.max(256, height * 2));
    this.aa = new AARaster(width, height);
    this.counter = 0;
    this.total = this.fullEnergy();
  }

  // The shape context: what shapes read from the engine.
  get ctx() { return this; }

  /** Total squared error over the whole image, computed from scratch. */
  fullEnergy() {
    const t = this.target;
    const c = this.current;
    let total = 0;
    for (let i = 0; i < t.length; i += 4) {
      const dr = t[i] - c[i];
      const dg = t[i + 1] - c[i + 1];
      const db = t[i + 2] - c[i + 2];
      total += dr * dr + dg * dg + db * db;
    }
    return total;
  }

  /** Root-mean-square error in 0..1 (0 is a perfect match). */
  score() {
    return Math.sqrt(this.total / (this.W * this.H * 4)) / 255;
  }

  /** The color that best fits the pixels under the current scanlines at this opacity. */
  computeColor(alpha) {
    const { W, target, current } = this;
    const ld = this.lines.data;
    const n = this.lines.n;
    const a = Math.floor((0x101 * 255) / alpha);
    let rsum = 0, gsum = 0, bsum = 0, count = 0;
    for (let k = 0; k < n; k++) {
      const o = k << 2;
      const x1 = ld[o + 1];
      const x2 = ld[o + 2];
      let i = (ld[o] * W + x1) * 4;
      for (let x = x1; x <= x2; x++, i += 4) {
        const cr = current[i], cg = current[i + 1], cb = current[i + 2];
        rsum += (target[i] - cr) * a + cr * 0x101;
        gsum += (target[i + 1] - cg) * a + cg * 0x101;
        bsum += (target[i + 2] - cb) * a + cb * 0x101;
      }
      count += x2 - x1 + 1;
    }
    if (count === 0) return [0, 0, 0, 0];
    return [
      clampInt(Math.trunc(rsum / count) >> 8, 0, 255),
      clampInt(Math.trunc(gsum / count) >> 8, 0, 255),
      clampInt(Math.trunc(bsum / count) >> 8, 0, 255),
      alpha,
    ];
  }

  /**
   * Energy change from painting `color` over the current scanlines. When
   * `commit` is true the pixels are written to the current picture too.
   * Blending matches the Go implementation's integer arithmetic exactly.
   */
  paint(color, commit) {
    const { W, target, current } = this;
    const ld = this.lines.data;
    const n = this.lines.n;
    const ca = color[3];
    // premultiplied 16-bit color, as Go's color.NRGBA.RGBA() produces it
    const sr = Math.floor(((color[0] * 257) * ca) / 255);
    const sg = Math.floor(((color[1] * 257) * ca) / 255);
    const sb = Math.floor(((color[2] * 257) * ca) / 255);
    const sa = ca * 257;
    let delta = 0;
    for (let k = 0; k < n; k++) {
      const o = k << 2;
      const x1 = ld[o + 1];
      const x2 = ld[o + 2];
      const ma = ld[o + 3];
      const a = (M - Math.floor((sa * ma) / M)) * 0x101;
      let i = (ld[o] * W + x1) * 4;
      if (ma === M) {
        for (let x = x1; x <= x2; x++, i += 4) {
          const tr = target[i], tg = target[i + 1], tb = target[i + 2];
          const dr = current[i], dg = current[i + 1], db = current[i + 2];
          const nr = (sr + ((dr * a / M) | 0)) >> 8;
          const ng = (sg + ((dg * a / M) | 0)) >> 8;
          const nb = (sb + ((db * a / M) | 0)) >> 8;
          delta += (tr - nr) * (tr - nr) + (tg - ng) * (tg - ng) + (tb - nb) * (tb - nb)
            - (tr - dr) * (tr - dr) - (tg - dg) * (tg - dg) - (tb - db) * (tb - db);
          if (commit) {
            current[i] = nr;
            current[i + 1] = ng;
            current[i + 2] = nb;
          }
        }
      } else {
        const srm = sr * ma, sgm = sg * ma, sbm = sb * ma;
        for (let x = x1; x <= x2; x++, i += 4) {
          const tr = target[i], tg = target[i + 1], tb = target[i + 2];
          const dr = current[i], dg = current[i + 1], db = current[i + 2];
          const nr = Math.floor((dr * a + srm) / M) >> 8;
          const ng = Math.floor((dg * a + sgm) / M) >> 8;
          const nb = Math.floor((db * a + sbm) / M) >> 8;
          delta += (tr - nr) * (tr - nr) + (tg - ng) * (tg - ng) + (tb - nb) * (tb - nb)
            - (tr - dr) * (tr - dr) - (tg - dg) * (tg - dg) - (tb - db) * (tb - db);
          if (commit) {
            current[i] = nr;
            current[i + 1] = ng;
            current[i + 2] = nb;
          }
        }
      }
    }
    return delta;
  }

  /** Energy the picture would have if this shape were added. */
  evaluate(shape, alpha) {
    this.counter++;
    shape.rasterize();
    const color = this.computeColor(alpha);
    return this.total + this.paint(color, false);
  }

  randomState(mode, alpha) {
    const shape = randomShape(this, mode);
    return alpha === 0 ? new State(this, shape, 128, true) : new State(this, shape, alpha, false);
  }

  bestRandomState(mode, alpha, count) {
    let best = null;
    let bestEnergy = 0;
    for (let i = 0; i < count; i++) {
      const state = this.randomState(mode, alpha);
      const energy = state.energy();
      if (i === 0 || energy < bestEnergy) {
        bestEnergy = energy;
        best = state;
      }
    }
    return best;
  }

  /**
   * Find the best next shape: `climbs` independent hill climbs, each starting
   * from the best of `candidates` random shapes.
   * @returns {{shape: object, color: number[], energy: number, evals: number}}
   */
  search({ mode = 1, alpha = 128, candidates = 1000, age = 100, climbs = 16 } = {}) {
    this.counter = 0;
    let best = null;
    for (let i = 0; i < climbs; i++) {
      const start = this.bestRandomState(mode, alpha, candidates);
      const state = hillClimb(start, age);
      if (best === null || state.energy() < best.energy()) best = state;
    }
    best.shape.rasterize();
    const color = this.computeColor(best.alpha);
    const snap = best.shape.snapshot();
    return { shape: { ...snap, color }, energy: best.energy(), evals: this.counter };
  }

  /** Paint a shape (with its stored color) onto the current picture. */
  apply(snap) {
    const shape = shapeFromSnapshot(this, snap);
    shape.rasterize();
    this.total += this.paint(snap.color, true);
  }

  /** Replay shapes saved from an earlier session, in order. */
  restore(shapes) {
    for (const snap of shapes) this.apply(snap);
  }
}
