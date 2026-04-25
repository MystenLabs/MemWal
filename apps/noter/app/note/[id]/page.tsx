"use client";

/**
 * Note Detail Route
 *
 * Individual note editor page.
 * Layout: Note list (left) + Editor (center)
 */

import { NoteEditor } from "@/feature/note/ui/note-editor";
import { NoteList } from "@/feature/note/ui/note-list";
import { useAuth } from "@/feature/auth";
import Image from "next/image";
import { use, useEffect } from "react";
import { useRouter } from "next/navigation";

export default function NoteDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const { isAuthenticated, isLoading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      router.replace("/");
    }
  }, [isLoading, isAuthenticated, router]);

  if (!id || typeof id !== "string") {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="text-red-500">Invalid note ID</div>
      </div>
    );
  }

  return (
    <div className="flex h-screen">
      <Image src="/bgr-3.webp" alt="Noter" fill className="fixed inset-0 -z-10 object-cover invert dark:invert-0 -translate-y-[80vh] background" />

      {/* Left Sidebar - Note List */}
      <NoteList />

      {/* Main Content - Editor */}
      <main className="flex-1 flex flex-col min-w-0">
        <NoteEditor noteId={id} />
      </main>
    </div>
  );
}
