import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyCell, classifyGrid, DEFAULT_DRIVABILITY } from './drivability.js'
import { cellDrivability } from '../../dashbard_timesxript_drivability/drivability.ts'

const cell = (id, complexity = .1, confidence = .9, resolution = .5) => ({
  semantic_class: id, terrain_complexity: complexity, semantic_confidence: confidence, resolution,
})

test('all dashboard classes match supplied TypeScript rules across profiles and boundaries', () => {
  for (const profile of ['on-road', 'off-road']) {
    const options = { ...DEFAULT_DRIVABILITY, profile }
    for (let id = -1; id <= 18; id++) {
      for (const complexity of [0, .499, .5, .799, .8, 1]) {
        for (const confidence of [0, .499, .5, 1]) {
          assert.equal(classifyCell(cell(id, complexity, confidence), options),
            cellDrivability(id + 1, complexity, confidence, options), `${profile}, class ${id}, ${complexity}, ${confidence}`)
        }
      }
    }
  }
})

test('vehicle profile affects surfaces and vegetation but never clears obstacles', () => {
  const offRoad = { ...DEFAULT_DRIVABILITY, profile: 'off-road' }
  for (const id of [10, 11, 16]) {
    assert.equal(classifyCell(cell(id)), 'caution')
    assert.equal(classifyCell(cell(id), offRoad), 'drivable')
  }
  assert.equal(classifyCell(cell(14)), 'blocked')
  assert.equal(classifyCell(cell(14), offRoad), 'caution')
  for (const id of [-1, 0, 1, 2, 3, 4, 5, 6, 7, 12, 13, 15, 17, 18]) {
    assert.equal(classifyCell(cell(id), offRoad), 'blocked')
  }
})

test('live thresholds supersede the legacy notebook score', () => {
  const road = { ...cell(8, .3, .6), traversability: 0 }
  assert.equal(classifyCell(road), 'drivable')
  assert.equal(classifyCell(road, { ...DEFAULT_DRIVABILITY, roughCaution: .3 }), 'caution')
  assert.equal(classifyCell(road, { ...DEFAULT_DRIVABILITY, roughCaution: .2, roughBlocked: .3 }), 'blocked')
  assert.equal(classifyCell(road, { ...DEFAULT_DRIVABILITY, minConfidence: .7 }), 'caution')
  assert.equal(classifyCell({ ...cell(0), traversability: 1 }), 'blocked')
})

test('incomplete measurements never yield drivable and source data stays intact', () => {
  for (const value of [undefined, null, NaN, -1, 2]) {
    assert.equal(classifyCell({ ...cell(8), terrain_complexity: value }), 'caution')
    assert.equal(classifyCell({ ...cell(8), semantic_confidence: value }), 'caution')
  }
  const cells = [cell(8), cell(10, .1, .9, .2), cell(0, .1, .9, .1)]
  const before = structuredClone(cells), result = classifyGrid(cells)
  assert.deepEqual(cells, before)
  assert.deepEqual(result.grid.map(c => c.drivability), ['drivable', 'caution', 'blocked'])
  assert.ok(Math.abs(result.area.drivable - .25) < 1e-10)
  assert.ok(Math.abs(result.area.caution - .04) < 1e-10)
  assert.ok(Math.abs(result.area.blocked - .01) < 1e-10)
  assert.deepEqual(classifyGrid([]).area, { drivable: 0, caution: 0, blocked: 0 })
})
