"use client";

import { GlobeIcon, FileUpIcon, LoaderIcon, XIcon } from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { useSources } from "@/hooks/use-sources";
import { Button } from "../ui/button";

function PureSourceUpload({
  disabled,
}: {
  disabled?: boolean;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { mutate } = useSources();

  // Close popover when clicking outside
  useEffect(() => {
    if (!isOpen) return;
    function handleClickOutside(event: MouseEvent) {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(event.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  const processSource = useCallback(
    async (body: FormData | string) => {
      setIsProcessing(true);
      setIsOpen(false);

      const toastId = toast.loading("Processing source...");

      try {
        const isUrl = typeof body === "string";
        const response = await fetch("/api/research/process-source", {
          method: "POST",
          ...(isUrl
            ? {
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ url: body }),
              }
            : { body }),
        });

        if (!response.ok) {
          const data = await response.json();
          throw new Error(data.message || "Failed to process source");
        }

        const data = await response.json();
        toast.success(`Source processed: ${data.title}`, {
          id: toastId,
          description: `${data.chunkCount} chunks created`,
        });
        mutate();
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Failed to process source",
          { id: toastId },
        );
      } finally {
        setIsProcessing(false);
        setUrl("");
      }
    },
    [mutate],
  );

  const handleUrlSubmit = useCallback(() => {
    const trimmed = url.trim();
    if (!trimmed) return;

    try {
      new URL(trimmed);
    } catch {
      toast.error("Please enter a valid URL");
      return;
    }

    processSource(trimmed);
  }, [url, processSource]);

  const handleFileSelect = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) return;

      if (!file.name.endsWith(".pdf")) {
        toast.error("Only PDF files are supported");
        return;
      }

      const formData = new FormData();
      formData.append("file", file);
      processSource(formData);

      // Reset file input
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    },
    [processSource],
  );

  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        accept=".pdf"
        onChange={handleFileSelect}
        className="hidden"
      />

      <Button
        ref={buttonRef}
        className="aspect-square h-8 rounded-lg p-1 transition-colors hover:bg-accent"
        disabled={disabled || isProcessing}
        onClick={() => setIsOpen(!isOpen)}
        variant="ghost"
        title="Add research source"
      >
        {isProcessing ? (
          <LoaderIcon className="size-[14px] animate-spin" />
        ) : (
          <GlobeIcon size={14} />
        )}
      </Button>

      {isOpen && (
        <div
          ref={popoverRef}
          className="absolute bottom-full left-0 z-50 mb-2 w-[340px] rounded-xl border bg-background p-3 shadow-lg"
        >
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-medium">Add Research Source</span>
            <button
              type="button"
              onClick={() => setIsOpen(false)}
              className="rounded-md p-0.5 text-muted-foreground hover:text-foreground"
            >
              <XIcon className="size-3.5" />
            </button>
          </div>

          <div className="flex gap-1.5">
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="Paste a URL..."
              className="flex-1 rounded-lg border bg-muted px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus:border-primary"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleUrlSubmit();
                }
              }}
              autoFocus
            />
            <Button
              className="h-9 px-3"
              disabled={!url.trim()}
              onClick={handleUrlSubmit}
              size="sm"
            >
              Process
            </Button>
          </div>

          <div className="mt-2 flex items-center gap-2">
            <div className="h-px flex-1 bg-border" />
            <span className="text-xs text-muted-foreground">or</span>
            <div className="h-px flex-1 bg-border" />
          </div>

          <Button
            className="mt-2 w-full gap-2"
            variant="outline"
            size="sm"
            onClick={() => {
              fileInputRef.current?.click();
              setIsOpen(false);
            }}
          >
            <FileUpIcon className="size-4" />
            Upload PDF
          </Button>
        </div>
      )}
    </>
  );
}

export const SourceUpload = memo(PureSourceUpload);
