import { z } from "zod";

/* =========================================================
 * Custom Validators
 * ======================================================= */

// Accept either a valid URL or a non-empty string (e.g., S3 key)
const filepathSchema = z.union([
    z.url(),
    z.string().min(1),
]);

// Optional webhook URL (allow empty string but normalize it)
const webhookUrlSchema = z
    .url()
    .optional()
    .or(z.literal(""))
    .transform((val) => (val === "" ? undefined : val));

/* =========================================================
 * Upload Payload Schema
 * ======================================================= */
export const uploadPayloadSchema = z.object({
    generateThumbnail: z.coerce.boolean().default(false),
    webhookUrl: webhookUrlSchema,
    filepath: filepathSchema,
    mediaId: z.union([z.string().min(1), z.coerce.number()]),
});
/* =========================================================
 * Types
 * ======================================================= */
export type UploadPayload = z.infer<typeof uploadPayloadSchema>;
