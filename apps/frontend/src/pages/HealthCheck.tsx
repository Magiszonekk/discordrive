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

function StatBar({ label, value, total, color }: { label: string; value: number; total: number; color: string }) {
  const pct = total > 0 ? (value / total) * 100 : 0;
  return (
    <div className="flex items-center gap-3">
      <span className="w-24 text-xs text-zinc-400 shrink-0">{label}</span>
      <div className="flex-1 bg-zinc-800 rounded-full h-2">
        <div className={`h-2 rounded-full transition-all ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="w-28 text-xs text-zinc-400 text-right shrink-0">
        {value.toLocaleString()} <span className="text-zinc-600">({pct.toFixed(1)}%)</span>
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

  return (
    <div className="flex-1 p-6 space-y-6">
      <div className="flex items-center gap-2">
        <ShieldCheck size={20} className="text-zinc-400" />
        <h1 className="text-xl font-semibold text-white">Health Check</h1>
      </div>

      {/* ── DB state panel ── */}
      <section className="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-medium text-white">Stan bazy danych</h2>
          {stats.latestChecked && (
            <span className="text-xs text-zinc-500">
              Ostatnio sprawdzone: {stats.latestChecked.toLocaleString()}
            </span>
          )}
        </div>

        {healthLoading ? (
          <p className="text-sm text-zinc-500">Ładowanie...</p>
        ) : stats.total === 0 ? (
          <p className="text-sm text-zinc-500">Brak plików.</p>
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-zinc-500 mb-3">
              {stats.total.toLocaleString()} chunków total &middot; {files.length} plików
            </p>
            <StatBar label="Healthy" value={stats.healthy} total={stats.total} color="bg-green-500" />
            <StatBar label="Missing" value={stats.missing} total={stats.total} color="bg-red-500" />
            <StatBar label="Modified" value={stats.modified} total={stats.total} color="bg-yellow-500" />
            <StatBar label="Unchecked" value={stats.unchecked} total={stats.total} color="bg-zinc-600" />
          </div>
        )}
      </section>

      {/* ── Run panel ── */}
      <section className="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
        <h2 className="text-sm font-medium text-white mb-4">Uruchom health check</h2>

        <div className="space-y-4">
          {/* Mode toggle */}
          <div className="flex items-center gap-3">
            <span className="text-xs text-zinc-400 w-16 shrink-0">Tryb</span>
            <div className="flex rounded-lg overflow-hidden border border-zinc-700">
              {(["exists", "integrity"] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  className={`px-4 py-1.5 text-sm transition-colors ${
                    mode === m
                      ? "bg-zinc-700 text-white"
                      : "text-zinc-400 hover:text-white"
                  }`}
                >
                  {m}
                </button>
              ))}
            </div>
            <span className="text-xs text-zinc-500">
              {mode === "exists"
                ? "Sprawdza czy chunki istnieją na Discordzie (szybkie)"
                : "Pobiera i weryfikuje SHA-256 każdego chunka (wolne, dokładne)"}
            </span>
          </div>

          {/* Sample % */}
          <div className="flex items-center gap-3">
            <span className="text-xs text-zinc-400 w-16 shrink-0">Sample</span>
            <input
              type="range"
              min={1}
              max={100}
              value={samplePercent}
              onChange={(e) => setSamplePercent(Number(e.target.value))}
              className="flex-1 accent-blue-500"
            />
            <input
              type="number"
              min={1}
              max={100}
              value={samplePercent}
              onChange={(e) => setSamplePercent(Math.min(100, Math.max(1, Number(e.target.value))))}
              className="w-16 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-sm text-white text-center focus:outline-none focus:border-zinc-500"
            />
            <span className="text-xs text-zinc-500">%</span>
          </div>

          {/* File selector */}
          <div className="flex items-center gap-3">
            <span className="text-xs text-zinc-400 w-16 shrink-0">Plik</span>
            <select
              value={fileId ?? ""}
              onChange={(e) => setFileId(e.target.value || null)}
              className="bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:border-zinc-500"
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
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-zinc-700 disabled:text-zinc-500 text-white rounded-lg text-sm font-medium transition-colors"
            >
              <Play size={14} />
              {isRunning ? "Trwa sprawdzanie..." : "Uruchom"}
            </button>
          </div>
        </div>
      </section>

      {/* ── Results / progress panel ── */}
      {(isRunning || lastResult) && (
        <section className="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
          <h2 className="text-sm font-medium text-white mb-4">
            {isRunning ? "Sprawdzanie w toku..." : "Wyniki ostatniego przebiegu"}
          </h2>

          {isRunning && (
            <div className="mb-4">
              <div className="flex justify-between text-xs text-zinc-400 mb-1">
                <span>
                  Sprawdzono: ~{checkedDuringRun.toLocaleString()} / {stats.total.toLocaleString()} chunków
                </span>
                <span>{formatDuration(elapsed)}</span>
              </div>
              <div className="w-full bg-zinc-800 rounded-full h-2">
                <div
                  className="h-2 rounded-full bg-blue-500 transition-all"
                  style={{ width: stats.total > 0 ? `${Math.min(100, (checkedDuringRun / stats.total) * 100)}%` : "0%" }}
                />
              </div>
              {(() => {
                const elapsedSec = elapsed / 1000;
                const chunksPerSec = elapsedSec > 0 ? checkedDuringRun / elapsedSec : 0;
                const remaining = stats.total - checkedDuringRun;
                const etaMs = chunksPerSec > 0 ? (remaining / chunksPerSec) * 1000 : null;
                return elapsedSec > 2 && chunksPerSec > 0 ? (
                  <div className="flex items-center gap-3 mt-2 text-xs text-zinc-500">
                    <span>{chunksPerSec.toFixed(1)} chunks/s</span>
                    {etaMs !== null && (
                      <>
                        <span className="text-zinc-700">·</span>
                        <span>ETA: ~{formatDuration(etaMs)}</span>
                      </>
                    )}
                  </div>
                ) : null;
              })()}
            </div>
          )}

          {lastResult && (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-5">
              {[
                { label: "Checked", value: lastResult.checked, color: "text-white" },
                { label: "Healthy", value: lastResult.healthy, color: "text-green-400" },
                { label: "Missing", value: lastResult.missing, color: "text-red-400" },
                { label: "Modified", value: lastResult.modified, color: "text-yellow-400" },
                { label: "Skipped", value: lastResult.skipped, color: "text-zinc-400" },
                { label: "Duration", value: formatDuration(lastResult.durationMs), color: "text-zinc-300" },
              ].map(({ label, value, color }) => (
                <div key={label} className="bg-zinc-800 rounded-lg px-4 py-3">
                  <p className="text-xs text-zinc-500 mb-1">{label}</p>
                  <p className={`text-lg font-semibold ${color}`}>{typeof value === "number" ? value.toLocaleString() : value}</p>
                </div>
              ))}
            </div>
          )}

          {/* Files with issues */}
          {!isRunning && filesWithIssues.length > 0 && (
            <div>
              <div className="flex items-center gap-2 mb-3">
                <AlertTriangle size={14} className="text-yellow-400" />
                <p className="text-xs font-medium text-zinc-300">
                  Pliki z problemami ({filesWithIssues.length})
                </p>
              </div>
              <div className="bg-zinc-950 rounded-lg border border-zinc-800 overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-zinc-800">
                      <th className="text-left px-4 py-2 text-xs text-zinc-500 font-medium">Plik</th>
                      <th className="text-right px-4 py-2 text-xs text-green-500 font-medium">Healthy</th>
                      <th className="text-right px-4 py-2 text-xs text-red-500 font-medium">Missing</th>
                      <th className="text-right px-4 py-2 text-xs text-yellow-500 font-medium">Modified</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filesWithIssues.map((f) => (
                      <tr key={f.fileId} className="border-b border-zinc-800/50 hover:bg-zinc-800/30">
                        <td className="px-4 py-2 text-white truncate max-w-xs">{f.fileName}</td>
                        <td className="px-4 py-2 text-right text-green-400">{f.healthyCount.toLocaleString()}</td>
                        <td className="px-4 py-2 text-right text-red-400">{f.missingCount.toLocaleString()}</td>
                        <td className="px-4 py-2 text-right text-yellow-400">{f.modifiedCount.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {!isRunning && filesWithIssues.length === 0 && lastResult && (
            <p className="text-sm text-green-400 flex items-center gap-2">
              <ShieldCheck size={16} />
              Wszystkie sprawdzone chunki są w porządku.
            </p>
          )}
        </section>
      )}
    </div>
  );
}
