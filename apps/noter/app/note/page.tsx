"use client";

/**
 * Note List Route
 *
 * Default note view - redirects to first note or shows empty state.
 */

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useNoteList } from "@/feature/note/hook/use-note-list";
import { useAuth } from "@/feature/auth";
import { Button } from "@/shared/components/ui/button";
import { FileText, Loader2 } from "lucide-react";

export default function NotePage() {
  const { notes, isLoading, createNote, isCreating } = useNoteList();
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!authLoading && !isAuthenticated) {
      router.replace("/");
    }
  }, [authLoading, isAuthenticated, router]);

  useEffect(() => {
    // Redirect to first note if available
    if (!isLoading && notes.length > 0) {
      router.push(`/note/${notes[0].id}`);
    }
  }, [notes, isLoading, router]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // Empty state
  if (notes.length === 0) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="text-center space-y-4 max-w-md">
          <FileText className="h-16 w-16 mx-auto text-muted-foreground" />
          <h2 className="text-2xl font-bold">No notes yet</h2>
          <p className="text-muted-foreground">
            Create your first note to start capturing memories with AI-powered
            detection
          </p>
          <Button
            onClick={async () => {
              const note = await createNote({
                title: "New Note",
                content: {
                  root: {
                    children: [
                      {
                        children: [],
                        direction: null,
                        format: "",
                        indent: 0,
                        type: "paragraph",
                        version: 1,
                      },
                    ],
                    direction: null,
                    format: "",
                    indent: 0,
                    type: "root",
                    version: 1,
                  },
                },
                plainText: "",
              });
              router.push(`/note/${note.id}`);
            }}
            disabled={isCreating}
            size="lg"
          >
            {isCreating ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                Creating...
              </>
            ) : (
              "Create Your First Note"
            )}
          </Button>
        </div>
      </div>
    );
  }

  // Redirecting...
  return (
    <div className="flex items-center justify-center h-screen">
      <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
    </div>
  );
}
