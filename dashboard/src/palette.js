import { DRIVABILITY_COLORS } from './drivability.js'

export const KNOWN_CLASSES = {
  0: 'Car',
  1: 'Bicycle',
  2: 'Motorcycle',
  3: 'Truck',
  4: 'Other-vehicle',
  5: 'Person/Pedestrian',
  6: 'Bicyclist',
  7: 'Motorcyclist',
  8: 'Road',
  9: 'Parking',
  10: 'Sidewalk',
  11: 'Other-ground',
  12: 'Building',
  13: 'Fence',
  14: 'Vegetation',
  15: 'Trunk',
  16: 'Terrain',
  17: 'Pole',
  18: 'Traffic-sign',
}

const colors = [
  '#f13943', '#ed5d96', '#ffab36', '#e77529', '#c63b51',
  '#35b9ff', '#6858f5', '#a04dec', '#858e9e', '#647589',
  '#bbc7cf', '#ccaa60', '#f0c62e', '#aa7e36', '#25ad3f',
  '#47782d', '#75c65b', '#b854e5', '#e24ddf',
]

export function colorForClass(id) {
  const numericId = Number(id)
  if (numericId < 0) return '#60758b'
  return colors[((numericId % colors.length) + colors.length) % colors.length]
}

export function nameForClass(id) {
  if (Number(id) < 0) return 'Unlabeled'
  return KNOWN_CLASSES[id] ?? `Class ${id}`
}

export function layerColor(cell, mode, range = [-3, 5]) {
  if (mode === 'semantic') return colorForClass(cell.semantic_class)
  if (mode === 'drivability') return DRIVABILITY_COLORS[cell.drivability] ?? DRIVABILITY_COLORS.unknown
  if (mode === 'resolution') {
    const t = Math.max(0, Math.min(1, Math.log2(cell.resolution / 0.05) / 3.4))
    return `hsl(204, 90%, ${85 - t * 55}%)`
  }
  if (mode === 'density') return `hsl(185, 85%, ${25 + Math.min(1, Math.log2(1 + cell.point_count) / 7) * 60}%)`
  const t = Math.max(0, Math.min(1, (cell.elevation - range[0]) / Math.max(0.01, range[1] - range[0])))
  return `hsl(${(1 - t) * 250}, 95%, 55%)`
}

export function hexToRgb(hex) {
  const value = Number.parseInt(hex.slice(1), 16)
  return [(value >> 16) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255]
}
