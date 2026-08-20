// Load .env.local / .env into process.env for headless scripts (tsx doesn't do
// it automatically the way Next.js does). Uses Node's built-in loadEnvFile —
// zero dependencies. Missing files are ignored.

export function loadEnv(): void {
  const p = process as unknown as { loadEnvFile?: (path: string) => void };
  for (const f of [".env.local", ".env"]) {
    try {
      p.loadEnvFile?.(f);
    } catch {
      // file absent — fine
    }
  }
}
