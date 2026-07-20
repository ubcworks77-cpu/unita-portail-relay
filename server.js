/**
 * Relais push — Portail client Unita Business Zaventem
 *
 * Rôle :
 *  - reçoit les abonnements push envoyés par le PWA (POST /subscribe)
 *  - reçoit les webhooks envoyés par Odoo (POST /webhook/odoo) et transforme
 *    ça en notification push envoyée au(x) client(s) concerné(s)
 *
 * Stockage : fichier JSON local (subscriptions.json). Suffisant pour le
 * volume actuel (quelques dizaines de clients). À migrer vers une vraie
 * base (ex. Postgres) si le volume grossit fortement.
 */

const express = require("express");
const cors = require("cors");
const webpush = require("web-push");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());

const DB_FILE = path.join(__dirname, "subscriptions.json");

// --- Config (à définir en variables d'environnement chez l'hébergeur) ---
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_CONTACT_EMAIL = process.env.VAPID_CONTACT_EMAIL || "mailto:info@ezw.works";
// Secret partagé simple pour vérifier que les appels /webhook/odoo viennent bien d'Odoo
// (transmis en query string ?secret=... car l'action native "Envoyer une notification
// webhook" d'Odoo ne permet pas d'ajouter des clés personnalisées dans le corps JSON).
const ODOO_WEBHOOK_SECRET = process.env.ODOO_WEBHOOK_SECRET || "changeme";

// --- Accès API Odoo (pour résoudre partner_id -> email, l'automatisation
// Odoo ne peut envoyer que l'ID brut, pas l'email directement) ---
const ODOO_URL = process.env.ODOO_URL || "https://ub-center.odoo.com";
const ODOO_DB = process.env.ODOO_DB || "ub-center";
const ODOO_LOGIN = process.env.ODOO_LOGIN;
const ODOO_API_KEY = process.env.ODOO_API_KEY;

let odooUidCache = null;

