import { cachedFetch } from './frameCache.js'

const MAGIC = 'LGF1'

function isGzip(buffer) {
  const bytes = new Uint8Array(buffer, 0, Math.min(2, buffer.byteLength))
  return bytes.length === 2 && bytes[0] === 0x1f && bytes[1] === 0x8b
}

async function gunzipIfNeeded(buffer) {
  if (!isGzip(buffer)) return buffer
  const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'))
  return new Response(stream).arrayBuffer()
}

function sectionView(buffer, section) {
  const count = section.shape.reduce((total, size) => total * size, 1)
  switch (section.dtype) {
    case 'int16': return new Int16Array(buffer, section.offset, count)
    case 'uint8': return new Uint8Array(buffer, section.offset, count)
    case 'uint16': return new Uint16Array(buffer, section.offset, count)
    case 'float32': return new Float32Array(buffer, section.offset, count)
    default: throw new Error(`LGF1: unsupported dtype ${String(section.dtype)} in ${section.name}`)
  }
}

export function decodeFrame(buffer) {
  if (buffer.byteLength < 8 || buffer.byteLength > 256 * 1024 * 1024) throw new Error('LGF1: invalid frame size')
  const bytes = new Uint8Array(buffer)
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3])
  if (magic !== MAGIC) {
    throw new Error(isGzip(buffer) ? 'LGF1: expected decompressed bytes' : 'LGF1: bad magic')
  }

  const headerLength = new DataView(buffer).getUint32(4, true)
  if (!headerLength || headerLength > buffer.byteLength - 8 || (8 + headerLength) % 8) {
    throw new Error('LGF1: invalid header length')
  }

  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + headerLength)))
  if (!header || header.format !== 'LGF1' || header.version !== 1 || typeof header.frame_id !== 'string') {
    throw new Error('LGF1: invalid header')
  }

  const widths = { int16: 2, uint8: 1, uint16: 2, float32: 4 }
  const sections = Object.create(null)
  const occupied = []
  for (const section of header.sections ?? []) {
    if (!section || typeof section.name !== 'string' || sections[section.name] || !Object.hasOwn(widths, section.dtype)) {
      throw new Error('LGF1: invalid section table')
    }
    const count = Array.isArray(section.shape) ? section.shape.reduce((total, size) => total * size, 1) : -1
    if (!Number.isInteger(section.offset) || !Number.isInteger(section.bytes) || !Array.isArray(section.shape) ||
        count < 0 || section.offset < 8 + headerLength || section.offset % 8 ||
        section.offset + section.bytes > buffer.byteLength || count * widths[section.dtype] !== section.bytes) {
      throw new Error(`LGF1: invalid section ${section.name}`)
    }
    sections[section.name] = section
    if (section.bytes) occupied.push([section.offset, section.offset + section.bytes])
  }
  occupied.sort((a, b) => a[0] - b[0])
  if (occupied.some((range, index) => index && range[0] < occupied[index - 1][1])) throw new Error('LGF1: overlapping sections')

  const requireSection = (name, dtype, shape) => {
    const section = sections[name]
    if (!section || section.dtype !== dtype || section.shape.length !== shape.length ||
        !shape.every((size, index) => section.shape[index] === size)) {
      throw new Error(`LGF1: invalid section ${name}`)
    }
  }

  const pointSection = sections['points.class']
  const cellSection = sections['cells.class']
  if (!pointSection || !cellSection) throw new Error('LGF1: missing class sections')
  const pointCount = pointSection.shape[0]
  const cellCount = cellSection.shape[0]
  if (pointCount > 1_000_000 || cellCount > 1_000_000 || header.n_cells !== cellCount) throw new Error('LGF1: invalid counts')

  requireSection('points.xyz_cm', 'int16', [pointCount, 3])
  for (const name of ['intensity', 'class', 'confidence']) requireSection(`points.${name}`, 'uint8', [pointCount])
  if (sections['points.gt_class']) requireSection('points.gt_class', 'uint8', [pointCount])
  requireSection('cells.ixy', 'int16', [cellCount, 2])
  requireSection('cells.z_cm', 'int16', [cellCount, 3])
  for (const name of ['level', 'class', 'traversability', 'complexity', 'confidence']) {
    requireSection(`cells.${name}`, 'uint8', [cellCount])
  }
  for (const name of ['z_std_mm', 'point_count']) requireSection(`cells.${name}`, 'uint16', [cellCount])

  const get = (name) => sectionView(buffer, sections[name])
  return {
    header,
    points: {
      count: pointCount,
      xyzCm: get('points.xyz_cm'),
      intensity: get('points.intensity'),
      cls: get('points.class'),
      confidence: get('points.confidence'),
      gtClass: sections['points.gt_class'] ? get('points.gt_class') : null,
    },
    cells: {
      count: cellCount,
      ixy: get('cells.ixy'),
      level: get('cells.level'),
      cls: get('cells.class'),
      zCm: get('cells.z_cm'),
      zStdMm: get('cells.z_std_mm'),
      traversability: get('cells.traversability'),
      complexity: get('cells.complexity'),
      confidence: get('cells.confidence'),
      pointCount: get('cells.point_count'),
    },
  }
}

