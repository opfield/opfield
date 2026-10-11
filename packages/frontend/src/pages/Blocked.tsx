import { Ban } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";

export function BlockedPage() {
  const navigate = useNavigate();
  const { user, logout } = useAuthStore();
  const [signingOut, setSigningOut] = useState(false);

  const handleLogout = async () => {
    setSigningOut(true);
    try {
      await api.logout();
    } catch {
      // ignore
    }
    logout();
    setSigningOut(false);
    navigate("/login");
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="flex flex-col items-center gap-4 max-w-sm text-center">
        <div className="h-12 w-12 flex items-center justify-center border border-destructive/30 bg-destructive/5">
          <Ban className="h-6 w-6 text-destructive" />
        </div>
        <h2 className="text-lg font-semibold text-foreground">Access Blocked</h2>
        <p className="text-sm text-muted-foreground">
          Your account{user?.email ? ` (${user.email})` : ""} has been blocked by an administrator.
          Contact your admin if you believe this is an error.
        </p>
        <Button variant="outline" className="mt-2" onClick={handleLogout} pending={signingOut}>
          Sign out
        </Button>
      </div>
    </div>
  );
}
