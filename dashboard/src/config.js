const trimTrailingSlash = (value) => value.replace(/\/+$/, '')
const env = import.meta.env ?? {}

// Recorded sequence: the precomputed LGF1 clip on Hugging Face (frames 001500-002499).
export const DEFAULT_FRAME_MANIFEST_URL =
  'https://huggingface.co/datasets/ranbyDipz/sih-lidar-clip/resolve/main/manifest.json'
export const FRAME_MANIFEST_URL = (env.VITE_FRAME_MANIFEST_URL || DEFAULT_FRAME_MANIFEST_URL).trim()

// Uploads: the Hugging Face Space (VITE_HF_SPACE, e.g. "ranbyDipz/point-matrix-hub") is the
// primary backend. Without it, the optional FastAPI backend in backend/ is used via VITE_API_BASE_URL.
export const HF_SPACE = (env.VITE_HF_SPACE ?? '').trim()
const apiBase = (env.VITE_API_BASE_URL ?? (HF_SPACE ? '' : '/api')).trim()
export const API_BASE_URL = apiBase ? trimTrailingSlash(apiBase) : ''
export const BACKEND = HF_SPACE ? 'hf' : API_BASE_URL ? 'api' : null
export const UPLOADS_ENABLED = Boolean(BACKEND)

export function apiUrl(path) {
  if (!API_BASE_URL) throw new Error('The FastAPI backend is not configured for this deployment.')
  return `${API_BASE_URL}${path.startsWith('/') ? path : `/${path}`}`
}
