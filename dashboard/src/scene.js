// Display geometry only. Source cells, metrics, and exported grids stay unchanged.
const GROUND = new Set([8, 9, 10, 11, 16])
const VEHICLES = new Set([0, 3, 4])
const clamp = (value, low, high) => Math.max(low, Math.min(high, value))
const quantile = (sorted, fraction) => sorted[Math.floor((sorted.length - 1) * fraction)] ?? 0
const center = cell => [(cell.x_min + cell.x_max) / 2, (cell.y_min + cell.y_max) / 2]

export function createView(cells, detail = true, points = []) {
  if (!cells.length && !points.length) return { x: 0, y: 0, width: 40, depth: 40, base: -2, low: -3, high: 3 }
  const xs = [], ys = [], zs = [], ground = []
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const cell of cells) {
    const [x, y] = center(cell)
    xs.push(x); ys.push(y); zs.push(cell.elevation)
    minX = Math.min(minX, cell.x_min); maxX = Math.max(maxX, cell.x_max)
    minY = Math.min(minY, cell.y_min); maxY = Math.max(maxY, cell.y_max)
    if (GROUND.has(cell.semantic_class)) ground.push(cell.elevation)
  }
  for (let i = 0; i < points.length; i += 4) {
    minX = Math.min(minX, points[i]); maxX = Math.max(maxX, points[i])
    minY = Math.min(minY, points[i + 1]); maxY = Math.max(maxY, points[i + 1])
    if (!cells.length) { xs.push(points[i]); ys.push(points[i + 1]); zs.push(points[i + 2]) }
  }
  for (const list of [xs, ys, zs, ground]) list.sort((a, b) => a - b)
  const x = detail ? quantile(xs, .5) : (minX + maxX) / 2
  const y = detail ? quantile(ys, .5) : (minY + maxY) / 2
  const width = detail ? Math.min(60, Math.max(12, maxX - minX)) : Math.max(12, maxX - minX)
  const depth = detail ? Math.min(60, Math.max(12, maxY - minY)) : Math.max(12, maxY - minY)
  const low = Math.floor(quantile(zs, .02) * 2) / 2
  return {
    x, y, width, depth, base: ground.length ? quantile(ground, .5) : quantile(zs, .05),
    low, high: Math.max(low + 1, Math.ceil(quantile(zs, .98) * 2) / 2),
  }
}

export function inView(x, y, view) {
  return Math.abs(x - view.x) <= view.width / 2 && Math.abs(y - view.y) <= view.depth / 2
}

function groundSampler(cells, fallback) {
  const bins = new Map()
  for (const cell of cells) {
    if (!GROUND.has(cell.semantic_class)) continue
    const [x, y] = center(cell), key = `${Math.floor(x / 5)},${Math.floor(y / 5)}`
    if (!bins.has(key)) bins.set(key, [])
    bins.get(key).push(cell.elevation)
  }
  for (const [key, heights] of bins) bins.set(key, quantile(heights.sort((a, b) => a - b), .5))
  return (x, y) => {
    const gx = Math.floor(x / 5), gy = Math.floor(y / 5)
    const local = bins.get(`${gx},${gy}`)
    if (local !== undefined) return local
    let sum = 0, count = 0
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const height = bins.get(`${gx + dx},${gy + dy}`)
      if (height !== undefined) { sum += height; count++ }
    }
    return count ? sum / count : fallback
  }
}

function vehicleClusters(cells) {
  const bins = new Map()
  cells.forEach(cell => {
    if (!VEHICLES.has(cell.semantic_class)) return
    const [x, y] = center(cell), gx = Math.floor(x / .8), gy = Math.floor(y / .8)
    const key = `${cell.semantic_class}:${gx}:${gy}`
    if (!bins.has(key)) bins.set(key, { gx, gy, id: cell.semantic_class, cells: [] })
    bins.get(key).cells.push(cell)
  })
  const visited = new Set(), clusters = []
  for (const [key, bin] of bins) {
    if (visited.has(key)) continue
    const queue = [bin], group = []
    visited.add(key)
    for (let i = 0; i < queue.length; i++) {
      const current = queue[i]
      for (const cell of current.cells) group.push(cell)
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        const neighbor = `${current.id}:${current.gx + dx}:${current.gy + dy}`
        if (!visited.has(neighbor) && bins.has(neighbor)) {
          visited.add(neighbor); queue.push(bins.get(neighbor))
        }
      }
    }
    if (group.length >= 6) clusters.push(group)
  }
  return clusters
}

