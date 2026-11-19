#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

rm -f zotero-dedupe.xpi
zip -q -X -r zotero-dedupe.xpi manifest.json bootstrap.js README.md icons

echo "Built $(pwd)/zotero-dedupe.xpi"
unzip -l zotero-dedupe.xpi
