#!/usr/bin/env bash
set -euo pipefail
BUCKET="${GOOP_S3_BUCKET:-mathscholar}"
BACKEND="${GOOP_BACKEND_URL:-}"
command -v aws >/dev/null || { echo 'AWS CLI missing: https://aws.amazon.com/cli/'; exit 1; }
aws sts get-caller-identity >/dev/null || { echo 'Configure AWS CLI credentials first (aws configure / AWS SSO).'; exit 1; }
python3 - "$BACKEND" <<'PYTHON'
import sys, pathlib, json
url=sys.argv[1].strip().rstrip('/')
if url and not url.startswith('https://'):
 raise SystemExit('GOOP_BACKEND_URL must begin with https://')
pathlib.Path('site/goop-config.js').write_text('window.GOOP_BACKEND_URL = '+json.dumps(url)+';\n')
PYTHON
aws s3 cp site/index.html "s3://$BUCKET/index.html" --content-type 'text/html; charset=utf-8' --cache-control 'no-cache'
# Upload scripts and images with suitable MIME types from AWS CLI's built-in inference.
aws s3 sync site/ "s3://$BUCKET/" --exclude 'index.html' --cache-control 'no-cache'
echo "Uploaded Goop site to https://$BUCKET.s3.us-east-2.amazonaws.com/index.html"
echo 'NOTE: Media/Blox APIs still require the Docker backend to be running over HTTPS.'