// Convert a decoded LGF1 frame into the dashboard's { grid, points, meta } shape.
// Classes become the dashboard's -1..18 convention (LGF1 uses 0 = unlabeled, 1..19).
// options.maxPoints thins the points evenly for display (the grid keeps every point);
// options.meta overrides/extends the metadata (used for live uploads).
export function normalizeLGFFrame(frame, options = {}) {
  const { header, points, cells } = frame
  const grid = new Array(cells.count)
  const distribution = {}
  for (let index = 0; index < cells.count; index += 1) {
    const resolution = header.level_sizes_m[cells.level[index]]
    distribution[resolution] = (distribution[resolution] ?? 0) + 1
    const x = cells.ixy[index * 2]
    const y = cells.ixy[index * 2 + 1]
    const elevation = cells.zCm[index * 3 + 2] / 100
    grid[index] = {
      x_min: x * resolution,
      x_max: (x + 1) * resolution,
      y_min: y * resolution,
      y_max: (y + 1) * resolution,
      resolution,
      elevation,
      semantic_class: cells.cls[index] ? cells.cls[index] - 1 : -1,
      semantic_confidence: cells.confidence[index] / 255,
      occupancy: 1,
      traversability: cells.traversability[index] / 255,
      point_count: cells.pointCount[index],
      terrain_complexity: cells.complexity[index] / 255,
    }
  }

  const stride = options.maxPoints && points.count > options.maxPoints ? Math.ceil(points.count / options.maxPoints) : 1
  const shown = Math.ceil(points.count / stride)
  const pointBuffer = new Float32Array(shown * 4)
  for (let out = 0, index = 0; index < points.count; index += stride, out += 1) {
    pointBuffer[out * 4] = points.xyzCm[index * 3] / 100
    pointBuffer[out * 4 + 1] = points.xyzCm[index * 3 + 1] / 100
    pointBuffer[out * 4 + 2] = points.xyzCm[index * 3 + 2] / 100
    pointBuffer[out * 4 + 3] = points.cls[index] ? points.cls[index] - 1 : -1
  }

  return {
    grid,
    points: pointBuffer,
    meta: {
      frame_id: header.frame_id,
      total_input_points: header.n_points_total,
      exported_points: shown,
      total_cells: cells.count,
      resolution_distribution: distribution,
      inference_ms: header.timing_ms?.salsanext_total ?? null,
      grid_ms: header.timing_ms?.grid_engine_total ?? null,
      total_ms: header.timing_ms?.end_to_end ?? null,
      method: header.device ? `Precomputed LGF clip (${header.device})` : 'Precomputed LGF clip',
      ...header.stats,
      ...options.meta,
    },
  }
}

// Metadata for a frame returned by the live Space (/infer): its timing fields differ from the clip's.
export function liveFrameMeta(summary = {}) {
  const t = summary.timing_ms ?? {}
  return {
    inference_ms: t.segmentation_ms ?? null,
    grid_ms: t.grid_engine_cpu_ms ?? null,
    total_ms: t.server_total_ms ?? null,
    gpu_wait_ms: t.gpu_wait_ms ?? null,
    method: summary.method ?? 'SalsaNext + KNN',
    device: summary.device ?? null,
  }
}

export async function loadLGFFrame(url, init) {
  const response = await cachedFetch(url, init)
  if (!response.ok) throw new Error(`LGF1: ${response.status} ${response.statusText} for ${url}`)
  return decodeFrame(await gunzipIfNeeded(await response.arrayBuffer()))
}

export async function loadLGFManifest(url) {
  const response = await cachedFetch(url)
  if (!response.ok) throw new Error(`Could not load frame manifest: ${response.status} ${response.statusText}`)
  const manifest = await response.json()
  return {
    ...manifest,
    baseUrl: new URL('.', new URL(url, globalThis.location?.href ?? url)).href,
  }
}

export function frameUrl(manifest, index, kind = 'lite') {
  const frame = manifest.frames[index]
  return new URL(kind === 'full' ? frame.full : frame.lite, manifest.baseUrl).href
}
