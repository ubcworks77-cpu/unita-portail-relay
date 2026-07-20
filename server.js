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
const ODOO_WEBHOOK_SECRET = process.env.ODOO_WEBHOOK_SECRET || "changeme";

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

// ---------------------------------------------------------------------
// POST /webhook/odoo — appelé par l'action "Envoyer une notification
// webhook" d'une règle d'automatisation Odoo.
//
// Payload attendu (configuré dans Odoo, champ "Champs" de l'action) :
// {
//   "secret": "...",
//   "type": "courrier" | "facture",
//   "partner_email": "client@example.com",
//   "title": "Nouveau courrier reçu",
//   "body": "Un document vient d'être ajouté à votre espace.",
//   "url": "https://ub-center.odoo.com/my/documents"
// }
// ---------------------------------------------------------------------
app.post("/webhook/odoo", async (req, res) => {
  const { secret, partner_email, title, body, url } = req.body || {};

  if (secret !== ODOO_WEBHOOK_SECRET) {
    return res.status(401).json({ error: "secret invalide" });
  }
  if (!partner_email) {
    return res.status(400).json({ error: "partner_email requis" });
  }

  const db = loadDb();
  const k = keyFor(partner_email);
  const subs = db.subscriptions[k] || [];

  if (subs.length === 0) {
    // Le client n'a pas (encore) installé le PWA / activé les notifications.
    // Ce n'est pas une erreur : il verra l'info dans son portail / son email.
    return res.json({ ok: true, sent: 0 });
  }

  const payload = JSON.stringify({
    title: title || "Unita Business Zaventem",
    body: body || "Nouvelle information disponible sur votre portail.",
    url: url || "https://ub-center.odoo.com/my/home",
  });

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
