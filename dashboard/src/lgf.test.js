import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { decodeFrame, liveFrameMeta, normalizeLGFFrame } from './lgf.js'
import { classifyGrid } from './drivability.js'

// Small real LGF1 frame written by the Python encoder (1,200 synthetic points).
const load = () => {
  const bytes = gunzipSync(readFileSync(new URL('./fixtures/live-frame.lgf.gz', import.meta.url)))
  return decodeFrame(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
}

test('LGF1 frames decode with the expected sections and counts', () => {
  const frame = load()
  assert.equal(frame.header.format, 'LGF1')
  assert.equal(frame.points.count, 1200)
  assert.equal(frame.cells.count, frame.header.n_cells)
  assert.equal(frame.points.xyzCm.length, frame.points.count * 3)
})

test('normalized cells use dashboard classes and valid complexity for drivability', () => {
  const { grid } = normalizeLGFFrame(load())
  assert.ok(grid.length > 0)
  for (const cell of grid) {
    assert.ok(Number.isInteger(cell.semantic_class) && cell.semantic_class >= -1 && cell.semantic_class <= 18)
    assert.ok(cell.terrain_complexity >= 0 && cell.terrain_complexity <= 1)
    assert.ok(cell.x_max > cell.x_min && Math.abs((cell.x_max - cell.x_min) - cell.resolution) < 1e-9)
  }
  const first = grid[0]
  assert.equal(first.x_min, -80)
  assert.equal(first.semantic_class, 10)         // LGF1 class 11 (sidewalk) -> dashboard 10
  const { area } = classifyGrid(grid)
  assert.ok(area.drivable + area.caution + area.blocked > 0)
})

test('display points are thinned evenly while the grid keeps every point', () => {
  const full = normalizeLGFFrame(load())
  const thin = normalizeLGFFrame(load(), { maxPoints: 300 })
  assert.equal(full.points.length / 4, 1200)
  assert.equal(thin.points.length / 4, 300)
  assert.equal(thin.meta.exported_points, 300)
  assert.equal(thin.meta.total_input_points, 1200)
  assert.deepEqual(Array.from(thin.points.slice(0, 4)), Array.from(full.points.slice(0, 4)))
  assert.equal(thin.grid.length, full.grid.length)
})

test('live Space summaries map onto the metrics panel fields', () => {
  const summary = { method: 'SalsaNext + KNN (NVIDIA A10G)', device: 'NVIDIA A10G',
    timing_ms: { segmentation_ms: 31.5, gpu_wait_ms: 412, grid_engine_cpu_ms: 9.25, server_total_ms: 480 } }
  const { meta } = normalizeLGFFrame(load(), { meta: liveFrameMeta(summary) })
  assert.equal(meta.inference_ms, 31.5)
  assert.equal(meta.grid_ms, 9.25)
  assert.equal(meta.total_ms, 480)
  assert.equal(meta.method, 'SalsaNext + KNN (NVIDIA A10G)')
  assert.equal(liveFrameMeta({ method: 'Provided semantic labels', timing_ms: { grid_engine_cpu_ms: 5 } }).inference_ms, null)
})
