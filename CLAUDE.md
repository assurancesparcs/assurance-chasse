# Règles de travail pour Claude — Projet ADC&E Assurances Chasse

## 🎯 Règles d'or (priorité absolue)

1. **Liens directs toujours** : ne JAMAIS faire perdre du temps à l'utilisateur en décrivant un chemin de menus. Donner directement le lien cliquable de la page concernée. Quand un lien admet des paramètres pré-remplis (ex. GitHub token avec scopes), les utiliser.
2. **Concision** : pas de pavés inutiles. Aller à l'essentiel.
3. **Tester avant de demander** : si une étape technique est testable côté code, la tester localement (build, syntax check) avant de demander à l'utilisateur de tester.
4. **Anticiper les pièges récurrents** : conflits comptes Google, OIDC Vercel Blob, tokens dans le chat à révoquer, etc.

## 🔗 Raccourcis (liens directs à utiliser systématiquement)

### GitHub
- **Créer un Personal Access Token (classic) avec `repo` pré-coché** : https://github.com/settings/tokens/new?description=claude-push-temp&scopes=repo
- **Lister / révoquer tokens** : https://github.com/settings/tokens
- **Repo** : https://github.com/assurancesparcs/assurance-chasse

### Vercel
- **Tokens** : https://vercel.com/account/tokens
- **Dashboard projets** : https://vercel.com/dashboard
- Projets : `assurance-chasse` (33), `assurance-chasse-calvados` (14), `assurance-chasse-dordogne` (24), `assurance-chasse-lot-et-garonne` (47)
- Pour Environment Variables d'un projet : Settings → Environment Variables

### Stripe (mode En direct)
- **Webhooks** : https://dashboard.stripe.com/webhooks
- **Produits** : https://dashboard.stripe.com/products
- **Clés API** : https://dashboard.stripe.com/apikeys

### Google
- **Drive** : https://drive.google.com (compte `chasse.assurance@gmail.com`)
- **Apps Script** : https://script.google.com

### Anthropic (pour le chatbot)
- **Console API** : https://console.anthropic.com/
- **Clés API** : https://console.anthropic.com/settings/keys

## 🏗 Architecture du projet

### Repo
Mono-repo qui génère 4 sites statiques (un par dépt) via `scripts/build.js` + templating `{{var}}`.

```
config/           — 1 fichier JSON par dépt + _brand.json (commun)
templates/        — fichiers HTML avec variables {{...}}
templates/_partials/ — nav, footer, etc.
public/           — PDFs, images, vidéo, vendor/leaflet
api/              — fonctions serverless Vercel (Node.js)
scripts/build.js  — build statique → dist/{slug}/
```

### Les 4 sites
| Dépt | Slug | Domaine | dualEntryHomepage | showVideo | showSecureArea |
|---|---|---|---|---|---|
| Gironde | gironde | assurancechasse33.fr | ✅ | ✅ | ✅ |
| Calvados | calvados | assurancechasse14.fr | ✅ | ✅ | ✅ |
| Dordogne | dordogne | assurancechasse24.fr | ✅ | ✅ | ✅ |
| Lot-et-Garonne | lot-et-garonne | assurancechasse47.fr | ✅ | ✅ | ✅ |

### Partenaires assurance
- **RC chasseur individuel** : MIC Insurance / ELKYIA (CG MIC, IPID RCCH)
- **Sécurité chasse (option 1)** : Allianz, gérée par Cabinet Poncey Lebas
- **Chiens (option 2)** : MIC Insurance / ELKYIA
- **Installation cynégétique (option 3)** : MIC Insurance / ELKYIA — 160 €/an forfait
- **ACCA (collectif)** : Allianz Associa Pro, contrat n°48596694 / ORIAS Poncey Lebas 07022305-12066667 (PAS encore actif côté souscription — badge "Prochainement disponible")

### Tarifs (`config/_brand.json`)
- Sécurité chasse : 25 €/an
- Chiens petits gibiers : 45 €/chien/an
- Chiens gros gibiers : 95 €/chien/an
- Installation cynégétique : 160 €/an
- Frais admin : 1 € par ligne

### Tunnel souscription
1. `/garanties.html` → choix option → bouton "En savoir plus"
2. `/lecture-{securite,chiens,installation}.html` → ouvrir 2 PDFs CG → cocher 2 cases → bouton "Procéder à la souscription"
3. `/options-chasse.html?opt={sec,chi,ins}` → formulaire (avec carte Leaflet GPS pour Option 3)
4. Récap → Stripe Checkout → `/confirmation.html`

### Flux post-paiement (webhook `/api/stripe-webhook`)
Trois destinations en parallèle (`Promise.allSettled`) :
1. **✉ Emails** : confirmation client + alerte interne (sujet `[PAIEMENT FDC??]`) avec PDF attestation joint
2. **📊 Google Sheets** : si `GOOGLE_SHEETS_WEBHOOK_URL` + `GOOGLE_SHEETS_WEBHOOK_SECRET` configurés
3. **🗄  Archive Blob** : 1 JSON + 1 PDF par souscription dans Vercel Blob du projet (sous prefix `souscriptions/` et `attestations/`)

→ L'admin (User1) télécharge le CSV consolidé depuis l'**Espace Siège** : action `?action=export-souscriptions-csv`.

