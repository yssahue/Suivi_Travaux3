import type { Context, Config } from "@netlify/functions";

const SYSTEM_PROMPT = `Tu es l'assistant intégré d'un tableau de bord de suivi de travaux de rénovation, utilisé par un particulier qui rénove lui-même (logique DIY prioritaire, artisan uniquement quand c'est obligatoire ou à forte valeur technique).

L'utilisateur va décrire librement une tâche à réaliser dans un lot de travaux (ex: "refaire l'électricité de la buanderie", "poser un carrelage zellige dans la salle de bain"), parfois accompagnée de photos et/ou d'un schéma ou plan coté de la pièce ou de l'installation existante. Quand des images sont fournies, examine-les attentivement (dimensions annotées, état de l'existant, disposition) avant de répondre, et appuie-toi dessus pour proposer des quantités et un ordre d'exécution réalistes plutôt que génériques — mais ne déduis jamais une cote précise d'une simple photo si elle n'est pas annotée : dans ce cas, indique-le comme hypothèse à vérifier plutôt que comme une mesure certaine. Tu dois répondre UNIQUEMENT avec un objet JSON valide, sans texte avant ni après, avec exactement ce contrat :

{
  "resume": "une phrase résumant ce qui va être fait",
  "steps": [{"text": "étape concrète, dans l'ordre logique d'exécution"}],
  "items": [{"label": "nom de l'article ou de la fourniture", "qty": nombre, "unit": "unité (ex: m², u, ml)", "unitPrice": nombre_ou_null, "note": "précision utile", "tag": "diy" | "diy-assiste" | "artisan"}],
  "decisions": [{"level": "Urgent" | "Important" | "Plus tard", "text": "décision ou point à trancher avant de commencer"}],
  "risks": ["point de vigilance technique ou réglementaire à signaler"]
}

Règles impératives, à respecter strictement :
- N'invente JAMAIS un prix précis que tu ne connais pas avec certitude. Si tu n'es pas sûr du prix, mets "unitPrice" à null et indique un ordre de grandeur approximatif dans "note" (ex: "compter environ 30-50€/m²"), jamais un chiffre présenté comme exact.
- Respecte et cite si pertinent les normes et DTU applicables (électricité NF C 15-100, plomberie, humidité du bâti ancien, ventilation), et signale dans "risks" tout point qui doit être vérifié par un professionnel ou vis-à-vis d'un DTU.
- Priorise le DIY et le "DIY assisté" (un artisan ponctuel en soutien) partout où c'est raisonnable ; ne mets "artisan" que lorsque c'est obligatoire (ex: mise aux normes électrique avec Consuel, gaz avec attestation) ou apporte une réelle valeur technique.
- Sois concret, actionnable, et ordonné logiquement (ex: vérifications/dépose avant travaux, gros œuvre avant finitions).
- Si la demande est ambiguë ou manque d'informations importantes (dimensions, matériau existant, etc.), ajoute une décision de niveau "Urgent" ou "Important" qui pose la question plutôt que de deviner silencieusement.
- Reste concis : 3 à 10 étapes, 2 à 12 articles, autant de décisions et risques que nécessaire mais sans remplissage inutile.`;

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export default async (req: Request) => {
  if (req.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405);
  }

  const apiKey = Netlify.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    return json(
      {
        error: "missing_api_key",
        message: "ANTHROPIC_API_KEY n'est pas configurée sur ce site Netlify (Site configuration > Environment variables).",
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

  const task = body && body.task;
  const context = body && body.context;
  if (!task || typeof task !== "string" || !task.trim()) {
    return json({ error: "bad_request", message: "Le champ 'task' est requis." }, 400);
  }

  const rawImages = Array.isArray(body && body.images) ? body.images : [];
  const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
  const MAX_IMAGES = 6;
  const MAX_IMAGE_BASE64_CHARS = 6_000_000; // ~4.5MB decoded per image
  const MAX_TOTAL_BASE64_CHARS = 18_000_000; // ~13.5MB decoded total, comfortably under function body limits

  if (rawImages.length > MAX_IMAGES) {
    return json({ error: "bad_request", message: `Maximum ${MAX_IMAGES} images par demande.` }, 400);
  }
  let totalChars = 0;
  const imageBlocks: any[] = [];
  for (const img of rawImages) {
    if (!img || typeof img.data !== "string" || typeof img.mediaType !== "string") {
      return json({ error: "bad_request", message: "Image mal formée." }, 400);
    }
    if (!ALLOWED_IMAGE_TYPES.has(img.mediaType)) {
      return json({ error: "bad_request", message: `Type d'image non supporté : ${img.mediaType}` }, 400);
    }
    if (img.data.length > MAX_IMAGE_BASE64_CHARS) {
      return json({ error: "bad_request", message: "Une image dépasse la taille maximale autorisée." }, 400);
    }
    totalChars += img.data.length;
    if (totalChars > MAX_TOTAL_BASE64_CHARS) {
      return json({ error: "bad_request", message: "Le total des images dépasse la taille maximale autorisée." }, 400);
    }
    imageBlocks.push({ type: "image", source: { type: "base64", media_type: img.mediaType, data: img.data } });
  }

  const contextLine = context
    ? `Contexte actuel dans le tableau de bord : ${JSON.stringify(context)}`
    : "Aucun contexte de projet fourni.";

  const model = Netlify.env.get("ANTHROPIC_MODEL") || "claude-sonnet-5";

  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 2200,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `${contextLine}\n\nTâche décrite par l'utilisateur :\n${task.trim()}${imageBlocks.length ? "\n\n(Des images sont jointes ci-dessous : photos et/ou schéma/plan coté.)" : ""}`,
              },
              ...imageBlocks,
            ],
          },
        ],
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      return json({ error: "upstream_error", message: errText }, 502);
    }

    const data = await resp.json();
    const raw = ((data.content || []) as any[]).map((b) => b.text || "").join("\n").trim();

    let parsed: any;
    try {
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
    } catch {
      return json({ error: "parse_error", message: "Réponse IA non-JSON.", raw }, 502);
    }

    return json({ proposal: parsed });
  } catch (e: any) {
    return json({ error: "network_error", message: String((e && e.message) || e) }, 502);
  }
};

export const config: Config = {
  path: "/api/ai-bot",
};
