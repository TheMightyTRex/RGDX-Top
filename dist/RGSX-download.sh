#!/bin/bash
# RGSX batch downloader launcher for Linux, macOS, Batocera and Knulli.
# Put this next to rgsx-library-checker.html and rgsx_batch_download.py, in your
# RetroBat / Batocera / Knulli folder, and run it ON the machine where RGSX is
# installed:
#     ./RGSX-download.sh            download the queued games
#     ./RGSX-download.sh --dry-run  show what would be downloaded
#
# On Batocera/Knulli you can also run it over SSH, or add it as a Port.
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$HERE/rgsx_batch_download.py"
if [ ! -f "$SCRIPT" ]; then
  echo "rgsx_batch_download.py was not found next to this script."
  echo "Keep both files together in your RetroBat / Batocera folder."
  exit 1
fi

# Find Python 3.
PY=""
for c in python3 python; do
  if command -v "$c" >/dev/null 2>&1; then PY="$c"; break; fi
done
if [ -z "$PY" ]; then
  echo "Python 3 was not found. Install it, or start RGSX once so it is set up."
  exit 1
fi

# On handhelds RGSX ships its own modules under vendor/; make them importable.
RGSX_DIR="$HERE/roms/ports/RGSX"
if [ -d "$RGSX_DIR/vendor" ]; then
  export PYTHONPATH="$RGSX_DIR/vendor${PYTHONPATH:+:$PYTHONPATH}"
fi
export RGSX_HEADLESS=1

"$PY" "$SCRIPT" "$@"
rc=$?

echo
# Pause if we have an interactive terminal (ignored when launched non-interactively).
if [ -t 0 ]; then read -r -p "Finished. Press Enter to close. " _ || true; fi
exit $rc
