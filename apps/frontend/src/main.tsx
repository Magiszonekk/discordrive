import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router";
import { App } from "./App.js";
import { restoreSession } from "./stores/auth.js";
import "./index.css";

// Register decryption proxy Service Worker
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/ddv4-sw.js").catch(() => {
    // SW registration may fail in unsupported environments — non-critical
  });
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
    },
  },
});

// Restore session before mounting app (prevents flash of login page on HMR/reload)
restoreSession().finally(() => {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </QueryClientProvider>
    </StrictMode>,
  );
});
