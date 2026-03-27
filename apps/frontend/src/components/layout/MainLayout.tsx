import { Link, useLocation } from "react-router";
import { useAuthStore } from "../../stores/auth.js";
import { Files, Settings, ShieldCheck } from "lucide-react";

export function MainLayout({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);

  return (
    <div className="min-h-screen bg-zinc-950 flex">
      {/* Sidebar */}
      <aside className="w-64 bg-zinc-900 border-r border-zinc-800 flex flex-col">
        <div className="p-4 border-b border-zinc-800">
          <h1 className="text-lg font-bold text-white">DiscorDrive</h1>
        </div>

        <nav className="flex-1 p-3 space-y-1">
          <Link
            to="/"
            className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm ${
              location.pathname === "/" || location.pathname.startsWith("/folder")
                ? "bg-zinc-800 text-white"
                : "text-zinc-400 hover:text-white hover:bg-zinc-800"
            }`}
          >
            <Files size={15} />
            Files
          </Link>
          <Link
            to="/health"
            className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm ${
              location.pathname === "/health"
                ? "bg-zinc-800 text-white"
                : "text-zinc-400 hover:text-white hover:bg-zinc-800"
            }`}
          >
            <ShieldCheck size={15} />
            Healthcheck
          </Link>
          <Link
            to="/settings"
            className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm ${
              location.pathname === "/settings"
                ? "bg-zinc-800 text-white"
                : "text-zinc-400 hover:text-white hover:bg-zinc-800"
            }`}
          >
            <Settings size={15} />
            Settings
          </Link>
        </nav>

        <div className="p-4 border-t border-zinc-800">
          <p className="text-xs text-zinc-500 truncate mb-2">{user?.email}</p>
          <button
            onClick={logout}
            className="text-xs text-zinc-400 hover:text-white"
          >
            Log out
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 flex flex-col">{children}</main>
    </div>
  );
}
