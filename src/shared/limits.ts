export const LIMITS = {
  fileBytes: 5 * 1024 * 1024,
  batchBytes: 20 * 1024 * 1024,
  filesPerBatch: 50,
  messageChars: 200_000,
  shortHandoffChars: 1500,
  shortHandoffMinChars: 800,
  modelTimeoutMs: 45_000,
  modelMaxOutputChars: 20_000,
  modelMaxOutputTokens: 4096,
  modelMaxInputChars: 80_000,
  modelRetry: 1,
} as const;

export const DEFAULT_PORT = 43173;
