// Shapes the search can place. Each shape knows how to create a random
// instance, mutate itself (for hill climbing), rasterize into scanlines, and
// describe itself as a plain snapshot {type, nums, flag}.
//
// A shape holds a "context" with: W, H, rnd (Rng), lines (Lines), aa (AARaster).
// Coordinates are image pixels. Ported from the Go implementation in
// primitive/*.go with the same ranges and mutation rules.

import { clamp, clampInt, degrees, radians, rotate } from './math.js';

const trunc = Math.trunc;

// ---------------------------------------------------------------- triangle

export class Triangle {
  constructor(ctx, x1, y1, x2, y2, x3, y3) {
    this.ctx = ctx;
    this.x1 = x1; this.y1 = y1;
    this.x2 = x2; this.y2 = y2;
    this.x3 = x3; this.y3 = y3;
  }

  static random(ctx) {
    const rnd = ctx.rnd;
    const x1 = rnd.intn(ctx.W);
    const y1 = rnd.intn(ctx.H);
    const t = new Triangle(
      ctx, x1, y1,
      x1 + rnd.intn(31) - 15, y1 + rnd.intn(31) - 15,
      x1 + rnd.intn(31) - 15, y1 + rnd.intn(31) - 15,
    );
    t.mutate();
    return t;
  }

  copy() {
    return new Triangle(this.ctx, this.x1, this.y1, this.x2, this.y2, this.x3, this.y3);
  }

  mutate() {
    const { W, H, rnd } = this.ctx;
    const m = 16;
    for (;;) {
      switch (rnd.intn(3)) {
        case 0:
          this.x1 = clampInt(this.x1 + trunc(rnd.norm() * 16), -m, W - 1 + m);
          this.y1 = clampInt(this.y1 + trunc(rnd.norm() * 16), -m, H - 1 + m);
          break;
        case 1:
          this.x2 = clampInt(this.x2 + trunc(rnd.norm() * 16), -m, W - 1 + m);
          this.y2 = clampInt(this.y2 + trunc(rnd.norm() * 16), -m, H - 1 + m);
          break;
        default:
          this.x3 = clampInt(this.x3 + trunc(rnd.norm() * 16), -m, W - 1 + m);
          this.y3 = clampInt(this.y3 + trunc(rnd.norm() * 16), -m, H - 1 + m);
      }
      if (this.valid()) break;
    }
  }

  valid() {
    const minDegrees = 15;
    let x1 = this.x2 - this.x1;
    let y1 = this.y2 - this.y1;
    let x2 = this.x3 - this.x1;
    let y2 = this.y3 - this.y1;
    let d1 = Math.sqrt(x1 * x1 + y1 * y1);
    let d2 = Math.sqrt(x2 * x2 + y2 * y2);
    x1 /= d1; y1 /= d1; x2 /= d2; y2 /= d2;
    const a1 = degrees(Math.acos(x1 * x2 + y1 * y2));

    x1 = this.x1 - this.x2;
    y1 = this.y1 - this.y2;
    x2 = this.x3 - this.x2;
    y2 = this.y3 - this.y2;
    d1 = Math.sqrt(x1 * x1 + y1 * y1);
    d2 = Math.sqrt(x2 * x2 + y2 * y2);
    x1 /= d1; y1 /= d1; x2 /= d2; y2 /= d2;
    const a2 = degrees(Math.acos(x1 * x2 + y1 * y2));

    const a3 = 180 - a1 - a2;
    return a1 > minDegrees && a2 > minDegrees && a3 > minDegrees;
  }

  rasterize() {
    const { lines, W, H } = this.ctx;
    lines.clear();
    rasterizeTriangle(this.x1, this.y1, this.x2, this.y2, this.x3, this.y3, lines);
    lines.crop(W, H);
  }

  snapshot() {
    return { type: 'triangle', nums: [this.x1, this.y1, this.x2, this.y2, this.x3, this.y3], flag: false };
  }
}

