import { useEffect, useMemo, useRef, useState } from 'react'
import PointCloud from './components/PointCloud'
import SemanticMap from './components/SemanticMap'
import Upload from './components/Upload'
import { UPLOADS_ENABLED, apiUrl } from './config'
import { loadFrames } from './data'
import { KNOWN_CLASSES, colorForClass, nameForClass } from './palette'
import { createView } from './scene'
import { classifyCell, classifyGrid, DEFAULT_DRIVABILITY, DRIVABILITY_COLORS } from './drivability'
import { egoPosition } from './ego'

const EMPTY = new Set()
const EMPTY_CELLS = []
const VIEWERS = [
  { id: 'raw', title: 'Raw LiDAR Points', note: 'XYZ geometry colored by elevation' },
  { id: 'semantic', title: 'Semantic 2.5D Map', note: 'Adaptive semantic grid with 2.5D structure' },
  { id: 'drivability', title: 'Drivability Map', note: 'Exact cells classified by vehicle profile' },
]

const number = value => Number(value ?? 0).toLocaleString()
const ms = value => value == null ? 'Not recorded' : `${value.toFixed(1)} ms`

function initialWindowState() {
  return {
    raw: { frameIndex: 0, playing: false, speed: 1, topDown: false, zoom: 1, reset: 0, selected: null },
    semantic: { frameIndex: 0, playing: false, speed: 1, topDown: false, zoom: 1, reset: 0, selected: null },
    drivability: { frameIndex: 0, playing: false, speed: 1, topDown: true, zoom: 1, reset: 0, selected: null },
  }
}

function Row({ label, value }) {
  return <div className="metric-row"><span>{label}</span><strong>{value}</strong></div>
}

function ViewToggle({ value, onChange }) {
  return <div className="segmented"><button className={!value ? 'active' : ''} onClick={() => onChange(false)}>Isometric</button>
    <button className={value ? 'active' : ''} onClick={() => onChange(true)}>Top-down</button></div>
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
      <option value={6}>6×</option>
    </select>
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
  id, title, note, frame, loading, uploaded, frameCount, hiddenClasses, onToggleClass, onShowAllClasses,
  boundaries, elevated, representation, detail, pointSize, showEgo, drivabilityOptions,
  state, setTopDown, setZoom, resetView, setSelected, step, togglePlaying, scrub, setSpeed,
}) {
  const captureRef = useRef(null)
  const meta = frame?.meta ?? {}
  const sourceCells = frame?.grid ?? EMPTY_CELLS
  const { grid: cells, area: drivabilityArea } = useMemo(() => classifyGrid(sourceCells, drivabilityOptions), [sourceCells, drivabilityOptions])
  const points = frame?.points ?? new Float32Array()
  const view = useMemo(() => createView(sourceCells, detail, points), [sourceCells, detail, points])
  const ego = useMemo(() => showEgo ? egoPosition(sourceCells) : null, [sourceCells, showEgo])
  const retained = cells.reduce((sum, cell) => sum + cell.point_count, 0)

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

  return <section className="viewer-card">
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
      {id === 'raw' ? <span className="viewer-toolbar-label">Height (Z)</span> : <ViewToggle value={state.topDown} onChange={setTopDown} />}
      <div className="viewer-actions">
        {id !== 'raw' && <button onClick={resetView}>Reset view</button>}
        <button onClick={captureView} disabled={!frame}>Capture</button>
        {id !== 'raw' && <button onClick={() => downloadJSON(frame, drivabilityOptions)} disabled={!frame}>Export JSON</button>}
      </div>
    </div>
    <div className="viewer-stage">
      {id === 'raw'
        ? <PointCloud points={points} hiddenClasses={EMPTY} mode="height" topDown={false} view={view} pointSize={pointSize}
          ego={ego} playing={state.playing} zoom={state.zoom} onZoomChange={setZoom} captureRef={captureRef} />
        : <SemanticMap cells={id === 'semantic' ? sourceCells : cells} hiddenClasses={id === 'semantic' ? hiddenClasses : EMPTY}
          mode={id === 'semantic' ? 'semantic' : 'drivability'} boundaries={boundaries} elevated={elevated}
          topDown={state.topDown} reset={state.reset} onSelect={setSelected} captureRef={captureRef}
          representation={id === 'semantic' ? representation : 'cells'} view={view} selected={state.selected}
          zoom={state.zoom} onZoomChange={setZoom} ego={ego} playing={state.playing} />}
      {loading && <div className="viewer-loading">Loading frame…</div>}
      {id === 'semantic' && <div className="semantic-legend viewer-legend">
        <div>Semantic classes <button onClick={onShowAllClasses}>Show all</button></div>
        {Object.entries(KNOWN_CLASSES).map(([classId, name]) => <button key={classId} className={hiddenClasses.has(Number(classId)) ? 'muted' : ''}
          aria-pressed={!hiddenClasses.has(Number(classId))} onClick={() => onToggleClass(Number(classId))}>
          <i style={{ background: colorForClass(Number(classId)) }} />{name}</button>)}
      </div>}
      {id === 'drivability' && <div className="semantic-legend drivability-legend viewer-legend">
        <div>Drivability</div>
        {Object.entries(DRIVABILITY_COLORS).map(([status, color]) => <p key={status}><i style={{ background: color }} />{status}</p>)}
        <small>{drivabilityOptions.profile} profile<br />Unknown = no returns</small>
      </div>}
      {id !== 'raw' && <SelectionCard selected={state.selected} drivabilityOptions={drivabilityOptions} onClose={() => setSelected(null)} />}
      <div className="viewer-note">{uploaded ? meta.method : note}</div>
    </div>
    <div className="viewer-metrics">
      <Row label="Input points" value={number(meta.total_input_points)} />
      <Row label="Rendered" value={number(meta.exported_points)} />
      <Row label={id === 'raw' ? 'Semantic cells' : 'Displayed cells'} value={number(cells.length)} />
      <Row label="End-to-end" value={ms(meta.total_ms)} />
      {id === 'drivability' && <Row label="Drivable area" value={`${drivabilityArea.drivable.toFixed(1)} m²`} />}
      {id === 'semantic' && <Row label="Retained points" value={`${meta.total_input_points ? (retained / meta.total_input_points * 100).toFixed(2) : '0.00'}%`} />}
    </div>
    <PlaybackStrip disabled={disabled} frameIndex={state.frameIndex} frameCount={frameCount} playing={state.playing}
      speed={state.speed} onStep={step} onToggle={togglePlaying} onScrub={scrub} onSpeed={setSpeed} />
  </section>
}

