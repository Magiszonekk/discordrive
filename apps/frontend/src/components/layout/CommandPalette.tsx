import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { Files, Folder, LogOut, Settings, ShieldCheck } from "lucide-react";
import { useAuthStore } from "../../stores/auth.js";
import { useCommandPaletteStore } from "../../stores/commandPalette.js";

interface StaticCommand {
  id: string;
  label: string;
  hint: string;
  icon: typeof Files;
  run: (navigate: ReturnType<typeof useNavigate>, logout: () => void) => void;
}

const STATIC_COMMANDS: StaticCommand[] = [
  { id: "go-files", label: "Go to Files", hint: "root", icon: Files, run: (nav) => nav("/") },
  { id: "go-health", label: "Go to Healthcheck", hint: "page", icon: ShieldCheck, run: (nav) => nav("/health") },
  { id: "go-settings", label: "Go to Settings", hint: "page", icon: Settings, run: (nav) => nav("/settings") },
  { id: "log-out", label: "Log out", hint: "session", icon: LogOut, run: (_nav, logout) => logout() },
];

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const navigate = useNavigate();
  const logout = useAuthStore((s) => s.logout);
  const items = useCommandPaletteStore((s) => s.items);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      setQuery("");
      setActiveIndex(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const fileResults = q
      ? items
          .filter((item) => item.name.toLowerCase().includes(q))
          .slice(0, 6)
          .map((item) => ({
            id: `item-${item.id}`,
            label: item.name,
            hint: item.kind,
            icon: item.kind === "folder" ? Folder : Files,
            run: (nav: ReturnType<typeof useNavigate>) =>
              nav(item.kind === "folder" ? `/folder/${item.id}` : `/`),
          }))
      : [];
    const commandResults = q
      ? STATIC_COMMANDS.filter((c) => c.label.toLowerCase().includes(q))
      : STATIC_COMMANDS;
    return [...fileResults, ...commandResults];
  }, [query, items]);

  useEffect(() => setActiveIndex(0), [query]);

  function runMatch(index: number) {
    const match = matches[index];
    if (!match) return;
    match.run(navigate, logout);
    onClose();
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, matches.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      runMatch(activeIndex);
    }
  }

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === dialogRef.current) onClose();
      }}
      aria-label="Command palette"
      className="m-auto w-full max-w-lg rounded-card border border-rule bg-paper p-0 text-ink-2 shadow-[0_1px_2px_oklch(24%_0.02_258/0.08)] backdrop:bg-ink/40"
    >
      <div className="flex items-center gap-2 border-b border-rule px-4 py-3">
        <span aria-hidden="true" className="font-mono text-xs text-muted">⌘K</span>
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Jump to a folder, file, or page…"
          className="min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-muted"
          aria-label="Search commands and files"
        />
        <kbd className="rounded-chip border border-rule-2 px-1.5 py-0.5 font-mono text-[0.6875rem] text-muted">Esc</kbd>
      </div>
      <ul role="listbox" className="max-h-80 overflow-y-auto p-2">
        {matches.length === 0 && (
          <li className="px-3 py-6 text-center text-sm text-muted">No matches.</li>
        )}
        {matches.map((match, index) => {
          const Icon = match.icon;
          return (
            <li key={match.id} role="option" aria-selected={index === activeIndex}>
              <button
                type="button"
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => runMatch(index)}
                className={`flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left text-sm transition-colors duration-micro ease-out ${
                  index === activeIndex ? "bg-paper-2 text-ink" : "text-ink-2"
                }`}
              >
                <Icon size={16} className="shrink-0 text-muted" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">{match.label}</span>
                <span className="font-mono text-[0.6875rem] uppercase tracking-wide text-muted">{match.hint}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </dialog>
  );
}
