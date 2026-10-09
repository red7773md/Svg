// Getting a photo ready: shrink it, strip its metadata, and cut out the pixels
// the search works on. Everything happens in the browser; nothing is uploaded.
//
// Re-drawing the photo on a canvas drops EXIF/GPS data and bakes in the camera
// rotation, and encoding it as JPEG gives a compact copy that is kept in the
// browser for later visits.

import { IMAGE } from './config.js';
import { formatBytes } from './format.js';

const ACCEPTED = /^image\/(png|jpe?g|webp|gif|bmp|avif)$/i;

function makeCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

function toBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('The browser could not encode the image.'))), type, quality);
  });
}

async function decode(source) {
  try {
    return await createImageBitmap(source, { imageOrientation: 'from-image' });
  } catch {
    return await createImageBitmap(source);
  }
}

/** Draw `bitmap` at the new size onto a canvas, halving step by step for a clean downscale. */
function resampled(bitmap, width, height, background) {
  let current = bitmap;
  let w = bitmap.width;
  let h = bitmap.height;
  while (w / 2 >= width && h / 2 >= height) {
    const half = makeCanvas(w / 2, h / 2);
    const g = half.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(current, 0, 0, half.width, half.height);
    current = half;
    w = half.width;
    h = half.height;
  }
  const out = makeCanvas(width, height);
  const g = out.getContext('2d', { willReadFrequently: true });
  if (background) {
    g.fillStyle = background;
    g.fillRect(0, 0, out.width, out.height);
  }
  g.imageSmoothingQuality = 'high';
  g.drawImage(current, 0, 0, out.width, out.height);
  return out;
}

/**
 * Validate and shrink an uploaded file.
 * @param {File} file
 * @param {(level: 'info'|'warn'|'ok', message: string) => void} log  shown to the person
 * @returns {Promise<{blob: Blob, width: number, height: number, originalBytes: number, storedBytes: number}>}
 */
export async function prepareImage(file, log = () => {}) {
  if (file.type && !ACCEPTED.test(file.type)) {
    throw new Error(`"${file.name}" is not a supported image. Use a PNG, JPEG, WebP, GIF or BMP file.`);
  }
  if (file.size > IMAGE.maxFileBytes) {
    throw new Error(`"${file.name}" is ${formatBytes(file.size)}, which is over the ${formatBytes(IMAGE.maxFileBytes)} limit.`);
  }

  log('info', `Reading ${file.name} (${formatBytes(file.size)})`);
  let bitmap;
  try {
    bitmap = await decode(file);
  } catch {
    throw new Error(`Could not open "${file.name}". The file may be damaged or in a format this browser cannot read.`);
  }
  const { width: srcW, height: srcH } = bitmap;
  if (srcW * srcH > IMAGE.maxPixels) {
    bitmap.close?.();
    throw new Error(`The image is ${srcW} x ${srcH} pixels, which is too large to open in the browser.`);
  }
  log('info', `Image size ${srcW} x ${srcH} px`);

  const big = file.size > IMAGE.bigFileBytes;
  const tall = Math.max(srcW, srcH) > IMAGE.storedSide;
  if (big) {
    log('warn', `Your image is larger than the ${formatBytes(IMAGE.bigFileBytes)} limit. Reducing its size to make it compatible…`);
  } else if (tall) {
    log('info', `Image is larger than ${IMAGE.storedSide} px. Reducing its size to keep the page fast…`);
  }

  const k = Math.min(1, IMAGE.storedSide / Math.max(srcW, srcH));
  const width = Math.max(1, Math.round(srcW * k));
  const height = Math.max(1, Math.round(srcH * k));
  const canvas = resampled(bitmap, width, height, '#ffffff');
  bitmap.close?.();
  if (k < 1) log('info', `Resized to ${width} x ${height} px`);

  let blob = await toBlob(canvas, 'image/jpeg', IMAGE.jpegQuality);
  log('info', 'Removed metadata (location, camera info) and flattened transparency');
  // A very detailed photo can still be heavy; trade a little quality for size.
  for (let quality = IMAGE.jpegQuality; blob.size > IMAGE.bigFileBytes && quality > 0.5; ) {
    quality -= 0.1;
    blob = await toBlob(canvas, 'image/jpeg', quality);
    log('info', `Compressing further (quality ${Math.round(quality * 100)}%) → ${formatBytes(blob.size)}`);
  }

  if (big || tall || blob.size < file.size) {
    log('ok', `Ready: ${formatBytes(file.size)} → ${formatBytes(blob.size)}`);
  } else {
    log('ok', 'Ready');
  }
  return { blob, width, height, originalBytes: file.size, storedBytes: blob.size };
}

/**
 * The pixels the search works on: the stored photo scaled so its longest side is `side`.
 * @returns {Promise<{width: number, height: number, data: Uint8ClampedArray, background: number[]}>}
 */
export async function analysisPixels(blob, side) {
  const bitmap = await decode(blob);
  const k = Math.min(1, side / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * k));
  const height = Math.max(1, Math.round(bitmap.height * k));
  const canvas = resampled(bitmap, width, height, '#ffffff');
  bitmap.close?.();
  const { data } = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, width, height);
  return { width, height, data, background: averageColor(data) };
}

/** Average color of the picture; the shapes are painted on top of it. */
export function averageColor(data) {
  let r = 0, g = 0, b = 0;
  const n = data.length / 4;
  for (let i = 0; i < data.length; i += 4) {
    r += data[i];
    g += data[i + 1];
    b += data[i + 2];
  }
  return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
}

/** Object URL for a blob; the caller revokes it. */
export const blobUrl = (blob) => URL.createObjectURL(blob);
