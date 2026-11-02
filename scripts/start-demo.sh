#!/usr/bin/env bash
set -euo pipefail
task_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
# Compatibility entry; new deployments run setup once, then start for daily use.
bash "$task_root/scripts/setup.sh"
exec bash "$task_root/scripts/start.sh" "$@"
