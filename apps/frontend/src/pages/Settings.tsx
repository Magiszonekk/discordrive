import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { gqlRequest } from "../lib/graphql.js";
import { useAuthStore } from "../stores/auth.js";

const STORAGE_QUERY = `
  query StorageUsage {
    storageUsage { totalBytes fileCount }
  }
`;

export function Settings() {
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);

  const { data } = useQuery({
    queryKey: ["storageUsage"],
    queryFn: () =>
      gqlRequest<{
        storageUsage: { totalBytes: string; fileCount: number };
      }>(STORAGE_QUERY),
  });

  return (
    <div className="flex-1 p-6 max-w-2xl">
      <h1 className="text-2xl font-bold text-white mb-6">Settings</h1>

      <div className="space-y-6">
        <div className="bg-zinc-900 rounded-xl border border-zinc-800 p-6">
          <h2 className="text-lg font-semibold text-white mb-4">Account</h2>
          <p className="text-zinc-400">{user?.email}</p>
        </div>

        <div className="bg-zinc-900 rounded-xl border border-zinc-800 p-6">
          <h2 className="text-lg font-semibold text-white mb-4">Storage Usage</h2>
          {data ? (
            <div className="text-zinc-400">
              <p>{formatSize(data.storageUsage.totalBytes)} used</p>
              <p>{data.storageUsage.fileCount} files</p>
            </div>
          ) : (
            <p className="text-zinc-500">Loading...</p>
          )}
        </div>

        <button
          onClick={logout}
          className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg text-sm font-medium"
        >
          Log out
        </button>
      </div>
    </div>
  );
}

function formatSize(bytes: string): string {
  const size = Number(bytes);
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
