"use strict";

/* ============================================================
   UTILITAIRES
   ============================================================ */
function uid(prefix) {
  return (prefix || "id") + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function fmtEUR(n) {
  if (n == null || isNaN(n)) return "—";
  return Number(n).toLocaleString("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 2 });
}
function nowIso() { return new Date().toISOString(); }
function debounce(fn, ms) {
  let t = null;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
function guessPrice(text) {
  if (!text) return null;
  const m = String(text).match(/(\d{1,4}(?:[.,]\d{2})?)\s*€/);
  if (!m) return null;
  const v = parseFloat(m[1].replace(",", "."));
  return isNaN(v) ? null : v;
}

/* ============================================================
   API
   ============================================================ */
const Api = {
  async listProjects() {
    const r = await fetch("/api/projects");
    if (!r.ok) throw new Error("Impossible de charger la liste des projets.");
    return (await r.json()).projects || [];
  },
  async getProject(id) {
    const r = await fetch("/api/projects/" + encodeURIComponent(id));
    if (r.status === 404) return null;
    if (!r.ok) throw new Error("Impossible de charger le projet.");
    return (await r.json()).project;
  },
  async saveProject(project) {
    const r = await fetch("/api/projects/" + encodeURIComponent(project.id), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(project),
    });
    if (!r.ok) throw new Error("Échec de l'enregistrement.");
    return (await r.json()).project;
  },
  async deleteProject(id) {
    const r = await fetch("/api/projects/" + encodeURIComponent(id), { method: "DELETE" });
    if (!r.ok) throw new Error("Échec de la suppression.");
  },
  async askAI(task, context, images) {
    const r = await fetch("/api/ai-bot", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task, context, images: images && images.length ? images : undefined }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.message || data.error || "Erreur de l'assistant IA.");
    return data.proposal;
  },
  async searchProducts(query, sites) {
    const r = await fetch("/api/product-search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, sites }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.message || data.error || "Erreur de recherche produit.");
    return data.results || [];
  },
};

/* ============================================================
   MODELE DE DONNEES (usines par défaut)
   ============================================================ */
const DEFAULT_SITES = [
  { store: "Leroy Merlin", domain: "leroymerlin.fr" },
  { store: "Tecnomat", domain: "tecnomat.fr" },
];

function newProject(name, address) {
  return {
    id: uid("proj"),
    name: name || "Nouveau projet",
    address: address || "",
    notes: "",
    budget: { phase1Min: null, phase1Max: null, phase2Note: "" },
    defaultSites: DEFAULT_SITES.map((s) => ({ ...s })),
    rooms: [],
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
}
function newRoom(name) {
  return {
    id: uid("room"),
    name: name || "Nouvelle pièce",
    surfaceM2: null,
    heightM: null,
    notes: "",
    lots: [],
    // Travaux "généraux" de la pièce : permet de commencer étapes / achats / décisions
    // directement sur la pièce, sans être obligé de créer un lot au préalable.
    items: [],
    steps: [],
    decisions: [],
  };
}
function newLot(name) {
  return {
    id: uid("lot"),
    name: name || "Nouveau lot",
    category: "",
    diy: "diy",
    status: "a-faire",
    order: Date.now(),
    budgetMin: null,
    budgetMax: null,
    items: [],
    decisions: [],
    steps: [],
  };
}
function newItem(label) {
  return { id: uid("item"), label: label || "", qty: 1, unit: "u", unitPrice: null, note: "", tag: "diy", tbd: false, done: false, links: [] };
}
function newDecision(text, level) {
  return { id: uid("dec"), text: text || "", level: level || "Important", resolved: false };
}
function newStep(text) {
  return { id: uid("step"), text: text || "", done: false };
}

/* ============================================================
   ETAT GLOBAL
   ============================================================ */
const STATE = {
  projectsList: [],
  project: null,
  loading: false,
  loadError: null,
  saveStatus: "idle", // idle | saving | saved | error
  ui: { view: "home", roomId: null, lotId: null, tab: "apercu" },
  ai: { open: false, task: "", busy: false, error: null, proposal: null, selected: null, images: [], forBucketId: undefined },
  search: { openForItem: null, query: "", busy: false, error: null, results: null, selected: {} },
  // état des petits formulaires inline (remplacent les prompt() du navigateur)
  uiForms: { addingRoom: false, addingLot: false, addingStep: false, addingItem: false, addingDecision: false, decisionLevel: "Important" },
  // plier / déplier les articles
  uiCollapse: { items: {} },
  openLinkInfo: {},
};

function currentRoom() {
  if (!STATE.project || !STATE.ui.roomId) return null;
  return STATE.project.rooms.find((r) => r.id === STATE.ui.roomId) || null;
}
function currentLot() {
  const room = currentRoom();
  if (!room || !STATE.ui.lotId) return null;
  return room.lots.find((l) => l.id === STATE.ui.lotId) || null;
}

/* ---- "buckets" : un lot réel, OU les travaux généraux d'une pièce (même forme) ---- */
function roomBucket(room) {
  return {
    id: null,
    name: "Travaux généraux",
    category: "",
    diy: "diy",
    status: "en-cours",
    order: -1,
    items: room.items,
    steps: room.steps,
    decisions: room.decisions,
  };
}
function findBucketById(bucketId) {
  if (!STATE.project || !bucketId) return null;
  if (String(bucketId).indexOf("room:") === 0) {
    const roomId = bucketId.slice(5);
    const room = STATE.project.rooms.find((r) => r.id === roomId);
    return room ? { room, lot: roomBucket(room) } : null;
  }
  for (const room of STATE.project.rooms) {
    const lot = room.lots.find((l) => l.id === bucketId);
    if (lot) return { room, lot };
  }
  return null;
}
function currentBucketId() {
  const lot = currentLot();
  if (lot) return lot.id;
  const room = currentRoom();
  if (room) return "room:" + room.id;
  return null;
}
function allBucketsFlat() {
  if (!STATE.project) return [];
  const out = [];
  for (const room of STATE.project.rooms) {
    const rb = roomBucket(room);
    if (rb.items.length || rb.steps.length || rb.decisions.length) {
      out.push({ room, lot: rb, isRoomLevel: true });
    }
    for (const lot of room.lots) out.push({ room, lot, isRoomLevel: false });
  }
  return out;
}
function lotTotal(lot) {
  return lot.items.reduce((sum, it) => sum + (Number(it.qty) || 0) * (Number(it.unitPrice) || 0), 0);
}
function roomFullTotal(room) {
  return lotTotal(roomBucket(room)) + room.lots.reduce((s, l) => s + lotTotal(l), 0);
}
function projectTotal() {
  if (!STATE.project) return 0;
  return allBucketsFlat().reduce((s, { lot }) => s + lotTotal(lot), 0);
}

/* ============================================================
   PERSISTANCE
   ============================================================ */
const saveProjectDebounced = debounce(async () => {
  if (!STATE.project) return;
  STATE.saveStatus = "saving";
  renderSaveBar();
  try {
    const saved = await Api.saveProject(STATE.project);
    STATE.project.updatedAt = saved.updatedAt;
    STATE.saveStatus = "saved";
  } catch (e) {
    STATE.saveStatus = "error";
  }
  renderSaveBar();
}, 700);

function touchProject() {
  if (!STATE.project) return;
  STATE.project.updatedAt = nowIso();
  saveProjectDebounced();
}

function renderSaveBar() {
  const el = document.getElementById("savebar");
  if (!el) return;
  const label = { idle: "", saving: "Enregistrement…", saved: "Enregistré ✓", error: "⚠ Échec de l'enregistrement" }[STATE.saveStatus] || "";
  el.textContent = label;
}

/* ============================================================
   ROUTAGE
   ============================================================ */
function parseHash() {
  const h = location.hash.replace(/^#\/?/, "");
  const parts = h.split("/").filter(Boolean);
  return parts;
}
async function route() {
  // On quitte une page : referme les petits formulaires inline en cours et les états ponctuels.
  STATE.uiForms = { addingRoom: false, addingLot: false, addingStep: false, addingItem: false, addingDecision: false, decisionLevel: "Important" };
  STATE.search = { openForItem: null, query: "", busy: false, error: null, results: null, selected: {} };

  const parts = parseHash();
  if (!parts.length) {
    STATE.ui.view = "home";
    STATE.project = null;
    localStorage.removeItem("reno.lastProjectId");
    render();
    loadProjectsList();
    return;
  }
  const projectId = parts[0];
  if (!STATE.project || STATE.project.id !== projectId) {
    STATE.loading = true;
    STATE.loadError = null;
    render();
    try {
      const p = await Api.getProject(projectId);
      if (!p) {
        STATE.loadError = "Projet introuvable.";
        STATE.loading = false;
        render();
        return;
      }
      normalizeProject(p);
      STATE.project = p;
      localStorage.setItem("reno.lastProjectId", projectId);
    } catch (e) {
      STATE.loadError = e.message || "Erreur de chargement.";
      STATE.loading = false;
      render();
      return;
    }
    STATE.loading = false;
  }
  STATE.ui.view = "project";
  STATE.ui.roomId = parts[1] || null;
  STATE.ui.lotId = parts[2] || null;
  if (STATE.ui.lotId) STATE.ui.view = "lot";
  else if (STATE.ui.roomId) STATE.ui.view = "room";
  render();
}
function goHome() { location.hash = ""; }
function goProject(id) { location.hash = "#" + id; }
function goRoom(id) { location.hash = "#" + STATE.project.id + "/" + id; }
function goLot(roomId, lotId) { location.hash = "#" + STATE.project.id + "/" + roomId + "/" + lotId; }

function normalizeProject(p) {
  p.rooms = p.rooms || [];
  p.defaultSites = p.defaultSites && p.defaultSites.length ? p.defaultSites : DEFAULT_SITES.map((s) => ({ ...s }));
  p.budget = p.budget || { phase1Min: null, phase1Max: null, phase2Note: "" };
  for (const room of p.rooms) {
    room.lots = room.lots || [];
    room.items = room.items || [];
    room.steps = room.steps || [];
    room.decisions = room.decisions || [];
    for (const it of room.items) it.links = it.links || [];
    for (const lot of room.lots) {
      lot.items = lot.items || [];
      lot.decisions = lot.decisions || [];
      lot.steps = lot.steps || [];
      lot.order = lot.order || 0;
      for (const it of lot.items) it.links = it.links || [];
    }
  }
}

/* ============================================================
   RENDU — HOME
   ============================================================ */
async function loadProjectsList() {
  try {
    STATE.projectsList = await Api.listProjects();
  } catch (e) {
    STATE.projectsList = [];
  }
  if (STATE.ui.view === "home") renderHome();
}

function renderHome() {
  const main = document.getElementById("app");
  const last = localStorage.getItem("reno.lastProjectId");
  main.innerHTML = `
    <div class="app-shell">
      <div class="main" style="max-width:900px;margin:0 auto;padding-top:60px;">
        <div style="text-align:center;margin-bottom:34px;">
          <h1 style="font-size:32px;">Mes projets de rénovation</h1>
          <p class="muted">Un tableau de bord pour construire, suivre et budgétiser n'importe quel projet de rénovation, pièce par pièce.</p>
        </div>
        <div class="card">
          <h3>Créer un nouveau projet</h3>
          <div class="field-row">
            <div class="field"><label>Nom du projet</label><input id="np-name" placeholder="Ex : Maison rue Jouffroy"></div>
            <div class="field"><label>Adresse (optionnel)</label><input id="np-address" placeholder="Ex : 21 rue Jouffroy, Roubaix"></div>
          </div>
          <button class="btn primary" id="np-create">+ Créer le projet</button>
        </div>
        <div id="projects-list"></div>
      </div>
    </div>
  `;
  document.getElementById("np-create").onclick = async () => {
    const name = document.getElementById("np-name").value.trim();
    const address = document.getElementById("np-address").value.trim();
    if (!name) { alert("Donnez un nom au projet."); return; }
    const p = newProject(name, address);
    try {
      await Api.saveProject(p);
      goProject(p.id);
    } catch (e) {
      alert("Impossible de créer le projet : " + e.message);
    }
  };

  const listEl = document.getElementById("projects-list");
  if (STATE.projectsList.length === 0) {
    listEl.innerHTML = `<p class="empty">Aucun projet pour l'instant — créez le premier ci-dessus.</p>`;
    return;
  }
  listEl.innerHTML = `<div class="grid cols-2" style="margin-top:22px;">${STATE.projectsList
    .map(
      (p) => `
    <div class="room-card" onclick="goProject('${p.id}')">
      <h3>${esc(p.name)}${p.id === last ? ' <span class="faint">(récent)</span>' : ""}</h3>
      <div class="room-meta">Mis à jour le ${new Date(p.updatedAt).toLocaleString("fr-FR")}</div>
    </div>`
    )
    .join("")}</div>`;
}

/* ============================================================
   RENDU — LAYOUT PROJET (sidebar + tabs)
   ============================================================ */
function render() {
  if (STATE.ui.view === "home") { renderHome(); return; }
  const main = document.getElementById("app");

  if (STATE.loading) {
    main.innerHTML = `<div class="app-shell"><div class="main"><p class="muted">Chargement du projet…</p></div></div>`;
    return;
  }
  if (STATE.loadError) {
    main.innerHTML = `<div class="app-shell"><div class="main"><div class="errbox">${esc(STATE.loadError)}</div><button class="btn" onclick="goHome()">← Retour à l'accueil</button></div></div>`;
    return;
  }
  if (!STATE.project) { renderHome(); return; }

  const p = STATE.project;
  const view = STATE.ui.view;

  main.innerHTML = `
    <div class="app-shell">
      <div class="sidebar">
        <div class="brand" style="cursor:pointer" onclick="goHome()">🏠 Rénovation<small>Tableau de bord</small></div>
        <div class="faint" style="padding:0 6px 6px 6px;">${esc(p.name)}</div>
        <div class="sidenav">
          <a class="${view === "project" && STATE.ui.tab === "apercu" ? "active" : ""}" onclick="setTab('apercu')">Aperçu</a>
          <a class="${view === "project" && STATE.ui.tab === "planning" ? "active" : ""}" onclick="setTab('planning')">Planning</a>
          <a class="${view === "project" && STATE.ui.tab === "budget" ? "active" : ""}" onclick="setTab('budget')">Budget</a>
          <a class="${view === "project" && STATE.ui.tab === "decisions" ? "active" : ""}" onclick="setTab('decisions')">Décisions</a>
          <a class="${view === "project" && STATE.ui.tab === "achats" ? "active" : ""}" onclick="setTab('achats')">Achats</a>
          <a class="${view === "project" && STATE.ui.tab === "parametres" ? "active" : ""}" onclick="setTab('parametres')">Paramètres</a>
        </div>
        <div class="sidebar-foot">
          <div id="savebar" class="savebar"></div>
          <div style="margin-top:8px;"><button class="btn small" onclick="goHome()">← Tous les projets</button></div>
        </div>
      </div>
      <div class="main" id="main-content"></div>
    </div>
    <button class="ai-fab" onclick="toggleAI()">✨ Assistant IA</button>
    <div id="ai-panel-root"></div>
  `;
  renderSaveBar();

  const content = document.getElementById("main-content");
  if (view === "room") content.innerHTML = renderRoomView();
  else if (view === "lot") content.innerHTML = renderLotView();
  else content.innerHTML = renderProjectTab();

  renderAIPanel();
  focusPendingInput();
}

function focusPendingInput() {
  const map = {
    addingRoom: "new-room-name",
    addingLot: "new-lot-name",
    addingStep: "new-step-text",
    addingItem: "new-item-name",
    addingDecision: "new-decision-text",
  };
  for (const flag in map) {
    if (STATE.uiForms[flag]) {
      const el = document.getElementById(map[flag]);
      if (el) { el.focus(); return; }
    }
  }
}

function setTab(tab) {
  STATE.ui.tab = tab;
  STATE.ui.view = "project";
  STATE.ui.roomId = null;
  STATE.ui.lotId = null;
  location.hash = "#" + STATE.project.id;
  render();
}
window.setTab = setTab;

/* ============================================================
   RENDU — TABS PROJET
   ============================================================ */
function renderProjectTab() {
  const p = STATE.project;
  const tab = STATE.ui.tab;
  const header = `
    <div class="pagehead">
      <div><h1>${esc(p.name)}</h1><div class="sub">${esc(p.address || "")}</div></div>
    </div>`;
  if (tab === "planning") return header + renderPlanningTab();
  if (tab === "budget") return header + renderBudgetTab();
  if (tab === "decisions") return header + renderDecisionsTab();
  if (tab === "achats") return header + renderAchatsTab();
  if (tab === "parametres") return header + renderParametresTab();
  return header + renderApercuTab();
}

function renderApercuTab() {
  const p = STATE.project;
  const total = projectTotal();
  const nbLots = p.rooms.reduce((s, r) => s + r.lots.length, 0);
  const nbDecOpen = allBucketsFlat().reduce((s, { lot }) => s + lot.decisions.filter((d) => !d.resolved).length, 0);
  const adding = STATE.uiForms.addingRoom;
  return `
    <div class="grid cols-3" style="margin-bottom:20px;">
      <div class="stat"><div class="num">${p.rooms.length}</div><div class="label">Pièces</div></div>
      <div class="stat"><div class="num">${nbLots}</div><div class="label">Lots de travaux</div></div>
      <div class="stat"><div class="num">${fmtEUR(total)}</div><div class="label">Budget articles estimé</div></div>
      <div class="stat"><div class="num">${nbDecOpen}</div><div class="label">Décisions en attente</div></div>
    </div>
    <div class="row between" style="margin-bottom:10px;">
      <h2>Pièces</h2>
      ${adding ? "" : `<button class="btn primary" onclick="STATE.uiForms.addingRoom=true;render();">+ Ajouter une pièce</button>`}
    </div>
    ${adding ? `
    <div class="card" style="margin-bottom:14px;">
      <div class="field-row" style="align-items:flex-end;margin-bottom:0;">
        <div class="field" style="flex:1;margin-bottom:0;"><label>Nom de la pièce</label><input id="new-room-name" placeholder="Ex : Cuisine, Chambre 2" onkeydown="if(event.key==='Enter'){event.preventDefault();submitAddRoom();}"></div>
        <button class="btn primary" onclick="submitAddRoom()">Créer</button>
        <button class="btn ghost" onclick="STATE.uiForms.addingRoom=false;render();">Annuler</button>
      </div>
    </div>` : ""}
    ${p.rooms.length === 0
      ? `<p class="empty">Aucune pièce pour l'instant. Ajoutez votre première pièce avec ses dimensions pour commencer à structurer le projet.</p>`
      : `<div class="grid cols-3">${p.rooms.map(renderRoomCard).join("")}</div>`}
  `;
}
function submitAddRoom() {
  const input = document.getElementById("new-room-name");
  const name = input ? input.value.trim() : "";
  if (!name) { if (input) input.focus(); return; }
  const room = newRoom(name);
  STATE.project.rooms.push(room);
  STATE.uiForms.addingRoom = false;
  touchProject();
  render();
}
window.submitAddRoom = submitAddRoom;

function renderRoomCard(room) {
  const total = roomFullTotal(room);
  return `
    <div class="room-card" onclick="goRoom('${room.id}')">
      <h3>${esc(room.name)}</h3>
      <div class="room-meta">${room.surfaceM2 ? room.surfaceM2 + " m²" : "surface non renseignée"}${room.heightM ? " · H " + room.heightM + " m" : ""}</div>
      <div class="room-meta" style="margin-top:6px;">${room.lots.length} lot${room.lots.length > 1 ? "s" : ""} · ${fmtEUR(total)}</div>
    </div>`;
}

function renderPlanningTab() {
  const flat = allBucketsFlat().sort((a, b) => a.lot.order - b.lot.order);
  if (!flat.length) return `<p class="empty">Aucun lot de travaux planifié. Ouvrez une pièce pour commencer une tâche ou en créer un.</p>`;
  return `
    <table>
      <thead><tr><th>#</th><th>Pièce</th><th>Lot</th><th>Statut</th><th>DIY / Artisan</th><th>Budget</th></tr></thead>
      <tbody>
        ${flat.map(({ room, lot, isRoomLevel }, i) => `
          <tr style="cursor:pointer" onclick="${isRoomLevel ? `goRoom('${room.id}')` : `goLot('${room.id}','${lot.id}')`}">
            <td>${i + 1}</td>
            <td>${esc(room.name)}</td>
            <td>${esc(lot.name)}</td>
            <td>${isRoomLevel ? '<span class="faint">—</span>' : statusLabel(lot.status)}</td>
            <td>${isRoomLevel ? '<span class="faint">—</span>' : diyBadge(lot.diy)}</td>
            <td>${fmtEUR(lotTotal(lot))}</td>
          </tr>`).join("")}
      </tbody>
    </table>`;
}
function statusLabel(s) {
  return { "a-faire": "À faire", "en-cours": "En cours", "fait": "Terminé" }[s] || s;
}
function diyBadge(diy) {
  const cls = diy === "artisan" ? "artisan" : diy === "diy-assiste" ? "diy-assiste" : "diy";
  const label = diy === "artisan" ? "Artisan" : diy === "diy-assiste" ? "DIY assisté" : "DIY";
  return `<span class="badge ${cls}">${label}</span>`;
}

function renderBudgetTab() {
  const p = STATE.project;
  const flat = allBucketsFlat();
  const total = projectTotal();
  return `
    <div class="card">
      <h3>Budget global</h3>
      <div class="field-row">
        <div class="field"><label>Phase 1 — min (€)</label><input type="number" value="${p.budget.phase1Min ?? ""}" onchange="STATE.project.budget.phase1Min=this.value?Number(this.value):null;touchProject();"></div>
        <div class="field"><label>Phase 1 — max (€)</label><input type="number" value="${p.budget.phase1Max ?? ""}" onchange="STATE.project.budget.phase1Max=this.value?Number(this.value):null;touchProject();"></div>
      </div>
      <div class="field"><label>Notes phase 2 / montée en gamme</label><textarea rows="2" onchange="STATE.project.budget.phase2Note=this.value;touchProject();">${esc(p.budget.phase2Note)}</textarea></div>
    </div>
    <div class="card">
      <h3>Total articles chiffrés : ${fmtEUR(total)}</h3>
      <table>
        <thead><tr><th>Pièce</th><th>Lot</th><th>Total articles</th></tr></thead>
        <tbody>
          ${flat.map(({ room, lot, isRoomLevel }) => `<tr style="cursor:pointer" onclick="${isRoomLevel ? `goRoom('${room.id}')` : `goLot('${room.id}','${lot.id}')`}"><td>${esc(room.name)}</td><td>${esc(lot.name)}</td><td>${fmtEUR(lotTotal(lot))}</td></tr>`).join("") || `<tr><td colspan="3" class="empty">Aucun article chiffré pour l'instant.</td></tr>`}
        </tbody>
      </table>
    </div>`;
}

function renderDecisionsTab() {
  const flat = allBucketsFlat();
  const levels = ["Urgent", "Important", "Plus tard"];
  const byLevel = {};
  for (const lvl of levels) byLevel[lvl] = [];
  for (const { room, lot } of flat) {
    const bId = lot.id || ("room:" + room.id);
    for (const d of lot.decisions) {
      byLevel[d.level] = byLevel[d.level] || [];
      byLevel[d.level].push({ room, lot, d, bId });
    }
  }
  return levels.map((lvl) => `
    <div class="card">
      <h3><span class="badge ${lvl === "Urgent" ? "urgent" : lvl === "Important" ? "important" : "later"}">${lvl}</span></h3>
      ${(byLevel[lvl] || []).length === 0 ? `<p class="faint">Aucune décision.</p>` : `
      <div class="checklist">
        ${byLevel[lvl].map(({ room, lot, d, bId }) => `
          <label>
            <input type="checkbox" ${d.resolved ? "checked" : ""} onchange="toggleDecisionResolved('${bId}','${d.id}')">
            <span style="${d.resolved ? "text-decoration:line-through;color:var(--ink-faint);" : ""}">${esc(d.text)} <span class="faint">— ${esc(room.name)} / ${esc(lot.name)}</span></span>
          </label>`).join("")}
      </div>`}
    </div>`).join("");
}
function toggleDecisionResolved(bucketId, decId) {
  const b = findBucketById(bucketId);
  if (b) {
    const d = b.lot.decisions.find((x) => x.id === decId);
    if (d) d.resolved = !d.resolved;
  }
  touchProject();
  render();
}
window.toggleDecisionResolved = toggleDecisionResolved;

function renderAchatsTab() {
  const flat = allBucketsFlat();
  const rows = [];
  for (const { room, lot, isRoomLevel } of flat) for (const it of lot.items) rows.push({ room, lot, it, isRoomLevel });
  if (!rows.length) return `<p class="empty">Aucun article pour l'instant.</p>`;
  return `
    <table>
      <thead><tr><th>Article</th><th>Pièce / Lot</th><th>Qté</th><th>Prix unit.</th><th>Total</th><th>Tag</th><th>Liens</th></tr></thead>
      <tbody>
        ${rows.map(({ room, lot, it, isRoomLevel }) => `
          <tr>
            <td>${esc(it.label)}${it.tbd ? ' <span class="badge decision">à décider</span>' : ""}</td>
            <td style="cursor:pointer" onclick="${isRoomLevel ? `goRoom('${room.id}')` : `goLot('${room.id}','${lot.id}')`}">${esc(room.name)} / ${esc(lot.name)}</td>
            <td>${it.qty} ${esc(it.unit || "")}</td>
            <td>${it.unitPrice != null ? fmtEUR(it.unitPrice) : "—"}</td>
            <td>${fmtEUR((Number(it.qty) || 0) * (Number(it.unitPrice) || 0))}</td>
            <td>${diyBadge(it.tag)}</td>
            <td>${itemLinksHtml(it, it.id)}</td>
          </tr>`).join("")}
      </tbody>
    </table>`;
}

function renderParametresTab() {
  const p = STATE.project;
  return `
    <div class="card">
      <h3>Informations générales</h3>
      <div class="field"><label>Nom du projet</label><input value="${esc(p.name)}" onchange="STATE.project.name=this.value;touchProject();renderSaveBar();"></div>
      <div class="field"><label>Adresse</label><input value="${esc(p.address)}" onchange="STATE.project.address=this.value;touchProject();"></div>
      <div class="field"><label>Notes</label><textarea rows="3" onchange="STATE.project.notes=this.value;touchProject();">${esc(p.notes)}</textarea></div>
    </div>
    <div class="card">
      <h3>Sites de référence pour la recherche produit</h3>
      <p class="faint">Utilisés par défaut pour la recherche en direct d'articles à acheter dans chaque lot.</p>
      <div id="sites-list">${p.defaultSites.map((s, i) => `
        <div class="field-row" style="align-items:flex-end;">
          <div class="field"><label>Enseigne</label><input value="${esc(s.store)}" onchange="STATE.project.defaultSites[${i}].store=this.value;touchProject();"></div>
          <div class="field"><label>Domaine</label><input value="${esc(s.domain)}" onchange="STATE.project.defaultSites[${i}].domain=this.value;touchProject();"></div>
          <button class="btn danger small" onclick="removeSite(${i})">Retirer</button>
        </div>`).join("")}</div>
      <button class="btn small" onclick="addSite()">+ Ajouter un site</button>
    </div>
    <div class="card">
      <h3>Zone de danger</h3>
      <button class="btn danger" onclick="deleteCurrentProject()">Supprimer ce projet</button>
    </div>`;
}
function addSite() { STATE.project.defaultSites.push({ store: "", domain: "" }); touchProject(); render(); }
function removeSite(i) { STATE.project.defaultSites.splice(i, 1); touchProject(); render(); }
async function deleteCurrentProject() {
  if (!confirm("Supprimer définitivement ce projet et toutes ses données ?")) return;
  try { await Api.deleteProject(STATE.project.id); } catch (e) { alert(e.message); return; }
  goHome();
}
window.addSite = addSite; window.removeSite = removeSite; window.deleteCurrentProject = deleteCurrentProject;

/* ============================================================
   RENDU — VUE PIECE
   ============================================================ */
function renderRoomView() {
  const room = currentRoom();
  if (!room) return `<p class="empty">Pièce introuvable.</p>`;
  const bucketId = "room:" + room.id;
  const rb = roomBucket(room);
  const addingLot = STATE.uiForms.addingLot;
  return `
    <div class="pagehead">
      <div>
        <div class="faint" style="cursor:pointer" onclick="setTab('apercu')">← ${esc(STATE.project.name)}</div>
        <h1>${esc(room.name)}</h1>
      </div>
      <button class="btn danger" onclick="deleteRoom('${room.id}')">Supprimer la pièce</button>
    </div>
    <div class="card">
      <div class="field-row">
        <div class="field"><label>Nom</label><input value="${esc(room.name)}" onchange="renameRoom('${room.id}',this.value)"></div>
        <div class="field"><label>Surface (m²)</label><input type="number" step="0.1" value="${room.surfaceM2 ?? ""}" onchange="STATE.project.rooms.find(r=>r.id==='${room.id}').surfaceM2=this.value?Number(this.value):null;touchProject();"></div>
        <div class="field"><label>Hauteur sous plafond (m)</label><input type="number" step="0.01" value="${room.heightM ?? ""}" onchange="STATE.project.rooms.find(r=>r.id==='${room.id}').heightM=this.value?Number(this.value):null;touchProject();"></div>
      </div>
      <div class="field"><label>Notes</label><textarea rows="2" onchange="STATE.project.rooms.find(r=>r.id==='${room.id}').notes=this.value;touchProject();">${esc(room.notes)}</textarea></div>
    </div>

    <h2 style="margin-top:6px;">Travaux généraux de la pièce</h2>
    <p class="faint" style="margin-top:-6px;margin-bottom:12px;">Pas besoin de créer un lot pour commencer : décrivez la tâche à l'assistant IA (✨) ou ajoutez directement une étape, un article ou une décision ci-dessous.</p>
    ${renderStepsCard(bucketId, rb.steps)}
    ${renderItemsCard(bucketId, rb)}
    ${renderDecisionsCard(bucketId, rb.decisions)}

    <div class="row between" style="margin-bottom:10px;margin-top:26px;">
      <h2 style="margin-bottom:0;">Lots de travaux <span class="faint" style="font-weight:400;">— optionnel, pour subdiviser un chantier précis</span></h2>
      ${addingLot ? "" : `<button class="btn primary" onclick="STATE.uiForms.addingLot=true;render();">+ Ajouter un lot</button>`}
    </div>
    ${addingLot ? `
    <div class="card" style="margin-bottom:14px;">
      <div class="field-row" style="align-items:flex-end;margin-bottom:0;">
        <div class="field" style="flex:1;margin-bottom:0;"><label>Nom du lot</label><input id="new-lot-name" placeholder="Ex : Électricité, Peinture, Salle de bain" onkeydown="if(event.key==='Enter'){event.preventDefault();submitAddLot('${room.id}');}"></div>
        <button class="btn primary" onclick="submitAddLot('${room.id}')">Créer</button>
        <button class="btn ghost" onclick="STATE.uiForms.addingLot=false;render();">Annuler</button>
      </div>
    </div>` : ""}
    ${room.lots.length === 0 ? `<p class="empty">Aucun lot pour l'instant. Un lot regroupe les étapes, achats et décisions d'un chantier précis (ex : « Électricité », « Salle de bain »).</p>` : `
    <div class="grid cols-3">${room.lots.map((lot) => `
      <div class="lot-card" onclick="goLot('${room.id}','${lot.id}')">
        <h3>${esc(lot.name)}</h3>
        <div class="row gap-sm" style="margin-bottom:6px;">${diyBadge(lot.diy)}<span class="badge later">${statusLabel(lot.status)}</span></div>
        <div class="lot-meta">${lot.items.length} article(s) · ${fmtEUR(lotTotal(lot))}</div>
      </div>`).join("")}</div>`}
  `;
}
function renameRoom(roomId, name) {
  const room = STATE.project.rooms.find((r) => r.id === roomId);
  if (room) room.name = name;
  touchProject();
}
function deleteRoom(roomId) {
  if (!confirm("Supprimer cette pièce et tous ses lots ?")) return;
  STATE.project.rooms = STATE.project.rooms.filter((r) => r.id !== roomId);
  touchProject();
  setTab("apercu");
}
function submitAddLot(roomId) {
  const input = document.getElementById("new-lot-name");
  const name = input ? input.value.trim() : "";
  if (!name) { if (input) input.focus(); return; }
  const room = STATE.project.rooms.find((r) => r.id === roomId);
  const lot = newLot(name);
  room.lots.push(lot);
  STATE.uiForms.addingLot = false;
  touchProject();
  goLot(roomId, lot.id);
}
window.renameRoom = renameRoom; window.deleteRoom = deleteRoom; window.submitAddLot = submitAddLot;

/* ============================================================
   RENDU — VUE LOT
   ============================================================ */
function renderLotView() {
  const room = currentRoom();
  const lot = currentLot();
  if (!room || !lot) return `<p class="empty">Lot introuvable.</p>`;
  return `
    <div class="pagehead">
      <div>
        <div class="faint" style="cursor:pointer" onclick="goRoom('${room.id}')">← ${esc(room.name)}</div>
        <h1>${esc(lot.name)}</h1>
      </div>
      <button class="btn danger" onclick="deleteLot('${room.id}','${lot.id}')">Supprimer le lot</button>
    </div>
    <div class="card">
      <div class="field-row">
        <div class="field"><label>Nom</label><input value="${esc(lot.name)}" onchange="lotSet('${lot.id}','name',this.value)"></div>
        <div class="field"><label>Catégorie</label><input value="${esc(lot.category)}" placeholder="ex : électricité, plomberie…" onchange="lotSet('${lot.id}','category',this.value)"></div>
        <div class="field"><label>Approche</label>
          <select onchange="lotSet('${lot.id}','diy',this.value)">
            <option value="diy" ${lot.diy === "diy" ? "selected" : ""}>DIY</option>
            <option value="diy-assiste" ${lot.diy === "diy-assiste" ? "selected" : ""}>DIY assisté</option>
            <option value="artisan" ${lot.diy === "artisan" ? "selected" : ""}>Artisan</option>
          </select>
        </div>
        <div class="field"><label>Statut</label>
          <select onchange="lotSet('${lot.id}','status',this.value)">
            <option value="a-faire" ${lot.status === "a-faire" ? "selected" : ""}>À faire</option>
            <option value="en-cours" ${lot.status === "en-cours" ? "selected" : ""}>En cours</option>
            <option value="fait" ${lot.status === "fait" ? "selected" : ""}>Terminé</option>
          </select>
        </div>
      </div>
    </div>

    ${renderStepsCard(lot.id, lot.steps)}
    ${renderItemsCard(lot.id, lot)}
    ${renderDecisionsCard(lot.id, lot.decisions)}
  `;
}
function lotSet(lotId, key, value) {
  const lot = currentLot();
  if (lot && lot.id === lotId) lot[key] = value;
  touchProject();
  render();
}
function deleteLot(roomId, lotId) {
  if (!confirm("Supprimer ce lot et tout son contenu ?")) return;
  const room = STATE.project.rooms.find((r) => r.id === roomId);
  room.lots = room.lots.filter((l) => l.id !== lotId);
  touchProject();
  goRoom(roomId);
}
window.lotSet = lotSet; window.deleteLot = deleteLot;

/* ============================================================
   CARTES REUTILISABLES — Étapes / Articles / Décisions
   (utilisées à la fois par la vue "Pièce" — travaux généraux —
    et par la vue "Lot", via un bucketId générique)
   ============================================================ */
function renderStepsCard(bucketId, steps) {
  const adding = STATE.uiForms.addingStep;
  return `
    <div class="card">
      <div class="row between"><h3>Étapes</h3>${adding ? "" : `<button class="btn small" onclick="STATE.uiForms.addingStep=true;render();">+ Étape</button>`}</div>
      ${adding ? `
      <div class="field-row" style="align-items:flex-end;">
        <div class="field" style="flex:1;"><label>Nouvelle étape</label><input id="new-step-text" placeholder="Décrire l'étape" onkeydown="if(event.key==='Enter'){event.preventDefault();submitAddStep('${bucketId}');}"></div>
        <button class="btn primary" onclick="submitAddStep('${bucketId}')">Ajouter</button>
        <button class="btn ghost" onclick="STATE.uiForms.addingStep=false;render();">Annuler</button>
      </div>` : ""}
      ${steps.length === 0 ? `<p class="faint">Aucune étape définie. Décrivez la tâche à l'assistant IA (✨ en bas à droite) pour générer des étapes, ou ajoutez-les manuellement.</p>` : `
      <div class="checklist">${steps.map((s) => `
        <label>
          <input type="checkbox" ${s.done ? "checked" : ""} onchange="toggleStep('${bucketId}','${s.id}')">
          <span style="${s.done ? "text-decoration:line-through;color:var(--ink-faint);" : ""}">${esc(s.text)}</span>
          <button class="btn ghost small" style="margin-left:auto" onclick="event.stopPropagation();deleteStep('${bucketId}','${s.id}')">✕</button>
        </label>`).join("")}</div>`}
    </div>`;
}
function submitAddStep(bucketId) {
  const input = document.getElementById("new-step-text");
  const text = input ? input.value.trim() : "";
  if (!text) { if (input) input.focus(); return; }
  const b = findBucketById(bucketId);
  if (b) b.lot.steps.push(newStep(text));
  STATE.uiForms.addingStep = false;
  touchProject();
  render();
}
function toggleStep(bucketId, stepId) {
  const b = findBucketById(bucketId);
  const s = b && b.lot.steps.find((x) => x.id === stepId);
  if (s) s.done = !s.done;
  touchProject();
  render();
}
function deleteStep(bucketId, stepId) {
  const b = findBucketById(bucketId);
  if (b) {
    const idx = b.lot.steps.findIndex((s) => s.id === stepId);
    if (idx !== -1) b.lot.steps.splice(idx, 1);
  }
  touchProject();
  render();
}
window.submitAddStep = submitAddStep; window.toggleStep = toggleStep; window.deleteStep = deleteStep;

function renderDecisionsCard(bucketId, decisions) {
  const adding = STATE.uiForms.addingDecision;
  const lvl = STATE.uiForms.decisionLevel || "Important";
  return `
    <div class="card">
      <div class="row between"><h3>Décisions</h3>${adding ? "" : `<button class="btn small" onclick="STATE.uiForms.addingDecision=true;render();">+ Décision</button>`}</div>
      ${adding ? `
      <div class="field-row" style="align-items:flex-end;">
        <div class="field" style="flex:2;"><label>Décision à prendre</label><input id="new-decision-text" placeholder="Ex : choisir la teinte du joint" onkeydown="if(event.key==='Enter'){event.preventDefault();submitAddDecision('${bucketId}');}"></div>
        <div class="field"><label>Niveau</label>
          <select onchange="STATE.uiForms.decisionLevel=this.value">
            <option value="Urgent" ${lvl === "Urgent" ? "selected" : ""}>Urgent</option>
            <option value="Important" ${lvl === "Important" ? "selected" : ""}>Important</option>
            <option value="Plus tard" ${lvl === "Plus tard" ? "selected" : ""}>Plus tard</option>
          </select>
        </div>
        <button class="btn primary" onclick="submitAddDecision('${bucketId}')">Ajouter</button>
        <button class="btn ghost" onclick="STATE.uiForms.addingDecision=false;render();">Annuler</button>
      </div>` : ""}
      ${decisions.length === 0 ? `<p class="faint">Aucune décision en attente.</p>` : `
      <div class="checklist">${decisions.map((d) => `
        <label>
          <input type="checkbox" ${d.resolved ? "checked" : ""} onchange="toggleDecisionResolved('${bucketId}','${d.id}')">
          <span class="badge ${d.level === "Urgent" ? "urgent" : d.level === "Important" ? "important" : "later"}">${d.level}</span>
          <span style="${d.resolved ? "text-decoration:line-through;color:var(--ink-faint);" : ""}">${esc(d.text)}</span>
        </label>`).join("")}</div>`}
    </div>`;
}
function submitAddDecision(bucketId) {
  const input = document.getElementById("new-decision-text");
  const text = input ? input.value.trim() : "";
  if (!text) { if (input) input.focus(); return; }
  const level = STATE.uiForms.decisionLevel || "Important";
  const b = findBucketById(bucketId);
  if (b) b.lot.decisions.push(newDecision(text, level));
  STATE.uiForms.addingDecision = false;
  STATE.uiForms.decisionLevel = "Important";
  touchProject();
  render();
}
window.submitAddDecision = submitAddDecision;

/* ---- articles / items ---- */
function isItemCollapsed(it, manyItems) {
  const v = STATE.uiCollapse.items[it.id];
  return v === undefined ? manyItems : v;
}
function renderItemsCard(bucketId, lotLike) {
  const items = lotLike.items;
  const adding = STATE.uiForms.addingItem;
  const manyItems = items.length > 4;
  const anyCollapsed = items.some((it) => isItemCollapsed(it, manyItems));
  return `
    <div class="card">
      <div class="row between">
        <h3>Articles / achats</h3>
        <div class="row gap-sm">
          ${items.length > 1 ? `<button class="btn ghost small" onclick="toggleAllItems('${bucketId}',${anyCollapsed ? "false" : "true"})">${anyCollapsed ? "Tout déplier" : "Tout plier"}</button>` : ""}
          ${adding ? "" : `<button class="btn small" onclick="STATE.uiForms.addingItem=true;render();">+ Article</button>`}
        </div>
      </div>
      ${adding ? `
      <div class="field-row" style="align-items:flex-end;">
        <div class="field" style="flex:1;"><label>Nom de l'article</label><input id="new-item-name" placeholder="Ex : Receveur de douche" onkeydown="if(event.key==='Enter'){event.preventDefault();submitAddItem('${bucketId}');}"></div>
        <button class="btn primary" onclick="submitAddItem('${bucketId}')">Ajouter</button>
        <button class="btn ghost" onclick="STATE.uiForms.addingItem=false;render();">Annuler</button>
      </div>` : ""}
      ${items.length === 0 ? `<p class="faint">Aucun article pour l'instant.</p>` : items.map((it) => renderItemRow(bucketId, it, isItemCollapsed(it, manyItems))).join("")}
      <div class="row" style="margin-top:8px;font-weight:600;">Total : ${fmtEUR(lotTotal(lotLike))}</div>
    </div>`;
}
function toggleAllItems(bucketId, collapseAll) {
  const b = findBucketById(bucketId);
  if (!b) return;
  for (const it of b.lot.items) STATE.uiCollapse.items[it.id] = collapseAll;
  render();
}
function submitAddItem(bucketId) {
  const input = document.getElementById("new-item-name");
  const label = input ? input.value.trim() : "";
  if (!label) { if (input) input.focus(); return; }
  const b = findBucketById(bucketId);
  if (b) {
    const item = newItem(label);
    b.lot.items.push(item);
  }
  STATE.uiForms.addingItem = false;
  touchProject();
  render();
}
window.toggleAllItems = toggleAllItems; window.submitAddItem = submitAddItem;

function toggleItemCollapsed(itemId, currentlyCollapsed) {
  STATE.uiCollapse.items[itemId] = !currentlyCollapsed;
  render();
}
window.toggleItemCollapsed = toggleItemCollapsed;

function renderItemRow(bucketId, it, collapsed) {
  const total = fmtEUR((Number(it.qty) || 0) * (Number(it.unitPrice) || 0));
  if (collapsed) {
    return `
    <div class="item-row item-row-collapsed" id="item-${it.id}">
      <div class="item-summary" onclick="toggleItemCollapsed('${it.id}',true)">
        <span class="chevron">▸</span>
        <span class="item-summary-label">${esc(it.label || "(sans nom)")}</span>
        ${it.tbd ? '<span class="badge decision">à décider</span>' : ""}
        ${diyBadge(it.tag)}
        <span class="item-price">${total}</span>
      </div>
    </div>`;
  }
  return `
    <div class="item-row" id="item-${it.id}">
      <div class="item-summary" onclick="toggleItemCollapsed('${it.id}',false)">
        <span class="chevron">▾</span>
        <span class="item-summary-label">${esc(it.label || "(sans nom)")}</span>
        <span class="item-price">${total}</span>
      </div>
      <div class="item-main" style="margin-top:6px;">
        <div style="flex:1">
          <input class="item-title" style="width:100%;border:none;background:none;padding:2px 0;font-weight:600;" value="${esc(it.label)}" placeholder="Nom de l'article" onchange="itemSet('${bucketId}','${it.id}','label',this.value)">
          <div class="row gap-sm" style="margin-top:4px;">
            <input type="number" step="0.01" style="width:70px" value="${it.qty}" onchange="itemSet('${bucketId}','${it.id}','qty',Number(this.value))" title="Quantité">
            <input style="width:60px" value="${esc(it.unit)}" onchange="itemSet('${bucketId}','${it.id}','unit',this.value)" title="Unité">
            <input type="number" step="0.01" style="width:90px" placeholder="Prix unit." value="${it.unitPrice ?? ""}" onchange="itemSet('${bucketId}','${it.id}','unitPrice',this.value?Number(this.value):null)">
            <select onchange="itemSet('${bucketId}','${it.id}','tag',this.value)">
              <option value="diy" ${it.tag === "diy" ? "selected" : ""}>DIY</option>
              <option value="diy-assiste" ${it.tag === "diy-assiste" ? "selected" : ""}>DIY assisté</option>
              <option value="artisan" ${it.tag === "artisan" ? "selected" : ""}>Artisan</option>
            </select>
            <label class="faint" style="display:flex;align-items:center;gap:4px;"><input type="checkbox" ${it.tbd ? "checked" : ""} onchange="itemSet('${bucketId}','${it.id}','tbd',this.checked)">à décider</label>
          </div>
        </div>
        <button class="btn ghost small" onclick="deleteItem('${bucketId}','${it.id}')">Supprimer</button>
      </div>
      <textarea rows="1" class="item-note" style="width:100%;border:none;background:none;resize:vertical;" placeholder="Note…" onchange="itemSet('${bucketId}','${it.id}','note',this.value)">${esc(it.note)}</textarea>
      <div class="row between" style="margin-top:4px;">
        <div>${itemLinksHtml(it, it.id)}</div>
        <button class="btn ghost small" onclick="openProductSearch('${bucketId}','${it.id}')">🔎 Chercher en ligne</button>
      </div>
      ${STATE.search.openForItem === it.id ? renderSearchPanel(bucketId, it) : ""}
    </div>`;
}
function itemSet(bucketId, itemId, key, value) {
  const b = findBucketById(bucketId);
  const it = b && b.lot.items.find((x) => x.id === itemId);
  if (it) it[key] = value;
  touchProject();
  render();
}
function deleteItem(bucketId, itemId) {
  const b = findBucketById(bucketId);
  if (b) {
    const idx = b.lot.items.findIndex((i) => i.id === itemId);
    if (idx !== -1) b.lot.items.splice(idx, 1);
  }
  touchProject();
  render();
}
window.itemSet = itemSet; window.deleteItem = deleteItem;

function itemLinksHtml(it, itemId) {
  const links = it.links || [];
  if (!links.length) return "";
  if (links.length === 1) {
    const l = links[0];
    return `<a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">🔗 ${esc(l.store)}${l.price != null ? " — " + fmtEUR(l.price) : ""}</a>`;
  }
  const key = "li-" + itemId;
  const open = STATE.openLinkInfo && STATE.openLinkInfo[key];
  return `
    <span>
      <button class="btn ghost small" onclick="toggleLinkInfo('${key}')">ⓘ ${links.length} options d'achat</button>
      ${open ? `<div class="linkinfo">${links.map((l) => `
        <div class="linkopt" style="margin-bottom:6px;">
          <div class="linkopt-head"><b>${esc(l.store)}</b><span class="badge ${l.tier === "value" ? "tier-value" : "tier-mid"}">${l.tier === "value" ? "meilleur rapport qualité/prix" : "autre option"}</span></div>
          <div>${l.price != null ? fmtEUR(l.price) : "prix non renseigné"}</div>
          <a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">🔗 Voir la fiche produit</a>
          ${l.note ? `<div class="faint">${esc(l.note)}</div>` : ""}
        </div>`).join("")}</div>` : ""}
    </span>`;
}
function toggleLinkInfo(key) {
  STATE.openLinkInfo[key] = !STATE.openLinkInfo[key];
  render();
}
window.toggleLinkInfo = toggleLinkInfo;

/* ============================================================
   RECHERCHE PRODUIT EN LIGNE (par article)
   ============================================================ */
function openProductSearch(bucketId, itemId) {
  const b = findBucketById(bucketId);
  const it = b && b.lot.items.find((x) => x.id === itemId);
  STATE.search = { openForItem: itemId, query: (it && it.label) || "", busy: false, error: null, results: null, selected: {} };
  render();
}
function closeProductSearch() {
  STATE.search = { openForItem: null, query: "", busy: false, error: null, results: null, selected: {} };
  render();
}
window.openProductSearch = openProductSearch;
window.closeProductSearch = closeProductSearch;

function renderSearchPanel(bucketId, it) {
  const s = STATE.search;
  return `
    <div class="linkinfo" style="margin-top:8px;">
      <div class="row gap-sm">
        <input style="flex:1" value="${esc(s.query)}" onchange="STATE.search.query=this.value" placeholder="Terme de recherche">
        <button class="btn small primary" onclick="runProductSearch('${bucketId}','${it.id}')" ${s.busy ? "disabled" : ""}>${s.busy ? '<span class="spinner"></span> Recherche…' : "Chercher"}</button>
        <button class="btn ghost small" onclick="closeProductSearch()">Fermer</button>
      </div>
      ${s.error ? `<div class="errbox">${esc(s.error)}</div>` : ""}
      ${s.results ? renderSearchResults(bucketId, it) : ""}
    </div>`;
}
async function runProductSearch(bucketId, itemId) {
  STATE.search.busy = true;
  STATE.search.error = null;
  render();
  try {
    const sites = STATE.project.defaultSites.filter((x) => x.domain);
    const results = await Api.searchProducts(STATE.search.query, sites);
    STATE.search.results = results;
    STATE.search.selected = {};
  } catch (e) {
    STATE.search.error = e.message;
  }
  STATE.search.busy = false;
  render();
}
window.runProductSearch = runProductSearch;

function renderSearchResults(bucketId, it) {
  const s = STATE.search;
  const results = (s.results || []).filter((r) => !r.error && r.url);
  if (!results.length) return `<p class="faint" style="margin-top:8px;">Aucun résultat exploitable. Essayez un autre terme.</p>`;
  return `
    <p class="faint" style="margin:8px 0 4px;">Cochez la ou les options à garder, ajustez le prix si besoin, puis validez.</p>
    <div style="display:flex;flex-direction:column;gap:8px;">
      ${results.map((r, i) => {
        const price = guessPrice(r.description);
        return `
        <div class="linkopt">
          <div class="linkopt-head">
            <label style="cursor:pointer"><input type="checkbox" id="sr-pick-${i}" style="margin-right:6px;"><b>${esc(r.store)}</b></label>
          </div>
          <div style="font-size:12.8px;font-weight:600;margin:4px 0;">${esc(r.title || "(titre non détecté)")}</div>
          <div class="faint" style="margin-bottom:6px;">${esc((r.description || "").slice(0, 220))}</div>
          <a href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">🔗 Ouvrir la fiche</a>
          <div class="row gap-sm" style="margin-top:6px;">
            <label class="faint">Prix constaté (€) :</label>
            <input type="number" step="0.01" id="sr-price-${i}" style="width:90px" value="${price != null ? price : ""}">
          </div>
        </div>`;
      }).join("")}
    </div>
    <button class="btn small primary" style="margin-top:8px;" onclick="confirmSearchSelection('${bucketId}','${it.id}')">✓ Ajouter la sélection à l'article</button>
    ${STATE.search.selectError ? `<div class="errbox">${esc(STATE.search.selectError)}</div>` : ""}
  `;
}
function confirmSearchSelection(bucketId, itemId) {
  const results = (STATE.search.results || []).filter((r) => !r.error && r.url);
  const picked = [];
  results.forEach((r, i) => {
    const cb = document.getElementById("sr-pick-" + i);
    if (cb && cb.checked) {
      const priceInput = document.getElementById("sr-price-" + i);
      const price = priceInput && priceInput.value !== "" ? Number(priceInput.value) : null;
      picked.push({ store: r.store, url: r.url, price });
    }
  });
  if (!picked.length) {
    STATE.search.selectError = "Cochez au moins une option avant de valider.";
    render();
    return;
  }
  STATE.search.selectError = null;
  const withPrice = picked.filter((p) => p.price != null);
  let cheapestUrl = null;
  if (withPrice.length) cheapestUrl = withPrice.slice().sort((a, b) => a.price - b.price)[0].url;
  const newLinks = picked.map((p) => ({
    store: p.store,
    url: p.url,
    price: p.price,
    tier: cheapestUrl ? (p.url === cheapestUrl ? "value" : "mid") : "mid",
    note: "Trouvé via la recherche en ligne — à vérifier avant achat.",
  }));
  const b = findBucketById(bucketId);
  const it = b && b.lot.items.find((x) => x.id === itemId);
  if (it) {
    it.links = (it.links || []).concat(newLinks);
    if (it.unitPrice == null && withPrice.length) it.unitPrice = withPrice.slice().sort((a, b) => a.price - b.price)[0].price;
  }
  touchProject();
  closeProductSearch();
}
window.confirmSearchSelection = confirmSearchSelection;

/* ============================================================
   ASSISTANT IA
   ============================================================ */
function resetAIComposer() {
  STATE.ai.task = "";
  STATE.ai.error = null;
  STATE.ai.proposal = null;
  STATE.ai.selected = null;
  STATE.ai.images = [];
  STATE.ai.imgError = null;
}

function toggleAI() {
  STATE.ai.open = !STATE.ai.open;
  renderAIPanel();
}
window.toggleAI = toggleAI;

const AI_MAX_IMAGES = 6;
const AI_IMAGE_MAX_DIM = 1400;
const AI_IMAGE_QUALITY = 0.75;

function resizeImageFile(file, maxDim, quality) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Lecture du fichier impossible."));
    reader.onload = (e) => {
      const img = new Image();
      img.onerror = () => reject(new Error("Image illisible."));
      img.onload = () => {
        let width = img.naturalWidth || img.width;
        let height = img.naturalHeight || img.height;
        if (width > maxDim || height > maxDim) {
          if (width >= height) { height = Math.round((height * maxDim) / width); width = maxDim; }
          else { width = Math.round((width * maxDim) / height); height = maxDim; }
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, width, height);
        let dataUrl;
        try {
          dataUrl = canvas.toDataURL("image/jpeg", quality);
        } catch (err) {
          reject(err);
          return;
        }
        const m = dataUrl.match(/^data:([^;]+);base64,(.*)$/);
        if (!m) { reject(new Error("Encodage image impossible.")); return; }
        resolve({ mediaType: m[1], data: m[2], previewUrl: dataUrl, name: file.name });
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

async function handleAIImagesSelected(input) {
  const files = Array.from(input.files || []);
  input.value = "";
  if (!files.length) return;
  STATE.ai.imgError = null;
  const remaining = AI_MAX_IMAGES - STATE.ai.images.length;
  if (remaining <= 0) {
    STATE.ai.imgError = `Maximum ${AI_MAX_IMAGES} images par demande.`;
    renderAIPanel();
    return;
  }
  const toProcess = files.slice(0, remaining);
  for (const file of toProcess) {
    if (!file.type || !file.type.startsWith("image/")) continue;
    try {
      const img = await resizeImageFile(file, AI_IMAGE_MAX_DIM, AI_IMAGE_QUALITY);
      STATE.ai.images.push(img);
    } catch (e) {
      STATE.ai.imgError = "Une image n'a pas pu être ajoutée (" + (e.message || "erreur") + ").";
    }
  }
  renderAIPanel();
}
window.handleAIImagesSelected = handleAIImagesSelected;

function removeAIImage(idx) {
  STATE.ai.images.splice(idx, 1);
  renderAIPanel();
}
window.removeAIImage = removeAIImage;

function renderAIImagesPicker() {
  const ai = STATE.ai;
  return `
    <div style="margin:10px 0;">
      <input type="file" accept="image/*" multiple id="ai-img-input" style="display:none" onchange="handleAIImagesSelected(this)">
      <button class="btn small" type="button" onclick="document.getElementById('ai-img-input').click()">📎 Ajouter photo(s) / schéma(s)</button>
      <span class="faint" style="margin-left:6px;">Plan coté, photo de l'existant… (${ai.images.length}/${AI_MAX_IMAGES})</span>
      ${ai.imgError ? `<div class="errbox">${esc(ai.imgError)}</div>` : ""}
      ${ai.images.length ? `<div class="row gap-sm" style="margin-top:8px;flex-wrap:wrap;">${ai.images.map((img, i) => `
        <div style="position:relative;">
          <img src="${img.previewUrl}" style="width:64px;height:64px;object-fit:cover;border-radius:8px;border:1px solid var(--border-soft);">
          <button class="btn ghost small" style="position:absolute;top:-8px;right:-8px;background:var(--surface);border:1px solid var(--border);border-radius:999px;width:20px;height:20px;padding:0;line-height:1;" onclick="removeAIImage(${i})" title="Retirer">✕</button>
        </div>`).join("")}</div>` : ""}
    </div>`;
}

function renderAIPanel() {
  const root = document.getElementById("ai-panel-root");
  if (!root) return;
  if (!STATE.ai.open) { root.innerHTML = ""; return; }
  const bucketId = currentBucketId();
  const b = bucketId ? findBucketById(bucketId) : null;
  if (STATE.ai.forBucketId !== bucketId) {
    resetAIComposer();
    STATE.ai.forBucketId = bucketId;
  }
  const ai = STATE.ai;

  root.innerHTML = `
    <div class="ai-panel">
      <div class="ai-panel-head">
        <div><h3 style="margin:0;">✨ Assistant IA</h3><div class="faint">${b ? esc(b.room.name) + (b.lot.id ? " / " + esc(b.lot.name) : " — travaux généraux") : "Aucune pièce sélectionnée"}</div></div>
        <button class="btn ghost" onclick="toggleAI()">✕</button>
      </div>
      <div class="ai-panel-body">
        ${!b ? `<p class="muted">Ouvrez une pièce (ou un lot) pour que l'assistant sache où ranger ses propositions.</p>` : `
          <p class="faint">Décrivez la tâche à réaliser${b.lot.id ? " dans ce lot" : " pour cette pièce"} ; joignez si besoin un schéma, une photo de l'existant ou des cotes. L'assistant proposera des étapes, des articles à acheter et des décisions à prendre.</p>
          <textarea rows="4" style="width:100%;" placeholder="Ex : refaire l'installation électrique de cette pièce…" onchange="STATE.ai.task=this.value">${esc(ai.task)}</textarea>
          ${renderAIImagesPicker()}
          ${ai.error ? `<div class="errbox">${esc(ai.error)}</div>` : ""}
          ${ai.proposal ? renderAIProposal(ai.proposal) : ""}
        `}
      </div>
      ${b ? `<div class="ai-panel-foot">
        <button class="btn primary" style="width:100%" onclick="sendAI()" ${ai.busy ? "disabled" : ""}>${ai.busy ? '<span class="spinner"></span> Réflexion…' : "Générer les étapes et achats"}</button>
      </div>` : ""}
    </div>`;
}

async function sendAI() {
  const bucketId = currentBucketId();
  const b = bucketId ? findBucketById(bucketId) : null;
  if (!b) return;
  const task = STATE.ai.task && STATE.ai.task.trim();
  if (!task) { STATE.ai.error = "Décrivez d'abord la tâche à réaliser."; renderAIPanel(); return; }
  STATE.ai.busy = true;
  STATE.ai.error = null;
  STATE.ai.proposal = null;
  renderAIPanel();
  try {
    const context = {
      projet: STATE.project.name,
      piece: b.room.name,
      lot: b.lot.id ? b.lot.name : "Travaux généraux de la pièce",
      categorie: b.lot.category,
      approche: b.lot.diy,
      articlesExistants: b.lot.items.map((i) => i.label),
    };
    const images = STATE.ai.images.map((i) => ({ mediaType: i.mediaType, data: i.data }));
    const proposal = await Api.askAI(task, context, images);
    STATE.ai.proposal = proposal;
    STATE.ai.selected = {
      steps: (proposal.steps || []).map(() => true),
      items: (proposal.items || []).map(() => true),
      decisions: (proposal.decisions || []).map(() => true),
    };
  } catch (e) {
    STATE.ai.error = e.message;
  }
  STATE.ai.busy = false;
  renderAIPanel();
}
window.sendAI = sendAI;

function renderAIProposal(p) {
  const sel = STATE.ai.selected || {};
  return `
    <div class="card" style="margin-top:12px;">
      ${p.resume ? `<p style="font-weight:600;">${esc(p.resume)}</p>` : ""}
      ${(p.steps || []).length ? `<h4>Étapes</h4><div class="checklist">${p.steps.map((s, i) => `
        <label><input type="checkbox" ${sel.steps[i] ? "checked" : ""} onchange="STATE.ai.selected.steps[${i}]=this.checked"><span>${esc(s.text)}</span></label>`).join("")}</div>` : ""}
      ${(p.items || []).length ? `<h4 style="margin-top:12px;">Articles</h4><div class="checklist">${p.items.map((it, i) => `
        <label><input type="checkbox" ${sel.items[i] ? "checked" : ""} onchange="STATE.ai.selected.items[${i}]=this.checked">
          <span>${esc(it.label)} — ${it.qty || ""} ${esc(it.unit || "")} ${it.unitPrice != null ? "· " + fmtEUR(it.unitPrice) : "· prix à confirmer"} ${diyBadge(it.tag)}${it.note ? `<div class="faint">${esc(it.note)}</div>` : ""}</span>
        </label>`).join("")}</div>` : ""}
      ${(p.decisions || []).length ? `<h4 style="margin-top:12px;">Décisions</h4><div class="checklist">${p.decisions.map((d, i) => `
        <label><input type="checkbox" ${sel.decisions[i] ? "checked" : ""} onchange="STATE.ai.selected.decisions[${i}]=this.checked">
          <span class="badge ${d.level === "Urgent" ? "urgent" : d.level === "Important" ? "important" : "later"}">${d.level}</span> ${esc(d.text)}</span>
        </label>`).join("")}</div>` : ""}
      ${(p.risks || []).length ? `<h4 style="margin-top:12px;">Points de vigilance</h4><ul>${p.risks.map((r) => `<li class="faint">${esc(r)}</li>`).join("")}</ul>` : ""}
      <button class="btn primary" style="margin-top:12px;width:100%;" onclick="applyAIProposal()">✓ Ajouter la sélection au lot</button>
    </div>`;
}
function applyAIProposal() {
  const bucketId = STATE.ai.forBucketId || currentBucketId();
  const b = findBucketById(bucketId);
  if (!b) return;
  const p = STATE.ai.proposal;
  const sel = STATE.ai.selected;
  (p.steps || []).forEach((s, i) => { if (sel.steps[i]) b.lot.steps.push(newStep(s.text)); });
  (p.items || []).forEach((it, i) => {
    if (sel.items[i]) {
      const item = newItem(it.label);
      item.qty = it.qty || 1;
      item.unit = it.unit || "u";
      item.unitPrice = it.unitPrice != null ? it.unitPrice : null;
      item.note = it.note || "";
      item.tag = it.tag || "diy";
      item.tbd = it.unitPrice == null;
      b.lot.items.push(item);
    }
  });
  (p.decisions || []).forEach((d, i) => { if (sel.decisions[i]) b.lot.decisions.push(newDecision(d.text, d.level)); });
  touchProject();
  resetAIComposer();
  render();
}
window.applyAIProposal = applyAIProposal;

/* ============================================================
   EXPOSITION GLOBALE + BOOT
   ============================================================ */
window.goHome = goHome;
window.goProject = goProject;
window.goRoom = goRoom;
window.goLot = goLot;
window.STATE = STATE;
window.touchProject = touchProject;
window.render = render;
window.newItem = newItem;
window.newStep = newStep;
window.newDecision = newDecision;
window.findBucketById = findBucketById;
window.projectTotal = projectTotal;

window.addEventListener("hashchange", route);
route();
