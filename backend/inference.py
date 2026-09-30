"""SalsaNext inference using the notebook's projection and KNN pipeline."""

import importlib.util
import os
from pathlib import Path

import numpy as np

from .notebook import ROOT, load_projection

MODEL_DIR = Path(os.environ.get("SALSANEXT_MODEL_DIR", ROOT / "models"))
REPO = Path(os.environ.get("SALSANEXT_REPO", ROOT / "models" / "SalsaNext"))
WEIGHTS = Path(os.environ.get("SALSANEXT_WEIGHTS", MODEL_DIR / "pretrained" / "model.pt"))


def availability():
    missing = []
    if not WEIGHTS.is_file():
        missing.append("SalsaNext pretrained checkpoint")
    if not (REPO / "train/tasks/semantic/modules/SalsaNext.py").is_file():
        missing.append("SalsaNext model source")
    if importlib.util.find_spec("torch") is None:
        missing.append("PyTorch")
    return {"ready": not missing, "missing": missing}


class Segmenter:
    def __init__(self):
        import torch
        import yaml

        self.torch = torch
        # CPU preserves the reference path on machines without NVIDIA CUDA.
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        torch.set_num_threads(min(4, os.cpu_count() or 1))
        source = (REPO / "train/tasks/semantic/modules/SalsaNext.py").read_text()
        source = source.replace("import imp", "").replace("import __init__ as booger", "")
        scope = {"__name__": "_salsanext_model"}
        exec(compile(source, "SalsaNext.py", "exec"), scope)
        self.model = scope["SalsaNext"](20)
        checkpoint = torch.load(WEIGHTS, map_location="cpu", weights_only=True)
        state = checkpoint.get("state_dict", checkpoint)
        self.model.load_state_dict({key.removeprefix("module."): value for key, value in state.items()})
        self.model.to(self.device).eval()
        sensor = dict(height=64, width=2048, fov_up=3.0, fov_down=-25.0,
                      img_means=[12.12, 10.88, 0.23, -1.04, 0.21],
                      img_stds=[12.32, 11.47, 6.91, 0.86, 0.16])
        params = dict(knn=5, search=5, sigma=1.0, cutoff=1.0)
        config = WEIGHTS.parent / "arch_cfg.yaml"
        if config.is_file():
            arch = yaml.safe_load(config.read_text())
            settings = arch["dataset"]["sensor"]
            sensor.update(height=settings["img_prop"]["height"], width=settings["img_prop"]["width"],
                          **{key: settings[key] for key in ("fov_up", "fov_down", "img_means", "img_stds")})
            params.update(arch.get("post", {}).get("KNN", {}).get("params", {}))
        scope = dict(torch=torch, np=np, SENSOR=sensor,
                     MEANS=torch.tensor(sensor["img_means"], device=self.device).view(5, 1),
                     STDS=torch.tensor(sensor["img_stds"], device=self.device).view(5, 1))
        self.project = load_projection(scope)
        knn_scope = {"__name__": "_salsanext_knn"}
        knn_source = (REPO / "train/tasks/semantic/postproc/KNN.py").read_text()
        exec(compile(knn_source, "KNN.py", "exec"), knn_scope)
        self.knn = knn_scope["KNN"](params, 20).to(self.device)

    def predict(self, scan):
        torch = self.torch
        with torch.inference_mode():
            points = torch.from_numpy(np.array(scan, dtype=np.float32, copy=True)).to(self.device)
            image, ranges, px, py, depth = self.project(points)
            probs = self.model(image)[0].float()
            labels = self.knn(ranges, depth, probs.argmax(0), px, py)
            confidence = probs[labels, py, px]
            return labels.cpu().numpy(), confidence.cpu().numpy(), self.device
