import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import GridView from './components/GridView'
import SemanticMap from './components/SemanticMap'
import PointCloud from './components/PointCloud'
import Upload from './components/Upload'
import { BACKEND, UPLOADS_ENABLED, apiUrl } from './config'
import { loadFrames } from './data'
import { KNOWN_CLASSES, colorForClass, layerColor, nameForClass } from './palette'
import { createView } from './scene'
import { classifyCell, classifyGrid, DEFAULT_DRIVABILITY, DRIVABILITY_COLORS } from './drivability'
import { egoPosition } from './ego'

const EMPTY = new Set()
const EMPTY_CELLS = []
const WINDOWS = {
  1: 'Raw LiDAR Point Cloud', 2: 'Semantic Segmentation', 3: 'Adaptive 2.5D Semantic Map',
  4: 'System Metrics', 5: 'Layer Controls', 6: 'Elevation Map', 7: 'Drivability Map',
  8: 'Adaptive Resolution', 9: 'Resolution Distribution',
}
const number = value => Number(value ?? 0).toLocaleString()
const ms = value => value == null ? 'Not recorded' : `${value.toFixed(1)} ms`

function Panel({ index, title, tag, className = '', children, promoteTo, onReturn }) {
  const [expanded, setExpanded] = useState(false)
  const expandButton = useRef(null)
  useEffect(() => {
    if (!expanded) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const close = event => { if (event.key === 'Escape') setExpanded(false) }
    window.addEventListener('keydown', close)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', close)
      expandButton.current?.focus()
    }
  }, [expanded])
  useEffect(() => { if (promoteTo) setExpanded(false) }, [promoteTo])
  return <><section className={`panel ${className} ${expanded ? 'is-expanded' : ''}`}>
    <header className="panel-header"><span className="panel-index">{String(index).padStart(2, '0')}</span>
      <h2>{title}</h2>{tag && <span className="panel-tag">{tag}</span>}
      <button ref={expandButton} className="expand-panel" aria-label={`${expanded ? 'Restore' : 'Expand'} ${title}`}
        title={expanded ? 'Restore panel (Esc)' : 'Expand panel'} aria-expanded={expanded} disabled={!!promoteTo} onClick={() => setExpanded(v => !v)}>
        <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d={expanded
          ? 'M7 2v5H2m11-5v5h5M7 18v-5H2m11 5v-5h5'
          : 'M7 2H2v5m11-5h5v5M2 13v5h5m11-5v5h-5'} stroke="currentColor" strokeWidth="1.5" /></svg>
      </button></header>
    <div className="panel-body">{promoteTo ? <div className="promoted-placeholder">
      <span className="eyebrow">DISPLAYED IN WINDOW 3</span><strong>{title}</strong>
      <button onClick={onReturn}>Return to this window</button>
    </div> : children}</div>
  </section>
    {promoteTo && createPortal(<section className={`promoted-view ${className}`}>
      <div className="panel-body">{children}</div>
    </section>, promoteTo)}
  </>
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
  anchor.href = url; anchor.download = `lidar-${frame.meta.frame_id}-grid.json`; anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export default function App() {
  const [dataset, setDataset] = useState(null)
  const [frame, setFrame] = useState(null)
  const [frameIndex, setFrameIndex] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [uploaded, setUploaded] = useState(null)
  const [uploadOpen, setUploadOpen] = useState(false)
  const [hiddenClasses, setHiddenClasses] = useState(() => new Set())
  const [mode, setMode] = useState('semantic')
  const [boundaries, setBoundaries] = useState(true)
  const [elevated, setElevated] = useState(true)
  const [representation, setRepresentation] = useState('blocks')
  const [detail, setDetail] = useState(true)
  const [pointSize, setPointSize] = useState(1.8)
  const [drivabilityOptions, setDrivabilityOptions] = useState(() => ({ ...DEFAULT_DRIVABILITY }))
  const [topDown, setTopDown] = useState(false)
  const [mapZoom, setMapZoom] = useState(1)
  const [mainWindow, setMainWindow] = useState(3)
  const [mainHost, setMainHost] = useState(null)
  const [showEgo, setShowEgo] = useState(true)
  const [rawTop, setRawTop] = useState(false)
  const [segTop, setSegTop] = useState(false)
  const [selected, setSelected] = useState(null)
  const [reset, setReset] = useState(0)
  const lastFrame = useRef(null)
  const captureRef = useRef(null)

  const captureView = async () => {
    if (!captureRef.current) return
    try {
      const blob = await captureRef.current()
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `lidar-${frame.meta.frame_id}-window-${mainWindow}.png`
      anchor.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (e) { setError(e.message) }
  }

  useEffect(() => {
    let active = true
    loadFrames().then(result => { if (active) setDataset(result) })
      .catch(e => { if (active) { setError(e.message); setLoading(false) } })
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (uploaded) { setFrame(uploaded); setLoading(false); return }
    if (!dataset) return
    let active = true
    setLoading(true)
    dataset.loadFrame(dataset.frameIds[frameIndex]).then(next => {
      if (active) { setFrame(next); setLoading(false); setSelected(null); setError('') }
    }).catch(e => { if (active) { setError(e.message); setLoading(false); setPlaying(false) } })
    return () => { active = false }
  }, [dataset, frameIndex, uploaded])

  useEffect(() => {
    if (!playing || !dataset || uploaded || loading) return
    const timer = setTimeout(() => setFrameIndex(i => (i + 1) % dataset.frameIds.length), 500 / speed)
    return () => clearTimeout(timer)
  }, [playing, dataset, uploaded, loading, speed, frameIndex])

  useEffect(() => {
    if (frame && lastFrame.current !== frame) { setSelected(null); lastFrame.current = frame }
  }, [frame])

  const meta = frame?.meta ?? {}
  const sourceCells = frame?.grid ?? EMPTY_CELLS
  const { grid: cells, area: drivabilityArea } = useMemo(() => classifyGrid(sourceCells, drivabilityOptions), [sourceCells, drivabilityOptions])
  const view = useMemo(() => createView(sourceCells, detail, frame?.points), [sourceCells, detail, frame?.points])
  const ego = useMemo(() => showEgo ? egoPosition(sourceCells) : null, [sourceCells, showEgo])
  const spatialWindow = [1, 2, 3, 6, 7, 8].includes(mainWindow)
  const promotion = index => ({
    promoteTo: mainWindow === index ? mainHost : null,
    onReturn: () => setMainWindow(3),
  })
  const primaryView = index => mainWindow === index ? { zoom: mapZoom, onZoomChange: setMapZoom, captureRef } : {}
  const reduction = meta.total_input_points ? (1 - cells.length / meta.total_input_points) * 100 : 0
  const retained = cells.reduce((sum, c) => sum + c.point_count, 0)
  const retention = meta.total_input_points ? retained / meta.total_input_points * 100 : 0
  const distribution = Object.entries(meta.resolution_distribution ?? {}).sort((a, b) => Number(a[0]) - Number(b[0]))
  let accumulated = 0
  const donut = distribution.map(([size, count]) => {
    const start = accumulated; accumulated += count / Math.max(1, cells.length) * 100
    return `${layerColor({ resolution: Number(size) }, 'resolution')} ${start}% ${accumulated}%`
  }).join(', ')
  const step = delta => { setPlaying(false); setFrameIndex(i => (i + delta + dataset.frameIds.length) % dataset.frameIds.length) }
  const toggleClass = id => setHiddenClasses(previous => {
    const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next
  })
  const acceptUpload = result => {
    setUploaded(result); setFrame(result); setPlaying(false); setUploadOpen(false)
    setHiddenClasses(new Set()); setSelected(null); setReset(v => v + 1); setError('')
  }

  return <main className="app-shell">
    <header className="topbar">
      <div className="brand-icon"><svg viewBox="0 0 40 40" fill="none"><path d="m20 4 16 9-16 9L4 13 20 4Zm-16 16 16 9 16-9M4 27l16 9 16-9" stroke="currentColor" strokeWidth="2" /><path d="m12 13 8-4 8 4-8 4-8-4Z" fill="currentColor" opacity=".4" /></svg></div>
      <h1>LiDAR<span>-X</span></h1><div className="brand-divider" />
      <p className="tagline">Adaptive 2.5D Semantic Mapping<span>PERCEPTION / UNDERSTANDING / NAVIGATION</span></p>
      <div className="topbar-right"><span className="status-badge"><i className="status-dot" />{uploaded ? 'Scan processed' : 'Dataset explorer'}</span>
        <button className="primary upload-trigger" onClick={() => setUploadOpen(true)} disabled={!UPLOADS_ENABLED}
          title={UPLOADS_ENABLED ? 'Upload a point cloud to the processing backend' : 'Set VITE_HF_SPACE (or VITE_API_BASE_URL) to enable uploads'}>
          <span>↑</span> Upload LiDAR</button></div>
    </header>

    <div className="session-bar"><div><span className="eyebrow">ACTIVE SOURCE</span><strong>{uploaded ? uploaded.filename : 'Semantic LiDAR / Recorded sequence'}</strong>
      <span className="source-chip">{uploaded ? 'USER UPLOAD' : `${number(dataset?.frameIds.length)} FRAMES`}</span></div>
      {uploaded ? <button onClick={() => { setUploaded(null); setReset(v => v + 1) }}>← Back to sequence</button>
        : <span className="session-note">Synchronized views <i /> Frame {meta.frame_id ?? '------'}</span>}</div>

    {error && <div role="alert" className="error-banner">{error}<button onClick={() => { setError(''); setFrameIndex(i => Math.max(0, i - 1)) }}>Retry previous frame</button></div>}
    {!frame ? <div className="loading-state"><div className="radar" /><h2>{error ? 'Frame data unavailable' : 'Loading spatial data'}</h2>
      <p>{error ? 'You can still upload a new scan with the button above.' : 'Preparing synchronized point clouds and adaptive grids...'}</p></div>
      : <div className={`workspace ${loading ? 'is-loading' : ''}`}>
        <Panel index={1} title="Raw LiDAR Point Cloud" tag={`${number(meta.exported_points)} sampled`} className="raw-panel" {...promotion(1)}>
          <div className="viewport-toolbar"><ViewToggle value={rawTop} onChange={setRawTop} /><span>Height (Z)</span></div>
          <PointCloud points={frame.points} hiddenClasses={EMPTY} mode="height" topDown={rawTop} {...{ view, pointSize, ego, playing }} {...primaryView(1)} />
          <div className="viewport-caption">XYZ geometry{!uploaded && ' · sampled from recorded cloud'}</div>
          <div className="height-key"><span>{view.high} m</span><i /><span>{view.low} m</span></div>
        </Panel>
        <Panel index={2} title="Semantic Segmentation" tag="19 CLASSES" className="seg-panel" {...promotion(2)}>
          <div className="viewport-toolbar"><ViewToggle value={segTop} onChange={setSegTop} /><span>Semantic class</span></div>
          <PointCloud points={frame.points} hiddenClasses={hiddenClasses} topDown={segTop} {...{ view, pointSize, ego, playing }} {...primaryView(2)} />
          <div className="viewport-caption">{uploaded ? meta.method : 'Recorded semantic labels'} · {detail ? 'Detail crop' : 'Full scan'}</div>
        </Panel>
        <Panel index={3} title={WINDOWS[mainWindow]} tag="PRIMARY VIEW" className="main-panel">
          <div className="window-picker">
            <label htmlFor="window-three-view">Window 3 view</label>
            <select id="window-three-view" value={mainWindow} onChange={e => {
              setMainWindow(Number(e.target.value)); setMapZoom(1); setSelected(null)
            }}>
              {Object.entries(WINDOWS).map(([index, title]) => <option key={index} value={index}>{index}. {title}</option>)}
            </select>
          </div>
          {mainWindow === 3 && <div className="map-summary"><span>Source cells <b>{number(cells.length)}</b></span>
            <div className="segmented" aria-label="Scene representation">
              <button disabled={mode === 'drivability'} className={representation === 'blocks' && mode !== 'drivability' ? 'active' : ''} onClick={() => { setRepresentation('blocks'); setSelected(null) }}>Block scene</button>
              <button className={representation === 'cells' || mode === 'drivability' ? 'active' : ''} onClick={() => { setRepresentation('cells'); setSelected(null) }}>Exact cells</button>
            </div></div>}
          {spatialWindow && <div className="map-zoom">
            <label htmlFor="semantic-map-zoom">Zoom</label>
            <button aria-label="Zoom out Window 3" disabled={mapZoom <= .5}
              onClick={() => setMapZoom(value => Math.max(.5, Math.round(value / 1.25 * 100) / 100))}>−</button>
            <input id="semantic-map-zoom" type="range" min="50" max="800" step="1"
              value={Math.round(mapZoom * 100)} aria-valuetext={`${Math.round(mapZoom * 100)} percent`}
              onChange={e => setMapZoom(Number(e.target.value) / 100)} />
            <button aria-label="Zoom in Window 3" disabled={mapZoom >= 8}
              onClick={() => setMapZoom(value => Math.min(8, Math.round(value * 1.25 * 100) / 100))}>+</button>
            <output htmlFor="semantic-map-zoom">{Math.round(mapZoom * 100)}%</output>
          </div>}
          <div className="window-three-host" ref={setMainHost} hidden={mainWindow === 3} />
          {mainWindow === 3 && <><div className="main-map">
            <SemanticMap key={uploaded?.jobId ?? 'sequence'} {...{ cells, mode, boundaries, elevated, topDown, reset, captureRef, representation, view, selected }}
              hiddenClasses={mode === 'drivability' ? EMPTY : hiddenClasses} onSelect={setSelected}
              zoom={mapZoom} onZoomChange={setMapZoom} {...{ ego, playing }} />
            <div className="map-actions"><button className={!topDown ? 'active' : ''} onClick={() => setTopDown(false)}>3D view</button>
              <button className={topDown ? 'active' : ''} onClick={() => setTopDown(true)}>Top-down</button>
              <button onClick={() => { setMapZoom(1); setReset(v => v + 1) }}>Reset</button></div>
            {mode === 'drivability' ? <div className="semantic-legend drivability-legend">
              <div>Drivability</div>
              {Object.entries(DRIVABILITY_COLORS).map(([state, color]) => <p key={state}><i style={{ background: color }} />{state}</p>)}
              <small>{drivabilityOptions.profile} profile<br />Unknown = no returns</small>
            </div> : <div className="semantic-legend"><div>Semantic classes <button onClick={() => setHiddenClasses(new Set())}>Show all</button></div>
              {Object.entries(KNOWN_CLASSES).map(([id, name]) => <button key={id} className={hiddenClasses.has(Number(id)) ? 'muted' : ''}
                aria-pressed={!hiddenClasses.has(Number(id))} onClick={() => toggleClass(Number(id))}>
                <i style={{ background: colorForClass(Number(id)) }} />{name}</button>)}</div>}
            {selected && <div className="cell-card"><div><strong>{selected.display_kind ?? 'Cell inspection'}</strong><button aria-label="Close cell details" onClick={() => setSelected(null)}>×</button></div>
              {selected.display_kind && <p className="inspection-note">{selected.source_count} source cells. Values below describe one representative measured cell.</p>}
              <Row label="Center (X, Y)" value={`${((selected.x_min + selected.x_max) / 2).toFixed(2)}, ${((selected.y_min + selected.y_max) / 2).toFixed(2)} m`} />
              <Row label="Resolution" value={`${(selected.resolution * 100).toFixed(1)} cm`} />
              <Row label="Elevation" value={`${selected.elevation.toFixed(2)} m`} />
              <Row label="Points" value={number(selected.point_count)} />
              <Row label="Semantic" value={nameForClass(selected.semantic_class)} />
              <Row label="Confidence" value={`${(selected.semantic_confidence * 100).toFixed(1)}%`} />
              <Row label="Drivability" value={classifyCell(selected, drivabilityOptions)} />
              <Row label="Terrain complexity" value={Number.isFinite(selected.terrain_complexity) ? selected.terrain_complexity.toFixed(2) : 'Unavailable'} />
              <Row label="Notebook score" value={selected.traversability.toFixed(2)} /></div>}
            <div className="map-hint">{cells.length ? 'DRAG TO ORBIT · SCROLL TO ZOOM · CLICK TO INSPECT' : 'No labeled cells. All input points were unlabeled.'}</div>
          </div>
          <div className="scene-footnote"><span className="status-dot" />{mode === 'drivability'
            ? `${drivabilityOptions.profile} profile · exact cells · gray areas have no LiDAR data`
            : representation === 'blocks'
            ? 'Aggregated display blocks · vehicle silhouettes inferred from semantic clusters'
            : 'Original cell footprints and elevations · no object silhouettes'}</div></>}
          {spatialWindow && ego && <div className="ego-key"><i />Cyan car = our vehicle<span>Sensor origin · +X forward</span></div>}
        </Panel>
        <aside className="sidebar">
          <Panel index={4} title="System Metrics" className="metrics-panel" {...promotion(4)}>
            <div className="metric-group"><h3><i /> INPUT / LiDAR</h3>
              <Row label="Input points" value={number(meta.total_input_points)} />
              <Row label="Displayed points" value={number(meta.exported_points)} />
              <Row label="Source" value={uploaded ? 'Uploaded scan' : 'Recorded sequence'} /></div>
            <div className="metric-group"><h3><i /> SEMANTIC MODEL</h3>
              <Row label="Method" value={uploaded ? (meta.inference_ms == null ? 'Provided labels' : 'SalsaNext + KNN') : 'Recorded labels'} />
              <Row label="Inference time" value={ms(meta.inference_ms)} /><Row label="Semantic classes" value="19 + unlabeled" /></div>
            <div className="metric-group"><h3><i /> ADAPTIVE GRID ENGINE</h3>
              <Row label="Processing time" value={ms(meta.grid_ms)} />
              <Row label="Final cells" value={number(cells.length)} />
              <Row label="Point-to-cell reduction" value={`${reduction.toFixed(2)}%`} />
              <Row label="Input point retention" value={`${retention.toFixed(2)}%`} />
              <Row label="Engine" value={uploaded ? (uploaded.frameUrl ? 'Grid Engine (NumPy, CPU)' : 'Notebook v2 / CPU') : 'Recorded output'} /></div>
            <div className="metric-group total"><h3><i /> TOTAL SYSTEM</h3>
              <Row label="End-to-end time" value={ms(meta.total_ms)} />
              <Row label="Status" value={loading ? 'Loading frame...' : 'Ready to explore'} /></div>
          </Panel>
          <Panel index={5} title="Layer Controls" className="layers-panel" {...promotion(5)}>
            <label className="field-label" htmlFor="color-layer">Map color</label>
            <select id="color-layer" value={mode} onChange={e => setMode(e.target.value)}>
              <option value="semantic">Semantic class colors</option><option value="elevation">Elevation / height</option>
              <option value="drivability">Drivability / vehicle profile</option><option value="resolution">Cell resolution</option><option value="density">Point density</option></select>
            <label className="checkbox"><input type="checkbox" checked={elevated} onChange={e => setElevated(e.target.checked)} /> Elevation (2.5D columns)</label>
            <label className="checkbox"><input type="checkbox" checked={boundaries} onChange={e => setBoundaries(e.target.checked)} /> Show cell boundaries</label>
            <label className="checkbox"><input type="checkbox" checked={showEgo} onChange={e => setShowEgo(e.target.checked)} /> Show our car (cyan ego marker)</label>
            <div className="control-divider" />
            <label className="field-label" htmlFor="scene-extent">Shared view extent</label>
            <select id="scene-extent" value={detail ? 'detail' : 'full'} onChange={e => { setDetail(e.target.value === 'detail'); setSelected(null) }}>
              <option value="detail">Detail view · central 60 m</option>
              <option value="full">Full scan · all points and cells</option>
            </select>
            <label className="point-size-label" htmlFor="point-size"><span>Point size</span><b>{pointSize.toFixed(1)} px</b></label>
            <input id="point-size" className="point-size-slider" type="range" min="1" max="4" step=".2"
              value={pointSize} onChange={e => setPointSize(Number(e.target.value))} />
            <div className="control-divider" />
            <label className="field-label" htmlFor="vehicle-profile">Drivability profile</label>
            <select id="vehicle-profile" value={drivabilityOptions.profile}
              onChange={e => setDrivabilityOptions(previous => ({ ...previous, profile: e.target.value }))}>
              <option value="on-road">On-road</option><option value="off-road">Off-road</option>
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
            <div className="drivability-area" aria-label="Observed area by drivability">
              {Object.entries(drivabilityArea).map(([state, area]) => <Row key={state} label={state} value={`${area.toFixed(1)} m²`} />)}
            </div>
            <p className="layer-note">Areas cover all observed cells. Empty space is unknown and excluded. Profile changes apply instantly.</p>
            <p className="layer-note">Class filters affect semantic views. Drivability always shows all observed cells.</p>
          </Panel>
          <Panel index={9} title="Resolution Distribution" className="distribution-panel" {...promotion(9)}>
            <div className="distribution"><div className="donut" style={{ background: donut ? `conic-gradient(${donut})` : '#183047' }}><div><b>{number(cells.length)}</b><span>cells</span></div></div>
              <div className="distribution-labels">{distribution.map(([size, count]) => <div key={size}>
                <i style={{ background: layerColor({ resolution: Number(size) }, 'resolution') }} />
                <span>{Number((Number(size) * 100).toFixed(2))} cm</span><b>{(count / cells.length * 100).toFixed(1)}%</b></div>)}</div></div>
          </Panel>
        </aside>
        <div className="mini-maps">
          <Panel index={6} title="Elevation Map" tag="2.5D HEIGHT" {...promotion(6)}>
            <GridView cells={cells} hiddenClasses={hiddenClasses} mode="elevation" boundaries={boundaries} {...{ view, ego }} {...primaryView(6)} />
            <div className="mini-key"><span>{view.low} m</span><i className="spectrum" /><span>{view.high} m</span></div>
          </Panel>
          <Panel index={7} title="Drivability Map" tag={drivabilityOptions.profile.toUpperCase()} {...promotion(7)}>
            <GridView cells={cells} hiddenClasses={EMPTY} mode="drivability" boundaries={boundaries} {...{ view, ego }} {...primaryView(7)} />
            <div className="mini-key">{Object.entries(DRIVABILITY_COLORS).map(([state, color]) =>
              <span className="resolution-key" key={state}><i style={{ background: color }} />{state}</span>)}</div>
          </Panel>
          <Panel index={8} title="Adaptive Resolution" {...promotion(8)}>
            <GridView cells={cells} hiddenClasses={hiddenClasses} mode="resolution" boundaries={boundaries} {...{ view, ego }} {...primaryView(8)} />
            <div className="mini-key">{distribution.map(([size]) => <span className="resolution-key" key={size}>
              <i style={{ background: layerColor({ resolution: Number(size) }, 'resolution') }} />{Number((Number(size) * 100).toFixed(2))} cm</span>)}</div>
          </Panel>
        </div>
      </div>}

    <footer className="playback"><span className="playback-label">FRAME PLAYBACK</span>
      <div className="playback-buttons"><button aria-label="Previous frame" disabled={!dataset || !!uploaded} onClick={() => step(-1)}>⏮</button>
        <button className="primary play-button" aria-label={playing ? 'Pause playback' : 'Play sequence'} disabled={!dataset || !!uploaded}
          onClick={() => setPlaying(v => !v)}>{playing ? 'Ⅱ' : '▶'}</button>
        <button aria-label="Next frame" disabled={!dataset || !!uploaded} onClick={() => step(1)}>⏭</button></div>
      <input type="range" aria-label="Frame" min="0" max={Math.max(0, (dataset?.frameIds.length ?? 1) - 1)} value={frameIndex}
        disabled={!dataset || !!uploaded} onChange={e => { setPlaying(false); setFrameIndex(Number(e.target.value)) }} />
      <span className="frame-counter">{uploaded ? 'Single scan' : `${frameIndex + 1} / ${number(dataset?.frameIds.length)}`}</span>
      <select aria-label="Playback speed" value={speed} onChange={e => setSpeed(Number(e.target.value))} disabled={!!uploaded}>
        <option value={0.5}>0.5× speed</option><option value={1}>1× speed</option><option value={2}>2× speed</option></select>
      <button disabled={!frame || loading || !spatialWindow} onClick={captureView}>Capture view</button>
      <button disabled={!frame} onClick={() => downloadJSON(frame, drivabilityOptions)}>↓ Export map</button>
      {uploaded?.frameUrl ? <a className="button-link" href={uploaded.frameUrl} download>↓ Download frame (.lgf.gz)</a>
        : uploaded && BACKEND === 'api' && <a className="button-link" href={apiUrl(`/jobs/${uploaded.jobId}/download`)}>↓ Download NPZ</a>}
    </footer>
    <div className="bottom-note"><span>LiDAR-X <b>/</b> SPATIAL INTELLIGENCE WORKSPACE</span><span>Coordinates in metres · Z is up · {uploaded ? 'Adaptive grid: 5 / 10 / 20 / 40 cm' : 'Recorded dataset resolutions'}</span></div>
    {uploadOpen && <Upload onComplete={acceptUpload} onClose={() => setUploadOpen(false)} />}
  </main>
}
