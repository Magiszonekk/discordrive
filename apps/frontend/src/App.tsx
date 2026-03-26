import { Routes, Route, Navigate } from "react-router";
import { useAuthStore } from "./stores/auth.js";
import { Login } from "./pages/Login.js";
import { Register } from "./pages/Register.js";
import { Dashboard } from "./pages/Dashboard.js";
import { SharedFile } from "./pages/SharedFile.js";
import { Settings } from "./pages/Settings.js";
import { Unlock } from "./pages/Unlock.js";
import { MainLayout } from "./components/layout/MainLayout.js";

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const token = useAuthStore((s) => s.token);
  const masterKey = useAuthStore((s) => s.masterKey);

  if (!token) {
    return <Navigate to="/login" replace />;
  }

  // Token restored from localStorage but masterKey lost (in-memory only)
  if (!masterKey) {
    return <Unlock />;
  }

  return <>{children}</>;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
      <Route path="/share/:token" element={<SharedFile />} />
      <Route
        path="/*"
        element={
          <ProtectedRoute>
            <MainLayout>
              <Routes>
                <Route path="/" element={<Dashboard />} />
                <Route path="/folder/:folderId" element={<Dashboard />} />
                <Route path="/settings" element={<Settings />} />
              </Routes>
            </MainLayout>
          </ProtectedRoute>
        }
      />
    </Routes>
  );
}