function rasterizeTriangle(x1, y1, x2, y2, x3, y3, lines) {
  let t;
  if (y1 > y3) { t = x1; x1 = x3; x3 = t; t = y1; y1 = y3; y3 = t; }
  if (y1 > y2) { t = x1; x1 = x2; x2 = t; t = y1; y1 = y2; y2 = t; }
  if (y2 > y3) { t = x2; x2 = x3; x3 = t; t = y2; y2 = y3; y3 = t; }
  if (y2 === y3) {
    triangleBottom(x1, y1, x2, y2, x3, y3, lines);
  } else if (y1 === y2) {
    triangleTop(x1, y1, x2, y2, x3, y3, lines);
  } else {
    const x4 = x1 + trunc(((y2 - y1) / (y3 - y1)) * (x3 - x1));
    const y4 = y2;
    triangleBottom(x1, y1, x2, y2, x4, y4, lines);
    triangleTop(x2, y2, x4, y4, x3, y3, lines);
  }
}

function triangleBottom(x1, y1, x2, y2, x3, y3, lines) {
  const s1 = (x2 - x1) / (y2 - y1);
  const s2 = (x3 - x1) / (y3 - y1);
  let ax = x1;
  let bx = x1;
  for (let y = y1; y <= y2; y++) {
    let a = trunc(ax);
    let b = trunc(bx);
    ax += s1;
    bx += s2;
    if (a > b) { const t = a; a = b; b = t; }
    lines.add(y, a, b, 0xffff);
  }
}

function triangleTop(x1, y1, x2, y2, x3, y3, lines) {
  const s1 = (x3 - x1) / (y3 - y1);
  const s2 = (x3 - x2) / (y3 - y2);
  let ax = x3;
  let bx = x3;
  for (let y = y3; y > y1; y--) {
    ax -= s1;
    bx -= s2;
    let a = trunc(ax);
    let b = trunc(bx);
    if (a > b) { const t = a; a = b; b = t; }
    lines.add(y, a, b, 0xffff);
  }
}

// --------------------------------------------------------------- rectangle

export class Rectangle {
  constructor(ctx, x1, y1, x2, y2) {
    this.ctx = ctx;
    this.x1 = x1; this.y1 = y1;
    this.x2 = x2; this.y2 = y2;
  }

  static random(ctx) {
    const rnd = ctx.rnd;
    const x1 = rnd.intn(ctx.W);
    const y1 = rnd.intn(ctx.H);
    return new Rectangle(
      ctx, x1, y1,
      clampInt(x1 + rnd.intn(32) + 1, 0, ctx.W - 1),
      clampInt(y1 + rnd.intn(32) + 1, 0, ctx.H - 1),
    );
  }

  copy() { return new Rectangle(this.ctx, this.x1, this.y1, this.x2, this.y2); }

  mutate() {
    const { W, H, rnd } = this.ctx;
    if (rnd.intn(2) === 0) {
      this.x1 = clampInt(this.x1 + trunc(rnd.norm() * 16), 0, W - 1);
      this.y1 = clampInt(this.y1 + trunc(rnd.norm() * 16), 0, H - 1);
    } else {
      this.x2 = clampInt(this.x2 + trunc(rnd.norm() * 16), 0, W - 1);
      this.y2 = clampInt(this.y2 + trunc(rnd.norm() * 16), 0, H - 1);
    }
  }

  rasterize() {
    const lines = this.ctx.lines;
    lines.clear();
    const x1 = Math.min(this.x1, this.x2);
    const x2 = Math.max(this.x1, this.x2);
    const y1 = Math.min(this.y1, this.y2);
    const y2 = Math.max(this.y1, this.y2);
    for (let y = y1; y <= y2; y++) lines.add(y, x1, x2, 0xffff);
  }

  snapshot() {
    return { type: 'rectangle', nums: [this.x1, this.y1, this.x2, this.y2], flag: false };
  }
}

