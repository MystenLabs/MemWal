/**
 * ShowDiagram Tool UI
 *
 * Displays educational flow diagrams
 */

"use client";

import type { ShowDiagramOutput } from "@/shared/lib/ai/tools";

type ToolShowDiagramProps = {
  output: ShowDiagramOutput;
};

export function ToolShowDiagram({ output }: ToolShowDiagramProps) {
  return (
    <div className="space-y-2">
      {/* Title as link */}
      <a
        href={output.docsUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-block font-medium text-sm hover:underline hover:text-primary transition-colors"
      >
        {output.title}
      </a>

      {/* SVG Diagram */}
      <div className="w-full overflow-x-auto">
        <img
          src={output.svgPath}
          alt={output.title}
          className="w-full h-auto rounded-lg"
          style={{ minWidth: '700px' }}
        />
      </div>
    </div>
  );
}

// Keep the old export name for backward compatibility
export { ToolShowDiagram as ToolShowZkLoginDiagram };
