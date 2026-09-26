import type { Context, Config } from "@netlify/functions";

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type Site = { store: string; domain: string };

const DEFAULT_SITES: Site[] = [
  { store: "Leroy Merlin", domain: "leroymerlin.fr" },
  { store: "Tecnomat", domain: "tecnomat.fr" },
];

export default async (req: Request) => {
  if (req.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405);
  }

  const apiKey = Netlify.env.get("BRAVE_SEARCH_API_KEY");
  if (!apiKey) {
    return json(
      {
        error: "missing_api_key",
        message: "BRAVE_SEARCH_API_KEY n'est pas configurée sur ce site Netlify (Site configuration > Environment variables).",
      },
      500
    );
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad_request", message: "Corps JSON invalide." }, 400);
  }

  const query = body && body.query;
  if (!query || typeof query !== "string" || !query.trim()) {
    return json({ error: "bad_request", message: "Le champ 'query' est requis." }, 400);
  }

  const sites: Site[] =
    Array.isArray(body.sites) && body.sites.length
      ? body.sites.filter((s: any) => s && s.domain).slice(0, 4)
      : DEFAULT_SITES;

  const results: any[] = [];

  try {
    for (const site of sites) {
      const q = `${query.trim()} site:${site.domain}`;
      const resp = await fetch(
        `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=3`,
        {
          headers: {
            Accept: "application/json",
            "X-Subscription-Token": apiKey,
          },
        }
      );

      if (!resp.ok) {
        results.push({ store: site.store, domain: site.domain, error: `HTTP ${resp.status}` });
        continue;
      }

      const data = await resp.json();
      const webResults = (data.web && data.web.results) || [];
      for (const r of webResults.slice(0, 3)) {
        results.push({
          store: site.store,
          domain: site.domain,
          url: r.url,
          title: r.title,
          description: String(r.description || "").replace(/<[^>]+>/g, ""),
        });
      }
    }

    return json({ results });
  } catch (e: any) {
    return json({ error: "network_error", message: String((e && e.message) || e) }, 502);
  }
};

export const config: Config = {
  path: "/api/product-search",
};
