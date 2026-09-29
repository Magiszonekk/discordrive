#!/usr/bin/env bash
# Run the fuzz test over several seeds with a hard per-seed timeout; report time/exit per seed.
export PATH=/usr/local/bin:$PATH HOME=~
cd "$(dirname "$0")/.." || exit 1
RUNS=${RUNS:-300}
OUT=${OUT:-${TMPDIR:-/tmp}/fuzz-seeds}
mkdir -p "$OUT"
for s in ${SEEDS:-1 2 3 4 5 6 7 8}; do
  start=$(date +%s.%N)
  timeout "${PER_SEED_TIMEOUT:-60}" env FUZZ_RUNS="$RUNS" FUZZ_SEED="$s" npx vitest run test/fuzz.test.ts --silent=false >"$OUT/seed_$s.log" 2>&1
  ec=$?
  end=$(date +%s.%N)
  printf 'seed %s exit %s %.1fs\n' "$s" "$ec" "$(echo "$end - $start" | bc)"
done
