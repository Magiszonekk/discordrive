import { Monitor, Moon, Sun } from "lucide-react";
import { useColorModeStore, type ColorMode } from "../../stores/colorMode.js";

const OPTIONS: { mode: ColorMode; label: string; icon: typeof Sun }[] = [
  { mode: "light", label: "Light", icon: Sun },
  { mode: "dark", label: "Dark", icon: Moon },
  { mode: "system", label: "System", icon: Monitor },
];

export function ColorModeToggle({ className }: { className?: string }) {
  const mode = useColorModeStore((s) => s.mode);
  const setMode = useColorModeStore((s) => s.setMode);

  return (
    <div
      role="radiogroup"
      aria-label="Colour mode"
      className={`inline-flex items-center gap-0.5 rounded-md border border-rule-2 p-0.5 ${className ?? ""}`}
    >
      {OPTIONS.map(({ mode: optionMode, label, icon: Icon }) => {
        const active = mode === optionMode;
        return (
          <button
            key={optionMode}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={label}
            title={label}
            onClick={() => setMode(optionMode)}
            className={`inline-flex h-7 w-7 items-center justify-center rounded transition-colors duration-micro ease-out ${
              active ? "bg-paper-2 text-accent" : "text-muted hover:text-ink-2"
            }`}
          >
            <Icon size={14} strokeWidth={1.75} />
          </button>
        );
      })}
    </div>
  );
}
