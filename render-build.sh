#!/usr/bin/env bash
set -euo pipefail

# CPU wheels avoid installing the CUDA toolkit on a CPU web service.
python -m pip install 'torch>=2.6,<3' --index-url https://download.pytorch.org/whl/cpu
python -m pip install -r requirements.txt
python -m backend.setup_model
cd dashboard
bash render-build.sh
