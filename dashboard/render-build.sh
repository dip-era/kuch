#!/usr/bin/env bash
set -euo pipefail

# Recorded frames now come from the Hugging Face clip (VITE_FRAME_MANIFEST_URL),
# so no Git LFS assets are pulled here.
npm ci
# This build is served by the FastAPI backend, so uploads use its /api.
VITE_HF_SPACE= npm run build
