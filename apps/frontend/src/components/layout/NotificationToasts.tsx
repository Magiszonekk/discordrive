import { useEffect } from "react";
import { useNotificationStore } from "../../stores/notifications.js";

const toneClasses: Record<string, string> = {
  success: "border-emerald-500/30 bg-emerald-500/10 text-emerald-200",
  error: "border-red-500/30 bg-red-500/10 text-red-200",
  info: "border-blue-500/30 bg-blue-500/10 text-blue-200",
};

export function NotificationToasts() {
  const notifications = useNotificationStore((s) => s.notifications);
  const remove = useNotificationStore((s) => s.remove);

  useEffect(() => {
    if (notifications.length === 0) return;

    const timers = notifications.map((item) =>
      window.setTimeout(() => remove(item.id), 3500),
    );

    return () => {
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, [notifications, remove]);

  return (
    <div className="pointer-events-none fixed right-4 top-4 z-[100] flex w-full max-w-sm flex-col gap-2">
      {notifications.map((item) => (
        <div
          key={item.id}
          data-testid={`toast-${item.kind}`}
          className={`pointer-events-auto rounded-xl border px-4 py-3 text-sm shadow-lg backdrop-blur ${toneClasses[item.kind] ?? toneClasses.info}`}
        >
          {item.message}
        </div>
      ))}
    </div>
  );
}
