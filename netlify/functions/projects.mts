import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

function projectsStore() {
  return getStore("renovation-projects");
}

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type ProjectSummary = { id: string; name: string; updatedAt: string };

export default async (req: Request, _context: Context) => {
  const url = new URL(req.url);
  const parts = url.pathname.split("/").filter(Boolean); // ["api", "projects", maybe id]
  const id = parts[2];
  const store = projectsStore();

  try {
    if (req.method === "GET" && !id) {
      const index = ((await store.get("_index", { type: "json" })) || []) as ProjectSummary[];
      index.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
      return json({ projects: index });
    }

    if (req.method === "GET" && id) {
      const project = await store.get(id, { type: "json" });
      if (!project) return json({ error: "not_found" }, 404);
      return json({ project });
    }

    if (req.method === "PUT" && id) {
      let body: any;
      try {
        body = await req.json();
      } catch {
        return json({ error: "bad_request", message: "Corps JSON invalide." }, 400);
      }
      body.id = id;
      body.updatedAt = new Date().toISOString();
      if (!body.createdAt) body.createdAt = body.updatedAt;
      await store.setJSON(id, body);

      const index = ((await store.get("_index", { type: "json" })) || []) as ProjectSummary[];
      const summary: ProjectSummary = { id, name: body.name || "Projet sans nom", updatedAt: body.updatedAt };
      const i = index.findIndex((p) => p.id === id);
      if (i >= 0) index[i] = summary;
      else index.push(summary);
      await store.setJSON("_index", index);

      return json({ ok: true, project: body });
    }

    if (req.method === "DELETE" && id) {
      await store.delete(id);
      const index = ((await store.get("_index", { type: "json" })) || []) as ProjectSummary[];
      await store.setJSON(
        "_index",
        index.filter((p) => p.id !== id)
      );
      return json({ ok: true });
    }

    return json({ error: "bad_request" }, 400);
  } catch (e: any) {
    return json({ error: "server_error", message: String((e && e.message) || e) }, 500);
  }
};

export const config: Config = {
  path: ["/api/projects", "/api/projects/*"],
};
