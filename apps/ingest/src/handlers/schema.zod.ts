import { z } from "zod";

/* =========================================================
 * Custom Validators
 * ======================================================= */

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
    prefix: z.string().min(1),
    mediaId: z.union([z.string().min(1), z.coerce.number()]),
    filename: z.string().min(1),
    bucketName: z.string().min(1),
});
/* =========================================================
 * Types
 * ======================================================= */
export type UploadPayload = z.infer<typeof uploadPayloadSchema>;