export class RotatedRectangle {
  constructor(ctx, x, y, sx, sy, angle) {
    this.ctx = ctx;
    this.x = x; this.y = y;
    this.sx = sx; this.sy = sy;
    this.angle = angle;
  }

  static random(ctx) {
    const rnd = ctx.rnd;
    const r = new RotatedRectangle(
      ctx, rnd.intn(ctx.W), rnd.intn(ctx.H),
      rnd.intn(32) + 1, rnd.intn(32) + 1, rnd.intn(360),
    );
    r.mutate();
    return r;
  }

  copy() { return new RotatedRectangle(this.ctx, this.x, this.y, this.sx, this.sy, this.angle); }

  mutate() {
    const { W, H, rnd } = this.ctx;
    switch (rnd.intn(3)) {
      case 0:
        this.x = clampInt(this.x + trunc(rnd.norm() * 16), 0, W - 1);
        this.y = clampInt(this.y + trunc(rnd.norm() * 16), 0, H - 1);
        break;
      case 1:
        this.sx = clampInt(this.sx + trunc(rnd.norm() * 16), 1, W - 1);
        this.sy = clampInt(this.sy + trunc(rnd.norm() * 16), 1, H - 1);
        break;
      default:
        this.angle += trunc(rnd.norm() * 32);
    }
  }

  rasterize() {
    const { lines, W, H } = this.ctx;
    lines.clear();
    const sx = this.sx;
    const sy = this.sy;
    const angle = radians(this.angle);
    const [rx1, ry1] = rotate(-sx / 2, -sy / 2, angle);
    const [rx2, ry2] = rotate(sx / 2, -sy / 2, angle);
    const [rx3, ry3] = rotate(sx / 2, sy / 2, angle);
    const [rx4, ry4] = rotate(-sx / 2, sy / 2, angle);
    const x1 = trunc(rx1) + this.x, y1 = trunc(ry1) + this.y;
    const x2 = trunc(rx2) + this.x, y2 = trunc(ry2) + this.y;
    const x3 = trunc(rx3) + this.x, y3 = trunc(ry3) + this.y;
    const x4 = trunc(rx4) + this.x, y4 = trunc(ry4) + this.y;
    const minY = Math.min(y1, y2, y3, y4);
    const maxY = Math.max(y1, y2, y3, y4);
    const n = maxY - minY + 1;
    const ctx = this.ctx;
    if (!ctx.scratchLo || ctx.scratchLo.length < n) {
      ctx.scratchLo = new Int32Array(n + 256);
      ctx.scratchHi = new Int32Array(n + 256);
    }
    const lo = ctx.scratchLo;
    const hi = ctx.scratchHi;
    lo.fill(W, 0, n);
    hi.fill(0, 0, n);
    const xs = [x1, x2, x3, x4, x1];
    const ys = [y1, y2, y3, y4, y1];
    for (let i = 0; i < 4; i++) {
      const x = xs[i];
      const y = ys[i];
      const dx = xs[i + 1] - xs[i];
      const dy = ys[i + 1] - ys[i];
      const count = trunc(Math.sqrt(dx * dx + dy * dy)) * 2;
      for (let j = 0; j < count; j++) {
        const t = j / (count - 1);
        const xi = trunc(x + dx * t);
        const yi = trunc(y + dy * t) - minY;
        if (xi < lo[yi]) lo[yi] = xi;
        if (xi > hi[yi]) hi[yi] = xi;
      }
    }
    for (let i = 0; i < n; i++) {
      const y = minY + i;
      if (y < 0 || y >= H) continue;
      const a = Math.max(lo[i], 0);
      const b = Math.min(hi[i], W - 1);
      if (b >= a) lines.add(y, a, b, 0xffff);
    }
  }

  snapshot() {
    return { type: 'rotatedrect', nums: [this.x, this.y, this.sx, this.sy, this.angle], flag: false };
  }
}

// ----------------------------------------------------------------- ellipse

export class Ellipse {
  constructor(ctx, x, y, rx, ry, circle) {
    this.ctx = ctx;
    this.x = x; this.y = y;
    this.rx = rx; this.ry = ry;
    this.circle = circle;
  }

