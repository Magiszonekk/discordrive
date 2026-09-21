import { useCallback, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldCheck, Play, AlertTriangle } from "lucide-react";
import { gqlRequest } from "../lib/graphql.js";
import { StatBarsSkeleton } from "../components/files/Skeleton.js";

// ─── GraphQL ──────────────────────────────────────────────────────────────────

const HEALTH_CHECK_STATS = `
  query HealthCheckStats {
    healthCheckStats {
      total healthy missing modified unchecked fileCount latestCheckedAt
    }
  }
`;

const FILES_FOR_HEALTH_CHECK = `
  query FilesForHealthCheck($samplePercent: Float, $fileId: ID) {
    filesForHealthCheck(samplePercent: $samplePercent, fileId: $fileId) {
      fileId fileName chunkCount
      chunks { id index healthStatus healthCheckedAt }
    }
  }
`;

const FILES_WITH_HEALTH_ISSUES = `
  query FilesWithHealthIssues {
    filesWithHealthIssues {
      fileId fileName healthyCount missingCount modifiedCount
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

interface HealthCheckStats {
  total: number;
  healthy: number;
  missing: number;
  modified: number;
  unchecked: number;
  fileCount: number;
  latestCheckedAt: string | null;
}

interface FileIssueInfo {
  fileId: string;
  fileName: string;
  healthyCount: number;
  missingCount: number;
  modifiedCount: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

// Compact timestamp for UI labels — "Aug 25, 2026, 12:14" (no seconds).
function formatDateTime(d: Date): string {
  const date = d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const time = d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
  return `${date}, ${time}`;
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
  const [fileSearch, setFileSearch] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const [lastResult, setLastResult] = useState<HealthCheckSummary | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const runStartRef = useRef<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Snapshot of the sampling params actually used by the in-flight run, so
  // the progress poll below stays scoped to what's running even if the user
  // fiddles with the sliders while a previous run winds down.
  const [runParams, setRunParams] = useState<{ samplePercent: number; fileId: string | null } | null>(null);

  // DB-wide state panel — lightweight SQL-aggregated stats (no per-chunk
  // payload). Fetched once on mount and re-fetched after a run completes;
  // NOT polled on an interval. This replaces the old approach of reusing
  // filesForHealthCheck (which pulled every chunk of every file — on the
  // production scraper account, ~7500 files / ~340k chunks, that single
  // query took 30s+ and reliably crashed the browser tab) to also drive
  // both the DB-state panel AND the in-run progress bar via a 3s poll.
  // Progress during a run now uses runProgressQuery below instead, scoped
  // to the run's own sample.
  const { data: dbStatsData, isLoading: healthLoading } = useQuery({
    queryKey: ["healthCheckStats"],
    queryFn: () => gqlRequest<{ healthCheckStats: HealthCheckStats }>(HEALTH_CHECK_STATS),
    staleTime: 0,
  });

  // "Files with issues" table — scoped server-side to only files that
  // actually have a MISSING/MODIFIED chunk, instead of scanning every file
  // client-side.
  const { data: issuesData } = useQuery({
    queryKey: ["filesWithHealthIssues"],
    queryFn: () => gqlRequest<{ filesWithHealthIssues: FileIssueInfo[] }>(FILES_WITH_HEALTH_ISSUES),
    staleTime: 0,
  });

  // In-run progress — polls, but scoped to the SAME sample the running
  // health check is actually processing. For a 1% sample on a 7500-file
  // account this is ~75 files instead of all 7500, keeping the poll cheap
  // regardless of total account size.
  const { data: progressData } = useQuery({
    queryKey: ["filesForHealthCheck", "progress", runParams?.samplePercent, runParams?.fileId],
    queryFn: () =>
      gqlRequest<{ filesForHealthCheck: FileHealthInfo[] }>(FILES_FOR_HEALTH_CHECK, {
        samplePercent: runParams?.fileId ? undefined : runParams?.samplePercent,
        fileId: runParams?.fileId ?? undefined,
      }),
    enabled: isRunning && runParams !== null,
    refetchInterval: isRunning ? 3000 : false,
    staleTime: 0,
  });

  // Files list for the selector
  const { data: filesData } = useQuery({
    queryKey: ["files", null],
    queryFn: () => gqlRequest<{ files: Array<{ id: string; name: string }> }>(FILES_QUERY),
  });

  const stats: HealthCheckStats = dbStatsData?.healthCheckStats ?? {
    total: 0, healthy: 0, missing: 0, modified: 0, unchecked: 0, fileCount: 0, latestCheckedAt: null,
  };
  const filesWithIssues = issuesData?.filesWithHealthIssues ?? [];
  const progressFiles = progressData?.filesForHealthCheck ?? [];
  const allFiles = filesData?.files ?? [];
  const progressStats = aggregateChunks(progressFiles);

  // File selector: on a large account rendering every file as a native
  // <select><option> (7500+ elements on the production scraper account)
  // makes the DOM huge and slow to interact with, and only grows worse as
  // the scraper keeps adding files. Filter client-side by name and cap the
  // rendered option count — the field is a rarely-used "check one specific
  // file" escape hatch, not a primary navigation control.
  const FILE_SELECTOR_MAX_OPTIONS = 200;
  const filteredFiles = useMemo(() => {
    const needle = fileSearch.trim().toLowerCase();
    const matches = needle
      ? allFiles.filter((f) => f.name.toLowerCase().includes(needle))
      : allFiles;
    return matches.slice(0, FILE_SELECTOR_MAX_OPTIONS);
  }, [allFiles, fileSearch]);

  // Progress estimation during run — scoped to the run's own sample, not
  // the whole account.
  const checkedDuringRun = runStartRef.current
    ? progressFiles.flatMap((f) => f.chunks).filter((c) => {
        if (!c.healthCheckedAt || !runStartRef.current) return false;
        return new Date(c.healthCheckedAt).getTime() >= runStartRef.current - 1000;
      }).length
    : 0;
  const progressTotal = progressStats.total;

  const handleRun = useCallback(async () => {
    setIsRunning(true);
    setLastResult(null);
    runStartRef.current = Date.now();
    setRunParams({ samplePercent, fileId });

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
      setRunParams(null);
      queryClient.invalidateQueries({ queryKey: ["healthCheckStats"] });
      queryClient.invalidateQueries({ queryKey: ["filesWithHealthIssues"] });
    }
  }, [mode, samplePercent, fileId, queryClient]);

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
          <h2 className="text-sm font-medium text-ink">Database status</h2>
          {stats.latestCheckedAt && (
            <span className="font-mono text-xs tabular-nums text-muted">
              Last checked: {formatDateTime(new Date(stats.latestCheckedAt))}
            </span>
          )}
        </div>

        {healthLoading ? (
          <StatBarsSkeleton rows={4} />
        ) : stats.total === 0 ? (
          <p className="text-sm text-muted">No files yet.</p>
        ) : (
          <div className="space-y-3">
            <p className="mb-3 font-mono text-xs tabular-nums text-muted">
              {stats.total.toLocaleString()} chunks total &middot; {stats.fileCount.toLocaleString()} files
            </p>
            {/* One segmented bar — the whole composition at a glance */}
            <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-paper-3" role="img" aria-label={`Chunk health: ${stats.healthy} healthy, ${stats.missing} missing, ${stats.modified} modified, ${stats.unchecked} unchecked`}>
              {[
                { value: stats.healthy, cls: "bg-success", label: "Healthy" },
                { value: stats.missing, cls: "bg-error", label: "Missing" },
                { value: stats.modified, cls: "bg-warning", label: "Modified" },
                { value: stats.unchecked, cls: "bg-muted/60", label: "Unchecked" },
              ]
                .filter((seg) => seg.value > 0)
                .map((seg) => (
                  <div
                    key={seg.label}
                    className={`h-full ${seg.cls}`}
                    style={{ width: `${(seg.value / stats.total) * 100}%` }}
                    title={`${seg.label}: ${seg.value.toLocaleString()} (${((seg.value / stats.total) * 100).toFixed(1)}%)`}
                  />
                ))}
            </div>
            <StatBar label="Healthy" value={stats.healthy} total={stats.total} variant="success" />
            <StatBar label="Missing" value={stats.missing} total={stats.total} variant="error" />
            <StatBar label="Modified" value={stats.modified} total={stats.total} variant="warning" />
            <StatBar label="Unchecked" value={stats.unchecked} total={stats.total} variant="neutral" />
          </div>
        )}
      </section>

      {/* ── Run panel ── */}
      <section className="border-t border-rule pt-8">
        <h2 className="mb-4 text-sm font-medium text-ink">Run health check</h2>

        <div className="space-y-4">
          {/* Mode toggle */}
          <div className="flex items-center gap-3">
            <span className="w-20 shrink-0 text-xs text-muted">Mode</span>
            <div className="flex overflow-hidden rounded-md border border-rule-2">
              {([["exists", "Exists — chunk presence on Discord (fast)"], ["integrity", "Integrity — download & verify each chunk's SHA-256 (slow, thorough)"]] as const).map(([m, hint]) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMode(m)}
                  title={hint}
                  className={`px-4 py-1.5 text-sm capitalize transition-colors duration-short ease-out ${
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
                ? "Checks that chunks exist on Discord (fast)"
                : "Downloads and verifies the SHA-256 of every chunk (slow, thorough)"}
            </span>
          </div>

          {/* Sample % */}
          <div className="flex items-center gap-3">
            <span className="w-20 shrink-0 text-xs text-muted">Sample</span>
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
            <span className="w-20 shrink-0 text-xs text-muted">File</span>
            <input
              type="text"
              placeholder="Search files…"
              value={fileSearch}
              onChange={(e) => setFileSearch(e.target.value)}
              className="w-48 rounded-md border border-rule-2 bg-paper px-3 py-1.5 text-sm text-ink outline-2 outline-offset-1 outline-transparent transition-colors duration-short ease-out hover:bg-paper-2 focus:bg-paper focus:outline-focus"
            />
            <select
              value={fileId ?? ""}
              onChange={(e) => setFileId(e.target.value || null)}
              className="rounded-md border border-rule-2 bg-paper px-3 py-1.5 text-sm text-ink outline-2 outline-offset-1 outline-transparent transition-colors duration-short ease-out hover:bg-paper-2 focus:bg-paper focus:outline-focus"
            >
              <option value="">All files</option>
              {filteredFiles.map((f) => (
                <option key={f.id} value={f.id}>{f.name}</option>
              ))}
            </select>
            {allFiles.length > filteredFiles.length && (
              <span className="text-xs text-muted">
                showing {filteredFiles.length} of {allFiles.length} — narrow the search
              </span>
            )}
          </div>

          <div className="flex justify-end">
            <button
              onClick={handleRun}
              disabled={isRunning}
              className="flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-ink transition-colors duration-short ease-out hover:bg-accent-hover disabled:cursor-not-allowed disabled:bg-paper-3 disabled:text-muted"
            >
              <Play size={14} />
              {isRunning ? "Running…" : "Run check"}
            </button>
          </div>
        </div>
      </section>

      {/* ── Results / progress panel ── */}
      {(isRunning || lastResult) && (
        <section className="border-t border-rule pt-8">
          <h2 className="mb-4 text-sm font-medium text-ink">
            {isRunning ? "Check in progress…" : "Last run results"}
          </h2>

          {isRunning && (
            <div className="mb-4">
              <div className="mb-1 flex justify-between font-mono text-xs tabular-nums text-muted">
                <span>
                  Checked: ~{checkedDuringRun.toLocaleString()} / {progressTotal.toLocaleString()} chunks
                </span>
                <span>{formatDuration(elapsed)}</span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-paper-3">
                <div
                  className="h-2 w-full origin-left rounded-full bg-accent transition-transform duration-short ease-out"
                  style={{
                    transform: `scaleX(${progressTotal > 0 ? Math.min(1, checkedDuringRun / progressTotal) : 0})`,
                  }}
                />
              </div>
              {(() => {
                const elapsedSec = elapsed / 1000;
                const chunksPerSec = elapsedSec > 0 ? checkedDuringRun / elapsedSec : 0;
                const remaining = progressTotal - checkedDuringRun;
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
                  Files with issues ({filesWithIssues.length})
                </p>
              </div>
              <div className="overflow-hidden rounded-card border border-rule bg-paper">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-rule">
                      <th className="px-4 py-2 text-left font-mono text-xs uppercase tracking-wide text-muted">File</th>
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
              All checked chunks are healthy.
            </p>
          )}
        </section>
      )}
    </div>
  );
}
