import test from 'node:test'
import assert from 'node:assert/strict'
import { buildScene, createView, inView } from './scene.js'
import { layerColor } from './palette.js'

const cell = (x, y, id = 8, z = -2, size = .1) => ({
  x_min: x, x_max: x + size, y_min: y, y_max: y + size, resolution: size,
  elevation: z, semantic_class: id, semantic_confidence: .95, point_count: 3, traversability: .8,
})

test('exact cells preserve every source footprint, class, and top elevation', () => {
  const cells = [cell(0, 0), cell(1, 1, 0, -.5), cell(2, 2, 12, 4)]
  const before = structuredClone(cells), view = createView(cells, false)
  const parts = buildScene(cells, view, { representation: 'cells' })
  assert.equal(parts.length, cells.length)
  for (let i = 0; i < cells.length; i++) {
    assert.equal(parts[i].source, cells[i])
    assert.equal(parts[i].sx, cells[i].x_max - cells[i].x_min)
    assert.equal(parts[i].sz, cells[i].y_max - cells[i].y_min)
    assert.ok(Math.abs(parts[i].z + parts[i].sy / 2 - cells[i].elevation) < 1e-8)
  }
  assert.deepEqual(cells, before)
})

test('a separated pair of car clusters yields two silhouettes without changing input', () => {
  const cells = [cell(0, 3, 8, -2, 1)]
  for (const offset of [0, 10]) {
    for (let x = 0; x < 3; x += .25) for (let y = 0; y < 1.5; y += .25) {
      cells.push(cell(x + offset, y, 0, -.5, .25))
    }
  }
  const before = structuredClone(cells)
  const parts = buildScene(cells, createView(cells, false))
  assert.equal(parts.filter(p => p.finish === 'glass').length, 2)
  assert.equal(parts.filter(p => p.finish === 'tire').length, 8)
  const selections = new Set(parts.filter(p => p.finish).map(p => p.selection))
  assert.equal([...selections].reduce((sum, s) => sum + s.source_count, 0), cells.length - 1)
  assert.deepEqual(cells, before)
})

test('oversized ambiguous vehicle clusters remain blocks', () => {
  const cells = Array.from({ length: 50 }, (_, i) => cell(i * .3, 0, 0, 0, .3))
  const parts = buildScene(cells, createView(cells, false))
  assert.ok(parts.length > 0)
  assert.ok(parts.every(p => !p.finish))
})

test('road blocks stay shallow and flattening removes vehicle silhouettes', () => {
  const cells = [cell(0, 0), cell(.1, .1), cell(2, 2, 12, 5)]
  const view = createView(cells, false)
  const parts = buildScene(cells, view)
  assert.equal(parts.length, 2)
  assert.ok(parts.find(p => p.source.semantic_class === 8).sy <= .2)
  const flat = buildScene(cells, view, { elevated: false })
  assert.ok(flat.every(p => p.sy === .08 && !p.finish))
})

test('detail crop is bounded while full scan includes distant and unlabeled geometry', () => {
  const cells = Array.from({ length: 100 }, (_, i) => cell(i / 20, 0))
  const points = new Float32Array([500, 600, 1, -1])
  assert.ok(!inView(500, 600, createView(cells, true, points)))
  assert.ok(inView(500, 600, createView(cells, false, points)))
  const unlabeled = createView([], false, points)
  assert.ok(inView(500, 600, unlabeled))
  assert.ok(Object.values(unlabeled).every(Number.isFinite))
  assert.deepEqual(buildScene([], createView([])), [])
})

test('drivability colors distinguish all three states and unobserved space', () => {
  assert.equal(layerColor({ drivability: 'blocked' }, 'drivability'), '#d03b3b')
  assert.equal(layerColor({ drivability: 'caution' }, 'drivability'), '#fab219')
  assert.equal(layerColor({ drivability: 'drivable' }, 'drivability'), '#0ca30c')
  assert.equal(layerColor({}, 'drivability'), '#6b7075')
})
