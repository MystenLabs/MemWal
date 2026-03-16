/**
 * Tools Used Bar
 *
 * Shows badges for all tool invocations with their execution state
 */

import { Badge } from "@/shared/components/ui/badge";
import type { DynamicToolUIPart, ToolUIPart } from "ai";
import { getToolName } from "ai";
import { AlertCircle, CheckCircle, Loader2, XCircle } from "lucide-react";

type ToolsUsedBarProps = {
  toolInvocations: (ToolUIPart | DynamicToolUIPart)[];
};

export function ToolsUsedBar({ toolInvocations }: ToolsUsedBarProps) {
  if (toolInvocations.length === 0) return null;

  const getStateIcon = (tool: ToolUIPart | DynamicToolUIPart) => {
    const Icon = (() => {
      switch (tool.state) {
        case "input-streaming":
        case "input-available":
          return Loader2;
        case "output-available":
          return CheckCircle;
        case "output-error":
          return XCircle;
        default:
          return null;
      }
    })();

    if (!Icon) return null;

    return (
      <Icon
        className={`h-3 w-3 ${tool.state === "input-streaming" || tool.state === "input-available"
          ? "animate-spin"
          : ""
          }`}
      />
    );
  };

  const getVariant = (
    state: ToolUIPart["state"]
  ): "default" | "secondary" | "destructive" | "outline" => {
    if (state === "output-error") return "destructive";
    return "secondary";
  };

  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {toolInvocations.map((tool) => (
        <Badge variant={getVariant(tool.state)} key={tool.toolCallId}>
          {getStateIcon(tool)}
          {getToolName(tool as any)}
        </Badge>
      ))}
    </div>
  );
}
