import { useEffect, useMemo, useRef, useState } from 'react'
import PointCloud from './components/PointCloud'
import SemanticMap from './components/SemanticMap'
import Upload from './components/Upload'
import { BACKEND, UPLOADS_ENABLED, apiUrl } from './config'
import { loadFrames } from './data'
import { KNOWN_CLASSES, colorForClass, layerColor, nameForClass } from './palette'
import { createView } from './scene'
import { classifyCell, classifyGrid, DEFAULT_DRIVABILITY, DRIVABILITY_COLORS } from './drivability'
import { egoPosition } from './ego'

const EMPTY = new Set()
const EMPTY_CELLS = []
const VIEWERS = [
  { id: 'raw', kind: 'points', mode: 'height', title: 'Raw LiDAR Points', note: 'XYZ geometry colored by elevation', toolbarLabel: 'Height (Z)', defaultZoom: 3.1 },
  { id: 'segmentation', kind: 'points', mode: 'semantic', title: 'Semantic Segmentation', note: 'Per-point semantic classes with continuous playback', toolbarLabel: 'Semantic classes', defaultZoom: 3.1 },
  { id: 'semantic', kind: 'map', mode: 'semantic', title: 'Semantic 2.5D Map', note: 'Adaptive semantic grid with 2.5D structure' },
  { id: 'resolution', kind: 'map', mode: 'resolution', title: 'Adaptive Resolution Map', note: 'Exact adaptive cells colored by local grid resolution', defaultTopDown: true, defaultZoom: 4.2 },
  { id: 'elevation', kind: 'map', mode: 'elevation', title: 'Elevation Map', note: 'Height field view of the adaptive grid', defaultTopDown: true, defaultZoom: 4.2 },
  { id: 'drivability', kind: 'map', mode: 'drivability', title: 'Drivability Map', note: 'Exact cells classified by vehicle profile', defaultTopDown: true, defaultZoom: 4.2 },
]
const VIEWER_IDS = VIEWERS.map(({ id }) => id)
const viewerMap = value => Object.fromEntries(VIEWERS.map((viewer) => [viewer.id, typeof value === 'function' ? value(viewer) : value]))
const viewerById = Object.fromEntries(VIEWERS.map((viewer) => [viewer.id, viewer]))

const DEFAULT_ZOOM = 2
const PLAYBACK_FRAME_MS = 80
const STARTUP_STREAM_BUFFER = 12
const PREFETCH_AHEAD = 16
const PREFETCH_BEHIND = 4
const MAX_PREFETCH_AHEAD = 32
const RESOLUTION_LEGEND = [
  { label: '6.25 cm', resolution: 0.0625 },
  { label: '12.5 cm', resolution: 0.125 },
  { label: '25 cm', resolution: 0.25 },
  { label: '50 cm', resolution: 0.5 },
]
const number = value => Number(value ?? 0).toLocaleString()
const ms = value => value == null ? 'Not recorded' : `${value.toFixed(1)} ms`

function viewerMetrics(viewer, frameData, state, frameCount) {
  const meta = frameData?.meta ?? {}
  return {
    id: viewer.id,
    title: viewer.title,
    frame: frameCount ? `${state.frameIndex + 1} / ${number(frameCount)}` : '0 / 0',
    renderedLabel: viewer.kind === 'points' ? 'Rendered points' : 'Displayed cells',
    renderedValue: number(viewer.kind === 'points' ? Math.round((frameData?.points?.length ?? 0) / 4) : frameData?.grid?.length ?? 0),
    inputPoints: number(meta.total_input_points),
    latency: ms(meta.total_ms),
    playback: state.playing ? `${state.speed}× live` : 'Paused',
  }
}

function initialWindowState() {
  return viewerMap(viewer => ({
    frameIndex: 0,
    playing: false,
    speed: 1,
    topDown: viewer.defaultTopDown ?? false,
    zoom: viewer.defaultZoom ?? DEFAULT_ZOOM,
    reset: 0,
    selected: null,
  }))
}

function Row({ label, value }) {
  return <div className="metric-row"><span>{label}</span><strong>{value}</strong></div>
}

function ViewToggle({ value, onChange }) {
  return <div className="segmented"><button className={!value ? 'active' : ''} onClick={() => onChange(false)}>Isometric</button>
    <button className={value ? 'active' : ''} onClick={() => onChange(true)}>Top-down</button></div>
}

function LandingStat({ label, value }) {
  return <div className="landing-stat">
    <span>{label}</span>
    <strong>{value}</strong>
  </div>
}

