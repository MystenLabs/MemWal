"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/components/ui/select";
import { MODELS } from "@/shared/lib/ai/constant";
import { useAtom } from "jotai";
import { modelAtom } from "../state/atom";

export function ModelSelector() {
  const [model, setModel] = useAtom(modelAtom);

  return (
    <Select value={model} onValueChange={setModel}>
      <SelectTrigger className="h-8! outline-none border-none w-[180px] shrink-0">
        <SelectValue placeholder="Select model" />
      </SelectTrigger>
      <SelectContent>
        {MODELS.map((m) => (
          <SelectItem key={m.id} value={m.id}>
            <span className="flex items-center gap-2">
              <span>{m.name}</span>
              {/* <span className="text-xs text-muted-foreground">
                {m.provider}
              </span> */}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
