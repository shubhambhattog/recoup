import Dashboard from "@/components/Dashboard";
import { runScenario } from "@/lib/engine/run";

// The first batch is computed on the server and handed to the client, so the
// dashboard renders with real numbers immediately — no loading flash, no
// fetch-on-mount. The run is deterministic, so this prerenders at build time.
export default async function Page() {
  const initial = await runScenario({ seed: 42, n: 120 });
  return <Dashboard initial={initial} />;
}
