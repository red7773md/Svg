// Engine tests. Run with:  node --test tests/
// No dependencies: the engine is plain ES modules and the PNG helper is local.

import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { Rng } from '../public/js/engine/rng.js';
import { Lines } from '../public/js/engine/lines.js';
import { AARaster } from '../public/js/engine/raster.js';
import { Engine } from '../public/js/engine/engine.js';
import {
  Triangle, Rectangle, RotatedRectangle, Ellipse, RotatedEllipse, Quadratic, Polygon,
  randomShape, shapeFromSnapshot,
} from '../public/js/engine/shapes.js';
import { decodePng, resizeTo } from './helpers/png.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const example = (name) => resizeTo(decodePng(path.join(here, '..', 'examples', name)), 128);

function makeEngine(name = 'owl.png', seed = 1) {
  const img = example(name);
  const avg = [0, 0, 0];
  for (let i = 0; i < img.data.length; i += 4) for (let c = 0; c < 3; c++) avg[c] += img.data[i + c];
  const px = img.width * img.height;
  const bg = avg.map((v) => Math.round(v / px));
  return new Engine({ width: img.width, height: img.height, target: img.data, background: bg, seed });
}

// ------------------------------------------------------------------- rng

test('rng: ranges, spread, and repeatability', () => {
  const a = new Rng(42);
  const b = new Rng(42);
  for (let i = 0; i < 100; i++) assert.equal(a.uint32(), b.uint32());

  const r = new Rng(7);
  const counts = new Array(10).fill(0);
  for (let i = 0; i < 100000; i++) {
    const v = r.intn(10);
    assert.ok(v >= 0 && v < 10);
    counts[v]++;
  }
  for (const c of counts) assert.ok(c > 9000 && c < 11000, `bucket ${c}`);

  let sum = 0, sq = 0;
  const n = 100000;
  for (let i = 0; i < n; i++) { const v = r.norm(); sum += v; sq += v * v; }
  assert.ok(Math.abs(sum / n) < 0.02, 'normal mean near 0');
  assert.ok(Math.abs(sq / n - 1) < 0.03, 'normal variance near 1');
});

// ---------------------------------------------------------------- raster

test('AA raster: axis-aligned square covers exactly its area', () => {
  const aa = new AARaster(32, 32);
  aa.polygon([4, 4, 20, 4, 20, 12, 4, 12]);
  const lines = new Lines();
  aa.emit(lines);
  let area = 0;
  for (let k = 0; k < lines.n; k++) {
    const o = k * 4;
    area += ((lines.data[o + 2] - lines.data[o + 1] + 1) * lines.data[o + 3]) / 65535;
  }
  assert.ok(Math.abs(area - 16 * 8) < 1e-6, `area ${area}`);
});

test('AA raster: coverage of a triangle matches its geometric area', () => {
  const aa = new AARaster(64, 64);
  const pts = [5.3, 7.1, 50.6, 12.4, 22.2, 55.9];
  aa.polygon(pts);
  const lines = new Lines();
  aa.emit(lines);
  let area = 0;
  for (let k = 0; k < lines.n; k++) {
    const o = k * 4;
    area += ((lines.data[o + 2] - lines.data[o + 1] + 1) * lines.data[o + 3]) / 65535;
  }
  const expected = Math.abs((pts[2] - pts[0]) * (pts[5] - pts[1]) - (pts[4] - pts[0]) * (pts[3] - pts[1])) / 2;
  assert.ok(Math.abs(area - expected) / expected < 0.001, `area ${area} vs ${expected}`);
});

test('AA raster: clips to the image and resets between shapes', () => {
  const aa = new AARaster(32, 32);
  const lines = new Lines();
  aa.polygon([-20, -20, 60, -20, 60, 60, -20, 60]); // bigger than the image
  aa.emit(lines);
  let area = 0;
  for (let k = 0; k < lines.n; k++) {
    const o = k * 4;
    assert.ok(lines.data[o] >= 0 && lines.data[o] < 32);
    assert.ok(lines.data[o + 1] >= 0 && lines.data[o + 2] <= 31);
    area += ((lines.data[o + 2] - lines.data[o + 1] + 1) * lines.data[o + 3]) / 65535;
  }
  assert.ok(Math.abs(area - 32 * 32) < 1e-6, `area ${area}`);

  aa.reset();
  lines.clear();
  aa.emit(lines);
  assert.equal(lines.n, 0, 'nothing left after reset');
});

