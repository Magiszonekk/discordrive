import { create } from "zustand";

export interface NotificationItem {
  id: string;
  kind: "success" | "error" | "info";
  message: string;
}

interface NotificationState {
  notifications: NotificationItem[];
  push: (kind: NotificationItem["kind"], message: string) => string;
  remove: (id: string) => void;
}

export const useNotificationStore = create<NotificationState>((set) => ({
  notifications: [],
  push: (kind, message) => {
    const id = crypto.randomUUID();
    set((state) => ({
      notifications: [...state.notifications, { id, kind, message }],
    }));
    return id;
  },
  remove: (id) => {
    set((state) => ({
      notifications: state.notifications.filter((item) => item.id !== id),
    }));
  },
}));
