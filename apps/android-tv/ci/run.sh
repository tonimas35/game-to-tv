#!/usr/bin/env bash
# CI helper: run.sh TITLE COMMAND...
# Runs COMMAND showing its output. If it fails, its last lines also become a
# GitHub annotation (::error), which can be read through the REST API
# (check-runs/<job id>/annotations) even where the raw logs cannot be fetched.
# With G2T_NOTICE=1 the tail is also published as a ::notice when it works.
title="$1"
shift
log="$(mktemp)"
"$@" 2>&1 | tee "$log"
code=${PIPESTATUS[0]}
encode() { tail -n "${1:-80}" "$log" | cut -c1-400 | sed -e 's/%/%25/g' -e 's/\r/%0D/g' | awk '{printf "%s%%0A", $0}'; }
if [ "$code" -ne 0 ]; then
  echo "::error title=${title} (código ${code})::$(encode 80)"
elif [ "${G2T_NOTICE:-}" = "1" ]; then
  echo "::notice title=${title}::$(encode "${G2T_NOTICE_LINES:-60}")"
fi
exit "$code"
