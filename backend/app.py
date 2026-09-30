import io
import logging
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor

import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles

from .inference import Segmenter, availability
from .notebook import ROOT, load_grid

app = FastAPI(title="LiDAR-X processing service")
jobs = {}
lock = threading.Lock()
worker = ThreadPoolExecutor(max_workers=1)
segmenter = None
MAX_BYTES = 32 * 1024 * 1024
MAX_POINTS = 500_000
MAX_JOBS = 4


def parse_scan(content, filename, layout):
    if filename.lower().endswith(".bin"):
        if len(content) % 16:
            raise ValueError("KITTI .bin files must contain float32 rows of x, y, z, intensity.")
        array = np.frombuffer(content, dtype="<f4").reshape(-1, 4)
        if layout != "raw":
            raise ValueError(".bin uploads use raw XYZI format. Choose Raw XYZI.")
    elif filename.lower().endswith(".npy"):
        stream = io.BytesIO(content)
        version = np.lib.format.read_magic(stream)
        if version == (1, 0):
            shape, _, dtype = np.lib.format.read_array_header_1_0(stream)
        elif version == (2, 0):
            shape, _, dtype = np.lib.format.read_array_header_2_0(stream)
        else:
            raise ValueError("Use a numeric NumPy v1 or v2 .npy file.")
        # Validate the header before np.load can allocate from untrusted dimensions.
        if len(shape) != 2 or not 0 < shape[0] <= MAX_POINTS or not 4 <= shape[1] <= 6:
            raise ValueError("Expected 1 to 500,000 points with 4, 5, or 6 columns.")
        if dtype.kind not in "fiu" or dtype.hasobject:
            raise ValueError("Point clouds must contain numeric values, not Python objects.")
        expected = shape[0] * shape[1] * dtype.itemsize
        if expected != len(content) - stream.tell():
            raise ValueError("NumPy data size does not match its header.")
        stream.seek(0)
        array = np.load(stream, allow_pickle=False)
    else:
        raise ValueError("Choose a KITTI .bin or numeric .npy file.")
    columns = (4, 6) if layout == "legacy" else (4,) if layout == "raw" else (5,)
    if array.ndim != 2 or array.shape[1] not in columns or array.dtype.kind not in "fiu":
        raise ValueError(f"This format requires a numeric array with {' or '.join(map(str, columns))} columns.")
    if not 0 < len(array) <= MAX_POINTS:
        raise ValueError(f"Upload between 1 and {MAX_POINTS:,} points.")
    coordinates = array[:, :3]
    if not np.isfinite(array).all() or (coordinates > 10_000).any() or (coordinates < -10_000).any():
        raise ValueError("Coordinates must be finite and within 10 km of the sensor.")
    if (array > np.finfo(np.float32).max).any() or (array < -np.finfo(np.float32).max).any():
        raise ValueError("Point values must fit in float32.")
    if layout != "raw":
        labels = array[:, 3 if layout == "legacy" else 4]
        low, high = (0, 18) if layout == "legacy" else (0, 19)
        if (labels != np.floor(labels)).any() or (labels < low).any() or (labels > high).any():
            raise ValueError(f"Class IDs must be integers from {low} to {high}.")
    return array.astype(np.float32)


def update(job_id, **values):
    with lock:
        jobs[job_id].update(values)