  static random(ctx) {
    const rnd = ctx.rnd;
    return new Ellipse(ctx, rnd.intn(ctx.W), rnd.intn(ctx.H), rnd.intn(32) + 1, rnd.intn(32) + 1, false);
  }

  static randomCircle(ctx) {
    const rnd = ctx.rnd;
    const r = rnd.intn(32) + 1;
    return new Ellipse(ctx, rnd.intn(ctx.W), rnd.intn(ctx.H), r, r, true);
  }

  copy() { return new Ellipse(this.ctx, this.x, this.y, this.rx, this.ry, this.circle); }

  mutate() {
    const { W, H, rnd } = this.ctx;
    switch (rnd.intn(3)) {
      case 0:
        this.x = clampInt(this.x + trunc(rnd.norm() * 16), 0, W - 1);
        this.y = clampInt(this.y + trunc(rnd.norm() * 16), 0, H - 1);
        break;
      case 1:
        this.rx = clampInt(this.rx + trunc(rnd.norm() * 16), 1, W - 1);
        if (this.circle) this.ry = this.rx;
        break;
      default:
        this.ry = clampInt(this.ry + trunc(rnd.norm() * 16), 1, H - 1);
        if (this.circle) this.rx = this.ry;
    }
  }

  rasterize() {
    const { lines, W, H } = this.ctx;
    lines.clear();
    const aspect = this.rx / this.ry;
    for (let dy = 0; dy < this.ry; dy++) {
      const y1 = this.y - dy;
      const y2 = this.y + dy;
      if ((y1 < 0 || y1 >= H) && (y2 < 0 || y2 >= H)) continue;
      const s = trunc(Math.sqrt(this.ry * this.ry - dy * dy) * aspect);
      let x1 = this.x - s;
      let x2 = this.x + s;
      if (x1 < 0) x1 = 0;
      if (x2 >= W) x2 = W - 1;
      if (y1 >= 0 && y1 < H) lines.add(y1, x1, x2, 0xffff);
      if (y2 >= 0 && y2 < H && dy > 0) lines.add(y2, x1, x2, 0xffff);
    }
  }

  snapshot() {
    return { type: 'ellipse', nums: [this.x, this.y, this.rx, this.ry], flag: this.circle };
  }
}

// 32-sided polygon: within 0.2 px of the true ellipse at these sizes.
const ELLIPSE_SIDES = 32;
const UNIT_COS = new Float64Array(ELLIPSE_SIDES);
const UNIT_SIN = new Float64Array(ELLIPSE_SIDES);
for (let i = 0; i < ELLIPSE_SIDES; i++) {
  UNIT_COS[i] = Math.cos((i / ELLIPSE_SIDES) * 2 * Math.PI);
  UNIT_SIN[i] = Math.sin((i / ELLIPSE_SIDES) * 2 * Math.PI);
}

export class RotatedEllipse {
  constructor(ctx, x, y, rx, ry, angle) {
    this.ctx = ctx;
    this.x = x; this.y = y;
    this.rx = rx; this.ry = ry;
    this.angle = angle;
  }

  static random(ctx) {
    const rnd = ctx.rnd;
    return new RotatedEllipse(
      ctx, rnd.float() * ctx.W, rnd.float() * ctx.H,
      rnd.float() * 32 + 1, rnd.float() * 32 + 1, rnd.float() * 360,
    );
  }

  copy() { return new RotatedEllipse(this.ctx, this.x, this.y, this.rx, this.ry, this.angle); }

  mutate() {
    const { W, H, rnd } = this.ctx;
    switch (rnd.intn(3)) {
      case 0:
        this.x = clamp(this.x + rnd.norm() * 16, 0, W - 1);
        this.y = clamp(this.y + rnd.norm() * 16, 0, H - 1);
        break;
      case 1:
        this.rx = clamp(this.rx + rnd.norm() * 16, 1, W - 1);
        this.ry = clamp(this.ry + rnd.norm() * 16, 1, W - 1);
        break;
      default:
        this.angle += rnd.norm() * 32;
    }
  }

