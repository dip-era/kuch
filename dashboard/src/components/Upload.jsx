import { useEffect, useRef, useState } from 'react'
import { BACKEND, UPLOADS_ENABLED, apiUrl } from '../config'
import { inferScan, spaceHealth } from '../hfSpace'

async function responseJson(response) {
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(typeof body.detail === 'string' ? body.detail : 'The processing service could not complete this request.')
  return body
}

const HF = BACKEND === 'hf'

// Backup path: the FastAPI job API in backend/ (used when VITE_HF_SPACE is not set).
async function runApiJob(file, layout, onProgress, signal) {
  const body = new FormData()
  body.append('file', file); body.append('layout', layout)
  const { id } = await responseJson(await fetch(apiUrl('/jobs'), { method: 'POST', body, signal }))
  while (!signal.aborted) {
    const current = await responseJson(await fetch(apiUrl(`/jobs/${id}`), { signal }))
    onProgress(current)
    if (current.status === 'failed') throw new Error(current.error)
    if (current.status === 'complete') {
      const result = await responseJson(await fetch(apiUrl(`/jobs/${id}/result`), { signal }))
      return { ...result, points: new Float32Array(result.points), jobId: id }
    }
    await new Promise(resolve => setTimeout(resolve, 700))
  }
  throw new DOMException('Aborted', 'AbortError')
}

export default function Upload({ onComplete, onClose }) {
  const [file, setFile] = useState(null)
  const [layout, setLayout] = useState('raw')
  const [health, setHealth] = useState(null)
  const [error, setError] = useState('')
  const [job, setJob] = useState(null)
  const [busy, setBusy] = useState(false)
  const [dragging, setDragging] = useState(false)
  const input = useRef()
  const controller = useRef(null)
  useEffect(() => {
    if (!UPLOADS_ENABLED) {
      setHealth({ status: 'offline', model: { ready: false } })
      return () => {}
    }
    let active = true
    const abort = new AbortController()
    const request = HF
      ? spaceHealth(({ message }) => { if (active) setHealth({ status: 'waking', message }) })
      : fetch(apiUrl('/health'), { signal: abort.signal }).then(responseJson)
    request.then(result => { if (active) setHealth(result) })
      .catch(e => { if (active && e.name !== 'AbortError') setHealth({ status: 'offline' }) })
    return () => { active = false; abort.abort(); controller.current?.abort() }
  }, [])
  const choose = next => {
    setError('')
    if (next && !/\.(bin|npy)$/i.test(next.name)) return setError('Please choose a .bin or .npy point cloud.')
    if (next?.size > 32 * 1024 * 1024) return setError('The maximum upload size is 32 MB.')
    setFile(next)
  }
  const submit = async e => {
    e.preventDefault()
    if (!file || busy) return
    if (layout === 'labeled' && !/\.npy$/i.test(file.name)) return setError('Labeled scans must be .npy files (N × 5).')
    setBusy(true); setError(''); setJob({ progress: 2, stage: 'Uploading point cloud' })
    const abort = new AbortController()
    controller.current = abort
    try {
      const result = HF
        ? await inferScan(file, layout, setJob, abort.signal)
        : await runApiJob(file, layout, setJob, abort.signal)
      onComplete({ ...result, jobId: result.jobId ?? `hf-${Date.now()}`, filename: file.name })
    } catch (e) {
      if (e.name !== 'AbortError') setError(e.message)
    } finally { setBusy(false) }
  }
  const ready = health?.status === 'online'
  const serviceText = !health ? 'Connecting to processing service...'
    : !UPLOADS_ENABLED ? 'Uploads are disabled for this deployment. Set VITE_HF_SPACE (or VITE_API_BASE_URL).'
      : health.status === 'waking' ? health.message
        : health.status === 'offline'
          ? (HF ? 'Processing service is unreachable. Check the Hugging Face Space, then reopen this dialog.'
            : 'Processing service is offline. Start the Python backend to upload scans.')
          : HF ? 'SalsaNext on GPU · Grid engine online (Hugging Face Space)'
            : health.model.ready ? 'SalsaNext ready · Notebook grid engine online'
              : 'Grid engine ready · Raw inference needs the SalsaNext checkpoint'
  const formatHelp = layout === 'raw' ? 'N × 4: x, y, z, intensity. Binary scans use little-endian float32.'
    : layout === 'labeled' ? 'N × 5: x, y, z, intensity, class. Class 0 is unlabeled.'
      : 'N × 4 or N × 6: x, y, z, class, optional extra fields. Class 0 is car. Extra fields are ignored.'
  return <div className="modal-shade" onClick={e => { if (e.target === e.currentTarget && !busy) onClose() }}>
    <section className="upload-modal" role="dialog" aria-modal="true" aria-labelledby="upload-title"
      onKeyDown={e => { if (e.key === 'Escape' && !busy) onClose() }}>
      <div className="modal-heading"><span className="eyebrow">NEW PROCESSING JOB</span>
        <button aria-label="Close upload" onClick={onClose} disabled={busy}>×</button></div>
      <h2 id="upload-title">From raw points to a spatial map.</h2>
      <p>Upload a LiDAR scan. SalsaNext identifies semantic classes, then the grid engine builds an adaptive 2.5D grid.</p>
      <div className={`service-note ${health?.status === 'offline' ? 'warning' : ''}`}>
        <i className={`status-dot ${ready && (HF || health?.model?.ready) ? '' : 'amber'}`} />{serviceText}
      </div>
      <form onSubmit={submit}>
        <label className="field-label" htmlFor="layout">Input format</label>
        <select id="layout" value={layout} onChange={e => setLayout(e.target.value)} disabled={busy}>
          <option value="raw">Raw XYZI · .bin / .npy · SalsaNext inference</option>
          <option value="labeled">Labeled XYZIL · .npy · classes 0–19 (notebook v2)</option>
          {!HF && <option value="legacy">Labeled XYZL · .npy · classes 0–18 (existing dataset)</option>}
        </select>
        <button type="button" className={`drop-zone ${dragging ? 'dragging' : ''}`} disabled={busy}
          onClick={() => input.current.click()}
          onDragOver={e => { e.preventDefault(); setDragging(true) }}
          onDragLeave={() => setDragging(false)}
          onDrop={e => { e.preventDefault(); setDragging(false); if (!busy) choose(e.dataTransfer.files[0]) }}>
          <span className="upload-symbol">↑</span>
          <strong>{file ? file.name : 'Drop a point cloud here'}</strong>
          <span>{file ? `${(file.size / 1024 / 1024).toFixed(2)} MB · Click to replace` : 'or browse files · .bin / .npy · up to 32 MB'}</span>
        </button>
        <input ref={input} type="file" accept=".bin,.npy" hidden onChange={e => choose(e.target.files[0])} />
        <p className="format-help">{formatHelp}{' '}Coordinates in metres. Up to 500,000 points.</p>
        {busy && <div className="job-progress" role="status"><div><span>{job.stage}</span><b>{job.progress}%</b></div>
          <progress max="100" value={job.progress} /><small>{HF
            ? 'The first scan after a quiet period takes longer while the GPU starts. Keep this window open.'
            : 'Inference on CPU can take longer than on GPU. Keep this window open.'}</small></div>}
        {error && <p className="error-message" role="alert">{error}</p>}
        <div className="modal-actions"><button type="button" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="primary" disabled={!file || busy || !ready || (!HF && layout === 'raw' && !health?.model?.ready)}>
            {busy ? 'Processing...' : 'Process point cloud →'}</button></div>
      </form>
    </section>
  </div>
}
