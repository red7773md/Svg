import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeGif } from '../public/js/gif.js';
import { decodePng, resizeTo } from './helpers/png.mjs';

function frames(side, count) {
  const img = resizeTo(decodePng(new URL('../examples/owl.png', import.meta.url).pathname), side);
  const out = [];
  for (let f = 0; f < count; f++) {
    const k = (f + 1) / count;
    const data = new Uint8ClampedArray(img.data.length);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = 255 - (255 - img.data[i]) * k;
      data[i + 1] = 255 - (255 - img.data[i + 1]) * k;
      data[i + 2] = 255 - (255 - img.data[i + 2]) * k;
      data[i + 3] = 255;
    }
    out.push(data);
  }
  return { width: img.width, height: img.height, out };
}

test('GIF decodes in PIL with right size, frame count, delays, loop and colors', () => {
  const { width, height, out } = frames(200, 6);
  const delays = [100, 100, 100, 100, 100, 1500];
  const gif = encodeGif({ width, height, frames: out, delays, loop: 0 });
  const dir = mkdtempSync(join(tmpdir(), 'gif-'));
  const path = join(dir, 'a.gif');
  writeFileSync(path, gif);
  writeFileSync(join(dir, 'ref.raw'), Buffer.concat(out.map((f) => Buffer.from(f.buffer))));
  const script = `
import sys, json
from PIL import Image
im = Image.open(sys.argv[1]); ref = open(sys.argv[2],'rb').read()
n = im.n_frames; w,h = im.size; res = {'n':n,'size':[w,h],'loop':im.info.get('loop'),'delays':[],'err':[]}
for i in range(n):
    im.seek(i); res['delays'].append(im.info.get('duration'))
    px = im.convert('RGB').tobytes(); off = i*w*h*4; tot=0
    for p in range(w*h):
        for c in range(3): tot += abs(px[p*3+c]-ref[off+p*4+c])
    res['err'].append(tot/(w*h*3))
print(json.dumps(res))`;
  const res = JSON.parse(execFileSync('python3', ['-I', '-c', script, path, join(dir, 'ref.raw')]).toString());
  assert.equal(res.n, 6);
  assert.deepEqual(res.size, [width, height]);
  assert.equal(res.loop, 0);
  assert.deepEqual(res.delays, delays);
  for (const e of res.err) assert.ok(e < 6, `mean error ${e}`);
});

test('GIF with a flat two-color frame still decodes', () => {
  const w = 17, h = 9;
  const f = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < f.length; i += 4) { f[i] = i % 8 ? 255 : 0; f[i + 3] = 255; }
  const gif = encodeGif({ width: w, height: h, frames: [f], delays: [50] });
  const dir = mkdtempSync(join(tmpdir(), 'gif-'));
  writeFileSync(join(dir, 'b.gif'), gif);
  const out = execFileSync('python3', ['-I', '-c', 'import sys;from PIL import Image;im=Image.open(sys.argv[1]);im.load();print(im.size)', join(dir, 'b.gif')]).toString();
  assert.equal(out.trim(), `(${w}, ${h})`);
});
