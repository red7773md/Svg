// A small animated-GIF encoder with no dependencies.
//
// 1. buildPalette(frames): one shared 256-color palette (median cut).
// 2. GifWriter: writes frames as LZW-compressed indexed images.
// encodeGif() ties the two together for callers that don't need to yield
// between frames.

const BITS = 6;                       // color precision used for palette and lookup
const SHIFT = 8 - BITS;
const SIDE = 1 << BITS;

const keyOf = (r, g, b) => ((r >> SHIFT) << (2 * BITS)) | ((g >> SHIFT) << BITS) | (b >> SHIFT);

/**
 * Build a palette from RGBA frames. Later frames count more, since the last
 * frame is the one people care about.
 * @returns {{colors: Uint8Array, size: number, lookup: (r,g,b)=>number}}
 */
export function buildPalette(frames, maxColors = 256) {
  const counts = new Float64Array(SIDE * SIDE * SIDE);
  frames.forEach((frame, index) => {
    const weight = index === frames.length - 1 ? 8 : 1;
    const step = frame.length > 400000 ? 8 : 4; // sample every 2nd pixel on big frames
    for (let i = 0; i < frame.length; i += step) counts[keyOf(frame[i], frame[i + 1], frame[i + 2])] += weight;
  });

  const entries = [];
  for (let k = 0; k < counts.length; k++) {
    if (counts[k] === 0) continue;
    // center of the bin, in 0..255
    const r = ((k >> (2 * BITS)) << SHIFT) + (1 << (SHIFT - 1));
    const g = (((k >> BITS) & (SIDE - 1)) << SHIFT) + (1 << (SHIFT - 1));
    const b = ((k & (SIDE - 1)) << SHIFT) + (1 << (SHIFT - 1));
    entries.push({ r, g, b, n: counts[k] });
  }

  const boxes = [makeBox(entries)];
  while (boxes.length < maxColors) {
    let pick = -1;
    let best = 0;
    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i];
      if (box.entries.length < 2) continue;
      const score = box.range * Math.sqrt(box.total);
      if (score > best) { best = score; pick = i; }
    }
    if (pick < 0) break;
    const [a, b] = splitBox(boxes[pick]);
    boxes[pick] = a;
    boxes.push(b);
  }

  const size = Math.max(2, boxes.length);
  const colors = new Uint8Array(size * 3);
  boxes.forEach((box, i) => {
    let r = 0, g = 0, b = 0;
    for (const e of box.entries) { r += e.r * e.n; g += e.g * e.n; b += e.b * e.n; }
    colors[i * 3] = Math.round(r / box.total);
    colors[i * 3 + 1] = Math.round(g / box.total);
    colors[i * 3 + 2] = Math.round(b / box.total);
  });

  // Nearest palette color, cached per 6-bit color cell.
  const cache = new Int16Array(SIDE * SIDE * SIDE).fill(-1);
  function lookup(r, g, b) {
    const key = keyOf(r, g, b);
    let found = cache[key];
    if (found >= 0) return found;
    let bestDist = Infinity;
    found = 0;
    for (let i = 0; i < size; i++) {
      const dr = colors[i * 3] - r;
      const dg = colors[i * 3 + 1] - g;
      const db = colors[i * 3 + 2] - b;
      const d = dr * dr + dg * dg + db * db;
      if (d < bestDist) { bestDist = d; found = i; if (d === 0) break; }
    }
    cache[key] = found;
    return found;
  }
  return { colors, size, lookup };
}

function makeBox(entries) {
  let rmin = 255, rmax = 0, gmin = 255, gmax = 0, bmin = 255, bmax = 0, total = 0;
  for (const e of entries) {
    if (e.r < rmin) rmin = e.r; if (e.r > rmax) rmax = e.r;
    if (e.g < gmin) gmin = e.g; if (e.g > gmax) gmax = e.g;
    if (e.b < bmin) bmin = e.b; if (e.b > bmax) bmax = e.b;
    total += e.n;
  }
  const ranges = [rmax - rmin, gmax - gmin, bmax - bmin];
  const axis = ranges[0] >= ranges[1] && ranges[0] >= ranges[2] ? 'r' : ranges[1] >= ranges[2] ? 'g' : 'b';
  return { entries, total, range: Math.max(...ranges), axis };
}

function splitBox(box) {
  const axis = box.axis;
  const sorted = box.entries.slice().sort((p, q) => p[axis] - q[axis]);
  let acc = 0;
  let cut = 1;
  for (let i = 0; i < sorted.length - 1; i++) {
    acc += sorted[i].n;
    cut = i + 1;
    if (acc >= box.total / 2) break;
  }
  return [makeBox(sorted.slice(0, cut)), makeBox(sorted.slice(cut))];
}