  rasterize() {
    const { lines, aa } = this.ctx;
    const ex = this.ctx.ellX || (this.ctx.ellX = new Float64Array(ELLIPSE_SIDES));
    const ey = this.ctx.ellY || (this.ctx.ellY = new Float64Array(ELLIPSE_SIDES));
    const theta = radians(this.angle);
    const c = Math.cos(theta);
    const s = Math.sin(theta);
    for (let i = 0; i < ELLIPSE_SIDES; i++) {
      const px = this.rx * UNIT_COS[i];
      const py = this.ry * UNIT_SIN[i];
      ex[i] = px * c - py * s + this.x;
      ey[i] = px * s + py * c + this.y;
    }
    aa.reset();
    aa.polygonXY(ex, ey);
    lines.clear();
    aa.emit(lines);
  }

  snapshot() {
    return { type: 'rotatedellipse', nums: [this.x, this.y, this.rx, this.ry, this.angle], flag: false };
  }
}

// ------------------------------------------------------------------- curve

export class Quadratic {
  constructor(ctx, x1, y1, x2, y2, x3, y3, width) {
    this.ctx = ctx;
    this.x1 = x1; this.y1 = y1;
    this.x2 = x2; this.y2 = y2;
    this.x3 = x3; this.y3 = y3;
    this.width = width;
  }

  static random(ctx) {
    const rnd = ctx.rnd;
    const x1 = rnd.float() * ctx.W;
    const y1 = rnd.float() * ctx.H;
    const x2 = x1 + rnd.float() * 40 - 20;
    const y2 = y1 + rnd.float() * 40 - 20;
    const x3 = x2 + rnd.float() * 40 - 20;
    const y3 = y2 + rnd.float() * 40 - 20;
    const q = new Quadratic(ctx, x1, y1, x2, y2, x3, y3, 0.5);
    q.mutate();
    return q;
  }

  copy() { return new Quadratic(this.ctx, this.x1, this.y1, this.x2, this.y2, this.x3, this.y3, this.width); }

  mutate() {
    const { W, H, rnd } = this.ctx;
    const m = 16;
    for (;;) {
      // The Go original draws from 0..2, so its width branch never ran and
      // every curve stayed a half-pixel hairline. Drawing from 0..3 lets the
      // width evolve, which is what that branch was written to do.
      switch (rnd.intn(4)) {
        case 0:
          this.x1 = clamp(this.x1 + rnd.norm() * 16, -m, W - 1 + m);
          this.y1 = clamp(this.y1 + rnd.norm() * 16, -m, H - 1 + m);
          break;
        case 1:
          this.x2 = clamp(this.x2 + rnd.norm() * 16, -m, W - 1 + m);
          this.y2 = clamp(this.y2 + rnd.norm() * 16, -m, H - 1 + m);
          break;
        case 2:
          this.x3 = clamp(this.x3 + rnd.norm() * 16, -m, W - 1 + m);
          this.y3 = clamp(this.y3 + rnd.norm() * 16, -m, H - 1 + m);
          break;
        default:
          this.width = clamp(this.width + rnd.norm(), 1, 16);
      }
      if (this.valid()) break;
    }
  }

  valid() {
    const dx12 = trunc(this.x1 - this.x2), dy12 = trunc(this.y1 - this.y2);
    const dx23 = trunc(this.x2 - this.x3), dy23 = trunc(this.y2 - this.y3);
    const dx13 = trunc(this.x1 - this.x3), dy13 = trunc(this.y1 - this.y3);
    const d12 = dx12 * dx12 + dy12 * dy12;
    const d23 = dx23 * dx23 + dy23 * dy23;
    const d13 = dx13 * dx13 + dy13 * dy13;
    return d13 > d12 && d13 > d23;
  }

