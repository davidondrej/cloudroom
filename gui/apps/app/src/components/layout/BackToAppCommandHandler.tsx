import { useNavigate } from "react-router";
import { useAppCommandHandler } from "@/components/commands/AppCommandProvider";

export function BackToAppCommandHandler({ routePath }: { routePath: string }) {
  const navigate = useNavigate();

  useAppCommandHandler("app.back", () => {
    void navigate(routePath);
    return true;
  });

  return null;
}
