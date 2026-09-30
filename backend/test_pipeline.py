import io
import time
import unittest
from unittest.mock import patch

import numpy as np
from fastapi.testclient import TestClient

from .app import app, jobs, lock, parse_scan
from .notebook import load_grid


def npy_bytes(array):
    output = io.BytesIO()
    np.save(output, array)
    return output.getvalue()


class UploadTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)
        with lock:
            jobs.clear()

    def upload(self, array, layout="labeled"):
        return self.client.post("/api/jobs", data={"layout": layout},
                                files={"file": ("scan.npy", npy_bytes(array), "application/octet-stream")})

    def await_result(self, job_id):
        for _ in range(150):
            job = self.client.get(f"/api/jobs/{job_id}").json()
            if job["status"] in ("complete", "failed"):
                self.assertEqual(job["status"], "complete", job)
                return self.client.get(f"/api/jobs/{job_id}/result").json()
            time.sleep(0.05)
        self.fail("Job did not complete")

    def test_notebook_outputs_and_export(self):
        scan = np.array([[1, 2, 0, .5, 1], [1.01, 2.01, .1, .5, 1],
                         [35, 0, -.8, .2, 9], [0, 0, 0, 0, 0]], dtype=np.float32)
        response = self.upload(scan)
        self.assertEqual(response.status_code, 202, response.text)
        job_id = response.json()["id"]
        result = self.await_result(job_id)
        self.assertEqual(result["meta"]["total_input_points"], 4)
        self.assertEqual(result["meta"]["n_unlabeled_dropped"], 1)
        self.assertEqual(sum(cell["point_count"] for cell in result["grid"]), 3)
        self.assertTrue(all(0 <= cell["terrain_complexity"] <= 1 for cell in result["grid"]))
        self.assertEqual({cell["semantic_class"] for cell in result["grid"]}, {0, 8})
        export = self.client.get(f"/api/jobs/{job_id}/download")
        with np.load(io.BytesIO(export.content), allow_pickle=False) as archive:
            expected, _, _ = load_grid().run_reference(scan[:, :3], scan[:, 4], np.ones(len(scan)))
            np.testing.assert_array_equal(archive["final_cells"], load_grid().to_structured(expected))
            np.testing.assert_array_equal(archive["labels"], scan[:, 4])

    def test_legacy_six_column_input_preserves_class_zero(self):
        response = self.upload(np.array([[1, 2, 3, 0, .8, .5]], dtype=np.float32), "legacy")
        result = self.await_result(response.json()["id"])
        self.assertEqual(result["grid"][0]["semantic_class"], 0)
        self.assertEqual(result["meta"]["n_unlabeled_dropped"], 0)

    def test_all_unlabeled_is_valid_empty_grid(self):
        response = self.upload(np.zeros((2, 5), dtype=np.float32))
        result = self.await_result(response.json()["id"])
        self.assertEqual(result["grid"], [])
        self.assertEqual(result["meta"]["n_points_used"], 0)

    def test_rejects_invalid_inputs(self):
        cases = [np.zeros((0, 5)), np.zeros((2, 4)), np.array([[0, 0, np.nan, 0, 1]]),
                 np.array([[0, 0, 0, 0, 20]]), np.array([[0, 0, 0, 0, 1.000000001]]),
                 np.array([["unsafe"]], dtype=object)]
        for scan in cases:
            with self.subTest(scan=scan):
                self.assertEqual(self.upload(scan).status_code, 422)
        with self.assertRaises(ValueError):
            parse_scan(b"invalid", "scan.bin", "raw")

    def test_missing_model_returns_actionable_error(self):
        with patch("backend.app.availability", return_value={"ready": False}):
            response = self.upload(np.ones((3, 4)), "raw")
            self.assertEqual(response.status_code, 503)
            self.assertIn("SALSANEXT_WEIGHTS", response.json()["detail"])

    def test_raw_binary_runs_segmentation_and_exports_predictions(self):
        scan = np.array([[1, 2, 0, .5], [1.01, 2.01, .1, .6], [0, 0, 0, 0]], dtype="<f4")
        labels = np.array([1, 1, 0])
        confidence = np.array([.9, .8, .1], dtype=np.float32)
        with patch("backend.app.availability", return_value={"ready": True}), \
                patch("backend.app.segmenter") as model:
            model.predict.return_value = (labels, confidence, "cpu")
            response = self.client.post("/api/jobs", data={"layout": "raw"},
                                        files={"file": ("scan.bin", scan.tobytes(), "application/octet-stream")})
            self.assertEqual(response.status_code, 202, response.text)
            job_id = response.json()["id"]
            result = self.await_result(job_id)
            model.predict.assert_called_once()
            np.testing.assert_array_equal(model.predict.call_args.args[0], scan)
            self.assertEqual(result["meta"]["method"], "SalsaNext + KNN (cpu)")
            self.assertIsNotNone(result["meta"]["inference_ms"])
            self.assertEqual(result["meta"]["n_unlabeled_dropped"], 1)
            self.assertEqual(sum(cell["point_count"] for cell in result["grid"]), 2)
            export = self.client.get(f"/api/jobs/{job_id}/download")
            with np.load(io.BytesIO(export.content), allow_pickle=False) as archive:
                np.testing.assert_array_equal(archive["labels"], labels)
                np.testing.assert_array_equal(archive["confidence"], confidence)
                np.testing.assert_array_equal(archive["points"], scan[:, :3])

    def test_rejects_integer_coordinate_overflow(self):
        scan = np.array([[np.iinfo(np.int64).min, 0, 0, 0]], dtype=np.int64)
        with self.assertRaisesRegex(ValueError, "within 10 km"):
            parse_scan(npy_bytes(scan), "scan.npy", "raw")

    def test_unknown_job(self):
        for path in ("", "/result", "/download"):
            self.assertEqual(self.client.get(f"/api/jobs/not-a-job{path}").status_code, 404)

    def test_rejects_oversized_numpy_header_before_allocation(self):
        stream = io.BytesIO()
        np.lib.format.write_array_header_1_0(
            stream, {"descr": "<f4", "fortran_order": False, "shape": (10**12, 4)})
        with self.assertRaises(ValueError):
            parse_scan(stream.getvalue(), "scan.npy", "raw")


if __name__ == "__main__":
    unittest.main()
