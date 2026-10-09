import { z } from "zod";
import { LIMITS } from "../shared/limits.js";

export const aiRequest = z.object({
  kind: z.enum(["extract", "answer", "polish"]).optional(),
  sourceIds: z.array(z.string().min(1).max(128)).max(50_000).optional(),
  topicId: z.string().max(128).optional(),
  question: z.string().max(10_000).optional(),
  handoffBody: z.string().max(200_000).optional(),
  previewToken: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  confirmSend: z.boolean().optional(),
});
export const modelConfig = z.object({
  baseUrl: z.string().min(1).max(2048), model: z.string().min(1).max(256), apiKey: z.string().min(1).max(4096),
});
export const importInput = z.object({
  paste: z.string().optional(), pasteTitle: z.string().max(1000).optional(),
  pasteAsWhole: z.boolean().optional(), defaultTopic: z.string().max(1000).optional(),
  files: z.array(z.object({ name: z.string().min(1).max(1000), text: z.string().optional(),
    base64: z.string().optional(), asWhole: z.boolean().optional() })).max(LIMITS.filesPerBatch).optional(),
});