### Espace Siège (4 sites)
- Login : `/secure-login.html` (JWT, cookie 1h)
- Coffre : `/espace-securise.html`
- 2 utilisateurs par site : `SECURE_USER1` (admin = `chasse.assurance@gmail.com`) et `SECURE_USER2` (client local, optionnel)
- **User1 seul** a accès aux souscriptions (CSV + liste PDF) via `isAdminSession()` côté API
- User2 a accès aux fichiers déposés uniquement
- Chaque site a son propre Blob store **isolé** (`espace-securise-{slug}`)

### Vercel Blob — mode OIDC ou classique
Le code (`api/secure.js`, `api/stripe-webhook.js`) gère automatiquement les 2 modes via le helper `blobOpts()` :
- Mode classique : `BLOB_READ_WRITE_TOKEN` injecté → SDK gère seul
- Mode OIDC : `VERCEL_OIDC_TOKEN` (runtime) + `BLOB_READ_WRITE_TOKEN_STORE_ID` → passés explicitement au SDK

Si erreur Blob "No credentials" dans le siège → l'API renvoie un diagnostic UI (encart orange) qui dit précisément quoi configurer côté Vercel.

### Chatbot
- Page dédiée plein écran `/chatbot.html` (lien "Assistant" dans la nav)
- Backend `api/chatbot.js` → API Anthropic Claude (variable `ANTHROPIC_API_KEY` sur projet 33)
- System prompt par département (FDC, gibier, tarifs)

## 🔐 Variables d'env par projet Vercel

### Commun aux 4 projets
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (seul projet 33)
- `STRIPE_PRICE_SECURITE`, `STRIPE_PRICE_CHIENS_PETIT`, `STRIPE_PRICE_CHIENS_GROS`, `STRIPE_PRICE_ADMIN`, `STRIPE_PRICE_INSTALLATION`
- `GMAIL_USER` (= `chasse.assurance@gmail.com`), `GMAIL_APP_PASSWORD`
- `DEPT` (= slug du dépt, ex. `gironde`)
- `ANTHROPIC_API_KEY` (au moins sur projet 33 pour le chatbot)

### Espace Siège (par projet, distinct par site)
- `JWT_SECRET`, `CRON_SECRET` (chaînes aléatoires propres à chaque site)
- `SECURE_USER1_EMAIL` / `_NAME` / `_HASH`
- `SECURE_USER2_EMAIL` / `_NAME` / `_HASH` (optionnel)
- `BLOB_READ_WRITE_TOKEN` (mode classique) OU `BLOB_READ_WRITE_TOKEN_STORE_ID` (mode OIDC) — injecté automatiquement par Vercel quand le Blob est connecté au projet

### Suivi souscriptions (projet 33 uniquement)
- `GOOGLE_SHEETS_WEBHOOK_URL` (URL Apps Script `/exec`) — optionnel, Blob est l'archive principale
- `GOOGLE_SHEETS_WEBHOOK_SECRET`

## ⚠️ Pièges récurrents à anticiper

1. **Conflit de comptes Google** dans Apps Script : "Impossible d'ouvrir le fichier" → toujours faire en navigation privée avec **un seul compte** connecté.
2. **OIDC Vercel Blob** : sur les nouveaux stores, `BLOB_READ_WRITE_TOKEN` n'est pas injecté, c'est `VERCEL_OIDC_TOKEN` (runtime) + `BLOB_READ_WRITE_TOKEN_STORE_ID`. Le code gère, mais ne pas s'inquiéter si la variable n'apparaît pas dans la liste UI.
3. **Tokens dans le chat** : toujours rappeler à l'utilisateur de **révoquer** après usage (GitHub, Vercel, Stripe restricted).
4. **`continued: true` PDFKit** : ne pas l'utiliser entre 2 styles différents — provoque des chevauchements. Faire des `text()` séparés.
5. **Emojis dans PDF (Helvetica)** : ils s'affichent en caractères corrompus (Ø=Þá). Ne PAS utiliser d'emoji dans le contenu PDFKit.
6. **Push GitHub** : tokens valables max 1-7 jours, prévoir d'en redemander à chaque session.
7. **Apps Script Web App** : doit être déployé en "Qui a accès : Tout le monde" sinon Vercel reçoit une page de login HTML au lieu du JSON.

## 🛠 Workflow de modif standard

1. Modifier le fichier dans `templates/` ou `api/` ou `config/`
2. `node scripts/build.js` pour vérifier que tous les sites buildent
3. `node --check` sur les fichiers JS modifiés (syntax check)
4. `git add -A && git -c commit.gpgsign=false commit -m "..."` (signing server souvent KO dans la sandbox)
5. Push avec le token GitHub temporaire fourni par l'utilisateur
6. Rappeler à l'utilisateur de révoquer le token quand on a fini

## 🚫 NE PAS faire

- Ne pas créer de fichier `.md` (README, docs, etc.) sans demande explicite
- Ne pas modifier `config/_brand.json` sans vérifier l'impact sur les 4 sites
- Ne pas changer la structure `DUAL_ONLY_TEMPLATES` dans `build.js` (casse les 3 dépts qui héritent)
- Ne pas push avec `--no-verify` (sauf signing server KO comme aujourd'hui)
- Ne pas réutiliser le même Blob store entre plusieurs projets Vercel (= fuite de fichiers entre départements)
