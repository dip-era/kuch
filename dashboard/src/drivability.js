import { cellDrivability, DEFAULT_DRIVABILITY, DRIVABILITY_COLORS } from '../../dashbard_timesxript_drivability/drivability.ts'

export { DEFAULT_DRIVABILITY, DRIVABILITY_COLORS }

export function classifyCell(cell, options = DEFAULT_DRIVABILITY) {
  // Dashboard classes are -1..18; the supplied rules use notebook classes 0..19.
  const cls = Number.isInteger(cell.semantic_class) && cell.semantic_class >= -1 && cell.semantic_class <= 18
    ? cell.semantic_class + 1 : 0
  const complexity = cell.terrain_complexity
  const confidence = cell.semantic_confidence
  const valid = value => Number.isFinite(value) && value >= 0 && value <= 1
  const state = cellDrivability(cls, valid(complexity) ? complexity : 0, valid(confidence) ? confidence : 0, options)
  // Older/incomplete assets must not be advertised as clear terrain.
  return state === 'drivable' && (!valid(complexity) || !valid(confidence)) ? 'caution' : state
}

export function classifyGrid(cells, options = DEFAULT_DRIVABILITY) {
  const area = { drivable: 0, caution: 0, blocked: 0 }
  const grid = cells.map(cell => {
    const drivability = classifyCell(cell, options)
    area[drivability] += cell.resolution ** 2
    return { ...cell, drivability }
  })
  return { grid, area }
}