function vehicleShape(group, groundAt) {
  const centers = group.map(center)
  const cx = centers.reduce((sum, p) => sum + p[0], 0) / group.length
  const cy = centers.reduce((sum, p) => sum + p[1], 0) / group.length
  let xx = 0, yy = 0, xy = 0
  for (const [x, y] of centers) { xx += (x - cx) ** 2; yy += (y - cy) ** 2; xy += (x - cx) * (y - cy) }
  const angle = .5 * Math.atan2(2 * xy, xx - yy), cos = Math.cos(angle), sin = Math.sin(angle)
  let minL = Infinity, maxL = -Infinity, minW = Infinity, maxW = -Infinity
  for (const cell of group) {
    for (const x of [cell.x_min, cell.x_max]) for (const y of [cell.y_min, cell.y_max]) {
      const l = (x - cx) * cos + (y - cy) * sin, w = -(x - cx) * sin + (y - cy) * cos
      minL = Math.min(minL, l); maxL = Math.max(maxL, l)
      minW = Math.min(minW, w); maxW = Math.max(maxW, w)
    }
  }
  const truck = group[0].semantic_class === 3
  // Ambiguous merged objects stay as measured blocks instead of a single vehicle.
  if (maxL - minL > (truck ? 14 : 6.8) || maxW - minW > 3.2 || maxL - minL < 1.2) return null
  const length = clamp(maxL - minL, truck ? 4 : 2.8, truck ? 14 : 6.8)
  const width = clamp(maxW - minW, 1.4, 3)
  const l = (minL + maxL) / 2, w = (minW + maxW) / 2
  const x = cx + l * cos - w * sin, y = cy + l * sin + w * cos
  const base = groundAt(x, y)
  const heights = group.map(c => c.elevation).sort((a, b) => a - b)
  const height = clamp(quantile(heights, .9) - base, 1.2, truck ? 3.8 : 2.5)
  const source = group.reduce((best, cell) => cell.point_count > best.point_count ? cell : best)
  const selection = { ...source, display_kind: 'Vehicle silhouette', source_count: group.length }
  const parts = []
  const part = (dx, dz, bottom, sx, sy, sz, finish) => {
    parts.push({
      x: x + dx * cos - dz * sin, y: y + dx * sin + dz * cos, z: base + bottom + sy / 2,
      sx, sy, sz, angle, source, selection, finish,
    })
  }
  part(0, 0, .25, length, height * .43, width, 'paint')
  part(-length * .08, 0, .25 + height * .43, length * .52, height * .42, width * .83, 'glass')
  part(-length * .08, 0, .25 + height * .85, length * .49, .09, width * .86, 'paint')
  for (const dx of [-length * .3, length * .3]) for (const dz of [-width * .48, width * .48]) {
    part(dx, dz, .03, .52, .52, .23, 'tire')
  }
  return parts
}

export function buildScene(cells, view, { representation = 'blocks', elevated = true } = {}) {
  const visible = cells.filter(cell => inView(...center(cell), view))
  const groundAt = groundSampler(visible, view.base)
  const parts = [], replaced = new Set()
  if (representation === 'blocks' && elevated) {
    for (const group of vehicleClusters(visible)) {
      const vehicle = vehicleShape(group, groundAt)
      if (vehicle) { parts.push(...vehicle); for (const cell of group) replaced.add(cell) }
    }
  }
  if (representation === 'cells') {
    for (const source of visible) {
      const [x, y] = center(source)
      const bottom = elevated ? Math.min(view.base - .15, source.elevation - .06) : view.base
      const height = elevated ? Math.max(.06, source.elevation - bottom) : .06
      parts.push({ x, y, z: bottom + height / 2, sx: source.x_max - source.x_min,
        sy: height, sz: source.y_max - source.y_min, source, selection: source })
    }
    return parts
  }
  const buckets = new Map()
  for (const source of visible) {
    if (replaced.has(source)) continue
    const id = source.semantic_class
    const size = id === 12 ? .8 : id === 14 ? .65 : GROUND.has(id) ? .5 : .25
    const [x, y] = center(source), gx = Math.floor(x / size), gy = Math.floor(y / size)
    const key = `${id}:${gx}:${gy}`
    if (!buckets.has(key)) buckets.set(key, { x: (gx + .5) * size, y: (gy + .5) * size, size, cells: [] })
    buckets.get(key).cells.push(source)
  }
  for (const bucket of buckets.values()) {
    const { x, y, size } = bucket
    const group = bucket.cells
    const source = group.reduce((best, cell) => cell.point_count > best.point_count ? cell : best)
    const heights = group.map(c => c.elevation).sort((a, b) => a - b)
    const ground = GROUND.has(source.semantic_class)
    const top = quantile(heights, ground ? .5 : .85)
    const floor = groundAt(x, y)
    const bottom = elevated ? (ground ? top - .12 : Math.min(floor, top - .12)) : view.base
    const height = elevated ? (ground ? .12 : Math.max(.12, Math.round((top - bottom) / .2) * .2)) : .08
    parts.push({
      x, y, z: bottom + height / 2, sx: size, sy: height, sz: size, source,
      selection: { ...source, display_kind: 'Display block', source_count: group.length },
    })
  }
  return parts
}
