---
title: "Delete Old Memories"
description: "Review and permanently delete memories from your Walrus Memory account."
---

## Overview

Walrus Memory lets you review and permanently remove memories you no longer want to store.
Preview your memories first, then delete any you want to clear.

<Warning>
  You cannot undo a deletion. Preview your memories before you delete them.
</Warning>

## Prerequisites

Connect the wallet that owns the memories you want to review. After you connect, the
dashboard opens at `/dashboard`.

## Navigate to the Delete memories panel

On the dashboard, scroll down to the **Delete memories** panel. The panel shows how many
memories your wallet has stored and their current status:

- **Stored**: memories that you can delete.
- **In progress**: memories that you selected for deletion and that Walrus Memory is now
  deleting.
- **Deleted**: memories that Walrus Memory removed.

Each memory appears as a row with these columns:

| **Column** | **Description** |
| --- | --- |
| Select | Checkbox that you use to choose the memory for deletion. |
| Blob | The blob ID of the stored memory. |
| Object | The onchain object ID. |
| Created | The date you stored the memory. |
| State | The memory state, for example `deletable` (recommended). |
| Preview | Opens a preview of the memory content. |

## Preview a memory before deleting

To check what a memory contains before you delete it, select the **Preview** control on its
row. The **Memory preview** window opens and shows the stored content. Close the preview
when you finish.

<Note>
  Previewing helps you confirm that you delete the right memories, because you cannot reverse a
  deletion.
</Note>

## Select memories to delete

Use the checkboxes in the **Select** column to choose the memories you want to delete.

- To select every memory on the current page, choose **Select page**.
- The **Delete selected** button updates to show how many memories you chose, for example
  **Delete selected (4)**.

## Delete memories

You can delete your selected memories, or delete all memories at once.

- **Delete selected (n)**: permanently deletes the memories you checked.
- **Delete all (n)**: permanently deletes every memory on the list.

<Warning>
  Both actions delete permanently. You cannot recover deleted memories.
</Warning>

After you start a deletion, the panel shows progress as it works through the memories, for
example `Deleting batch 1...`. When it finishes, you see a confirmation like **Deleted 4
memories**. The deleted memories now show the `deleted` state.

## Verify the deletion

Check the count line at the top of the panel to confirm the deletion. The memories you
removed now show the `deleted` state, and the **Deleted** count includes them.
