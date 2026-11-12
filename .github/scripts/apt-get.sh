#!/usr/bin/env bash
# apt-get with retries for CI runners.
#
# The Ubuntu mirrors (archive/security.ubuntu.com) are sometimes unreachable for a few minutes
# ("Temporary failure resolving ..."), which turned whole runs red before any test started.
# Each download is retried by apt itself (Acquire::Retries), and the whole command is repeated
# with a growing pause; before repeating an install the package lists are refreshed, because a
# failed fetch can leave them stale.
#
# Usage: .github/scripts/apt-get.sh update
#        .github/scripts/apt-get.sh install -y -qq --no-install-recommends xvfb
# Tunables (environment): APT_TRIES (default 5), APT_PAUSE (seconds, default 15; pause n = n * APT_PAUSE).
set -u

tries="${APT_TRIES:-5}"
pause="${APT_PAUSE:-15}"
opts=(-o Acquire::Retries=5 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30)

run() {
  sudo DEBIAN_FRONTEND=noninteractive apt-get "${opts[@]}" "$@"
}

for ((n = 1; n <= tries; n++)); do
  run "$@"
  status=$?
  if ((status == 0)); then
    exit 0
  fi
  if ((n == tries)); then
    echo "apt-get $1: failed $tries times (last exit $status)" >&2
    exit "$status"
  fi
  wait_s=$((n * pause))
  echo "apt-get $1: attempt $n of $tries failed (exit $status), trying again in ${wait_s}s" >&2
  sleep "$wait_s"
  if [ "$1" != "update" ]; then
    run update -qq || true
  fi
done
