"use client";

import { useEffect } from "react";
import { useSWRConfig } from "swr";
import { unstable_serialize } from "swr/infinite";
import { useDataStream } from "./data-stream-provider";
import { useSourceProcessing } from "../chat/source-processing-provider";
import { getChatHistoryPaginationKey } from "../sidebar/sidebar-history";

export function DataStreamHandler() {
  const { dataStream, setDataStream } = useDataStream();
  const { mutate } = useSWRConfig();
  const { pushEvent } = useSourceProcessing();

  useEffect(() => {
    if (!dataStream?.length) {
      return;
    }

    const newDeltas = dataStream.slice();
    setDataStream([]);

    for (const delta of newDeltas) {
      // Handle chat title updates
      if (delta.type === "data-chat-title") {
        mutate(unstable_serialize(getChatHistoryPaginationKey));
        continue;
      }

      // Handle source processing events
      if (delta.type === "data-source-processing") {
        const data = delta.data as { label: string };
        pushEvent({ type: "processing", label: data.label });
        continue;
      }

      if (delta.type === "data-source-processed") {
        const data = delta.data as { title: string; chunkCount: number; sourceId: string };
        pushEvent({
          type: "processed",
          label: data.title,
          title: data.title,
          chunkCount: data.chunkCount,
          sourceId: data.sourceId,
        });
        continue;
      }

      if (delta.type === "data-source-error") {
        const data = delta.data as { label: string; error: string };
        pushEvent({ type: "error", label: data.label, error: data.error });
        continue;
      }

      if (delta.type === "data-sources-done") {
        const data = delta.data as { count: number };
        pushEvent({ type: "done", count: data.count });
        mutate("/api/research/sources");
        continue;
      }
    }
  }, [dataStream, setDataStream, mutate, pushEvent]);

  return null;
}
