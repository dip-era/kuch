// Live uploads through the Hugging Face Space (Gradio API): /ping wakes it, /infer runs
// SalsaNext + the grid engine on one scan and returns an LGF1 frame (.lgf.gz).
import { Client, handle_file } from '@gradio/client'
import { HF_SPACE } from './config'
import { liveFrameMeta, loadLGFFrame, normalizeLGFFrame } from './lgf'

const DISPLAY_POINTS = 30_000         // points drawn in the browser; the grid uses every point
let clientPromise = null

const SPACE_MESSAGES = {
  sleeping: 'Processing service is asleep. Waking it up (can take a minute)...',
  starting: 'Processing service is starting...',
  building: 'Processing service is being updated. Try again in a few minutes.',
  stopped: 'Processing service is stopped.',
  paused: 'Processing service is paused by its owner.',
  space_error: 'Processing service failed to start.',
}

/** Connect once and reuse. onStatus receives { state, message } while the Space wakes up. */
export function connectSpace(onStatus) {
  if (!clientPromise) {
    clientPromise = Client.connect(HF_SPACE, {
      record_history: false,          // don't copy scans into browser storage
      events: ['data', 'status'],     // queue / processing updates for the progress bar
      status_callback: (s) => {
        if (s.status !== 'running') onStatus?.({ state: s.status, message: SPACE_MESSAGES[s.status] ?? s.message })
      },
    }).catch((error) => { clientPromise = null; throw error })
  }
  return clientPromise
}

/** Health check for the upload dialog: resolves when the Space answers /ping. */
export async function spaceHealth(onStatus) {
  const client = await connectSpace(onStatus)
  await client.predict('/ping', {})
  return { status: 'online', model: { ready: true }, backend: 'hf', space: HF_SPACE }
}

/**
 * Run the pipeline on one uploaded file.
 * layout: 'raw' (.bin / .npy N x 4, SalsaNext labels it) or 'labeled' (.npy N x 5, classes 0-19).
 * onProgress receives { stage, progress } for the progress bar. Returns the dashboard frame.
 */
export async function inferScan(file, layout, onProgress, signal) {
  onProgress?.({ stage: 'Connecting to the processing service', progress: 5 })
  const client = await connectSpace(({ message }) => onProgress?.({ stage: message, progress: 5 }))
  const data = { scan_file: handle_file(file) }
  if (layout && layout !== 'raw') data.layout = layout
  const job = client.submit('/infer', data)
  const abort = () => { job.cancel() }
  signal?.addEventListener('abort', abort, { once: true })
  try {
    for await (const message of job) {
      if (message.type === 'status') {
        if (message.stage === 'error') {
          const text = typeof message.message === 'string' ? message.message : 'The processing service returned an error.'
          throw new Error(text)
        }
        if (message.stage === 'pending') {
          const queued = message.position ? ` (position ${message.position + 1} in queue)` : ''
          onProgress?.({ stage: `Uploaded · waiting for the GPU${queued}`, progress: 20 })
        } else if (message.stage === 'generating' || message.stage === 'streaming') {
          onProgress?.({ stage: layout === 'labeled' ? 'Building the adaptive 2.5D grid'
            : 'Running SalsaNext and the grid engine', progress: 55 })
        }
      } else if (message.type === 'data') {
        const [frameFile, summary] = message.data
        if (!frameFile?.url) throw new Error('The processing service returned no frame.')
        onProgress?.({ stage: 'Downloading the result', progress: 85 })
        const decoded = await loadLGFFrame(frameFile.url, { signal })
        const frame = normalizeLGFFrame(decoded, {
          maxPoints: DISPLAY_POINTS,
          meta: { ...liveFrameMeta(summary), frame_id: summary?.frame ?? decoded.header.frame_id },
        })
        onProgress?.({ stage: 'Processing complete', progress: 100 })
        return { ...frame, summary, frameUrl: frameFile.url }
      }
    }
    throw new Error('The processing service closed the connection before returning a result.')
  } finally {
    signal?.removeEventListener('abort', abort)
  }
}