function LandingFeature({ eyebrow, title, copy }) {
  return <article className="landing-feature">
    <span className="eyebrow">{eyebrow}</span>
    <h3>{title}</h3>
    <p>{copy}</p>
  </article>
}

function SystemMetricsPanel({ items, featuredViewer, activeViewerCount, frameCount, sourceLabel }) {
  return <div className="control-card system-metrics-card">
    <span className="eyebrow">SYSTEM METRICS</span>
    <div className="system-metrics-heading">
      <h2>System metrics</h2>
      <p>Live telemetry for every viewport is consolidated here on the right rail.</p>
    </div>
    <div className="system-metrics-summary">
      <div className="system-metric-highlight">
        <span>Large panel</span>
        <strong>{featuredViewer.title}</strong>
      </div>
      <div className="system-metric-highlight">
        <span>Playing windows</span>
        <strong>{activeViewerCount} / {items.length}</strong>
      </div>
      <div className="system-metric-highlight">
        <span>Total frames</span>
        <strong>{number(frameCount)}</strong>
      </div>
      <div className="system-metric-highlight">
        <span>Source</span>
        <strong>{sourceLabel}</strong>
      </div>
    </div>
    <div className="system-metrics-grid">
      {items.map((item) => <section key={item.id} className="system-metric-panel">
        <header>
          <div>
            <span className="eyebrow">{item.id.toUpperCase()}</span>
            <strong>{item.title}</strong>
          </div>
          <span className={`system-metric-status ${item.playback === 'Paused' ? 'is-paused' : ''}`}>{item.playback}</span>
        </header>
        <Row label="Frame" value={item.frame} />
        <Row label={item.renderedLabel} value={item.renderedValue} />
        <Row label="Input points" value={item.inputPoints} />
        <Row label="Latency" value={item.latency} />
      </section>)}
    </div>
  </div>
}

