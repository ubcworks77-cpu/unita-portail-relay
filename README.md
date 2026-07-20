# Déploiement du relais push

## 1. Générer les clés VAPID (une seule fois)

```
npx web-push generate-vapid-keys
```

Note bien la clé publique et la clé privée — la publique sera aussi utilisée dans `pwa/app.js`.

## 2. Héberger (option recommandée : Render.com, gratuit pour ce volume)

1. Créer un compte Render (toi, pas moi — création de compte).
2. "New Web Service" → connecter ce dossier `relay/` (via GitHub, ou upload direct).
3. Build command : `npm install`
4. Start command : `npm start`
5. Variables d'environnement à définir :
   - `VAPID_PUBLIC_KEY`
   - `VAPID_PRIVATE_KEY`
   - `VAPID_CONTACT_EMAIL` = `mailto:info@ezw.works`
   - `ODOO_WEBHOOK_SECRET` = choisis une chaîne aléatoire longue (ex. générée avec `openssl rand -hex 32`)
   - `ODOO_URL` = `https://ub-center.odoo.com`
   - `ODOO_DB` = `ub-center`
   - `ODOO_LOGIN` = ton email de connexion Odoo
   - `ODOO_API_KEY` = une clé API Odoo (voir étape 4 ci-dessous) — **à créer et coller toi-même, ne la partage jamais en clair dans le chat**
6. Une fois déployé, tu obtiens une URL type `https://unita-relay.onrender.com`.

Alternatives équivalentes : Fly.io, Railway, un petit VPS existant.

## 3. Pourquoi une clé API Odoo ?

L'action native "Envoyer une notification webhook" d'Odoo ne peut transmettre que
l'ID brut des champs sélectionnés (ex. `partner_id: 45`), pas son email ni un texte
personnalisé. Le relais doit donc interroger l'API Odoo lui-même pour retrouver
l'email du client à partir de son ID.

## 4. Créer la clé API Odoo (à faire toi-même)

1. Dans Odoo, clique sur ton avatar (haut à droite) → **Mon profil**.
2. Onglet **Sécurité du compte** → section **Clés API** → **Nouvelle clé API**.
3. Donne-lui un nom (ex. "Relais push portail") et confirme ton mot de passe.
4. Copie la clé générée **immédiatement** (elle ne sera plus jamais affichée) et
   colle-la toi-même dans la variable `ODOO_API_KEY` sur Render — je ne dois pas
   la manipuler.

## 5. Une fois l'URL + la clé API en place

Dis-moi juste que c'est fait, je finalise les 2 règles d'automatisation Odoo pour
pointer vers `https://<ton-url>/webhook/odoo?secret=<ODOO_WEBHOOK_SECRET>`.

## Test rapide en local

```
cd relay
npm install
VAPID_PUBLIC_KEY=xxx VAPID_PRIVATE_KEY=yyy ODOO_WEBHOOK_SECRET=test \
ODOO_URL=https://ub-center.odoo.com ODOO_DB=ub-center ODOO_LOGIN=toi@exemple.com ODOO_API_KEY=xxx \
npm start
```

Puis :
```
curl -X POST "http://localhost:3000/webhook/odoo?secret=test" \
  -H "Content-Type: application/json" \
  -d '{"_model":"account.move","partner_id":45}'
```
