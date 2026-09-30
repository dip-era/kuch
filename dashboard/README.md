# PointMatrix Frontend

React, Three.js, and Canvas views for recorded and uploaded LiDAR scans.

```bash
npm ci
npm run dev
```

By default (`.env.production`, `.env.example`) the app uses:

```bash
VITE_FRAME_MANIFEST_URL=https://huggingface.co/datasets/ranbyDipz/sih-lidar-clip/resolve/main/manifest.json
VITE_HF_SPACE=ranbyDipz/point-matrix-hub
```

Uploads go straight to the Hugging Face Space via `@gradio/client` (`src/hfSpace.js`);
the result is an LGF1 frame decoded by `src/lgf.js`. To use the FastAPI backup in
`../backend` instead, clear `VITE_HF_SPACE` (Vite proxies `/api` to port 8000 in dev)
or set `VITE_API_BASE_URL`. `npm test` runs the unit tests; `npm run build` produces `dist`.
See the root README for Vercel deployment, input formats, and exports.