/** Map RGBA pixels to palette indexes. */
export function quantize(rgba, palette) {
  const out = new Uint8Array(rgba.length / 4);
  for (let i = 0, p = 0; i < rgba.length; i += 4, p++) out[p] = palette.lookup(rgba[i], rgba[i + 1], rgba[i + 2]);
  return out;
}

// --------------------------------------------------------------- the writer

export class GifWriter {
  /**
   * @param {object} o
   * @param {number} o.width
   * @param {number} o.height
   * @param {{colors: Uint8Array, size: number}} o.palette
   * @param {number} [o.loop=0] 0 means loop forever
   */
  constructor({ width, height, palette, loop = 0 }) {
    this.width = width;
    this.height = height;
    this.bytes = [];
    this.minCode = 8;
    // Global color table size: 2^(n+1) entries, at least as many as the palette.
    let n = 1;
    while ((1 << n) < palette.size) n++;
    this.tableBits = n;
    const table = new Uint8Array((1 << n) * 3);
    table.set(palette.colors);

    this.write(0x47, 0x49, 0x46, 0x38, 0x39, 0x61); // "GIF89a"
    this.u16(width);
    this.u16(height);
    this.write(0x80 | ((n - 1) << 4) | (n - 1), 0, 0); // global table flag, color res, size; bg index; aspect
    for (const b of table) this.bytes.push(b);
    // Looping extension
    this.write(0x21, 0xff, 0x0b);
    for (const ch of 'NETSCAPE2.0') this.bytes.push(ch.charCodeAt(0));
    this.write(0x03, 0x01);
    this.u16(loop);
    this.write(0x00);
    this.hash = new Int16Array(1 << 20);
  }

  write(...bytes) { for (const b of bytes) this.bytes.push(b); }
  u16(v) { this.bytes.push(v & 0xff, (v >> 8) & 0xff); }

  /** Add a frame of palette indexes. `delayMs` is rounded to 1/100 s. */
  addFrame(indexed, delayMs) {
    // Graphic control extension: no disposal, no transparency
    this.write(0x21, 0xf9, 0x04, 0x00);
    this.u16(Math.max(2, Math.round(delayMs / 10)));
    this.write(0x00, 0x00);
    // Image descriptor: full frame, no local table
    this.write(0x2c);
    this.u16(0); this.u16(0);
    this.u16(this.width); this.u16(this.height);
    this.write(0x00);
    this.write(this.minCode);
    this.lzw(indexed);
    this.write(0x00);
  }

  lzw(pixels) {
    const minCode = this.minCode;
    const clear = 1 << minCode;
    const eoi = clear + 1;
    const hash = this.hash;
    hash.fill(0);

    let codeSize = minCode + 1;
    let maxCode = (1 << codeSize) - 1;
    let next = eoi + 1;

    // bit packer writing into 255-byte sub-blocks
    let block = [];
    let acc = 0;
    let nbits = 0;
    const out = this.bytes;
    const flushBlock = () => {
      if (block.length === 0) return;
      out.push(block.length);
      for (const b of block) out.push(b);
      block = [];
    };
    const emit = (code) => {
      acc |= code << nbits;
      nbits += codeSize;
      while (nbits >= 8) {
        block.push(acc & 0xff);
        acc >>>= 8;
        nbits -= 8;
        if (block.length === 255) flushBlock();
      }
    };

    emit(clear);
    let prefix = pixels[0];
    for (let i = 1; i < pixels.length; i++) {
      const k = pixels[i];
      const key = (prefix << 8) | k;
      const found = hash[key];
      if (found) {
        prefix = found;
        continue;
      }
      emit(prefix);
      if (next < 4096) {
        hash[key] = next++;
        if (next - 1 > maxCode && codeSize < 12) {
          codeSize++;
          maxCode = (1 << codeSize) - 1;
        }
      } else {
        emit(clear);
        hash.fill(0);
        codeSize = minCode + 1;
        maxCode = (1 << codeSize) - 1;
        next = eoi + 1;
      }
      prefix = k;
    }
    emit(prefix);
    emit(eoi);
    if (nbits > 0) block.push(acc & 0xff);
    flushBlock();
  }

  /** The finished file. */
  finish() {
    this.bytes.push(0x3b);
    return Uint8Array.from(this.bytes);
  }
}

/**
 * Encode RGBA frames as a looping animated GIF.
 * @param {{width:number,height:number,frames:Uint8ClampedArray[],delays:number[],loop?:number}} o
 * @returns {Uint8Array}
 */
export function encodeGif({ width, height, frames, delays, loop = 0 }) {
  const palette = buildPalette(frames);
  const writer = new GifWriter({ width, height, palette, loop });
  frames.forEach((frame, i) => writer.addFrame(quantize(frame, palette), delays[i]));
  return writer.finish();
}
