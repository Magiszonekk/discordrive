/* Hallmark · genre: modern-minimal · macrostructure: App-shell (custom) · theme: Cobalt
 * design-system: design.md · designed-as-app · nav: sidebar (restyled) + ⌘K palette
 */
import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router";
import { Command, Files, Menu, Settings, ShieldCheck, X } from "lucide-react";
import { useAuthStore } from "../../stores/auth.js";
import { CommandPalette } from "./CommandPalette.js";
import { ColorModeToggle } from "./ColorModeToggle.js";

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
    <nav className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-3">
      {links.map((link) => {
        const Icon = link.icon;
        return (
          <Link
            key={link.to}
            to={link.to}
            onClick={onNavigate}
            className={`flex items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium transition-colors duration-short ease-out ${
              link.active
                ? "bg-paper-2 text-ink"
                : "text-ink-2 hover:bg-paper-2 hover:text-ink"
            }`}
          >
            <Icon size={17} strokeWidth={1.75} className={link.active ? "text-accent" : "text-muted"} />
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
    <div className="mt-auto shrink-0 border-t border-rule bg-paper p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <p className="min-w-0 truncate font-mono text-xs text-muted">{user?.email}</p>
        <ColorModeToggle />
      </div>
      <button
        onClick={logout}
        className="w-full rounded-md border border-rule-2 px-3 py-2.5 text-left text-sm text-ink-2 transition-colors duration-short ease-out hover:border-rule-2 hover:bg-paper-2 hover:text-ink"
      >
        Log out
      </button>
    </div>
  );
}

function PaletteTrigger({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="mx-3 mt-3 flex shrink-0 items-center gap-2 rounded-md border border-rule-2 px-3 py-2 text-left text-sm text-muted transition-colors duration-short ease-out hover:border-accent hover:text-ink-2"
    >
      <Command size={14} strokeWidth={1.75} />
      <span className="flex-1 truncate">Jump to…</span>
      <kbd className="rounded-chip border border-rule-2 px-1.5 py-0.5 font-mono text-[0.6875rem] text-muted">⌘K</kbd>
    </button>
  );
}

function MobileTopbar({ onMenuOpen, onPaletteOpen }: { onMenuOpen: () => void; onPaletteOpen: () => void }) {
  return (
    <header className="sticky top-0 z-sticky flex h-14 items-center justify-between border-b border-rule bg-paper px-4 md:hidden">
      <button
        onClick={onMenuOpen}
        className="inline-flex h-10 w-10 items-center justify-center rounded-md text-ink-2 transition-colors duration-short ease-out hover:bg-paper-2 hover:text-ink"
        aria-label="Open navigation menu"
      >
        <Menu size={20} strokeWidth={1.75} />
      </button>
      <h1 className="font-display text-base font-semibold text-ink">DiscorDrive</h1>
      <button
        onClick={onPaletteOpen}
        className="inline-flex h-10 w-10 items-center justify-center rounded-md text-ink-2 transition-colors duration-short ease-out hover:bg-paper-2 hover:text-ink"
        aria-label="Open command palette"
      >
        <Command size={18} strokeWidth={1.75} />
      </button>
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
      className={`fixed inset-0 z-modal md:hidden ${open ? "pointer-events-auto" : "pointer-events-none"}`}
      aria-hidden={!open}
    >
      <div
        className={`absolute inset-0 bg-ink/40 transition-opacity duration-short ease-out ${
          open ? "opacity-100" : "opacity-0"
        }`}
        onClick={onClose}
      />
      <aside
        className={`absolute left-0 top-0 flex h-full w-72 max-w-[85vw] flex-col border-r border-rule bg-paper shadow-[0_1px_2px_oklch(24%_0.02_258/0.08)] transition-transform duration-short ease-out ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-rule p-4">
          <h2 className="font-display text-lg font-semibold text-ink">DiscorDrive</h2>
          <button
            onClick={onClose}
            className="inline-flex h-10 w-10 items-center justify-center rounded-md text-muted transition-colors duration-short ease-out hover:bg-paper-2 hover:text-ink"
            aria-label="Close navigation menu"
          >
            <X size={20} strokeWidth={1.75} />
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
  const [paletteOpen, setPaletteOpen] = useState(false);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((open) => !open);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <div className="min-h-screen bg-paper text-ink-2 md:flex">
      <MobileTopbar onMenuOpen={() => setDrawerOpen(true)} onPaletteOpen={() => setPaletteOpen(true)} />
      <MobileDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} pathname={location.pathname} />

      <aside className="hidden w-64 shrink-0 flex-col border-r border-rule bg-paper md:sticky md:top-0 md:flex md:h-screen">
        <div className="shrink-0 border-b border-rule p-4">
          <h1 className="font-display text-lg font-semibold text-ink">DiscorDrive</h1>
        </div>
        <PaletteTrigger onOpen={() => setPaletteOpen(true)} />
        <SidebarNavigation pathname={location.pathname} />
        <SidebarFooter />
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">{children}</main>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  );
}
