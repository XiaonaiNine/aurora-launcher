/**
 * 生成应用图标（纯计算，无第三方依赖）
 *
 * 为什么手写：图标只是"圆角渐变方块 + 白色立方体描边"，
 * 用 SDF 算覆盖度 + 4×4 超采样就能得到干净的抗锯齿效果，
 * 比拉一个图像库或外部素材更可控，也不会让构建依赖变重。
 *
 * 输出：build/icon.ico（16/24/32/48/64/128/256 多尺寸）+ build/icon-256.png（预览）
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const SS = 4; // 超采样倍数
const OUT_DIR = path.resolve(import.meta.dirname, '..', 'build');
const SIZES = [16, 24, 32, 48, 64, 128, 256];

/* ---------------- 颜色 ---------------- */
const STOPS = [
  { t: 0.0, c: [0x10, 0xa0, 0x6a] }, // 翡翠绿
  { t: 0.55, c: [0x0d, 0x9a, 0x92] }, // 青
  { t: 1.0, c: [0x11, 0x8f, 0xb4] }, // 蓝
];

function gradient(t) {
  const x = Math.min(1, Math.max(0, t));
  for (let i = 1; i < STOPS.length; i += 1) {
    if (x <= STOPS[i].t) {
      const a = STOPS[i - 1];
      const b = STOPS[i];
      const k = (x - a.t) / (b.t - a.t || 1);
      return [
        Math.round(a.c[0] + (b.c[0] - a.c[0]) * k),
        Math.round(a.c[1] + (b.c[1] - a.c[1]) * k),
        Math.round(a.c[2] + (b.c[2] - a.c[2]) * k),
      ];
    }
  }
  return STOPS[STOPS.length - 1].c;
}

/* ---------------- 几何 ---------------- */
/** 圆角矩形的有符号距离（<0 在内部） */
function sdRoundRect(px, py, halfW, halfH, r) {
  const qx = Math.abs(px) - halfW + r;
  const qy = Math.abs(py) - halfH + r;
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.sqrt(ax * ax + ay * ay) + Math.min(Math.max(qx, qy), 0) - r;
}

/** 点到线段距离 */
function distSeg(px, py, ax, ay, bx, by) {
  const abx = bx - ax;
  const aby = by - ay;
  const apx = px - ax;
  const apy = py - ay;
  const len2 = abx * abx + aby * aby;
  const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, (apx * abx + apy * aby) / len2));
  const dx = apx - abx * t;
  const dy = apy - aby * t;
  return Math.sqrt(dx * dx + dy * dy);
}

// 立方体：正六边形轮廓 + 三条内部棱（与界面里的 logo 同构）
const V = {
  top: [0.5, 0.125],
  ur: [0.8125, 0.3],
  lr: [0.8125, 0.7],
  bottom: [0.5, 0.875],
  ll: [0.1875, 0.7],
  ul: [0.1875, 0.3],
  center: [0.5, 0.475],
};
const EDGES = [
  [V.top, V.ur],
  [V.ur, V.lr],
  [V.lr, V.bottom],
  [V.bottom, V.ll],
  [V.ll, V.ul],
  [V.ul, V.top],
  [V.center, V.ul],
  [V.center, V.ur],
  [V.center, V.bottom],
];

