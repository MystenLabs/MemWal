"use client";

import { Button } from "@/shared/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/shared/components/ui/dropdown-menu";
import { trpc } from "@/shared/lib/trpc/client";
import { cn } from "@/shared/lib/utils";
import { MessageSquare, PanelLeft, Plus, Trash2 } from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { uuidv7 } from "uuidv7";

export function SidebarFloat() {
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
    <div className="fixed top-4 left-4 z-40">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="icon" variant="secondary" className="size-9">
            <PanelLeft className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64 max-h-80 overflow-y-auto">
          <DropdownMenuItem onClick={handleNewChat}>
            <Plus className="size-4" />
            New Chat
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {chats?.map((chat) => (
            <DropdownMenuItem
              key={chat.id}
              className={cn("group cursor-pointer", currentChatId === chat.id && "bg-accent")}
              onClick={() => router.push(`/ai/${chat.id}`)}
            >
              <MessageSquare className="size-4 shrink-0 text-muted-foreground" />
              <span className="flex-1 truncate">
                {chat.title || "New Chat"}
              </span>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 shrink-0 opacity-0 group-hover:opacity-100 hover:bg-destructive/10 hover:text-destructive"
                onClick={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  deleteChat.mutate({ id: chat.id });
                }}
              >
                <Trash2 className="size-3" />
              </Button>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