// ---------------------------------------------------------------- shapes

const MODES = [1, 2, 3, 4, 5, 6, 7, 8];

test('shapes: every mode rasterizes inside the image, before and after mutation', () => {
  const e = makeEngine();
  for (const mode of MODES) {
    for (let i = 0; i < 300; i++) {
      const shape = randomShape(e, mode);
      for (let m = 0; m < 5; m++) {
        shape.rasterize();
        const { data, n } = e.lines;
        for (let k = 0; k < n; k++) {
          const o = k * 4;
          assert.ok(data[o] >= 0 && data[o] < e.H, `mode ${mode}: y ${data[o]}`);
          assert.ok(data[o + 1] >= 0 && data[o + 1] <= data[o + 2] && data[o + 2] < e.W, `mode ${mode}: x ${data[o + 1]}..${data[o + 2]}`);
          assert.ok(data[o + 3] > 0 && data[o + 3] <= 0xffff, `mode ${mode}: alpha ${data[o + 3]}`);
        }
        shape.mutate();
      }
    }
  }
});

test('shapes: snapshots rebuild an identical shape', () => {
  const e = makeEngine();
  for (const mode of MODES) {
    for (let i = 0; i < 50; i++) {
      const shape = randomShape(e, mode);
      shape.rasterize();
      const before = Array.from(e.lines.data.subarray(0, e.lines.n * 4));
      const snap = JSON.parse(JSON.stringify(shape.snapshot())); // survives storage
      const again = shapeFromSnapshot(e, snap);
      again.rasterize();
      const after = Array.from(e.lines.data.subarray(0, e.lines.n * 4));
      assert.deepEqual(after, before, `mode ${mode}`);
    }
  }
});

test('shapes: sizes match their geometry', () => {
  const e = makeEngine();
  const count = () => {
    let n = 0;
    for (let k = 0; k < e.lines.n; k++) n += e.lines.data[k * 4 + 2] - e.lines.data[k * 4 + 1] + 1;
    return n;
  };
  const weighted = () => {
    let n = 0;
    for (let k = 0; k < e.lines.n; k++) {
      const o = k * 4;
      n += ((e.lines.data[o + 2] - e.lines.data[o + 1] + 1) * e.lines.data[o + 3]) / 65535;
    }
    return n;
  };

  new Rectangle(e, 10, 10, 29, 24).rasterize();
  assert.equal(count(), 20 * 15);

  new Ellipse(e, 64, 64, 20, 12, false).rasterize();
  assert.ok(Math.abs(count() - Math.PI * 20 * 12) / (Math.PI * 20 * 12) < 0.06, `ellipse ${count()}`);

  new RotatedEllipse(e, 64, 64, 20, 12, 33).rasterize();
  assert.ok(Math.abs(weighted() - Math.PI * 20 * 12) / (Math.PI * 20 * 12) < 0.01, `rotated ellipse ${weighted()}`);

  // Scanlines include both end pixels (as in the Go original), so a triangle
  // gains roughly one pixel per row over its geometric area.
  new Triangle(e, 10, 10, 60, 14, 30, 70).rasterize();
  const tri = Math.abs((60 - 10) * (70 - 10) - (30 - 10) * (14 - 10)) / 2;
  const rows = 70 - 10 + 1;
  assert.ok(count() > tri && count() < tri + 2 * rows, `triangle ${count()} vs ${tri}`);

  new RotatedRectangle(e, 64, 64, 30, 16, 25).rasterize();
  assert.ok(Math.abs(count() - 30 * 16) / (30 * 16) < 0.15, `rotated rect ${count()}`);

  new Polygon(e, 4, false, [20, 90, 90, 20], [20, 20, 70, 70]).rasterize();
  assert.ok(Math.abs(weighted() - 70 * 50) < 1e-3, `polygon ${weighted()}`);

  // a 6 px wide straight stroke, 40 px long, plus round caps
  new Quadratic(e, 20, 60, 40, 60, 60, 60, 6).rasterize();
  const expected = 40 * 6 + Math.PI * 9;
  assert.ok(Math.abs(weighted() - expected) / expected < 0.08, `curve ${weighted()} vs ${expected}`);
});

