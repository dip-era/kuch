export const EGO_COLOR = '#00f0df'

export function egoPosition(cells) {
  const ground = cells.filter(cell => [8, 9, 10, 11, 16].includes(cell.semantic_class)
    && Math.abs((cell.x_min + cell.x_max) / 2) <= 6
    && Math.abs((cell.y_min + cell.y_max) / 2) <= 6)
    .map(cell => cell.elevation).filter(Number.isFinite).sort((a, b) => a - b)
  // Symbolic vehicle at the sensor origin; no world poses are available.
  return { x: 0, y: 0, z: ground.length ? ground[Math.floor(ground.length / 2)] : -1.73 }
}