function downloadJSON(frame, options) {
  const result = classifyGrid(frame.grid, options)
  const url = URL.createObjectURL(new Blob([JSON.stringify({
    meta: frame.meta, cells: result.grid, drivability: { options, area_m2: result.area },
  })], { type: 'application/json' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `lidar-${frame.meta.frame_id}-grid.json`
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function PlaybackStrip({ disabled, frameIndex, frameCount, playing, speed, onStep, onToggle, onScrub, onSpeed }) {
  return <div className="window-playback">
    <span className="playback-label">Playback</span>
    <div className="playback-buttons">
      <button aria-label="Previous frame" disabled={disabled} onClick={() => onStep(-1)}>⏮</button>
      <button className="primary play-button" aria-label={playing ? 'Pause playback' : 'Play sequence'} disabled={disabled}
        onClick={onToggle}>{playing ? 'Ⅱ' : '▶'}</button>
      <button aria-label="Next frame" disabled={disabled} onClick={() => onStep(1)}>⏭</button>
    </div>
    <input type="range" aria-label="Frame" min="0" max={Math.max(0, frameCount - 1)} value={frameIndex}
      disabled={disabled} onChange={e => onScrub(Number(e.target.value))} />
    <span className="frame-counter">{frameCount ? `${frameIndex + 1} / ${number(frameCount)}` : '0 / 0'}</span>
    <select aria-label="Playback speed" value={speed} onChange={e => onSpeed(Number(e.target.value))} disabled={disabled}>
      <option value={0.5}>0.5×</option>
      <option value={1}>1×</option>
      <option value={2}>2×</option>
      <option value={4}>4×</option>
    </select>
  </div>
}

function ZoomStrip({ zoom, onChange, disabled = false }) {
  return <div className="viewer-zoom">
    <label htmlFor={`zoom-${Math.round(zoom * 100)}`}>Zoom</label>
    <button aria-label="Zoom out" disabled={disabled || zoom <= .5}
      onClick={() => onChange(Math.max(.5, Math.round(zoom / 1.25 * 100) / 100))}>−</button>
    <input id={`zoom-${Math.round(zoom * 100)}`} type="range" min="50" max="800" step="1"
      value={Math.round(zoom * 100)} disabled={disabled}
      aria-valuetext={`${Math.round(zoom * 100)} percent`}
      onChange={e => onChange(Number(e.target.value) / 100)} />
    <button aria-label="Zoom in" disabled={disabled || zoom >= 8}
      onClick={() => onChange(Math.min(8, Math.round(zoom * 1.25 * 100) / 100))}>+</button>
    <output htmlFor={`zoom-${Math.round(zoom * 100)}`}>{Math.round(zoom * 100)}%</output>
  </div>
}

function SelectionCard({ selected, drivabilityOptions, onClose }) {
  if (!selected) return null
  return <div className="cell-card viewer-cell-card">
    <div><strong>{selected.display_kind ?? 'Cell inspection'}</strong><button aria-label="Close cell details" onClick={onClose}>×</button></div>
    {selected.display_kind && <p className="inspection-note">{selected.source_count} source cells. Values below describe one representative measured cell.</p>}
    <Row label="Center (X, Y)" value={`${((selected.x_min + selected.x_max) / 2).toFixed(2)}, ${((selected.y_min + selected.y_max) / 2).toFixed(2)} m`} />
    <Row label="Resolution" value={`${(selected.resolution * 100).toFixed(1)} cm`} />
    <Row label="Elevation" value={`${selected.elevation.toFixed(2)} m`} />
    <Row label="Points" value={number(selected.point_count)} />
    <Row label="Semantic" value={nameForClass(selected.semantic_class)} />
    <Row label="Confidence" value={`${(selected.semantic_confidence * 100).toFixed(1)}%`} />
    <Row label="Drivability" value={classifyCell(selected, drivabilityOptions)} />
    <Row label="Terrain complexity" value={Number.isFinite(selected.terrain_complexity) ? selected.terrain_complexity.toFixed(2) : 'Unavailable'} />
    <Row label="Notebook score" value={selected.traversability.toFixed(2)} />
  </div>
}

function ViewerWindow({
  id, kind, mode, title, note, toolbarLabel, frame, loading, uploaded, frameCount, hiddenClasses, onToggleClass, onShowAllClasses,
  boundaries, elevated, representation, detail, pointSize, showEgo, drivabilityOptions,
  state, setTopDown, setZoom, resetView, setSelected, step, togglePlaying, scrub, setSpeed, className = '',
}) {
  const captureRef = useRef(null)
  const meta = frame?.meta ?? {}
  const sourceCells = frame?.grid ?? EMPTY_CELLS
  const { grid: drivabilityCells } = useMemo(() => classifyGrid(sourceCells, drivabilityOptions), [sourceCells, drivabilityOptions])
  const points = frame?.points ?? new Float32Array()
  const view = useMemo(() => createView(sourceCells, detail, points), [sourceCells, detail, points])
  const ego = useMemo(() => showEgo ? egoPosition(sourceCells) : null, [sourceCells, showEgo])
  const isPointViewer = kind === 'points'
  const mapCells = mode === 'drivability' ? drivabilityCells : sourceCells
  const featured = id === 'semantic'
  const semanticLegend = id === 'semantic'
  const allowExport = id === 'semantic' || id === 'drivability'

  const captureView = async () => {
    if (!captureRef.current || !frame) return
    const blob = await captureRef.current()
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `lidar-${meta.frame_id}-${id}.png`
    anchor.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  const disabled = uploaded || !frameCount

  return <section className={`viewer-card ${className}`.trim()}>
    <header className="viewer-header">
      <div>
        <span className="eyebrow">{id.toUpperCase()}</span>
        <h2>{title}</h2>
      </div>
      <div className="viewer-chip-group">
        <span className="source-chip">{meta.frame_id ?? '------'}</span>
        <span className="viewer-subtle">{note}</span>
      </div>
    </header>
    <div className="viewer-toolbar">
      {!isPointViewer ? <ViewToggle value={state.topDown} onChange={setTopDown} /> : <span className="viewer-toolbar-label">{toolbarLabel}</span>}
      <div className="viewer-actions">
        <button onClick={resetView}>Reset view</button>
        <button onClick={captureView} disabled={!frame}>Capture</button>
        {!isPointViewer && allowExport && <button onClick={() => downloadJSON(frame, drivabilityOptions)} disabled={!frame}>Export JSON</button>}
      </div>
    </div>
    <ZoomStrip zoom={state.zoom} onChange={setZoom} disabled={!frame} />
    <div className="viewer-stage">
      {isPointViewer
        ? <PointCloud points={points} hiddenClasses={semanticLegend ? hiddenClasses : EMPTY} mode={mode} topDown={false} view={view} pointSize={pointSize}
          ego={ego} playing={state.playing} zoom={state.zoom} onZoomChange={setZoom} captureRef={captureRef} />
        : <SemanticMap cells={mapCells} hiddenClasses={semanticLegend ? hiddenClasses : EMPTY}
          mode={mode} boundaries={boundaries} elevated={elevated}
          topDown={state.topDown} reset={state.reset} onSelect={setSelected} captureRef={captureRef}
          representation={mode === 'semantic' ? representation : 'cells'} view={view} selected={state.selected}
          zoom={state.zoom} onZoomChange={setZoom} ego={ego} playing={state.playing} />}
      {loading && <div className="viewer-loading">Loading frame…</div>}
      {semanticLegend && <div className="semantic-legend viewer-legend">
        <div>Semantic classes <button onClick={onShowAllClasses}>Show all</button></div>
        {Object.entries(KNOWN_CLASSES).map(([classId, name]) => <button key={classId} className={hiddenClasses.has(Number(classId)) ? 'muted' : ''}
          aria-pressed={!hiddenClasses.has(Number(classId))} onClick={() => onToggleClass(Number(classId))}>
          <i style={{ background: colorForClass(Number(classId)) }} />{name}</button>)}
      </div>}
      {mode === 'drivability' && <div className="semantic-legend drivability-legend viewer-legend">
        <div>Drivability</div>
        {Object.entries(DRIVABILITY_COLORS).map(([status, color]) => <p key={status}><i style={{ background: color }} />{status}</p>)}
        <small>{drivabilityOptions.profile} profile<br />Unknown = no returns</small>
      </div>}
      {mode === 'resolution' && <div className="semantic-legend resolution-legend viewer-legend">
        <div>Cell Resolution</div>
        {RESOLUTION_LEGEND.map(({ label, resolution }) => <p key={label}>
          <i style={{ background: layerColor({ resolution }, 'resolution') }} />{label}
        </p>)}
      </div>}
      {!isPointViewer && <SelectionCard selected={state.selected} drivabilityOptions={drivabilityOptions} onClose={() => setSelected(null)} />}
      {featured && <div className="viewer-note">{uploaded ? meta.method : note}</div>}
    </div>
    <PlaybackStrip disabled={disabled} frameIndex={state.frameIndex} frameCount={frameCount} playing={state.playing}
      speed={state.speed} onStep={step} onToggle={togglePlaying} onScrub={scrub} onSpeed={setSpeed} />
  </section>
}

export default function App() {
  const [dataset, setDataset] = useState(null)
  const [frames, setFrames] = useState({})
  const [loadingByViewer, setLoadingByViewer] = useState(() => viewerMap(true))
  const [recordingWarmup, setRecordingWarmup] = useState(() => ({ phase: 'manifest', loaded: 0, total: 0, ready: false }))
  const [windowState, setWindowState] = useState(initialWindowState)
  const [featuredViewerId, setFeaturedViewerId] = useState('semantic')
  const [showLanding, setShowLanding] = useState(true)
  const [now, setNow] = useState(() => new Date())
  const [error, setError] = useState('')
  const [uploaded, setUploaded] = useState(null)
  const [uploadOpen, setUploadOpen] = useState(false)
  const [hiddenClasses, setHiddenClasses] = useState(() => new Set())
  const [boundaries, setBoundaries] = useState(true)
  const [elevated, setElevated] = useState(true)
  const [representation, setRepresentation] = useState('blocks')
  const [detail, setDetail] = useState(true)
  const [pointSize, setPointSize] = useState(1.8)
  const [drivabilityOptions, setDrivabilityOptions] = useState(() => ({ ...DEFAULT_DRIVABILITY }))
  const [showEgo, setShowEgo] = useState(true)
  const playbackClock = useRef({ last: 0, carry: viewerMap(0) })
  const frameIndexSignature = VIEWER_IDS.map(id => windowState[id].frameIndex).join('|')
  const playbackSignature = VIEWER_IDS
    .map(id => `${loadingByViewer[id] ? 1 : 0}:${windowState[id].playing ? 1 : 0}:${windowState[id].speed}:${windowState[id].frameIndex}`)
    .join('|')

  useEffect(() => {
    let active = true
    loadFrames().then(result => {
      if (!active) return
      setDataset(result)
      setRecordingWarmup({ phase: 'ready', loaded: result.frames?.size ?? 0, total: result.frameIds.length, ready: true })
      setLoadingByViewer(viewerMap(false))
      setError('')
    })
      .catch(nextError => { if (active) { setError(nextError.message); setLoadingByViewer(viewerMap(false)) } })
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (!dataset) return
    let active = true
    dataset.preloadTo?.(STARTUP_STREAM_BUFFER, (loaded, total) => {
      if (!active) return
      setRecordingWarmup(previous => ({
        ...previous,
        phase: loaded >= Math.min(total, STARTUP_STREAM_BUFFER) ? 'ready' : 'streaming',
        loaded,
        total,
        ready: true,
      }))
    }).then(() => {
      if (!active) return
      setRecordingWarmup(previous => ({
        ...previous,
        phase: 'ready',
        loaded: Math.max(previous.loaded, Math.min(dataset.frameIds.length, STARTUP_STREAM_BUFFER)),
        total: dataset.frameIds.length,
        ready: true,
      }))
    }).catch(() => {})
    return () => { active = false }
  }, [dataset])

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    if (uploaded) {
      setFrames(viewerMap(uploaded))
      setLoadingByViewer(viewerMap(false))
      return
    }
    if (!dataset) return
    setFrames(previous => {
      let changed = false
      const next = { ...previous }
      for (const { id } of VIEWERS) {
        const frame = dataset.getFrame?.(dataset.frameIds[windowState[id].frameIndex])
        if (frame && previous[id] !== frame) {
          next[id] = frame
          changed = true
        }
      }
      return changed ? next : previous
    })
    setLoadingByViewer(viewerMap(false))
  }, [dataset, uploaded, frameIndexSignature])

  useEffect(() => {
    if (!dataset || uploaded) return
    playbackClock.current.last = 0
    playbackClock.current.carry = viewerMap(0)
    let rafId = 0
    const frameCount = dataset.frameIds.length
    const frameIds = dataset.frameIds
    const tick = now => {
      const clock = playbackClock.current
      const delta = clock.last ? now - clock.last : 0
      clock.last = now
      setWindowState(previous => {
        let changed = false
        const next = { ...previous }
        for (const { id } of VIEWERS) {
          if (!previous[id].playing) {
            clock.carry[id] = 0
            continue
          }
          const period = PLAYBACK_FRAME_MS / previous[id].speed
          clock.carry[id] = Math.min(clock.carry[id] + delta, period * 2)
          if (clock.carry[id] < period) continue

          const candidate = (previous[id].frameIndex + 1) % frameCount
          const frameId = frameIds[candidate]
          if (!dataset.hasFrame?.(frameId)) {
            dataset.loadFrame(frameId).catch(() => {})
            clock.carry[id] = period
            continue
          }

          clock.carry[id] -= period
          next[id] = { ...previous[id], frameIndex: candidate }
          changed = true
        }
        return changed ? next : previous
      })
      rafId = requestAnimationFrame(tick)
    }
    rafId = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafId)
  }, [dataset, uploaded, playbackSignature])

  useEffect(() => {
    if (!dataset || uploaded) return
    const count = dataset.frameIds.length
    for (const { id } of VIEWERS) {
      const center = windowState[id].frameIndex
      const ahead = Math.min(MAX_PREFETCH_AHEAD, Math.max(32, PREFETCH_AHEAD, Math.ceil(windowState[id].speed * 12)))
      for (let offset = -PREFETCH_BEHIND; offset <= ahead; offset += 1) {
        if (!offset) continue
        const nextIndex = (center + offset + count) % count
        dataset.loadFrame(dataset.frameIds[nextIndex]).catch(() => {})
      }
    }
  }, [dataset, uploaded, playbackSignature])

  const updateViewerState = (id, update) => setWindowState(previous => ({
    ...previous,
    [id]: typeof update === 'function' ? update(previous[id]) : { ...previous[id], ...update },
  }))

  const frameCount = dataset?.frameIds.length ?? 0
  const featuredViewer = viewerById[featuredViewerId] ?? viewerById.semantic
  const activeViewerCount = VIEWER_IDS.filter(id => windowState[id].playing).length
  const systemMetricItems = VIEWERS.map(viewer => viewerMetrics(viewer, frames[viewer.id], windowState[viewer.id], frameCount))
  const sourceLabel = uploaded ? 'User upload' : 'Recorded sequence'
  const waitingForRecordedClip = !uploaded && !dataset
  const streamedFrameCount = uploaded ? 0 : Math.max(recordingWarmup.loaded, dataset?.frames?.size ?? 0)
  const warmupPercent = frameCount ? Math.round(streamedFrameCount / frameCount * 100) : 0
  const backgroundCacheActive = !uploaded && Boolean(dataset) && streamedFrameCount < frameCount

  if (showLanding) {
    return <main className="landing-shell">
      <section className="landing-hero">
        <div className="landing-orbit landing-orbit-a" />
        <div className="landing-orbit landing-orbit-b" />
        <div className="landing-gridline" />
        <header className="landing-header">
          <div className="brand-home">
            <div className="brand-icon"><svg viewBox="0 0 40 40" fill="none"><path d="m20 4 16 9-16 9L4 13 20 4Zm-16 16 16 9 16-9M4 27l16 9 16-9" stroke="currentColor" strokeWidth="2" /><path d="m12 13 8-4 8 4-8 4-8-4Z" fill="currentColor" opacity=".4" /></svg></div>
            <div className="brand-copy">
              <strong>PointMatrix</strong>
              <small>Tactical LiDAR Mapping Cockpit</small>
            </div>
          </div>
          <div className="landing-header-meta">
            <span className="status-badge status-live"><i className="status-dot" />System online</span>
            <span className="header-chip clock-chip">{now.toLocaleTimeString('en-GB', { hour12: false })}</span>
          </div>
        </header>

        <div className="landing-copy">
          <span className="landing-kicker">Adaptive 2.5D Semantic Mapping</span>
          <h1>Autonomous perception workspace built for rapid LiDAR inspection.</h1>
          <p>
            Launch into the full multi-window dashboard with synchronized raw points, semantic mapping,
            drivability analysis, elevation, and adaptive resolution views in one tactical cockpit.
          </p>
          <div className="landing-actions">
            <button className="primary landing-enter" onClick={() => setShowLanding(false)}>Enter Dashboard</button>
            <button onClick={() => { setShowLanding(false); setUploadOpen(true) }} disabled={!UPLOADS_ENABLED}>Upload LiDAR</button>
          </div>
          <div className="landing-stats">
            <LandingStat label="Views" value={String(VIEWERS.length)} />
            <LandingStat label="Frames Loaded" value={dataset ? number(frameCount) : 'Loading'} />
            <LandingStat label="Featured Mode" value={featuredViewer.title} />
            <LandingStat label="Playback" value="Independent" />
          </div>
        </div>

        <div className="landing-preview">
          <div className="landing-preview-card landing-preview-main">
            <span className="eyebrow">MAIN COCKPIT</span>
            <strong>Semantic 2.5D Map</strong>
            <p>Promote any viewer into the central panel, inspect cells, and switch between map modes live.</p>
          </div>
          <div className="landing-preview-stack">
            <div className="landing-preview-card">
              <span className="eyebrow">RAW POINTS</span>
              <strong>LiDAR geometry</strong>
              <p>Elevation-colored returns with tighter startup zoom for instant vehicle visibility.</p>
            </div>
            <div className="landing-preview-card">
              <span className="eyebrow">ANALYTICS</span>
              <strong>Resolution and drivability</strong>
              <p>Adaptive grid resolution, terrain height, and traversability layers with continuous playback.</p>
            </div>
          </div>
        </div>
      </section>

      <section className="landing-features">
        <LandingFeature eyebrow="MULTI-VIEW" title="Independent playback windows" copy="Each viewer keeps its own frame index, speed, zoom, and play state for side-by-side comparison." />
        <LandingFeature eyebrow="OPERATOR FLOW" title="Large-panel switching" copy="Promote raw points, segmentation, elevation, drivability, or resolution into the main display from one control." />
        <LandingFeature eyebrow="TACTICAL UI" title="Command-center visual language" copy="Dark HUD panels, telemetry chips, and premium cockpit styling aligned with the dashboard theme." />
      </section>
    </main>
  }

  const toggleClass = id => setHiddenClasses(previous => {
    const next = new Set(previous)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })

  const acceptUpload = result => {
    setUploaded(result)
    setUploadOpen(false)
    setHiddenClasses(new Set())
    setWindowState(previous => Object.fromEntries(Object.entries(previous).map(([id, state]) => [id, {
      ...state, playing: false, selected: null,
    }])))
    setError('')
  }

  const renderViewer = (viewer, className = '') => <ViewerWindow key={viewer.id} {...viewer} className={className}
    frame={frames[viewer.id]} loading={loadingByViewer[viewer.id]}
    uploaded={uploaded} frameCount={frameCount} hiddenClasses={hiddenClasses} onToggleClass={toggleClass}
    onShowAllClasses={() => setHiddenClasses(new Set())} boundaries={boundaries} elevated={elevated}
    representation={representation} detail={detail} pointSize={pointSize} showEgo={showEgo}
    drivabilityOptions={drivabilityOptions} state={windowState[viewer.id]}
    setTopDown={value => updateViewerState(viewer.id, { topDown: value, selected: null })}
    setZoom={value => updateViewerState(viewer.id, { zoom: value })}
    resetView={() => updateViewerState(viewer.id, previous => ({
      ...previous,
      zoom: viewerById[viewer.id]?.defaultZoom ?? DEFAULT_ZOOM,
      reset: previous.reset + 1,
      selected: null,
    }))}
    setSelected={value => updateViewerState(viewer.id, { selected: value })}
    step={delta => updateViewerState(viewer.id, previous => ({
      ...previous, playing: false, frameIndex: frameCount ? (previous.frameIndex + delta + frameCount) % frameCount : 0,
    }))}
    togglePlaying={() => updateViewerState(viewer.id, previous => ({ ...previous, playing: !previous.playing }))}
    scrub={value => updateViewerState(viewer.id, { playing: false, frameIndex: value })}
    setSpeed={value => updateViewerState(viewer.id, { speed: value })} />

  return <main className="app-shell">
    <header className="topbar">
      <div className="brand-home">
        <div className="brand-icon"><svg viewBox="0 0 40 40" fill="none"><path d="m20 4 16 9-16 9L4 13 20 4Zm-16 16 16 9 16-9M4 27l16 9 16-9" stroke="currentColor" strokeWidth="2" /><path d="m12 13 8-4 8 4-8 4-8-4Z" fill="currentColor" opacity=".4" /></svg></div>
        <div className="brand-copy">
          <strong>PointMatrix</strong>
          <small>Tactical LiDAR Mapping Cockpit</small>
        </div>
      </div>
      <div className="brand-divider" />
      <p className="tagline">Adaptive 2.5D Semantic Mapping for Autonomous Navigation<span>INDEPENDENT PERCEPTION WORKSPACE</span></p>
      <div className="topbar-right">
        <span className="status-badge status-live"><i className="status-dot" />{uploaded ? 'Scan processed' : 'System online'}</span>
        <span className="header-chip">Frame: {frameCount ? `${windowState[featuredViewer.id].frameIndex + 1} / ${number(frameCount)}` : '0 / 0'}</span>
        <span className="header-chip">10 Hz</span>
        <span className="header-chip clock-chip">{now.toLocaleTimeString('en-GB', { hour12: false })}</span>
        <button className="primary upload-trigger" onClick={() => setUploadOpen(true)} disabled={!UPLOADS_ENABLED}
          title={UPLOADS_ENABLED ? 'Upload a point cloud for processing' : 'Set VITE_HF_SPACE (or VITE_API_BASE_URL) to enable uploads'}>
          <span>↑</span> Upload LiDAR</button>
      </div>
    </header>

    <div className="session-bar">
      <div><span className="eyebrow">ACTIVE SOURCE</span><strong>{uploaded ? uploaded.filename : 'PointMatrix / Recorded sequence'}</strong>
        <span className="source-chip">{uploaded ? 'USER UPLOAD' : `${number(frameCount)} FRAMES`}</span>
        {backgroundCacheActive && <span className="source-chip cache-chip">{warmupPercent}% STREAMED</span>}</div>
      <div className="session-picker">
        <label className="field-label" htmlFor="featured-viewer">Large panel</label>
        <select id="featured-viewer" value={featuredViewerId} onChange={e => setFeaturedViewerId(e.target.value)}>
          {VIEWERS.map(viewer => <option key={viewer.id} value={viewer.id}>{viewer.title}</option>)}
        </select>
      </div>
      <div className="session-actions">
        {uploaded?.frameUrl
          ? <a className="button-link" href={uploaded.frameUrl} download>↓ Download frame (.lgf.gz)</a>
          : uploaded && BACKEND === 'api' && <a className="button-link" href={apiUrl(`/jobs/${uploaded.jobId}/download`)}>↓ Download NPZ</a>}
        {uploaded ? <button onClick={() => setUploaded(null)}>← Back to sequence</button>
          : <span className="session-note">{backgroundCacheActive
            ? `Playback starts immediately. Frames keep streaming in the background (${streamedFrameCount} / ${frameCount}).`
            : 'Recorded playback opens on the first frame and fetches upcoming frames as needed. Each window still keeps its own frame, speed, zoom, and play state.'}</span>}
      </div>
    </div>

    {error && <div role="alert" className="error-banner">{error}<button onClick={() => setError('')}>Dismiss</button></div>}

    {waitingForRecordedClip ? <div className="loading-state"><div className="radar" />
      <h2>{error ? 'Frame data unavailable' : 'Loading spatial data'}</h2>
      <p>{error ? 'You can still upload a new scan with the button above.' : 'Preparing the recorded sequence manifest and first frame...'}</p>
    </div>
      : <>
        <section className="dashboard-layout">
          {renderViewer(VIEWERS.find(({ id }) => id === 'raw'), 'layout-panel viewer-card--secondary layout-raw')}
          {renderViewer(VIEWERS.find(({ id }) => id === 'segmentation'), 'layout-panel viewer-card--secondary layout-segmentation')}
          {renderViewer(featuredViewer, 'layout-panel viewer-card--featured layout-semantic')}
          {renderViewer(VIEWERS.find(({ id }) => id === 'elevation'), 'layout-panel viewer-card--secondary layout-elevation')}
          {renderViewer(VIEWERS.find(({ id }) => id === 'drivability'), 'layout-panel viewer-card--secondary layout-drivability')}
          {renderViewer(VIEWERS.find(({ id }) => id === 'resolution'), 'layout-panel viewer-card--secondary layout-resolution')}

          <aside className="sidebar-panels layout-sidebar">
            <SystemMetricsPanel items={systemMetricItems} featuredViewer={featuredViewer}
              activeViewerCount={activeViewerCount} frameCount={frameCount} sourceLabel={sourceLabel} />

            <div className="control-card">
              <span className="eyebrow">LAYER CONTROLS</span>
              <h2>Visible layers</h2>
              <label className="checkbox checkbox-static"><input type="checkbox" checked readOnly /> Semantic (Class colors)</label>
              <label className="checkbox"><input type="checkbox" checked={elevated} onChange={e => setElevated(e.target.checked)} /> Elevation (Height map)</label>
              <label className="checkbox checkbox-static"><input type="checkbox" checked readOnly /> Traversability (Drivable / Non-drivable)</label>
              <label className="checkbox checkbox-static"><input type="checkbox" checked readOnly /> Resolution (Cell size)</label>
              <label className="checkbox checkbox-static checkbox-disabled"><input type="checkbox" checked={false} readOnly /> Point density</label>
              <label className="checkbox"><input type="checkbox" checked={boundaries} onChange={e => setBoundaries(e.target.checked)} /> Show cell boundaries</label>
            </div>

            <div className="control-card">
            <span className="eyebrow">SHARED VIEW CONTROLS</span>
            <h2>Display tuning</h2>
            <label className="checkbox"><input type="checkbox" checked={showEgo} onChange={e => setShowEgo(e.target.checked)} /> Show our car (cyan ego marker)</label>
            <label className="field-label" htmlFor="scene-extent">Spatial extent</label>
            <select id="scene-extent" value={detail ? 'detail' : 'full'} onChange={e => setDetail(e.target.value === 'detail')}>
              <option value="detail">Detail view · central 60 m</option>
              <option value="full">Full scan · all points and cells</option>
            </select>
            <label className="field-label" htmlFor="representation">Semantic scene rendering</label>
            <select id="representation" value={representation} onChange={e => setRepresentation(e.target.value)}>
              <option value="blocks">Aggregated display blocks</option>
              <option value="cells">Exact cells</option>
            </select>
            <label className="point-size-label" htmlFor="point-size"><span>Point size</span><b>{pointSize.toFixed(1)} px</b></label>
            <input id="point-size" className="point-size-slider" type="range" min="1" max="4" step=".2"
              value={pointSize} onChange={e => setPointSize(Number(e.target.value))} />
            </div>

            <div className="control-card">
            <span className="eyebrow">DRIVABILITY PROFILE</span>
            <h2>Vehicle thresholds</h2>
            <label className="field-label" htmlFor="vehicle-profile">Profile</label>
            <select id="vehicle-profile" value={drivabilityOptions.profile}
              onChange={e => setDrivabilityOptions(previous => ({ ...previous, profile: e.target.value }))}>
              <option value="on-road">On-road</option>
              <option value="off-road">Off-road</option>
            </select>
            {[
              ['roughCaution', 'Roughness: caution'],
              ['roughBlocked', 'Roughness: blocked'],
              ['minConfidence', 'Minimum confidence'],
            ].map(([key, label]) => <div key={key}>
              <label className="point-size-label" htmlFor={key}><span>{label}</span><b>{drivabilityOptions[key].toFixed(2)}</b></label>
              <input className="point-size-slider" id={key} type="range" min="0" max="1" step=".05"
                value={drivabilityOptions[key]} onChange={e => {
                  const value = Number(e.target.value)
                  setDrivabilityOptions(previous => ({
                    ...previous, [key]: value,
                    ...(key === 'roughCaution' ? { roughBlocked: Math.max(value, previous.roughBlocked) } : {}),
                    ...(key === 'roughBlocked' ? { roughCaution: Math.min(value, previous.roughCaution) } : {}),
                  }))
                }} />
            </div>)}
            <button onClick={() => setDrivabilityOptions({ ...DEFAULT_DRIVABILITY })}>Reset drivability</button>
            </div>
          </aside>
        </section>
      </>}

    <footer className="bottom-note"><span>PointMatrix <b>/</b> INDEPENDENT PLAYBACK WORKSPACE</span>
      <span>{VIEWERS.length} viewer windows run on separate frame indices while sharing the same dataset and controls.</span></footer>
    {uploadOpen && <Upload onComplete={acceptUpload} onClose={() => setUploadOpen(false)} />}
  </main>
}
