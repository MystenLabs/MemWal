"use client";

import { Button } from "@/shared/components/ui/button";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@/shared/components/ui/toggle-group";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/shared/components/ui/tooltip";
import { cn } from "@/shared/lib/utils";
import { Minus } from "lucide-react";
import { useTheme } from "next-themes";

interface AppearanceFloatPanelProps {
  className: string;
  onClose: () => void;
}

export function AppearanceFloatPanel({
  className,
  onClose,
}: AppearanceFloatPanelProps) {
  const { theme, setTheme } = useTheme();

  return (
    <div className={cn(className, "w-full max-w-sm")}>
      <div className="flex items-center justify-between p-1 shrink-0">
        <Button
          variant="secondary"
          size="sm"
          className="h-7 px-2 font-medium pointer-events-none"
        >
          Appearance
        </Button>
        <div className="flex items-center">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" onClick={onClose}>
                <Minus className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Minimize</TooltipContent>
          </Tooltip>
        </div>
      </div>
      <div className="px-1 pb-1">
        <ToggleGroup
          type="single"
          value={theme ?? "system"}
          onValueChange={(value) => {
            if (value) setTheme(value);
          }}
          variant="outline"
          className="w-full justify-start"
        >
          <ToggleGroupItem value="light" className="flex-1">
            Light
          </ToggleGroupItem>
          <ToggleGroupItem value="dark" className="flex-1">
            Dark
          </ToggleGroupItem>
          <ToggleGroupItem value="system" className="flex-1">
            System
          </ToggleGroupItem>
        </ToggleGroup>
      </div>
    </div>
  );
}
