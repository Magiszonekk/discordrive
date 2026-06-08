import { Routes, Route, Navigate } from "react-router";
import { useAuthStore } from "./stores/auth.js";
import { Login } from "./pages/Login.js";
import { Register } from "./pages/Register.js";
import { Dashboard } from "./pages/Dashboard.js";
import { SharedFile } from "./pages/SharedFile.js";
import { Settings } from "./pages/Settings.js";
import { HealthCheck } from "./pages/HealthCheck.js";
import { Unlock } from "./pages/Unlock.js";
import { MainLayout } from "./components/layout/MainLayout.js";
import { NotificationToasts } from "./components/layout/NotificationToasts.js";

function isTokenExpired(token: string): boolean {
  try {
    const payload = JSON.parse(atob(token.split(".")[1]!));
    return typeof payload.exp === "number" && payload.exp * 1000 < Date.now();
  } catch {
    return true;
  }
}

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const token = useAuthStore((s) => s.token);
  const ark = useAuthStore((s) => s.ark);
  const logout = useAuthStore((s) => s.logout);

  if (!token || isTokenExpired(token)) {
    if (token) logout();
    return <Navigate to="/login" replace />;
  }

  if (!ark) {
    return <Unlock />;
  }

  return <>{children}</>;
}

export function App() {
  return (
    <>
      <NotificationToasts />
      <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
      <Route path="/share/:shareId" element={<SharedFile />} />
      <Route
        path="/*"
        element={
          <ProtectedRoute>
            <MainLayout>
              <Routes>
                <Route path="/" element={<Dashboard />} />
                <Route path="/folder/:folderId" element={<Dashboard />} />
                <Route path="/settings" element={<Settings />} />
                <Route path="/health" element={<HealthCheck />} />
              </Routes>
            </MainLayout>
          </ProtectedRoute>
        }
      />
    </Routes>
    </>
  );
}