  rasterize() {
    const { lines, aa } = this.ctx;
    const n = CURVE_STEPS + 1;
    const lx = this.ctx.curveLx || (this.ctx.curveLx = new Float64Array(2 * n));
    const ly = this.ctx.curveLy || (this.ctx.curveLy = new Float64Array(2 * n));
    const hw = this.width / 2;

    // Walk the curve; at each point offset it left and right by half the width.
    let prevX = this.x1;
    let prevY = this.y1;
    for (let i = 0; i < n; i++) {
      const t = i / CURVE_STEPS;
      const u = 1 - t;
      const x = u * u * this.x1 + 2 * u * t * this.x2 + t * t * this.x3;
      const y = u * u * this.y1 + 2 * u * t * this.y2 + t * t * this.y3;
      // tangent: derivative of the curve (falls back to the chord at a cusp)
      let tx = 2 * u * (this.x2 - this.x1) + 2 * t * (this.x3 - this.x2);
      let ty = 2 * u * (this.y2 - this.y1) + 2 * t * (this.y3 - this.y2);
      let len = Math.sqrt(tx * tx + ty * ty);
      if (len < 1e-9) {
        tx = x - prevX; ty = y - prevY;
        len = Math.sqrt(tx * tx + ty * ty);
        if (len < 1e-9) { tx = 1; ty = 0; len = 1; }
      }
      const nx = (-ty / len) * hw;
      const ny = (tx / len) * hw;
      lx[i] = x + nx;
      ly[i] = y + ny;
      lx[2 * n - 1 - i] = x - nx;
      ly[2 * n - 1 - i] = y - ny;
      prevX = x;
      prevY = y;
    }

    aa.reset();
    aa.polygonXY(lx, ly);
    capCircle(aa, this.x1, this.y1, hw);
    capCircle(aa, this.x3, this.y3, hw);
    lines.clear();
    aa.emit(lines);
  }

  snapshot() {
    return {
      type: 'quadratic',
      nums: [this.x1, this.y1, this.x2, this.y2, this.x3, this.y3, this.width],
      flag: false,
    };
  }
}

const CURVE_STEPS = 8;

// Round cap. Wound the same way as the stroke outline so overlaps add up and clamp.
function capCircle(aa, cx, cy, r) {
  const n = 6;
  let px = cx + r;
  let py = cy;
  for (let i = 1; i <= n; i++) {
    const a = (-i / n) * 2 * Math.PI;
    const x = cx + r * Math.cos(a);
    const y = cy + r * Math.sin(a);
    aa.line(px, py, x, y);
    px = x;
    py = y;
  }
}

// ----------------------------------------------------------------- polygon

export class Polygon {
  constructor(ctx, order, convex, xs, ys) {
    this.ctx = ctx;
    this.order = order;
    this.convex = convex;
    this.xs = xs;
    this.ys = ys;
  }

  static random(ctx, order = 4, convex = false) {
    const rnd = ctx.rnd;
    const xs = new Array(order);
    const ys = new Array(order);
    xs[0] = rnd.float() * ctx.W;
    ys[0] = rnd.float() * ctx.H;
    for (let i = 1; i < order; i++) {
      xs[i] = xs[0] + rnd.float() * 40 - 20;
      ys[i] = ys[0] + rnd.float() * 40 - 20;
    }
    const p = new Polygon(ctx, order, convex, xs, ys);
    p.mutate();
    return p;
  }

  copy() { return new Polygon(this.ctx, this.order, this.convex, this.xs.slice(), this.ys.slice()); }

  mutate() {
    const { W, H, rnd } = this.ctx;
    const m = 16;
    for (;;) {
      if (rnd.float() < 0.25) {
        const i = rnd.intn(this.order);
        const j = rnd.intn(this.order);
        const tx = this.xs[i], ty = this.ys[i];
        this.xs[i] = this.xs[j]; this.ys[i] = this.ys[j];
        this.xs[j] = tx; this.ys[j] = ty;
      } else {
        const i = rnd.intn(this.order);
        this.xs[i] = clamp(this.xs[i] + rnd.norm() * 16, -m, W - 1 + m);
        this.ys[i] = clamp(this.ys[i] + rnd.norm() * 16, -m, H - 1 + m);
      }
      if (this.valid()) break;
    }
  }

