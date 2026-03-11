/**
 * Tool State Badge
 *
 * Displays tool execution state with icon and label
 */

import type { ToolUIPart } from "ai";
import { Badge } from "@/shared/components/ui/badge";
import { CheckCircle, XCircle, Loader2, AlertCircle } from "lucide-react";

type ToolBadgeProps = {
  toolName: string;
  state: ToolUIPart["state"];
  className?: string;
};

export function ToolBadge({ toolName, state, className }: ToolBadgeProps) {
  const getStateIcon = () => {
    switch (state) {
      case "input-streaming":
      case "input-available":
        return <Loader2 className="h-3 w-3 animate-spin" />;
      case "output-available":
        return <CheckCircle className="h-3 w-3" />;
      case "output-error":
        return <XCircle className="h-3 w-3" />;
      default:
        return null;
    }
  };

  const getVariant = (): "default" | "secondary" | "destructive" | "outline" => {
    if (state === "output-error") return "destructive";
    return "secondary";
  };

  return (
    <Badge variant={getVariant()} className={className}>
      {getStateIcon()}
      {toolName}
    </Badge>
  );
}
