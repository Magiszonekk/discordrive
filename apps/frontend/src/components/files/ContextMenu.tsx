import { useEffect, useRef } from "react";

interface MenuItem {
  label: string;
  onClick: () => void;
  danger?: boolean;
}

interface Props {
  items: MenuItem[];
  onClose: () => void;
  position?: { x: number; y: number };
}

export function ContextMenu({ items, onClose, position }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [onClose]);

  const style = position
    ? { position: "fixed" as const, left: position.x, top: position.y }
    : {};

  return (
    <div
      ref={ref}
      style={style}
      className="bg-zinc-800 border border-zinc-700 rounded-lg shadow-xl py-1 min-w-[140px] z-50"
    >
      {items.map((item) => (
        <button
          key={item.label}
          onClick={() => {
            item.onClick();
            onClose();
          }}
          className={`w-full text-left px-3 py-1.5 text-sm hover:bg-zinc-700 ${
            item.danger ? "text-red-400 hover:text-red-300" : "text-zinc-300 hover:text-white"
          }`}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