  valid() {
    if (!this.convex) return true;
    const n = this.order;
    let sign = false;
    for (let a = 0; a < n; a++) {
      const i = a % n, j = (a + 1) % n, k = (a + 2) % n;
      const dx1 = this.xs[j] - this.xs[i], dy1 = this.ys[j] - this.ys[i];
      const dx2 = this.xs[k] - this.xs[j], dy2 = this.ys[k] - this.ys[j];
      const c = dx1 * dy2 - dy1 * dx2;
      if (a === 0) sign = c > 0;
      else if (c > 0 !== sign) return false;
    }
    return true;
  }

  rasterize() {
    const { lines, aa } = this.ctx;
    aa.reset();
    aa.polygonXY(this.xs, this.ys);
    lines.clear();
    aa.emit(lines);
  }

  snapshot() {
    const nums = [];
    for (let i = 0; i < this.order; i++) nums.push(this.xs[i], this.ys[i]);
    return { type: 'polygon', nums, flag: this.convex };
  }
}

// ---------------------------------------------------------------- registry

/** Shape modes, numbered like the command-line tool's -m flag. */
export const MODE_COMBO = 0;
const RANDOM_BY_MODE = {
  1: Triangle.random,
  2: Rectangle.random,
  3: Ellipse.random,
  4: Ellipse.randomCircle,
  5: RotatedRectangle.random,
  6: Quadratic.random,
  7: RotatedEllipse.random,
  8: (ctx) => Polygon.random(ctx, 4, false),
};

export function randomShape(ctx, mode) {
  if (mode === MODE_COMBO) mode = ctx.rnd.intn(8) + 1;
  const make = RANDOM_BY_MODE[mode];
  if (!make) throw new Error(`unknown shape mode ${mode}`);
  return make(ctx);
}

const COUNTS = { triangle: 6, rectangle: 4, rotatedrect: 5, ellipse: 4, rotatedellipse: 5, quadratic: 7 };
const LIMIT = 1e5;

/** Rebuild a shape from a snapshot, validating it first (snapshots may come from storage). */
export function shapeFromSnapshot(ctx, snap) {
  const n = snap.nums;
  if (!Array.isArray(n) || n.some((v) => typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > LIMIT)) {
    throw new Error(`bad numbers in ${snap.type} shape`);
  }
  const need = COUNTS[snap.type];
  if (need !== undefined && n.length !== need) {
    throw new Error(`${snap.type} needs ${need} numbers, got ${n.length}`);
  }
  switch (snap.type) {
    case 'triangle': return new Triangle(ctx, n[0], n[1], n[2], n[3], n[4], n[5]);
    case 'rectangle': return new Rectangle(ctx, n[0], n[1], n[2], n[3]);
    case 'rotatedrect': return new RotatedRectangle(ctx, n[0], n[1], n[2], n[3], n[4]);
    case 'ellipse': return new Ellipse(ctx, n[0], n[1], n[2], n[3], !!snap.flag);
    case 'rotatedellipse': return new RotatedEllipse(ctx, n[0], n[1], n[2], n[3], n[4]);
    case 'quadratic': return new Quadratic(ctx, n[0], n[1], n[2], n[3], n[4], n[5], n[6]);
    case 'polygon': {
      if (n.length < 6 || n.length % 2 !== 0) throw new Error('polygon needs at least 3 points');
      const order = n.length / 2;
      const xs = new Array(order);
      const ys = new Array(order);
      for (let i = 0; i < order; i++) { xs[i] = n[i * 2]; ys[i] = n[i * 2 + 1]; }
      return new Polygon(ctx, order, !!snap.flag, xs, ys);
    }
    default: throw new Error(`unknown shape type "${snap.type}"`);
  }
}
