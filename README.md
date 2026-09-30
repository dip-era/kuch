# PointMatrix

Nine synchronized LiDAR views of a semantic 2.5D map.

| Part | Where it runs |
| --- | --- |
| Website (this repo, `dashboard/`) | Vercel, static |
| Recorded sequence (frames 001500–002499, LGF1) | Hugging Face dataset [`ranbyDipz/sih-lidar-clip`](https://huggingface.co/datasets/ranbyDipz/sih-lidar-clip) |
| Uploads (SalsaNext + adaptive grid) | Hugging Face ZeroGPU Space [`ranbyDipz/point-matrix-hub`](https://huggingface.co/spaces/ranbyDipz/point-matrix-hub) |
| Backup upload backend | FastAPI in `backend/` (Render or local), used only when `VITE_HF_SPACE` is empty |

The browser talks to the Space directly through [`@gradio/client`](https://www.gradio.app/guides/getting-started-with-the-js-client)
(`dashboard/src/hfSpace.js`). No server of our own is needed for the live site.

## Deploy on Vercel

1. Import the repository in Vercel. Keep the root directory as the repo root; `vercel.json`
   already sets the install/build commands and `dashboard/dist` as the output.
2. No environment variables are required: `dashboard/.env.production` sets
   `VITE_FRAME_MANIFEST_URL` (the HF clip) and `VITE_HF_SPACE` (the Space).
   Variables set in the Vercel project override those values at build time.
3. Deploy. `VITE_*` values are baked in at build time, so redeploy after changing them.

The first upload after a quiet period is slower while the Space's GPU starts; the
upload dialog shows the queue and wake-up state. Upload/download time depends on the
visitor's network (a KITTI scan is ~2 MB up, ~1 MB result down).

Local development against the same backends:

```bash
npm --prefix dashboard ci
npm --prefix dashboard run dev
```

`dashboard/.env.example` lists every variable.

## Run the FastAPI backup locally

Python 3.12+ and Node.js 22.12+ are required.

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python -m backend.setup_model
npm --prefix dashboard ci
npm --prefix dashboard run build
python -m uvicorn backend.app:app --host 0.0.0.0 --port 8000
```

Open **http://localhost:8000**. The backend serves both the built website and `/api`.
`dashboard/render-build.sh` builds with `VITE_HF_SPACE` cleared so this build uses `/api`;
for a manual build run `VITE_HF_SPACE= npm --prefix dashboard run build`.
The model has already been installed in this workspace under `models/`.

For frontend development against this backend, keep it running and use
`VITE_HF_SPACE= npm --prefix dashboard run dev`. Vite proxies `/api` to port 8000.

`VITE_FRAME_MANIFEST_URL` can point at either the older per-frame `manifest.json` format or
the Hugging Face `LGF1-clip` manifest. If neither `VITE_HF_SPACE` nor `VITE_API_BASE_URL`
is set, the dataset explorer works but uploads are disabled.

## Upload formats

| Mode | File | Columns | Labels |
| --- | --- | --- | --- |
| Raw | `.bin` or `.npy` | x, y, z, intensity | Predicted by SalsaNext |
| Notebook v2 labeled | `.npy` | x, y, z, intensity, class | 0 = unlabeled; 1-19 = classes |
| Existing labeled dataset | `.npy` | x, y, z, class; optionally two extra columns | 0-18; 0 = car (FastAPI backup only) |

The HF Space accepts the first two modes; the legacy 0–18 mode is hidden when
uploads go to the Space. Binary input uses little-endian float32 KITTI XYZI records. All coordinates are metres.
Limits: 32 MB, 500,000 points, finite coordinates within 10 km. Pickled/object arrays
are rejected. Extra columns in legacy six-column files are ignored; provided labels
use unit confidence.

Raw uploads use the notebook's range projection, the official SalsaNext checkpoint,
and KNN post-processing. The adaptive grid runs the notebook's **unmodified NumPy
reference implementation** with its 5/10/20/40 cm levels. CUDA is used for model
inference when available; otherwise CPU. The notebook's CUDA grid extension,
Kaggle setup cells, benchmarks, and plots are not executed by the web service.

The setup script downloads the [official SalsaNext pretrained model](https://github.com/TiagoCortinhal/SalsaNext#pretrained-model),
verifies the archive checksum, pins the source revision, and exports a tensor-only
checkpoint. Models are excluded from Git. To use a different prepared checkpoint,
set `SALSANEXT_WEIGHTS` and `SALSANEXT_REPO`; put `arch_cfg.yaml` beside the checkpoint.
The server only accepts tensor/state-dictionary checkpoints with `weights_only=True`.

## Dashboard and results

The views show raw XYZ geometry colored by height, semantic points, an interactive
2.5D grid, metrics, layer controls, elevation, drivability, resolution, and a
resolution distribution. Use the legend to filter classes, click a 3D cell to
inspect it, and select map colors in Layer Controls. Playback is for the recorded
sequence; a new upload is a single frame.

**Window 3 view** can display any of the nine windows. The selected content moves
into the primary panel; its original panel provides a return button. Spatial
views retain the primary zoom control and PNG capture. Metrics, controls, and
distribution views use the full panel without camera controls.

A cyan **OUR CAR / EGO** symbol identifies the sensor vehicle in all spatial
views, with an arrow along +X (forward). It stays at x=0, y=0 because the supplied
frames are sensor-relative and have no world poses. The scene moves around it
during playback; no world trajectory is inferred. Ground height comes from nearby
ground cells, falling back to -1.73 m for KITTI. The car dimensions are symbolic.
Layer Controls can hide the marker; it does not alter classification, metrics, or
exported cell data. PNG captures include the car geometry, while its HTML badge
is displayed in the interactive 3D views only.

The default **Block scene** aggregates nearby cells into visible architectural
blocks and infers stylized vehicle silhouettes from separated vehicle-class
clusters. Silhouette orientation and dimensions are visual estimates, not object
detection results. Clicking a display block shows a representative original cell.
Choose **Exact cells** for original cell footprints and elevations. Both modes
leave the original grid, metrics, and exports unchanged.

Layer Controls includes a shared central detail crop (up to 60 m), a full-scan
view, and point-size adjustment. Expand any panel from its header; press Escape
to restore it. Elevation colors share a per-frame range across all views, with
the lowest/highest 2% clamped to reduce the effect of outliers.

The browser displays up to 30,000 sampled points for uploads, but **all input points**
enter the pipeline. Recorded frames are the LGF1 "lite" frames from the HF clip (every
4th point, all grid cells) with the timings measured on the Kaggle T4 run. Uploads
show the Space's own timings (SalsaNext on the Space GPU, grid engine in NumPy on CPU),
which are not the CUDA benchmark numbers.
Elevation colors saturate outside the displayed per-frame scale; exact-cell geometry
uses the actual elevation.

Drivability imports `dashbard_timesxript_drivability/drivability.ts` directly.
It combines semantic class, terrain complexity, and confidence, with an on-road
default profile and an off-road option. Default thresholds are 0.5 for caution,
0.8 for blocked terrain, and 0.5 minimum confidence. Layer Controls changes these
live without processing the scan again. The three states are green (drivable),
amber (caution), and red (blocked); gray means no observed cell. Missing complexity
or confidence downgrades otherwise drivable cells to caution. Semantic class IDs
are shifted by +1 when calling the supplied rules. The notebook score is retained
separately, not used as the drivability decision.

Drivability uses exact cell footprints and ignores semantic visibility filters.
Area totals sum observed cell areas over the entire frame, excluding unknown space.
Recorded frames and upload results both include `terrain_complexity`.

Capture View downloads a PNG of the current 2.5D map, including its camera angle
and active color layer. Export Map downloads JSON with grid cells, per-cell
drivability, active profile/thresholds, area totals, and metrics. For Space uploads,
Download frame saves the full LGF1 frame (`.lgf.gz`, every point and cell). With the
FastAPI backup, Download NPZ includes full
XYZ points, original notebook labels (0-19), confidence, bounds, and structured
`final_cells`. Dashboard JSON uses the original dashboard's 0-18 class convention
with -1 for unlabeled. This conversion is intentional.

FastAPI backup: jobs run serially with at most two pending/active jobs. Results are held in memory
for the four most recent jobs and disappear on restart or eviction. Download results
before submitting more jobs. Run exactly one server worker; persistent multi-instance
job storage and user accounts are not implemented.

## Verification

```bash
pip install httpx
python -m unittest backend.test_pipeline -v
npm --prefix dashboard test
npm --prefix dashboard run build
```

Tests cover notebook export parity, point retention, label conversion, empty grids,
raw binary uploads with stubbed model predictions, input validation, missing model
configuration, and expired jobs.

## Render deployment (backup)

`render.yaml` defines a **Python web service**, because uploads require a running
backend. A static-only deployment cannot execute the notebook.

Push the project (including the notebook) to the connected repository, then sync the
Blueprint. The build installs the CPU model and builds the frontend against `/api`
(recorded frames still come from the HF clip; no Git LFS assets are needed). Choose a service with enough memory for PyTorch, full scans,
and cached results; the build does not select or purchase a plan.

The native Python runtime includes Node/npm ([Render runtime documentation](https://render.com/docs/native-runtimes)).
Build/start commands are in the Blueprint. This change prepares deployment; a public
deployment URL must come from the actual Render service after deployment succeeds.
