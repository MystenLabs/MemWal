/**
 * AUTH FORM SCHEMAS
 *
 * UI form validation schemas for authentication feature.
 * Derived from shared/db/type.ts using .pick().extend() pattern.
 *
 * Pattern: Forms use optionalId to handle both create and update modes in a single schema.
 */

import { z } from "zod";
import { userInsertSchema, uuidv7Schema } from "@/shared/db/type";

// ══════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════

/** Optional ID helper for create/update forms */
const optionalId = { id: uuidv7Schema.optional() } as const;

// ══════════════════════════════════════════════════════════════
// FORM SCHEMAS
// ══════════════════════════════════════════════════════════════

/**
 * User profile form (for editing profile after authentication)
 * Used in settings/profile pages where users can update their info
 */
export const userProfileFormSchema = userInsertSchema
  .pick({ name: true, email: true, avatar: true })
  .extend({
    ...optionalId,
    name: z.string().min(1, "Name is required").max(100, "Name is too long"),
    email: z.string().email("Invalid email address").optional(),
    avatar: z.string().url("Invalid avatar URL").optional(),
  });

// ══════════════════════════════════════════════════════════════
// TYPE EXPORTS
// ══════════════════════════════════════════════════════════════

export type UserProfileFormData = z.infer<typeof userProfileFormSchema>;