test('shapes: bad snapshots are rejected', () => {
  const e = makeEngine();
  assert.throws(() => shapeFromSnapshot(e, { type: 'triangle', nums: [1, 2, 3] }), /needs 6/);
  assert.throws(() => shapeFromSnapshot(e, { type: 'triangle', nums: [1, 2, 3, 4, 5, NaN] }), /bad numbers/);
  assert.throws(() => shapeFromSnapshot(e, { type: 'triangle', nums: [1, 2, 3, 4, 5, 1e9] }), /bad numbers/);
  assert.throws(() => shapeFromSnapshot(e, { type: 'star', nums: [1, 2] }), /unknown shape/);
  assert.throws(() => shapeFromSnapshot(e, { type: 'polygon', nums: [1, 2, 3, 4] }), /at least 3/);
});

// ---------------------------------------------------------------- engine

test('engine: partial energy equals a full recompute, for every mode and opacity', () => {
  const e = makeEngine();
  for (const mode of MODES) {
    for (const alpha of [1, 40, 128, 255]) {
      for (let i = 0; i < 40; i++) {
        const shape = randomShape(e, mode);
        const predicted = e.evaluate(shape, alpha);
        shape.rasterize();
        const color = e.computeColor(alpha);
        e.total += e.paint(color, true);
        const exact = e.fullEnergy();
        assert.equal(e.total, exact, `mode ${mode} alpha ${alpha} step ${i}`);
        assert.equal(predicted, exact, `prediction, mode ${mode} alpha ${alpha}`);
      }
    }
  }
});

test('engine: evaluating does not change the picture', () => {
  const e = makeEngine();
  const before = e.current.slice();
  const total = e.total;
  for (let i = 0; i < 200; i++) e.evaluate(randomShape(e, 0), 128);
  assert.deepEqual(e.current, before);
  assert.equal(e.total, total);
});

test('engine: search finds shapes that improve the picture', () => {
  const e = makeEngine('lenna.png', 5);
  let last = e.score();
  const start = last;
  for (let i = 0; i < 25; i++) {
    const res = e.search({ mode: 1, alpha: 128, candidates: 200, age: 50, climbs: 4 });
    e.apply(res.shape);
    assert.equal(e.total, res.energy, 'search energy matches applied energy');
    assert.equal(e.total, e.fullEnergy());
    assert.ok(e.score() <= last + 1e-9, `step ${i} made it worse`);
    last = e.score();
  }
  assert.ok(last < start * 0.8, `score ${start.toFixed(4)} -> ${last.toFixed(4)}`);
});

test('engine: every mode runs end to end and improves', () => {
  for (const mode of [0, ...MODES]) {
    const e = makeEngine('pyramids.png', 11);
    const start = e.score();
    for (let i = 0; i < 12; i++) {
      const res = e.search({ mode, alpha: 0, candidates: 60, age: 30, climbs: 3 });
      e.apply(res.shape);
    }
    assert.ok(e.score() < start, `mode ${mode}: ${start} -> ${e.score()}`);
    assert.equal(e.total, e.fullEnergy(), `mode ${mode}`);
  }
});

test('engine: restoring saved shapes reproduces the picture exactly', () => {
  const a = makeEngine('monalisa.png', 3);
  const saved = [];
  for (let i = 0; i < 20; i++) {
    const res = a.search({ mode: 0, alpha: 0, candidates: 80, age: 30, climbs: 3 });
    a.apply(res.shape);
    saved.push(JSON.parse(JSON.stringify(res.shape))); // as it would come back from storage
  }
  const b = makeEngine('monalisa.png', 99);
  b.restore(saved);
  assert.deepEqual(b.current, a.current);
  assert.equal(b.total, a.total);
});

test('engine: the same seed gives the same result', () => {
  const run = () => {
    const e = makeEngine('owl.png', 1234);
    return e.search({ mode: 1, alpha: 128, candidates: 100, age: 40, climbs: 4 });
  };
  const x = run();
  const y = run();
  assert.deepEqual(x.shape, y.shape);
  assert.equal(x.energy, y.energy);
});