def process(job_id, scan, layout):
    global segmenter
    start = time.perf_counter()
    try:
        if layout == "raw":
            update(job_id, stage="Running SalsaNext segmentation", progress=20)
            if segmenter is None:
                segmenter = Segmenter()
            labels, confidence, device = segmenter.predict(scan)
            method = f"SalsaNext + KNN ({device})"
        else:
            labels = scan[:, 3].astype(np.int64) + 1 if layout == "legacy" else scan[:, 4].astype(np.int64)
            confidence = np.ones(len(scan))
            method = "Provided semantic labels"
        inference_ms = (time.perf_counter() - start) * 1000
        update(job_id, stage="Building adaptive 2.5D grid", progress=65)
        reference = load_grid()
        grid_start = time.perf_counter()
        matrix, stats, bounds = reference.run_reference(scan[:, :3], labels, confidence)
        structured = reference.to_structured(matrix)
        grid_ms = (time.perf_counter() - grid_start) * 1000
        # Normalize to the existing dashboard's 0..18 convention; -1 is unlabeled.
        grid = []
        for row in structured:
            cell = {name: row[name].item() for name in structured.dtype.names}
            cell["semantic_class"] -= 1
            grid.append(cell)
        sample = np.linspace(0, len(scan) - 1, min(30_000, len(scan)), dtype=int)
        points = np.column_stack((scan[sample, :3], labels[sample] - 1)).astype("<f4")
        sizes, counts = np.unique(structured["resolution"], return_counts=True)
        meta = dict(frame_id=job_id, total_input_points=len(scan), exported_points=len(sample),
                    total_cells=len(grid), resolution_distribution={str(s): int(c) for s, c in zip(sizes, counts)},
                    inference_ms=inference_ms if layout == "raw" else None,
                    grid_ms=grid_ms, total_ms=(time.perf_counter() - start) * 1000,
                    method=method, notebook=reference.__name__, **stats)
        archive = io.BytesIO()
        np.savez_compressed(archive, final_cells=structured, points=scan[:, :3], labels=labels,
                            confidence=confidence, bounds=np.asarray(bounds if bounds is not None else []))
        update(job_id, status="complete", stage="Processing complete", progress=100,
               result={"grid": grid, "points": points.ravel().tolist(), "meta": meta},
               archive=archive.getvalue())
    except Exception:
        logging.exception("Processing failed for %s", job_id)
        update(job_id, status="failed", stage="Processing failed",
               error="Processing failed. Check the server log and model configuration, then retry.")


@app.get("/api/health")
def health():
    return {"status": "online", "model": availability(), "grid": "Notebook v2 / NumPy CPU",
            "max_bytes": MAX_BYTES, "max_points": MAX_POINTS}


@app.post("/api/jobs", status_code=202)
async def upload(file: UploadFile = File(...), layout: str = Form("raw")):
    if layout not in ("raw", "legacy", "labeled"):
        raise HTTPException(422, "Unknown point layout.")
    # Reserve capacity before reading a potentially large upload.
    with lock:
        busy = sum(job["status"] in ("uploading", "processing") for job in jobs.values())
        if busy >= 2:
            raise HTTPException(429, "The processing queue is full. Please try again shortly.")
        while len(jobs) >= MAX_JOBS:
            finished = next((key for key, job in jobs.items() if job["status"] in ("complete", "failed")), None)
            if finished is None:
                break
            del jobs[finished]
        job_id = uuid.uuid4().hex
        jobs[job_id] = dict(id=job_id, filename=(file.filename or "scan")[:160], status="uploading",
                            progress=0, stage="Validating upload")
    try:
        content = await file.read(MAX_BYTES + 1)
        if len(content) > MAX_BYTES:
            raise HTTPException(413, "File exceeds the 32 MB upload limit.")
        try:
            scan = parse_scan(content, file.filename or "", layout)
        except (ValueError, OSError, EOFError) as error:
            raise HTTPException(422, str(error)) from error
        if layout == "raw" and not availability()["ready"]:
            raise HTTPException(503, "Raw segmentation requires the SalsaNext checkpoint and model source. "
                                "Configure SALSANEXT_WEIGHTS and SALSANEXT_REPO on the server, "
                                "or upload a point cloud with semantic labels.")
        update(job_id, status="processing", stage="Queued for processing", progress=5)
        worker.submit(process, job_id, scan, layout)
        return {"id": job_id}
    except Exception:
        with lock:
            jobs.pop(job_id, None)
        raise
    finally:
        await file.close()


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str):
    with lock:
        job = jobs.get(job_id)
        if job is None:
            raise HTTPException(404, "This processing job has expired. Upload the file again.")
        return {key: value for key, value in job.items() if key not in ("result", "archive")}


@app.get("/api/jobs/{job_id}/result")
def get_result(job_id: str):
    with lock:
        job = jobs.get(job_id)
        if not job or job["status"] != "complete":
            raise HTTPException(404, "Result is not available.")
        return job["result"]


@app.get("/api/jobs/{job_id}/download")
def download(job_id: str):
    with lock:
        job = jobs.get(job_id)
        if not job or job["status"] != "complete":
            raise HTTPException(404, "Result is not available.")
        return Response(job["archive"], media_type="application/octet-stream",
                        headers={"Content-Disposition": f'attachment; filename="lidar-{job_id[:8]}.npz"'})


if (ROOT / "dashboard/dist").is_dir():
    app.mount("/", StaticFiles(directory=ROOT / "dashboard/dist", html=True), name="dashboard")
