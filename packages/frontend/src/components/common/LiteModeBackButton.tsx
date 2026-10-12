import { useNavigate } from "react-router-dom";
import { useBackNavigation } from "@/hooks/use-navigation-trail";
import { useUIStore } from "@/stores/ui";
import { PageBackButton } from "./PageBackButton";

/** Work Session pages: the dashboard and AI conversations. */
function isWorkSessionPage(pageKey: string | null) {
  return pageKey === "dashboard" || Boolean(pageKey?.startsWith("ai-chat|"));
}

export function LiteModeBackButton() {
  const aiLiteMode = useUIStore((state) => state.aiLiteMode);
  const navigate = useNavigate();
  const { previousPageKey, goBack } = useBackNavigation();

  if (!aiLiteMode) return null;

  // Always lands on the Work Session; through the trail when the user came from there, so the
  // conversation they had open comes back.
  return (
    <PageBackButton
      label="Back to Work Session"
      followTrail={false}
      onClick={() => {
        if (isWorkSessionPage(previousPageKey) && goBack()) return;
        navigate("/");
      }}
    />
  );
}
