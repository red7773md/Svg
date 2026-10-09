// Settings shared across the app.

export const LIMITS = {
  minShapes: 10,
  maxShapes: 2000,
  defaultShapes: 500,
  presets: [100, 250, 500, 1000, 2000],
  addMoreDefault: 250,
};

/** Numbers match the command-line tool's -m flag. */
export const SHAPE_MODES = [
  { value: 1, label: 'Triangles', hint: 'Sharp, faceted look' },
  { value: 0, label: 'Mixed shapes', hint: 'A bit of everything' },
  { value: 3, label: 'Ellipses', hint: 'Soft, painterly blobs' },
  { value: 4, label: 'Circles', hint: 'Dots and bubbles' },
  { value: 2, label: 'Rectangles', hint: 'Blocky, pixel-art feel' },
  { value: 5, label: 'Rotated rectangles', hint: 'Brush-stroke look' },
  { value: 7, label: 'Rotated ellipses', hint: 'Soft, tilted strokes' },
  { value: 8, label: 'Polygons', hint: 'Four-sided facets' },
  { value: 6, label: 'Curves', hint: 'Thin lines; needs many shapes' },
];

/** How hard the search works for each shape. Higher is slower and slightly better. */
export const QUALITY = {
  fast: { label: 'Fast', candidates: 300, climbs: 8 },
  balanced: { label: 'Balanced', candidates: 600, climbs: 12 },
  best: { label: 'Best', candidates: 1000, climbs: 16 },
};
export const DEFAULT_QUALITY = 'balanced';

/** Working resolution of the search (longest side, pixels). Output is vector, so it scales freely. */
export const DETAIL = {
  standard: { label: 'Standard (256 px)', side: 256 },
  fine: { label: 'Fine (384 px)', side: 384 },
};
export const DEFAULT_DETAIL = 'standard';

export const OPACITY = [
  { value: 0, label: 'Auto (per shape)' },
  { value: 64, label: '25%' },
  { value: 128, label: '50%' },
  { value: 192, label: '75%' },
  { value: 255, label: '100%' },
];
export const DEFAULT_OPACITY = 128;

/** Image preparation. */
export const IMAGE = {
  storedSide: 1600,            // longest side of the copy kept in the browser
  jpegQuality: 0.92,
  bigFileBytes: 5 * 1024 * 1024,
  maxFileBytes: 100 * 1024 * 1024,  // refuse anything bigger than this
  maxPixels: 200e6,                 // refuse images with more pixels than this
};

export const EXPORT_SIZES = [1024, 2048, 4096];
export const DEFAULT_EXPORT_SIZE = 2048;
export const PREVIEW_SIDE = 1024;
export const THUMB_SIDE = 360;

export const SAVE_EVERY_SHAPES = 10;
export const SAVE_EVERY_MS = 2500;
export const MAX_LOG_LINES = 250;
export const DB_NAME = 'primitive-pictures';
export const DB_VERSION = 1;
