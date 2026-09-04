/**
 * Verify every OpenRouter id the app can send still exists upstream.
 *
 * OpenRouter retires ids on its own schedule and answers a retired one with a
 * 404 ("No endpoints found for <id>") only at request time. Nothing in the type
 * system or the e2e suite notices, so a dead id surfaces as a generic "Oops, an
 * error occurred!" for whoever picks it — and for the title and artifact models,
 * which are hardcoded, it silently breaks those features for everyone.
 *
 * The catalog endpoint is public, so this needs no OPENROUTER_API_KEY.
 */
import { openRouterModelIds } from "../lib/ai/models";

const CATALOG_URL = "https://openrouter.ai/api/v1/models";

async function main(): Promise<void> {
  const response = await fetch(CATALOG_URL, {
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    throw new Error(
      `Could not read the OpenRouter catalog: ${response.status} ${response.statusText}`
    );
  }

  const catalog = (await response.json()) as { data: { id: string }[] };
  const live = new Set(catalog.data.map((model) => model.id));
  const retired = openRouterModelIds.filter((id) => !live.has(id));

  for (const id of openRouterModelIds) {
    console.log(`${live.has(id) ? "ok     " : "retired"} ${id}`);
  }

  if (retired.length > 0) {
    throw new Error(
      `${retired.length} model id(s) no longer exist on OpenRouter: ${retired.join(", ")}. ` +
        "Update lib/ai/models.ts — requests using these ids fail with a 404."
    );
  }

  console.log(`\nAll ${openRouterModelIds.length} model ids are live.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
