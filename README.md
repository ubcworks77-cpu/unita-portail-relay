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
6. Une fois déployé, tu obtiens une URL type `https://unita-relay.onrender.com`.

Alternatives équivalentes : Fly.io, Railway, un petit VPS existant.

## 3. Une fois l'URL connue

Donne-moi l'URL + le `ODOO_WEBHOOK_SECRET` choisi, je configure les 2 règles d'automatisation Odoo pour pointer vers `https://<ton-url>/webhook/odoo`.

## Test rapide en local

```
cd relay
npm install
VAPID_PUBLIC_KEY=xxx VAPID_PRIVATE_KEY=yyy ODOO_WEBHOOK_SECRET=test npm start
```

Puis :
```
curl -X POST http://localhost:3000/webhook/odoo \
  -H "Content-Type: application/json" \
  -d '{"secret":"test","partner_email":"test@example.com","title":"Test","body":"Ceci est un test","url":"https://ub-center.odoo.com/my/home"}'
```
