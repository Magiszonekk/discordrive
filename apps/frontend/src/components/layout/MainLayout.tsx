import { useState } from "react";
import { Link, useLocation } from "react-router";
import { Files, Menu, Settings, ShieldCheck, X } from "lucide-react";
import { useAuthStore } from "../../stores/auth.js";

function SidebarNavigation({
  pathname,
  onNavigate,
}: {
  pathname: string;
  onNavigate?: () => void;
}) {
  const links = [
    {
      to: "/",
      label: "Files",
      icon: Files,
      active: pathname === "/" || pathname.startsWith("/folder"),
    },
    {
      to: "/health",
      label: "Healthcheck",
      icon: ShieldCheck,
      active: pathname === "/health",
    },
    {
      to: "/settings",
      label: "Settings",
      icon: Settings,
      active: pathname === "/settings",
    },
  ];

  return (
    <nav className="flex-1 p-3 space-y-1">
      {links.map((link) => {
        const Icon = link.icon;
        return (
          <Link
            key={link.to}
            to={link.to}
            onClick={onNavigate}
            className={`flex items-center gap-3 rounded-lg px-3 py-3 text-sm transition-colors ${
              link.active
                ? "bg-zinc-800 text-white"
                : "text-zinc-400 hover:bg-zinc-800 hover:text-white"
            }`}
          >
            <Icon size={18} />
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}

function SidebarFooter() {
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);

  return (
    <div className="border-t border-zinc-800 p-4">
      <p className="mb-3 truncate text-xs text-zinc-500">{user?.email}</p>
      <button
        onClick={logout}
        className="w-full rounded-lg px-3 py-3 text-left text-sm text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-white"
      >
        Log out
      </button>
    </div>
  );
}

function MobileTopbar({ onMenuOpen }: { onMenuOpen: () => void }) {
  return (
    <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-zinc-800 bg-zinc-900 px-4 md:hidden">
      <button
        onClick={onMenuOpen}
        className="inline-flex h-10 w-10 items-center justify-center rounded-lg text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-white"
        aria-label="Open navigation menu"
      >
        <Menu size={20} />
      </button>
      <h1 className="text-base font-semibold text-white">DiscorDrive</h1>
      <div className="h-10 w-10" aria-hidden="true" />
    </header>
  );
}

function MobileDrawer({
  open,
  onClose,
  pathname,
}: {
  open: boolean;
  onClose: () => void;
  pathname: string;
}) {
  return (
    <div
      className={`fixed inset-0 z-40 md:hidden ${open ? "pointer-events-auto" : "pointer-events-none"}`}
      aria-hidden={!open}
    >
      <div
        className={`absolute inset-0 bg-black/60 transition-opacity ${
          open ? "opacity-100" : "opacity-0"
        }`}
        onClick={onClose}
      />
      <aside
        className={`absolute left-0 top-0 flex h-full w-72 max-w-[85vw] flex-col border-r border-zinc-800 bg-zinc-900 shadow-xl transition-transform ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex items-center justify-between border-b border-zinc-800 p-4">
          <h2 className="text-lg font-semibold text-white">DiscorDrive</h2>
          <button
            onClick={onClose}
            className="inline-flex h-10 w-10 items-center justify-center rounded-lg text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-white"
            aria-label="Close navigation menu"
          >
            <X size={20} />
          </button>
        </div>
        <SidebarNavigation pathname={pathname} onNavigate={onClose} />
        <SidebarFooter />
      </aside>
    </div>
  );
}

export function MainLayout({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const [drawerOpen, setDrawerOpen] = useState(false);

  return (
    <div className="min-h-screen bg-zinc-950 text-white md:flex">
      <MobileTopbar onMenuOpen={() => setDrawerOpen(true)} />
      <MobileDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        pathname={location.pathname}
      />

      <aside className="hidden w-64 flex-col border-r border-zinc-800 bg-zinc-900 md:flex md:min-h-screen">
        <div className="border-b border-zinc-800 p-4">
          <h1 className="text-lg font-bold text-white">DiscorDrive</h1>
        </div>
        <SidebarNavigation pathname={location.pathname} />
        <SidebarFooter />
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">{children}</main>
    </div>
  );
}
