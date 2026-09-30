import test from 'node:test'
import assert from 'node:assert/strict'
import { egoPosition } from './ego.js'

const cell = (x, y, z, id = 8) => ({
  x_min: x - .1, x_max: x + .1, y_min: y - .1, y_max: y + .1,
  semantic_class: id, elevation: z,
})

test('ego marker uses local ground and excludes buildings, vehicles, and distant terrain', () => {
  const cells = [cell(1, 1, -1.8), cell(2, 2, -1.7), cell(-1, 1, -1.6),
    cell(0, 0, 4, 12), cell(0, 0, -.1, 0), cell(100, 100, 20)]
  const before = structuredClone(cells)
  assert.deepEqual(egoPosition(cells), { x: 0, y: 0, z: -1.7 })
  assert.deepEqual(cells, before)
})

test('ego stays at sensor origin as scan geometry changes', () => {
  assert.deepEqual(egoPosition([cell(2, 2, -1.8)]), { x: 0, y: 0, z: -1.8 })
  assert.deepEqual(egoPosition([cell(-4, 3, -1.9)]), { x: 0, y: 0, z: -1.9 })
})

test('empty or invalid local ground uses the documented KITTI display fallback', () => {
  for (const cells of [[], [cell(0, 0, NaN)], [cell(0, 0, 4, 12)]]) {
    assert.deepEqual(egoPosition(cells), { x: 0, y: 0, z: -1.73 })
  }
})
