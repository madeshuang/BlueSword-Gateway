#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
python="$script_dir/../backend/.venv/bin/python"
if [ ! -x "$python" ]; then
  echo "Backend environment missing. Run bash scripts/setup.sh first." >&2
  exit 1
fi
exec "$python" "$script_dir/manage.py" start "$@"
