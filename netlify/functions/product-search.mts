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

  const apiKey = Netlify.env.get("TAVILY_API_KEY");
  if (!apiKey) {
    return json(
      {
        error: "missing_api_key",
        message: "TAVILY_API_KEY n'est pas configurée sur ce site Netlify (Site configuration > Environment variables).",
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
      const resp = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          query: query.trim(),
          include_domains: [site.domain],
          max_results: 3,
          search_depth: "basic",
        }),
      });

      if (!resp.ok) {
        results.push({ store: site.store, domain: site.domain, error: `HTTP ${resp.status}` });
        continue;
      }

      const data = await resp.json();
      const webResults = Array.isArray(data.results) ? data.results : [];
      for (const r of webResults.slice(0, 3)) {
        results.push({
          store: site.store,
          domain: site.domain,
          url: r.url,
          title: r.title,
          description: String(r.content || "").replace(/<[^>]+>/g, ""),
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
