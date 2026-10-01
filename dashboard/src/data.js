import { FRAME_MANIFEST_URL } from './config'
import { cachedFetch } from './frameCache.js'
import { frameUrl, loadLGFFrame, loadLGFManifest, normalizeLGFFrame } from './lgf'

const LOCAL_FRAME_CACHE_LIMIT = 160
const LGF_FRAME_CACHE_LIMIT = 192
const CLIP_DISPLAY_POINTS = 40_000
const PRELOAD_CONCURRENCY = 2

const GRID_FIELDS = [
  'x_min', 'x_max', 'y_min', 'y_max', 'resolution', 'elevation',
  'semantic_class', 'semantic_confidence', 'occupancy', 'traversability', 'point_count',
]

function trimCache(loaded, limit) {
  while (loaded.size > limit) loaded.delete(loaded.keys().next().value)
}

function yieldToBrowser() {
  return new Promise(resolve => setTimeout(resolve, 0))
}

function parseGridBinary(buffer, fields) {
  const floats = new Float32Array(buffer)
  if (floats.length % fields.length !== 0) throw new Error('Invalid grid buffer')
  const cells = new Array(floats.length / fields.length)
  for (let row = 0; row < cells.length; row += 1) {
    const cell = {}
    for (let column = 0; column < fields.length; column += 1) {
      const field = fields[column]
      const value = floats[row * fields.length + column]
      cell[field] = field === 'semantic_class' ? Math.round(value) : value
    }
    cells[row] = cell
  }
  return cells
}

function manifestBaseUrl(manifestUrl) {
  return new URL('.', new URL(manifestUrl, globalThis.location?.href ?? manifestUrl)).href
}

function frameAssetUrl(baseUrl, kind, frameId, extension) {
  return new URL(`./${kind}/${frameId}_${kind}.${extension}`, baseUrl).href
}

function normalizeLocalFrame(frameId, grid, points, meta) {
  const pointBuffer = new Float32Array(points)
  if (pointBuffer.length % 4 !== 0) throw new Error(`Invalid point buffer for ${frameId}`)
  return { grid, points: pointBuffer, meta }
}

async function loadLocalFrames(manifestUrl, onProgress) {
  const manifestResponse = await cachedFetch(manifestUrl)
  if (!manifestResponse.ok) throw new Error('Could not load frame manifest')
  const manifest = await manifestResponse.json()
  const { frames } = manifest
  if (!frames?.length) throw new Error('Frame manifest is empty')

  const loaded = new Map()
  const pending = new Map()
  let preloadChain = Promise.resolve()
  const gridFormat = manifest.grid_format ?? 'json'
  const gridFields = manifest.grid_fields ?? GRID_FIELDS
  const baseUrl = manifestBaseUrl(manifestUrl)

  const frameAssets = (frameId) => {
    const gridUrl = gridFormat === 'binary'
      ? frameAssetUrl(baseUrl, 'grid', frameId, 'bin')
      : frameAssetUrl(baseUrl, 'grid', frameId, 'json')
    return [gridUrl, frameAssetUrl(baseUrl, 'points', frameId, 'bin'), frameAssetUrl(baseUrl, 'meta', frameId, 'json')]
  }

  const loadFrame = (frameId) => {
    if (loaded.has(frameId)) return Promise.resolve(loaded.get(frameId))
    if (pending.has(frameId)) return pending.get(frameId)
    const request = (async () => {
      const [gridResponse, pointsResponse, metaResponse] = await Promise.all([
        ...frameAssets(frameId).map(url => cachedFetch(url)),
      ])
      if (![gridResponse, pointsResponse, metaResponse].every((response) => response.ok)) throw new Error(`Incomplete data for frame ${frameId}`)
      const [gridPayload, pointBuffer, meta] = await Promise.all([
        gridFormat === 'binary' ? gridResponse.arrayBuffer() : gridResponse.json(),
        pointsResponse.arrayBuffer(), metaResponse.json(),
      ])
      const grid = gridFormat === 'binary' ? parseGridBinary(gridPayload, gridFields) : gridPayload
      const frame = normalizeLocalFrame(frameId, grid, pointBuffer, meta)
      loaded.set(frameId, frame)
      pending.delete(frameId)
      trimCache(loaded, LOCAL_FRAME_CACHE_LIMIT)
      return frame
    })().catch((error) => { pending.delete(frameId); throw error })
    pending.set(frameId, request)
    return request
  }

  const preloadTo = (targetCount, onPreloadProgress) => {
    const total = frames.length
    const desired = Math.max(1, Math.min(total, targetCount))
    const run = async () => {
      onPreloadProgress?.(loaded.size, total)
      while (loaded.size < desired) {
        const batch = []
        for (const frameId of frames) {
          if (batch.length >= PRELOAD_CONCURRENCY) break
          if (loaded.has(frameId)) continue
          batch.push(loadFrame(frameId))
        }
        if (!batch.length) break
        await Promise.all(batch)
        onPreloadProgress?.(loaded.size, total)
        await yieldToBrowser()
      }
      return loaded
    }
    preloadChain = preloadChain.then(run)
    return preloadChain
  }

  const warmAssetCache = (onPreloadProgress) => {
    const total = frames.length
    const run = async () => {
      let completed = 0
      onPreloadProgress?.(completed, total)
      for (let index = 0; index < frames.length; index += PRELOAD_CONCURRENCY) {
        const batch = frames.slice(index, index + PRELOAD_CONCURRENCY)
        await Promise.all(batch.map(async (frameId) => {
          await Promise.all(frameAssets(frameId).map(url => cachedFetch(url)))
          completed += 1
          onPreloadProgress?.(completed, total)
        }))
        await yieldToBrowser()
      }
    }
    preloadChain = preloadChain.then(run)
    return preloadChain
  }

  onProgress?.(0, 1)
  await loadFrame(frames[0])
  onProgress?.(1, 1)
  return {
    frameIds: frames,
    frames: loaded,
    getFrame: frameId => loaded.get(frameId),
    hasFrame: frameId => loaded.has(frameId),
    loadFrame,
    preloadTo,
    warmAssetCache,
    semanticClasses: manifest.semantic_classes ?? [],
  }
}