async function odooJsonRpc(service, method, args) {
  const res = await fetch(`${ODOO_URL}/jsonrpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "call",
      params: { service, method, args },
      id: Date.now(),
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(JSON.stringify(data.error));
  return data.result;
}

async function odooAuthenticate() {
  if (odooUidCache) return odooUidCache;
  if (!ODOO_LOGIN || !ODOO_API_KEY) {
    throw new Error("ODOO_LOGIN / ODOO_API_KEY non configurés");
  }
  odooUidCache = await odooJsonRpc("common", "authenticate", [ODOO_DB, ODOO_LOGIN, ODOO_API_KEY, {}]);
  if (!odooUidCache) throw new Error("Authentification Odoo échouée");
  return odooUidCache;
}

// Résout l'email d'un partenaire (res.partner) à partir de son ID.
async function getPartnerEmail(partnerId) {
  if (!partnerId) return null;
  const uid = await odooAuthenticate();
  const result = await odooJsonRpc("object", "execute_kw", [
    ODOO_DB, uid, ODOO_API_KEY,
    "res.partner", "read", [[partnerId], ["email"]],
  ]);
  return result && result[0] ? result[0].email : null;
}

if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
  console.warn(
    "ATTENTION: VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY non définies. " +
    "Génère-les une fois avec: npx web-push generate-vapid-keys"
  );
} else {
  webpush.setVapidDetails(VAPID_CONTACT_EMAIL, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

function loadDb() {
  if (!fs.existsSync(DB_FILE)) return { subscriptions: {} };
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  } catch {
    return { subscriptions: {} };
  }
}

function saveDb(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

// Clé d'identification du client : on utilise son email de portail Odoo
// (partner email), c'est ce qu'Odoo peut nous transmettre facilement dans
// le champ "_fields" du webhook.
function keyFor(email) {
  return (email || "").trim().toLowerCase();
}

// ---------------------------------------------------------------------
// GET /vapid-public-key — le PWA récupère la clé publique pour s'abonner
// ---------------------------------------------------------------------
app.get("/vapid-public-key", (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

// ---------------------------------------------------------------------
// POST /subscribe — le PWA enregistre l'abonnement push d'un client
// body: { email: "client@example.com", subscription: {...PushSubscription} }
// ---------------------------------------------------------------------
app.post("/subscribe", (req, res) => {
  const { email, subscription } = req.body || {};
  if (!email || !subscription) {
    return res.status(400).json({ error: "email et subscription requis" });
  }
  const db = loadDb();
  const k = keyFor(email);
  db.subscriptions[k] = db.subscriptions[k] || [];
  // évite les doublons (même endpoint)
  const exists = db.subscriptions[k].some((s) => s.endpoint === subscription.endpoint);
  if (!exists) db.subscriptions[k].push(subscription);
  saveDb(db);
  res.json({ ok: true });
});

// Construit le message push selon le modèle Odoo à l'origine du webhook.
function buildNotification(modelName) {
  if (modelName === "account.move") {
    return {
      title: "Nouvelle facture disponible",
      body: "Une facture vient d'être émise sur votre compte Unita.",
      url: "https://ub-center.odoo.com/my/invoices",
    };
  }
  if (modelName === "documents.document") {
    return {
      title: "Nouveau courrier reçu",
      body: "Un document vient d'être ajouté à votre espace courrier.",
      url: "https://ub-center.odoo.com/my/documents",
    };
  }
  return {
    title: "Unita Business Zaventem",
    body: "Nouvelle information disponible sur votre portail.",
    url: "https://ub-center.odoo.com/my/home",
  };
}

// ---------------------------------------------------------------------
// POST /webhook/odoo?secret=... — appelé par l'action native "Envoyer une
// notification webhook" d'une règle d'automatisation Odoo.
//
// Le secret est passé en query string (?secret=...) car l'action native
// d'Odoo ne permet pas d'ajouter des clés personnalisées dans le corps JSON :
// elle n'envoie que les valeurs brutes des champs sélectionnés ("Champs"),
// plus les métadonnées _action / _id / _model. Il faut donc que la règle
// Odoo inclue le champ "Partenaire" (partner_id) — le relais résout
// lui-même son email via l'API Odoo.
//
// Corps reçu, ex. :
// { "_action": "...", "_id": 887, "_model": "account.move", "partner_id": 45 }
// ---------------------------------------------------------------------
app.post("/webhook/odoo", async (req, res) => {
  if (req.query.secret !== ODOO_WEBHOOK_SECRET) {
    return res.status(401).json({ error: "secret invalide" });
  }

  const { _model, partner_id } = req.body || {};
  if (!partner_id) {
    return res.status(400).json({ error: "partner_id requis" });
  }

  let partnerEmail;
  try {
    partnerEmail = await getPartnerEmail(partner_id);
  } catch (err) {
    console.error("Erreur résolution email Odoo:", err.message);
    return res.status(502).json({ error: "résolution email Odoo échouée" });
  }
  if (!partnerEmail) {
    return res.json({ ok: true, sent: 0, reason: "email introuvable" });
  }

  const db = loadDb();
  const k = keyFor(partnerEmail);
  const subs = db.subscriptions[k] || [];

  if (subs.length === 0) {
    // Le client n'a pas (encore) installé le PWA / activé les notifications.
    // Ce n'est pas une erreur : il verra l'info dans son portail / son email.
    return res.json({ ok: true, sent: 0 });
  }

  const payload = JSON.stringify(buildNotification(_model));

  let sent = 0;
  const stillValid = [];
  for (const sub of subs) {
    try {
      await webpush.sendNotification(sub, payload);
      sent++;
      stillValid.push(sub);
    } catch (err) {
      // 410/404 = abonnement expiré, on le retire silencieusement
      if (err.statusCode !== 410 && err.statusCode !== 404) {
        stillValid.push(sub);
      }
    }
  }
  db.subscriptions[k] = stillValid;
  saveDb(db);

  res.json({ ok: true, sent });
});

app.get("/", (req, res) => {
  res.send("Relais push Unita — OK");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Relais push démarré sur le port ${PORT}`));
