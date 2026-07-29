import { useEffect } from "react";
import { useNotificationStore } from "../../stores/notifications.js";

const toneClasses: Record<string, string> = {
  success: "border-l-success",
  error: "border-l-error",
  info: "border-l-accent",
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
    <div className="pointer-events-none fixed right-4 top-4 z-toast flex w-full max-w-sm flex-col gap-2">
      {notifications.map((item) => (
        <div
          key={item.id}
          data-testid={`toast-${item.kind}`}
          className={`pointer-events-auto rounded-card border border-l-2 border-rule bg-paper px-4 py-3 text-sm text-ink-2 shadow-lg backdrop-blur ${toneClasses[item.kind] ?? toneClasses.info}`}
        >
          {item.message}
        </div>
      ))}
    </div>
  );
}