async function loadLGFClipFrames(manifestUrl, onProgress) {
  const manifest = await loadLGFManifest(manifestUrl)
  if (!manifest.frames?.length) throw new Error('Frame manifest is empty')

  const loaded = new Map()
  const pending = new Map()
  let preloadChain = Promise.resolve()
  const frameIds = manifest.frames.map((frame) => frame.id)
  const frameIndexes = new Map(manifest.frames.map((frame, index) => [frame.id, index]))
  const frameAssets = (frameId) => {
    const index = frameIndexes.get(frameId)
    if (index == null) throw new Error(`Unknown frame ${frameId}`)
    return [frameUrl(manifest, index, 'lite')]
  }

  const loadFrame = (frameId) => {
    if (loaded.has(frameId)) return Promise.resolve(loaded.get(frameId))
    if (pending.has(frameId)) return pending.get(frameId)
    const request = (async () => {
      const index = frameIndexes.get(frameId)
      if (index == null) throw new Error(`Unknown frame ${frameId}`)
      const frame = normalizeLGFFrame(await loadLGFFrame(frameUrl(manifest, index, 'lite')), { maxPoints: CLIP_DISPLAY_POINTS })
      loaded.set(frameId, frame)
      pending.delete(frameId)
      trimCache(loaded, LGF_FRAME_CACHE_LIMIT)
      return frame
    })().catch((error) => { pending.delete(frameId); throw error })
    pending.set(frameId, request)
    return request
  }

  const preloadTo = (targetCount, onPreloadProgress) => {
    const total = frameIds.length
    const desired = Math.max(1, Math.min(total, targetCount))
    const run = async () => {
      onPreloadProgress?.(loaded.size, total)
      while (loaded.size < desired) {
        const batch = []
        for (const frameId of frameIds) {
          if (batch.length >= PRELOAD_CONCURRENCY) break
          if (loaded.has(frameId)) continue
          batch.push(loadFrame(frameId))
        }
        if (!batch.length) break
        await Promise.all(batch)
        onPreloadProgress?.(loaded.size, total)
        await yieldToBrowser()
      }
      return loaded
    }
    preloadChain = preloadChain.then(run)
    return preloadChain
  }

  const warmAssetCache = (onPreloadProgress) => {
    const total = frameIds.length
    const run = async () => {
      let completed = 0
      onPreloadProgress?.(completed, total)
      for (let index = 0; index < frameIds.length; index += PRELOAD_CONCURRENCY) {
        const batch = frameIds.slice(index, index + PRELOAD_CONCURRENCY)
        await Promise.all(batch.map(async (frameId) => {
          await Promise.all(frameAssets(frameId).map(url => cachedFetch(url)))
          completed += 1
          onPreloadProgress?.(completed, total)
        }))
        await yieldToBrowser()
      }
    }
    preloadChain = preloadChain.then(run)
    return preloadChain
  }

  onProgress?.(0, 1)
  await loadFrame(frameIds[0])
  onProgress?.(1, 1)
  return {
    frameIds,
    frames: loaded,
    getFrame: frameId => loaded.get(frameId),
    hasFrame: frameId => loaded.has(frameId),
    loadFrame,
    preloadTo,
    warmAssetCache,
    semanticClasses: manifest.classes ?? [],
  }
}

export async function loadFrames(onProgress, manifestUrl = FRAME_MANIFEST_URL) {
  const response = await cachedFetch(manifestUrl)
  if (!response.ok) throw new Error('Could not load frame manifest')
  const manifest = await response.json()
  if (manifest?.format === 'LGF1-clip') return loadLGFClipFrames(manifestUrl, onProgress)
  return loadLocalFrames(manifestUrl, onProgress)
}
