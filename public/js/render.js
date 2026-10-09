// Turning a list of shapes into pixels (canvas) or vectors (SVG).
//
// Both outputs come from the same geometry (`describe`), so what you see in the
// preview is what ends up in the downloaded files. Shape coordinates are pixel
// indexes of the working image; the shapes are drawn around pixel centers, which
// is why everything is shifted by half a pixel.

const HALF = 0.5;

/**
 * A picture is { width, height, background: [r,g,b], shapes: [...] } where
 * width/height are the size of the image the shapes were fitted to.
 */

function rotate(x, y, degrees) {
  const t = (degrees * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  return [x * c - y * s, x * s + y * c];
}

/** Plain geometry for one shape snapshot. */
export function describe(shape) {
  const n = shape.nums;
  switch (shape.type) {
    case 'triangle':
      return { kind: 'polygon', pts: n.slice(0, 6) };
    case 'polygon':
      return { kind: 'polygon', pts: n };
    case 'rectangle': {
      const x1 = Math.min(n[0], n[2]);
      const y1 = Math.min(n[1], n[3]);
      // Rectangles cover whole pixels, including the last row and column.
      return { kind: 'rect', x: x1 - HALF, y: y1 - HALF, w: Math.abs(n[2] - n[0]) + 1, h: Math.abs(n[3] - n[1]) + 1 };
    }
    case 'rotatedrect': {
      const [x, y, sx, sy, angle] = n;
      const pts = [];
      for (const [cx, cy] of [[-sx / 2, -sy / 2], [sx / 2, -sy / 2], [sx / 2, sy / 2], [-sx / 2, sy / 2]]) {
        const [rx, ry] = rotate(cx, cy, angle);
        pts.push(rx + x, ry + y);
      }
      return { kind: 'polygon', pts };
    }
    case 'ellipse':
      return { kind: 'ellipse', cx: n[0], cy: n[1], rx: n[2], ry: n[3], angle: 0 };
    case 'rotatedellipse':
      return { kind: 'ellipse', cx: n[0], cy: n[1], rx: n[2], ry: n[3], angle: n[4] };
    case 'quadratic':
      return { kind: 'curve', pts: n.slice(0, 6), width: n[6] };
    default:
      throw new Error(`unknown shape type "${shape.type}"`);
  }
}

const rgba = (c) => `rgba(${c[0]},${c[1]},${c[2]},${(c[3] / 255).toFixed(4)})`;

/** Draw one shape. The context must already be scaled so 1 unit = 1 working pixel. */
export function drawShape(ctx, shape) {
  const g = describe(shape);
  const color = rgba(shape.color);
  ctx.beginPath();
  switch (g.kind) {
    case 'polygon': {
      const p = g.pts;
      ctx.moveTo(p[0] + HALF, p[1] + HALF);
      for (let i = 2; i < p.length; i += 2) ctx.lineTo(p[i] + HALF, p[i + 1] + HALF);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
      break;
    }
    case 'rect':
      ctx.fillStyle = color;
      ctx.fillRect(g.x + HALF, g.y + HALF, g.w, g.h);
      break;
    case 'ellipse':
      ctx.ellipse(g.cx + HALF, g.cy + HALF, Math.max(g.rx, 0.01), Math.max(g.ry, 0.01), (g.angle * Math.PI) / 180, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      break;
    case 'curve': {
      const p = g.pts;
      ctx.moveTo(p[0] + HALF, p[1] + HALF);
      ctx.quadraticCurveTo(p[2] + HALF, p[3] + HALF, p[4] + HALF, p[5] + HALF);
      ctx.strokeStyle = color;
      ctx.lineWidth = g.width;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.stroke();
      break;
    }
  }
}

/**
 * Paint a picture onto a canvas. By default it clears the canvas and draws
 * everything. To extend a live preview, pass `from` (number of shapes already
 * drawn) and the new shapes are added on top.
 * @returns {number} how many shapes are now drawn
 */
export function renderToCanvas(canvas, pic, { from = 0, count = pic.shapes.length } = {}) {
  const ctx = canvas.getContext('2d');
  const s = canvas.width / pic.width;
  ctx.setTransform(s, 0, 0, canvas.height / pic.height, 0, 0);
  if (from === 0) {
    ctx.fillStyle = `rgb(${pic.background.join(',')})`;
    ctx.fillRect(0, 0, pic.width, pic.height);
  }
  for (let i = from; i < count; i++) drawShape(ctx, pic.shapes[i]);
  return count;
}

/** Output size for a given longest side, keeping the aspect ratio. */
export function fitSize(pic, side) {
  const k = side / Math.max(pic.width, pic.height);
  return { width: Math.max(1, Math.round(pic.width * k)), height: Math.max(1, Math.round(pic.height * k)) };
}

// ------------------------------------------------------------------- SVG

const num = (v) => String(Math.round(v * 100) / 100);
const hex = (c) => `#${[c[0], c[1], c[2]].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
const opacity = (a) => String(Math.round((a / 255) * 1000) / 1000);

function svgShape(shape) {
  const g = describe(shape);
  const c = shape.color;
  const paint = `fill="${hex(c)}" fill-opacity="${opacity(c[3])}"`;
  switch (g.kind) {
    case 'polygon': {
      const pts = [];
      for (let i = 0; i < g.pts.length; i += 2) pts.push(`${num(g.pts[i])},${num(g.pts[i + 1])}`);
      return `<polygon points="${pts.join(' ')}" ${paint}/>`;
    }
    case 'rect':
      return `<rect x="${num(g.x)}" y="${num(g.y)}" width="${num(g.w)}" height="${num(g.h)}" ${paint}/>`;
    case 'ellipse': {
      const rot = g.angle ? ` transform="rotate(${num(g.angle)} ${num(g.cx)} ${num(g.cy)})"` : '';
      return `<ellipse cx="${num(g.cx)}" cy="${num(g.cy)}" rx="${num(g.rx)}" ry="${num(g.ry)}"${rot} ${paint}/>`;
    }
    case 'curve': {
      const p = g.pts;
      return `<path d="M${num(p[0])} ${num(p[1])}Q${num(p[2])} ${num(p[3])} ${num(p[4])} ${num(p[5])}" `
        + `fill="none" stroke="${hex(c)}" stroke-opacity="${opacity(c[3])}" stroke-width="${num(g.width)}" stroke-linecap="round"/>`;
    }
    default:
      return '';
  }
}

/**
 * The picture as a standalone SVG document. It scales to any size; `side` only
 * sets the default display size (the longest side, in pixels).
 */
export function toSVG(pic, { side = 1024, count = pic.shapes.length } = {}) {
  const { width, height } = fitSize(pic, side);
  const body = [];
  for (let i = 0; i < count; i++) body.push(svgShape(pic.shapes[i]));
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${pic.width} ${pic.height}">`,
    `<rect width="${pic.width}" height="${pic.height}" fill="${hex(pic.background)}"/>`,
    `<g transform="translate(${HALF} ${HALF})">`,
    body.join('\n'),
    `</g>`,
    `</svg>`,
    ``,
  ].join('\n');
}