export default function App() {
  const [dataset, setDataset] = useState(null)
  const [frames, setFrames] = useState({})
  const [loadingByViewer, setLoadingByViewer] = useState({ raw: true, semantic: true, drivability: true })
  const [windowState, setWindowState] = useState(initialWindowState)
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

  useEffect(() => {
    let active = true
    loadFrames().then(result => { if (active) setDataset(result) })
      .catch(nextError => { if (active) { setError(nextError.message); setLoadingByViewer({ raw: false, semantic: false, drivability: false }) } })
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (uploaded) {
      setFrames({ raw: uploaded, semantic: uploaded, drivability: uploaded })
      setLoadingByViewer({ raw: false, semantic: false, drivability: false })
      return
    }
    if (!dataset) return
    let active = true
    for (const { id } of VIEWERS) {
      const frameId = dataset.frameIds[windowState[id].frameIndex]
      setLoadingByViewer(previous => ({ ...previous, [id]: true }))
      dataset.loadFrame(frameId).then(frame => {
        if (!active) return
        setFrames(previous => ({ ...previous, [id]: frame }))
        setLoadingByViewer(previous => ({ ...previous, [id]: false }))
        setError('')
      }).catch(nextError => {
        if (!active) return
        setLoadingByViewer(previous => ({ ...previous, [id]: false }))
        setWindowState(previous => ({ ...previous, [id]: { ...previous[id], playing: false } }))
        setError(nextError.message)
      })
    }
    return () => { active = false }
  }, [dataset, uploaded, windowState.raw.frameIndex, windowState.semantic.frameIndex, windowState.drivability.frameIndex])

  useEffect(() => {
    if (!dataset || uploaded) return
    const frameCount = dataset.frameIds.length
    const timers = VIEWERS.flatMap(({ id }) => {
      if (!windowState[id].playing || loadingByViewer[id]) return []
      return [setTimeout(() => {
        setWindowState(previous => ({
          ...previous,
          [id]: { ...previous[id], frameIndex: (previous[id].frameIndex + 1) % frameCount },
        }))
      }, 500 / windowState[id].speed)]
    })
    return () => timers.forEach(clearTimeout)
  }, [
    dataset, uploaded, loadingByViewer.raw, loadingByViewer.semantic, loadingByViewer.drivability,
    windowState.raw.playing, windowState.raw.speed, windowState.raw.frameIndex,
    windowState.semantic.playing, windowState.semantic.speed, windowState.semantic.frameIndex,
    windowState.drivability.playing, windowState.drivability.speed, windowState.drivability.frameIndex,
  ])

  const updateViewerState = (id, update) => setWindowState(previous => ({
    ...previous,
    [id]: typeof update === 'function' ? update(previous[id]) : { ...previous[id], ...update },
  }))

  const frameCount = dataset?.frameIds.length ?? 0

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

  return <main className="app-shell">
    <header className="topbar">
      <div className="brand-icon"><svg viewBox="0 0 40 40" fill="none"><path d="m20 4 16 9-16 9L4 13 20 4Zm-16 16 16 9 16-9M4 27l16 9 16-9" stroke="currentColor" strokeWidth="2" /><path d="m12 13 8-4 8 4-8 4-8-4Z" fill="currentColor" opacity=".4" /></svg></div>
      <h1>Point<span>Matrix</span></h1><div className="brand-divider" />
      <p className="tagline">Adaptive 2.5D Semantic Mapping<span>INDEPENDENT VIEW WINDOWS</span></p>
      <div className="topbar-right"><span className="status-badge"><i className="status-dot" />{uploaded ? 'Scan processed' : 'Dataset explorer'}</span>
        <button className="primary upload-trigger" onClick={() => setUploadOpen(true)} disabled={!UPLOADS_ENABLED}
          title={UPLOADS_ENABLED ? 'Upload a point cloud to the processing backend' : 'Set VITE_API_BASE_URL to enable uploads'}>
          <span>↑</span> Upload LiDAR</button></div>
    </header>

    <div className="session-bar">
      <div><span className="eyebrow">ACTIVE SOURCE</span><strong>{uploaded ? uploaded.filename : 'PointMatrix / Recorded sequence'}</strong>
        <span className="source-chip">{uploaded ? 'USER UPLOAD' : `${number(frameCount)} FRAMES`}</span></div>
      <div className="session-actions">
        {uploaded && UPLOADS_ENABLED && <a className="button-link" href={apiUrl(`/jobs/${uploaded.jobId}/download`)}>↓ Download NPZ</a>}
        {uploaded ? <button onClick={() => setUploaded(null)}>← Back to sequence</button>
          : <span className="session-note">Each window keeps its own frame, speed, and playback state.</span>}
      </div>
    </div>

    {error && <div role="alert" className="error-banner">{error}<button onClick={() => setError('')}>Dismiss</button></div>}

    {!dataset && !uploaded ? <div className="loading-state"><div className="radar" /><h2>{error ? 'Frame data unavailable' : 'Loading spatial data'}</h2>
      <p>{error ? 'You can still upload a new scan with the button above.' : 'Preparing independent playback windows...'}</p></div>
      : <>
        <section className="viewer-grid">
          {VIEWERS.map(viewer => <ViewerWindow key={viewer.id} {...viewer} frame={frames[viewer.id]} loading={loadingByViewer[viewer.id]}
            uploaded={uploaded} frameCount={frameCount} hiddenClasses={hiddenClasses} onToggleClass={toggleClass}
            onShowAllClasses={() => setHiddenClasses(new Set())} boundaries={boundaries} elevated={elevated}
            representation={representation} detail={detail} pointSize={pointSize} showEgo={showEgo}
            drivabilityOptions={drivabilityOptions} state={windowState[viewer.id]}
            setTopDown={value => updateViewerState(viewer.id, { topDown: value, selected: null })}
            setZoom={value => updateViewerState(viewer.id, { zoom: value })}
            resetView={() => updateViewerState(viewer.id, previous => ({ ...previous, zoom: 1, reset: previous.reset + 1, selected: null }))}
            setSelected={value => updateViewerState(viewer.id, { selected: value })}
            step={delta => updateViewerState(viewer.id, previous => ({
              ...previous, playing: false, frameIndex: frameCount ? (previous.frameIndex + delta + frameCount) % frameCount : 0,
            }))}
            togglePlaying={() => updateViewerState(viewer.id, previous => ({ ...previous, playing: !previous.playing }))}
            scrub={value => updateViewerState(viewer.id, { playing: false, frameIndex: value })}
            setSpeed={value => updateViewerState(viewer.id, { speed: value })} />)}
        </section>

        <section className="control-section">
          <div className="control-card">
            <span className="eyebrow">SHARED VIEW CONTROLS</span>
            <h2>Display tuning</h2>
            <label className="checkbox"><input type="checkbox" checked={elevated} onChange={e => setElevated(e.target.checked)} /> Elevation (2.5D columns)</label>
            <label className="checkbox"><input type="checkbox" checked={boundaries} onChange={e => setBoundaries(e.target.checked)} /> Show cell boundaries</label>
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
        </section>
      </>}

    <footer className="bottom-note"><span>PointMatrix <b>/</b> INDEPENDENT PLAYBACK WORKSPACE</span>
      <span>Three viewer windows run on separate frame indices while sharing the same dataset and controls.</span></footer>
    {uploadOpen && <Upload onComplete={acceptUpload} onClose={() => setUploadOpen(false)} />}
  </main>
}
