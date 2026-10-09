import { defineConfig } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// e2e 永远用独立端口和独立数据目录，不复用、不连 43173（那是老大日常实例的默认端口）。
const port = Number(process.env.XUSHANG_E2E_PORT ?? 43290);
if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 43173) throw new Error("e2e 需使用有效隔离端口，不能使用 43173");
const baseURL = process.env.XUSHANG_BASE_URL ?? `http://127.0.0.1:${port}`;
const dataDir = mkdtempSync(join(tmpdir(), "xushang-e2e-"));
if (/:43173(\/|$)/.test(baseURL)) throw new Error("e2e 不得指向 43173");

export default defineConfig({
  testDir: "tests/e2e",
  workers: 1,
  preserveOutput: "always",
  timeout: 90_000,
  use: {
    baseURL,
    locale: "zh-CN",
  },
  webServer: process.env.XUSHANG_E2E_NO_SERVER
    ? undefined
    : {
        // 每次使用全新的临时库，不删既有目录。
        command: "npm run start",
        url: `http://127.0.0.1:${port}/api/health`,
        reuseExistingServer: false,
        timeout: 120_000,
        env: {
          XUSHANG_PORT: String(port),
          XUSHANG_DATA_DIR: dataDir,
          XUSHANG_PID_FILE: `${dataDir}.pid`,
          XUSHANG_PORT_FILE: `${dataDir}.port`,
          NODE_ENV: "production",
        },
      },
});
