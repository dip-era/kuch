"""Install the pinned official model, then export a tensor-only inference checkpoint."""

import hashlib
import shutil
import subprocess
import tempfile
import urllib.request
import zipfile
from pathlib import Path

from .notebook import ROOT

MODEL_URL = ("https://drive.usercontent.google.com/download?"
             "id=1utfzooTDAlV5M6XGvCE0-L-vbdLe_2rD&export=download&confirm=t")
ARCHIVE_SHA256 = "cfbbb5403f9438ccc1ff0fac6b64c3f5f21a1881e76e4172a45a0e077624e0c5"
REVISION = "7548c124b48f0259cdc40e98dfc3aeeadca6070c"


def main():
    models = ROOT / "models"
    models.mkdir(exist_ok=True)
    repo = models / "SalsaNext"
    if not repo.exists():
        subprocess.run(["git", "clone", "https://github.com/TiagoCortinhal/SalsaNext.git", str(repo)], check=True)
        subprocess.run(["git", "-C", str(repo), "checkout", REVISION], check=True)
    actual = subprocess.check_output(["git", "-C", str(repo), "rev-parse", "HEAD"], text=True).strip()
    if actual != REVISION:
        raise RuntimeError(f"Expected SalsaNext source at {REVISION}; found {actual}.")
    target = models / "pretrained"
    if (target / "model.pt").is_file():
        print("SalsaNext tensor checkpoint is already installed.")
        return
    with tempfile.TemporaryDirectory() as temp:
        archive = Path(temp) / "pretrained.zip"
        print("Downloading the official SalsaNext checkpoint (95 MB)...")
        with urllib.request.urlopen(MODEL_URL, timeout=180) as response, archive.open("wb") as output:
            shutil.copyfileobj(response, output)
        with archive.open("rb") as source:
            digest = hashlib.file_digest(source, "sha256").hexdigest()
        if digest != ARCHIVE_SHA256:
            raise RuntimeError("Checkpoint archive checksum mismatch. No model was loaded.")
        target.mkdir(exist_ok=True)
        with zipfile.ZipFile(archive) as zipped:
            for name in ("SalsaNext", "arch_cfg.yaml", "data_cfg.yaml"):
                with zipped.open(f"pretrained/{name}") as source, (target / name).open("wb") as output:
                    shutil.copyfileobj(source, output)
        import torch
        # Only this checksum-verified official artifact uses the legacy pickle loader.
        # Uploaded point files never pass through torch.load.
        checkpoint = torch.load(target / "SalsaNext", map_location="cpu", weights_only=False)
        torch.save(checkpoint["state_dict"], target / "model.pt")
    print(f"Model installed at {target / 'model.pt'}")


if __name__ == "__main__":
    main()
