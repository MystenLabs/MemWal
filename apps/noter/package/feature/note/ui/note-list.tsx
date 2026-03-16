"use client";

/**
 * Note List Component
 *
 * Sidebar showing all user notes with create/delete actions.
 * Supports navigation between notes.
 */

import { Button } from "@/shared/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/shared/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/shared/components/ui/alert-dialog";
import { Input } from "@/shared/components/ui/input";
import { formatDistance } from "date-fns";
import { Loader2, Plus, MoreVertical, Pencil, Trash2 } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { generateNoteTitle } from "../domain/note";
import { useNoteList } from "../hook/use-note-list";
import { trpc } from "@/shared/lib/trpc/client";
export function NoteList() {
  const { notes, createNote, deleteNote, isLoading, isCreating } = useNoteList();
  const router = useRouter();
  const params = useParams();
  const currentNoteId = params.id as string | undefined;
  const utils = trpc.useUtils();

  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [noteToDelete, setNoteToDelete] = useState<string | null>(null);

  const updateMutation = trpc.note.update.useMutation({
    onSuccess: (updatedNote) => {
      // Invalidate the list query to refresh the sidebar
      utils.note.list.invalidate();

      // Invalidate the specific note query if it's open
      utils.note.get.invalidate({ id: updatedNote.id });

      setEditingNoteId(null);
      toast.success("Note renamed");
    },
    onError: (error) => {
      toast.error(`Failed to rename note: ${error.message}`);
    },
  });

  const handleCreateNote = async () => {
    try {
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
    } catch (error) {
      console.error("Failed to create note:", error);
      toast.error("Failed to create note");
    }
  };

  const handleStartEdit = (noteId: string, currentTitle: string) => {
    setEditingNoteId(noteId);
    setEditingTitle(currentTitle);
  };

  const handleSaveEdit = async (noteId: string) => {
    const trimmedTitle = editingTitle.trim();

    // Validation: empty title
    if (!trimmedTitle) {
      toast.error("Note title cannot be empty");
      return;
    }

    // Validation: title length
    if (trimmedTitle.length > 200) {
      toast.error("Note title is too long (max 200 characters)");
      return;
    }

    // Check if title actually changed
    const currentNote = notes.find(n => n.id === noteId);
    const currentTitle = currentNote?.title || generateNoteTitle(currentNote?.plainText || "");

    if (trimmedTitle === currentTitle) {
      // No changes, just exit edit mode
      setEditingNoteId(null);
      return;
    }

    // Save the change
    try {
      await updateMutation.mutateAsync({
        id: noteId,
        title: trimmedTitle,
      });
    } catch (error) {
      // Error is handled by mutation's onError callback
      console.error("Failed to save note title:", error);
    }
  };

  const handleCancelEdit = () => {
    setEditingNoteId(null);
    setEditingTitle("");
  };

  const handleDeleteClick = (noteId: string) => {
    setNoteToDelete(noteId);
    setDeleteDialogOpen(true);
  };

  const handleConfirmDelete = async () => {
    if (!noteToDelete) return;

    try {
      await deleteNote({ id: noteToDelete });

      // Invalidate cache for the deleted note
      utils.note.get.invalidate({ id: noteToDelete });

      // The note.list.invalidate() is already called in useNoteList hook

      // If we deleted the current note, navigate to notes list
      if (noteToDelete === currentNoteId) {
        router.push("/note");
      }

      toast.success("Note deleted");
      setDeleteDialogOpen(false);
      setNoteToDelete(null);
    } catch (error) {
      console.error("Failed to delete note:", error);
      toast.error("Failed to delete note");
    }
  };

  if (isLoading) {
    return (
      <div className="w-64 border-r flex items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="w-64 border-r flex flex-col h-full">
      {/* Header */}
      <div className="p-4 border-b">
        <Button
          onClick={handleCreateNote}
          disabled={isCreating}
          className="w-full"
          size="sm"
        >
          {isCreating ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
              Creating...
            </>
          ) : (
            <>
              <Plus className="h-4 w-4 mr-2" />
              New Note
            </>
          )}
        </Button>
      </div>

      {/* Note List */}
      <div className="flex-1 overflow-auto p-2 space-y-1">
        {notes.length === 0 ? (
          <div className="p-4 text-center text-sm text-muted-foreground">
            No notes yet. Create one to get started!
          </div>
        ) : (
          notes.map((note) => {
            const title = note.title || generateNoteTitle(note.plainText);
            const isActive = note.id === currentNoteId;
            const isEditing = editingNoteId === note.id;

            return (
              <div
                key={note.id}
                className={`group rounded-lg transition-colors ${isActive
                    ? "bg-accent text-accent-foreground"
                    : "hover:bg-accent/50"
                  }`}
              >
                {isEditing ? (
                  // Edit mode
                  <div className="px-3 py-2 space-y-2">
                    <Input
                      value={editingTitle}
                      onChange={(e) => setEditingTitle(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          handleSaveEdit(note.id);
                        } else if (e.key === "Escape") {
                          e.preventDefault();
                          handleCancelEdit();
                        }
                      }}
                      className="h-7 text-sm"
                      autoFocus
                      maxLength={200}
                      placeholder="Note title"
                    />
                    {editingTitle.trim().length === 0 && (
                      <p className="text-xs text-red-500">Title cannot be empty</p>
                    )}
                    {editingTitle.length > 200 && (
                      <p className="text-xs text-red-500">Title is too long</p>
                    )}
                    <div className="flex gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => handleSaveEdit(note.id)}
                        disabled={
                          updateMutation.isPending ||
                          !editingTitle.trim() ||
                          editingTitle.length > 200
                        }
                        className="h-6 text-xs flex-1"
                      >
                        {updateMutation.isPending ? "Saving..." : "Save"}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={handleCancelEdit}
                        disabled={updateMutation.isPending}
                        className="h-6 text-xs flex-1"
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  // View mode
                  <div className="flex items-start gap-1">
                    <Link
                      href={`/note/${note.id}`}
                      className="flex-1 px-3 py-1.5"
                    >
                      <div className="font-medium text-sm truncate">{title}</div>
                      <div className="text-xs text-muted-foreground mt-1">
                        {formatDistance(new Date(note.updatedAt), new Date(), {
                          addSuffix: true,
                        })}
                      </div>
                      {(note as any).memoryCount && (note as any).memoryCount > 0 && (
                        <div className="text-xs text-muted-foreground mt-1">
                          {(note as any).memoryCount}{" "}
                          {(note as any).memoryCount === 1 ? "memory" : "memories"}
                        </div>
                      )}
                    </Link>

                    {/* Actions dropdown */}
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 w-8 p-0 my-1 mr-1 opacity-0 group-hover:opacity-100 transition-opacity"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <MoreVertical className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          onClick={(e) => {
                            e.preventDefault();
                            handleStartEdit(note.id, title);
                          }}
                        >
                          <Pencil className="h-4 w-4 mr-2" />
                          Rename
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={(e) => {
                            e.preventDefault();
                            handleDeleteClick(note.id);
                          }}
                          className="text-red-600 focus:text-red-600"
                        >
                          <Trash2 className="h-4 w-4 mr-2" />
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Note?</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. This will permanently delete the note
              and all its memories.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmDelete}
              className="bg-red-600 hover:bg-red-700"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
