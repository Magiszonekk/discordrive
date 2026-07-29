import { useCallback, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldCheck, Play, AlertTriangle } from "lucide-react";
import { gqlRequest } from "../lib/graphql.js";

// ─── GraphQL ──────────────────────────────────────────────────────────────────

const FILES_FOR_HEALTH_CHECK = `
  query FilesForHealthCheck {
    filesForHealthCheck {
      fileId fileName chunkCount
      chunks { id index healthStatus healthCheckedAt }
    }
  }
`;

const RUN_HEALTH_CHECK = `
  mutation RunHealthCheck($mode: String!, $samplePercent: Float, $fileId: ID) {
    runHealthCheck(mode: $mode, samplePercent: $samplePercent, fileId: $fileId) {
      checked healthy missing modified skipped durationMs
    }
  }
`;

const FILES_QUERY = `
  query Files {
    files(parentFolderId: null) { id name }
  }
`;

// ─── Types ────────────────────────────────────────────────────────────────────

interface ChunkHealthInfo {
  id: string;
  index: number;
  healthStatus: string | null;
  healthCheckedAt: string | null;
}

interface FileHealthInfo {
  fileId: string;
  fileName: string;
  chunkCount: number;
  chunks: ChunkHealthInfo[];
}

interface HealthCheckSummary {
  checked: number;
  healthy: number;
  missing: number;
  modified: number;
  skipped: number;
  durationMs: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function aggregateChunks(files: FileHealthInfo[]) {
  let healthy = 0, missing = 0, modified = 0, unchecked = 0;
  let latestChecked: Date | null = null;

  for (const file of files) {
    for (const chunk of file.chunks) {
      if (chunk.healthStatus === "HEALTHY") healthy++;
      else if (chunk.healthStatus === "MISSING") missing++;
      else if (chunk.healthStatus === "MODIFIED") modified++;
      else unchecked++;

      if (chunk.healthCheckedAt) {
        const d = new Date(chunk.healthCheckedAt);
        if (!latestChecked || d > latestChecked) latestChecked = d;
      }
    }
  }

  return { healthy, missing, modified, unchecked, total: healthy + missing + modified + unchecked, latestChecked };
}

// ─── Sub-components ───────────────────────────────────────────────────────────

type HealthVariant = "success" | "error" | "warning" | "neutral";

const CHIP_CLASS: Record<HealthVariant, string> = {
  success: "chip chip--success",
  error: "chip chip--error",
  warning: "chip chip--warning",
  neutral: "chip",
};

const BAR_CLASS: Record<HealthVariant, string> = {
  success: "bg-success",
  error: "bg-error",
  warning: "bg-warning",
  neutral: "bg-muted",
};

function StatBar({
  label,
  value,
  total,
  variant,
}: {
  label: string;
  value: number;
  total: number;
  variant: HealthVariant;
}) {
  const pct = total > 0 ? (value / total) * 100 : 0;
  return (
    <div className="flex items-center gap-3">
      <span className={`${CHIP_CLASS[variant]} w-24 shrink-0`}>{label}</span>
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-paper-3">
        <div
          className={`h-2 w-full origin-left rounded-full transition-transform duration-short ease-out ${BAR_CLASS[variant]}`}
          style={{ transform: `scaleX(${pct / 100})` }}
        />
      </div>
      <span className="w-28 shrink-0 text-right font-mono text-xs tabular-nums text-ink-2">
        {value.toLocaleString()} <span className="text-muted">({pct.toFixed(1)}%)</span>
      </span>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export function HealthCheck() {
  const queryClient = useQueryClient();

  const [mode, setMode] = useState<"exists" | "integrity">("exists");
  const [samplePercent, setSamplePercent] = useState(100);
  const [fileId, setFileId] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [lastResult, setLastResult] = useState<HealthCheckSummary | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const runStartRef = useRef<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Main health data query — polls during run
  const { data: healthData, isLoading: healthLoading } = useQuery({
    queryKey: ["filesForHealthCheck"],
    queryFn: () =>
      gqlRequest<{ filesForHealthCheck: FileHealthInfo[] }>(FILES_FOR_HEALTH_CHECK),
    refetchInterval: isRunning ? 3000 : false,
    staleTime: 0,
  });

  // Files list for the selector
  const { data: filesData } = useQuery({
    queryKey: ["files", null],
    queryFn: () => gqlRequest<{ files: Array<{ id: string; name: string }> }>(FILES_QUERY),
  });

  const files = healthData?.filesForHealthCheck ?? [];
  const allFiles = filesData?.files ?? [];
  const stats = aggregateChunks(files);

  // Progress estimation during run
  const checkedDuringRun = runStartRef.current
    ? files.flatMap((f) => f.chunks).filter((c) => {
        if (!c.healthCheckedAt || !runStartRef.current) return false;
        return new Date(c.healthCheckedAt).getTime() >= runStartRef.current - 1000;
      }).length
    : 0;

  const handleRun = useCallback(async () => {
    setIsRunning(true);
    setLastResult(null);
    runStartRef.current = Date.now();

    timerRef.current = setInterval(() => {
      setElapsed(Date.now() - (runStartRef.current ?? Date.now()));
    }, 1000);

    try {
      const result = await gqlRequest<{ runHealthCheck: HealthCheckSummary }>(
        RUN_HEALTH_CHECK,
        { mode, samplePercent, fileId }
      );
      setLastResult(result.runHealthCheck);
    } catch (err) {
      console.error("Health check failed:", err);
    } finally {
      setIsRunning(false);
      if (timerRef.current) clearInterval(timerRef.current);
      setElapsed(0);
      runStartRef.current = null;
      queryClient.invalidateQueries({ queryKey: ["filesForHealthCheck"] });
    }
  }, [mode, samplePercent, fileId, queryClient]);

  // Files with issues (for results table)
  const filesWithIssues = files
    .map((f) => {
      const h = f.chunks.filter((c) => c.healthStatus === "HEALTHY").length;
      const m = f.chunks.filter((c) => c.healthStatus === "MISSING").length;
      const mod = f.chunks.filter((c) => c.healthStatus === "MODIFIED").length;
      return { ...f, healthyCount: h, missingCount: m, modifiedCount: mod };
    })
    .filter((f) => f.missingCount > 0 || f.modifiedCount > 0)
    .sort((a, b) => (b.missingCount + b.modifiedCount) - (a.missingCount + a.modifiedCount));

  const hasMissingIssues = filesWithIssues.some((f) => f.missingCount > 0);

  return (
    <div className="flex-1 space-y-8 p-6">
      <div className="flex items-center gap-2">
        <ShieldCheck size={20} className="text-accent" />
        <h1 className="font-display text-xl font-semibold text-ink">Health Check</h1>
      </div>

      {/* ── DB state panel ── */}
      <section>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-medium text-ink">Stan bazy danych</h2>
          {stats.latestChecked && (
            <span className="font-mono text-xs tabular-nums text-muted">
              Ostatnio sprawdzone: {stats.latestChecked.toLocaleString()}
            </span>
          )}
        </div>

        {healthLoading ? (
          <p className="text-sm text-muted">Ładowanie…</p>
        ) : stats.total === 0 ? (
          <p className="text-sm text-muted">Brak plików.</p>
        ) : (
          <div className="space-y-3">
            <p className="mb-3 font-mono text-xs tabular-nums text-muted">
              {stats.total.toLocaleString()} chunków total &middot; {files.length} plików
            </p>
            <StatBar label="Healthy" value={stats.healthy} total={stats.total} variant="success" />
            <StatBar label="Missing" value={stats.missing} total={stats.total} variant="error" />
            <StatBar label="Modified" value={stats.modified} total={stats.total} variant="warning" />
            <StatBar label="Unchecked" value={stats.unchecked} total={stats.total} variant="neutral" />
          </div>
        )}
      </section>

      {/* ── Run panel ── */}
      <section className="border-t border-rule pt-8">
        <h2 className="mb-4 text-sm font-medium text-ink">Uruchom health check</h2>

        <div className="space-y-4">
          {/* Mode toggle */}
          <div className="flex items-center gap-3">
            <span className="w-16 shrink-0 text-xs text-muted">Tryb</span>
            <div className="flex overflow-hidden rounded-md border border-rule-2">
              {(["exists", "integrity"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMode(m)}
                  className={`px-4 py-1.5 text-sm transition-colors duration-short ease-out ${
                    mode === m
                      ? "bg-accent text-accent-ink"
                      : "text-ink-2 hover:bg-paper-2"
                  }`}
                >
                  {m}
                </button>
              ))}
            </div>
            <span className="text-xs text-muted">
              {mode === "exists"
                ? "Sprawdza czy chunki istnieją na Discordzie (szybkie)"
                : "Pobiera i weryfikuje SHA-256 każdego chunka (wolne, dokładne)"}
            </span>
          </div>

          {/* Sample % */}
          <div className="flex items-center gap-3">
            <span className="w-16 shrink-0 text-xs text-muted">Sample</span>
            <input
              type="range"
              min={1}
              max={100}
              value={samplePercent}
              onChange={(e) => setSamplePercent(Number(e.target.value))}
              className="flex-1 accent-accent"
            />
            <input
              type="number"
              min={1}
              max={100}
              value={samplePercent}
              onChange={(e) => setSamplePercent(Math.min(100, Math.max(1, Number(e.target.value))))}
              className="w-16 rounded-md border border-rule-2 bg-paper px-2 py-1 text-center text-sm text-ink outline-2 outline-offset-1 outline-transparent transition-colors duration-short ease-out hover:bg-paper-2 focus:bg-paper focus:outline-focus"
            />
            <span className="text-xs text-muted">%</span>
          </div>

          {/* File selector */}
          <div className="flex items-center gap-3">
            <span className="w-16 shrink-0 text-xs text-muted">Plik</span>
            <select
              value={fileId ?? ""}
              onChange={(e) => setFileId(e.target.value || null)}
              className="rounded-md border border-rule-2 bg-paper px-3 py-1.5 text-sm text-ink outline-2 outline-offset-1 outline-transparent transition-colors duration-short ease-out hover:bg-paper-2 focus:bg-paper focus:outline-focus"
            >
              <option value="">Wszystkie pliki</option>
              {allFiles.map((f) => (
                <option key={f.id} value={f.id}>{f.name}</option>
              ))}
            </select>
          </div>

          <div className="flex justify-end">
            <button
              onClick={handleRun}
              disabled={isRunning}
              className="flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-ink transition-colors duration-short ease-out hover:bg-accent-hover disabled:cursor-not-allowed disabled:bg-paper-3 disabled:text-muted"
            >
              <Play size={14} />
              {isRunning ? "Trwa sprawdzanie…" : "Uruchom"}
            </button>
          </div>
        </div>
      </section>

      {/* ── Results / progress panel ── */}
      {(isRunning || lastResult) && (
        <section className="border-t border-rule pt-8">
          <h2 className="mb-4 text-sm font-medium text-ink">
            {isRunning ? "Sprawdzanie w toku…" : "Wyniki ostatniego przebiegu"}
          </h2>

          {isRunning && (
            <div className="mb-4">
              <div className="mb-1 flex justify-between font-mono text-xs tabular-nums text-muted">
                <span>
                  Sprawdzono: ~{checkedDuringRun.toLocaleString()} / {stats.total.toLocaleString()} chunków
                </span>
                <span>{formatDuration(elapsed)}</span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-paper-3">
                <div
                  className="h-2 w-full origin-left rounded-full bg-accent transition-transform duration-short ease-out"
                  style={{
                    transform: `scaleX(${stats.total > 0 ? Math.min(1, checkedDuringRun / stats.total) : 0})`,
                  }}
                />
              </div>
              {(() => {
                const elapsedSec = elapsed / 1000;
                const chunksPerSec = elapsedSec > 0 ? checkedDuringRun / elapsedSec : 0;
                const remaining = stats.total - checkedDuringRun;
                const etaMs = chunksPerSec > 0 ? (remaining / chunksPerSec) * 1000 : null;
                return elapsedSec > 2 && chunksPerSec > 0 ? (
                  <div className="mt-2 flex items-center gap-3 font-mono text-xs tabular-nums text-muted">
                    <span>{chunksPerSec.toFixed(1)} chunks/s</span>
                    {etaMs !== null && (
                      <>
                        <span className="text-muted">&middot;</span>
                        <span>ETA: ~{formatDuration(etaMs)}</span>
                      </>
                    )}
                  </div>
                ) : null;
              })()}
            </div>
          )}

          {lastResult && (
            <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4">
              {[
                { label: "Checked", value: lastResult.checked, className: "text-ink" },
                { label: "Healthy", value: lastResult.healthy, className: "text-success" },
                { label: "Missing", value: lastResult.missing, className: "text-error" },
                { label: "Modified", value: lastResult.modified, className: "text-warning" },
                { label: "Skipped", value: lastResult.skipped, className: "text-muted" },
                { label: "Duration", value: formatDuration(lastResult.durationMs), className: "text-ink-2" },
              ].map(({ label, value, className }) => (
                <div key={label} className="rounded-md bg-paper-2 px-4 py-3">
                  <p className="mb-1 font-mono text-[11px] uppercase tracking-wide text-muted">{label}</p>
                  <p className={`font-mono text-lg font-semibold tabular-nums ${className}`}>
                    {typeof value === "number" ? value.toLocaleString() : value}
                  </p>
                </div>
              ))}
            </div>
          )}

          {/* Files with issues */}
          {!isRunning && filesWithIssues.length > 0 && (
            <div>
              <div className="mb-3 flex items-center gap-2">
                <AlertTriangle size={14} className={hasMissingIssues ? "text-error" : "text-warning"} />
                <p className="text-xs font-medium text-ink-2">
                  Pliki z problemami ({filesWithIssues.length})
                </p>
              </div>
              <div className="overflow-hidden rounded-card border border-rule bg-paper">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-rule">
                      <th className="px-4 py-2 text-left font-mono text-xs uppercase tracking-wide text-muted">Plik</th>
                      <th className="px-4 py-2 text-right font-mono text-xs uppercase tracking-wide text-success">Healthy</th>
                      <th className="px-4 py-2 text-right font-mono text-xs uppercase tracking-wide text-error">Missing</th>
                      <th className="px-4 py-2 text-right font-mono text-xs uppercase tracking-wide text-warning">Modified</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filesWithIssues.map((f) => (
                      <tr key={f.fileId} className="border-b border-rule last:border-0 hover:bg-paper-2">
                        <td className="max-w-xs truncate px-4 py-2 text-ink-2">{f.fileName}</td>
                        <td className="px-4 py-2 text-right font-mono tabular-nums text-success">{f.healthyCount.toLocaleString()}</td>
                        <td className="px-4 py-2 text-right font-mono tabular-nums text-error">{f.missingCount.toLocaleString()}</td>
                        <td className="px-4 py-2 text-right font-mono tabular-nums text-warning">{f.modifiedCount.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {!isRunning && filesWithIssues.length === 0 && lastResult && (
            <p className="flex items-center gap-2 text-sm text-success">
              <ShieldCheck size={16} />
              Wszystkie sprawdzone chunki są w porządku.
            </p>
          )}
        </section>
      )}
    </div>
  );
}
