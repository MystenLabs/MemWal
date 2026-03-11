"use client";

import { useRouter, useParams } from "next/navigation";
import { trpc } from "@/shared/lib/trpc/client";
import { Button } from "@/shared/components/ui/button";
import { ScrollArea } from "@/shared/components/ui/scroll-area";
import { Plus, MessageSquare, Trash2 } from "lucide-react";
import { cn } from "@/shared/lib/utils";
import { uuidv7 } from "uuidv7";

export function ChatSidebar() {
  const router = useRouter();
  const params = useParams();
  const currentChatId = params?.id as string | undefined;

  const { data: chats, refetch } = trpc.chat.list.useQuery();
  const createChat = trpc.chat.create.useMutation({
    onSuccess: (chat) => {
      refetch();
      router.push(`/ai/${chat.id}`);
    },
  });
  const deleteChat = trpc.chat.delete.useMutation({
    onSuccess: () => {
      refetch();
      if (currentChatId) {
        router.push("/ai");
      }
    },
  });

  const handleNewChat = () => {
    const id = uuidv7();
    createChat.mutate({ id });
  };

  return (
    <div className="flex h-full w-64 flex-col border-r bg-muted/30">
      <div className="p-3">
        <Button
          onClick={handleNewChat}
          className="w-full justify-start gap-2"
          variant="outline"
        >
          <Plus className="h-4 w-4" />
          New Chat
        </Button>
      </div>

      <ScrollArea className="flex-1 px-2">
        <div className="space-y-1 py-2">
          {chats?.map((chat) => (
            <div
              key={chat.id}
              className={cn(
                "group flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors hover:bg-accent cursor-pointer",
                currentChatId === chat.id && "bg-accent"
              )}
              onClick={() => router.push(`/ai/${chat.id}`)}
            >
              <MessageSquare className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="flex-1 truncate">
                {chat.title || "New Chat"}
              </span>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 opacity-0 group-hover:opacity-100"
                onClick={(e) => {
                  e.stopPropagation();
                  deleteChat.mutate({ id: chat.id });
                }}
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            </div>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}
