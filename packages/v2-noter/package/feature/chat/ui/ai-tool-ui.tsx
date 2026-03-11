/**
 * AI Tool UI Router
 *
 * Routes tool invocations to their specific UI components
 */

import type { ToolUIPart, DynamicToolUIPart } from "ai";
import { getToolName } from "ai";
import { ToolGetUserInfo } from "./tools/tool-get-user-info";
import { ToolGetBalances } from "./tools/tool-get-balances";
import { ToolGetTransactions } from "./tools/tool-get-transactions";
import { ToolGetCoinHistory } from "./tools/tool-get-coin-history";
import { ToolShowDiagram } from "./tools/tool-show-diagram";
import { ToolBadge } from "./tool-badge";

type ToolUIProps = {
  tool: ToolUIPart | DynamicToolUIPart;
};

export function ToolUI({ tool }: ToolUIProps) {
  const toolName = getToolName(tool as any);
  const { state } = tool;
  const output = "output" in tool ? tool.output : undefined;
  const errorText = "errorText" in tool ? tool.errorText : undefined;

  // Show badge for non-completed states
  if (state !== "output-available" && state !== "output-error") {
    return <ToolBadge toolName={toolName} state={state} />;
  }

  // Error state
  if (state === "output-error" && errorText) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-3 dark:border-red-900 dark:bg-red-950/30">
        <div className="flex items-center gap-2 text-sm text-red-800 dark:text-red-300">
          <span>✗</span>
          <span className="font-medium">{toolName} failed:</span>
          <span>{errorText}</span>
        </div>
      </div>
    );
  }

  // Route to specific tool UI components for successful executions
  switch (toolName) {
    case "getUserInfo":
      return output ? <ToolGetUserInfo output={output as any} /> : null;

    case "getBalances":
      return output ? <ToolGetBalances output={output as any} /> : null;

    case "getTransactions":
      return output ? <ToolGetTransactions output={output as any} /> : null;

    case "getCoinHistory":
      return output ? <ToolGetCoinHistory output={output as any} /> : null;

    case "showDiagram":
      return output ? <ToolShowDiagram output={output as any} /> : null;

    // Add more tool renderers here as you add tools
    // case 'calculate':
    //   return output ? <ToolCalculate output={output as any} /> : null;

    default:
      // Fallback: show generic completed badge
      return <ToolBadge toolName={toolName} state={state} />;
  }
}
