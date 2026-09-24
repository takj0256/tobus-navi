#!/usr/bin/env bash
# Authentication only: never retry a collection/publication command here.
phase11_auth_check() {
  local attempt code=1
  for attempt in 1 2 3; do
    if "$@" whoami >/dev/null; then return 0; else code=$?; fi
    if (( attempt < 3 )); then
      echo "Cloudflare authentication preflight failed; retry $((attempt + 1))/3" >&2
      sleep "$((attempt * 2))"
    fi
  done
  return "$code"
}
