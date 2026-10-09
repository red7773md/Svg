// Every download format, built in the browser from the saved shape list.
//
// PNG, JPG and SVG are produced from the same geometry, so they match.
// SVG is a real vector file that scales to any size; PNG/JPG are rendered at
// the size you pick. GIF replays the picture being built. JSON is the shape
// list itself, for people who want to use it elsewhere.

import { renderToCanvas, fitSize, toSVG } from './render.js';
import { buildPalette, quantize, GifWriter } from './gif.js';
import { baseName } from './format.js';

export const FORMATS = [
  { id: 'png', label: 'PNG', hint: 'Image with sharp edges', ext: 'png', mime: 'image/png', sized: true },
  { id: 'jpg', label: 'JPG', hint: 'Smaller file', ext: 'jpg', mime: 'image/jpeg', sized: true },
  { id: 'svg', label: 'SVG', hint: 'Vector, scales to any size', ext: 'svg', mime: 'image/svg+xml', sized: false },
  { id: 'gif', label: 'GIF', hint: 'Animation of the build-up', ext: 'gif', mime: 'image/gif', sized: false },
  { id: 'json', label: 'JSON', hint: 'The shapes as data', ext: 'json', mime: 'application/json', sized: false },
];

/** The saved job as a picture the renderers understand. */
export function pictureOf(job) {
  return { width: job.width, height: job.height, background: job.background, shapes: job.shapes };
}

export function fileName(job, ext, suffix = '') {
  return `${baseName(job.name)}-${job.shapes.length}-shapes${suffix}.${ext}`;
}

function canvasBlob(canvas, mime, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('The browser could not create this file. Try a smaller size.'))), mime, quality);
  });
}

function renderCanvas(pic, side) {
  const { width, height } = fitSize(pic, side);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  renderToCanvas(canvas, pic);
  return canvas;
}

export async function exportRaster(pic, mime, side) {
  const canvas = renderCanvas(pic, side);
  return canvasBlob(canvas, mime, 0.95);
}

export function exportSVG(pic) {
  return new Blob([toSVG(pic)], { type: 'image/svg+xml' });
}

export function exportJSON(job) {
  const doc = {
    format: 'primitive-web',
    version: 1,
    name: job.name,
    width: job.width,
    height: job.height,
    background: job.background,
    score: job.score,
    shapes: job.shapes,
  };
  return new Blob([JSON.stringify(doc)], { type: 'application/json' });
}

const GIF_SIDE = 400;
const GIF_FRAMES = 60;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Animation of the picture being built. Early shapes change the picture the
 * most, so frames are spaced closely at the start and widely at the end.
 */
export async function exportGIF(pic, onProgress = () => {}) {
  const total = pic.shapes.length;
  const { width, height } = fitSize(pic, GIF_SIDE);
  const frameCount = Math.min(GIF_FRAMES, total);
  const marks = [];
  for (let i = 1; i <= frameCount; i++) {
    marks.push(Math.max(1, Math.round(total * Math.pow(i / frameCount, 2))));
  }
  const unique = [...new Set(marks)];

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const g = canvas.getContext('2d', { willReadFrequently: true });
  const frames = [];
  let drawn = 0;
  for (let i = 0; i < unique.length; i++) {
    drawn = renderToCanvas(canvas, pic, { from: drawn, count: unique[i] });
    frames.push(g.getImageData(0, 0, width, height).data);
    onProgress(0.5 * ((i + 1) / unique.length));
    if (i % 4 === 3) await tick();
  }
  const palette = buildPalette(frames);
  const writer = new GifWriter({ width, height, palette, loop: 0 });
  for (let i = 0; i < frames.length; i++) {
    const last = i === frames.length - 1;
    writer.addFrame(quantize(frames[i], palette), last ? 2500 : 80);
    onProgress(0.5 + 0.5 * ((i + 1) / frames.length));
    if (i % 4 === 3) await tick();
  }
  return new Blob([writer.finish()], { type: 'image/gif' });
}

/**
 * Build one file.
 * @param {string} id        one of FORMATS
 * @param {object} job       the saved job
 * @param {{side?: number, onProgress?: (n: number) => void}} [opts]
 * @returns {Promise<{blob: Blob, filename: string}>}
 */
export async function buildExport(id, job, { side = 2048, onProgress } = {}) {
  const pic = pictureOf(job);
  if (pic.shapes.length === 0) throw new Error('There are no shapes yet. Let the picture build a little first.');
  switch (id) {
    case 'png': return { blob: await exportRaster(pic, 'image/png', side), filename: fileName(job, 'png', `-${side}px`) };
    case 'jpg': return { blob: await exportRaster(pic, 'image/jpeg', side), filename: fileName(job, 'jpg', `-${side}px`) };
    case 'svg': return { blob: exportSVG(pic), filename: fileName(job, 'svg') };
    case 'gif': return { blob: await exportGIF(pic, onProgress), filename: fileName(job, 'gif') };
    case 'json': return { blob: exportJSON(job), filename: fileName(job, 'json') };
    default: throw new Error(`Unknown format "${id}"`);
  }
}

/** Start a browser download. */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

/** A small JPEG of the current picture for the history grid. */
export function makeThumb(pic, side, quality = 0.8) {
  return canvasBlob(renderCanvas(pic, side), 'image/jpeg', quality);
}