const smoothstep = (edge0, edge1, x) => {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

/** 渲染一张 size×size 的 RGBA 图 */
function render(size) {
  const hi = size * SS;
  const acc = new Float32Array(hi * hi * 4);

  const halfW = 0.5 - 0.012; // 留一点内边距，避免小尺寸下被裁边
  const radius = 0.225;
  const strokeW = 0.052; // 描边线宽（归一化）
  const pixel = 1 / hi;

  for (let y = 0; y < hi; y += 1) {
    for (let x = 0; x < hi; x += 1) {
      const px = (x + 0.5) / hi - 0.5;
      const py = (y + 0.5) / hi - 0.5;
      const i = (y * hi + x) * 4;

      // 背景：圆角方块 + 对角渐变
      const d = sdRoundRect(px, py, halfW, halfW, radius);
      const bgA = smoothstep(pixel * 1.2, -pixel * 1.2, d);
      if (bgA <= 0) continue;

      const t = (px + 0.5) * 0.45 + (py + 0.5) * 0.7;
      const [r, g, b] = gradient(t);
      acc[i] = r;
      acc[i + 1] = g;
      acc[i + 2] = b;
      acc[i + 3] = 255 * bgA;

      // 立方体描边（白）
      let dist = Infinity;
      for (const [a, c] of EDGES) {
        const dd = distSeg(px, py, a[0] - 0.5, a[1] - 0.5, c[0] - 0.5, c[1] - 0.5);
        if (dd < dist) dist = dd;
      }
      const stroke = smoothstep(strokeW / 2 + pixel, strokeW / 2 - pixel, dist);
      if (stroke > 0) {
        const a = stroke * 0.94 * bgA;
        acc[i] = acc[i] * (1 - a) + 255 * a;
        acc[i + 1] = acc[i + 1] * (1 - a) + 255 * a;
        acc[i + 2] = acc[i + 2] * (1 - a) + 255 * a;
      }
    }
  }

  // 降采样
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const i = ((y * SS + sy) * hi + (x * SS + sx)) * 4;
          const alpha = acc[i + 3] / 255;
          // 预乘 alpha 后再平均，避免边缘发黑
          r += acc[i] * alpha;
          g += acc[i + 1] * alpha;
          b += acc[i + 2] * alpha;
          a += alpha;
        }
      }
      const n = SS * SS;
      const o = (y * size + x) * 4;
      const aAvg = a / n;
      if (aAvg > 0.0001) {
        out[o] = Math.min(255, Math.round(r / n / aAvg));
        out[o + 1] = Math.min(255, Math.round(g / n / aAvg));
        out[o + 2] = Math.min(255, Math.round(b / n / aAvg));
        out[o + 3] = Math.round(aAvg * 255);
      }
    }
  }
  return out;
}

/* ---------------- PNG / ICO 编码 ---------------- */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}

function encodePng(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  // 每行前缀 filter byte = 0
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** ICO 容器：每个条目内嵌一张 PNG（Vista+ 支持） */
function encodeIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);

  const dirSize = 16 * entries.length;
  let offset = 6 + dirSize;
  const dirs = [];
  for (const e of entries) {
    const d = Buffer.alloc(16);
    d[0] = e.size >= 256 ? 0 : e.size;
    d[1] = e.size >= 256 ? 0 : e.size;
    d[2] = 0;
    d[3] = 0;
    d.writeUInt16LE(1, 4); // color planes
    d.writeUInt16LE(32, 6); // bits per pixel
    d.writeUInt32LE(e.png.length, 8);
    d.writeUInt32LE(offset, 12);
    dirs.push(d);
    offset += e.png.length;
  }
  return Buffer.concat([header, ...dirs, ...entries.map((e) => e.png)]);
}

/* ---------------- 主流程 ---------------- */
fs.mkdirSync(OUT_DIR, { recursive: true });

const entries = [];
for (const size of SIZES) {
  const rgba = render(size);
  entries.push({ size, png: encodePng(rgba, size) });
  if (size === 256) {
    fs.writeFileSync(path.join(OUT_DIR, 'icon-256.png'), entries[entries.length - 1].png);
  }
}

fs.writeFileSync(path.join(OUT_DIR, 'icon.ico'), encodeIco(entries));

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
console.log(`icon.ico  ${kb(fs.statSync(path.join(OUT_DIR, 'icon.ico')).size)}  尺寸 ${SIZES.join('/')}`);
console.log(`icon-256.png ${kb(fs.statSync(path.join(OUT_DIR, 'icon-256.png')).size)}`);
