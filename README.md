# Assurance Chasse — ADC&E

Sites jumeaux pour l'assurance chasse, partenariat **Cabinet ADCE Assurances** × Fédérations Départementales des Chasseurs.

| Département | Code | Domaine | FDC |
|---|---|---|---|
| Gironde | 33 | www.assurancechasse33.fr | FDC33 |
| Calvados | 14 | www.assurancechasse14.fr | FDC14 |
| Dordogne | 24 | www.assurancechasse24.fr | FDC24 |
| Lot-et-Garonne | 47 | www.assurancechasse47.fr | FDC47 |

## Architecture

- **1 repo, 4 sites** : tous les sites partagent le même code. Seul `config/<dept>.json` change.
- **Build statique** : `templates/*.html` + `config/*.json` → `dist/<dept>/*.html`.
- **Déploiement** : 4 projets Vercel pointant vers ce repo, chacun avec une variable d'env `DEPT=<slug>`.
- **Stripe** : 1 compte unique, mêmes `price_id` pour les 4 sites. `metadata.department` permet le suivi par fédération.
- **Firebase** : 1 projet Firestore unique pour stocker souscriptions, sinistres, contacts.

## Commandes

```bash
npm run build              # Build les 4 sites
npm run build:gironde      # Build un seul site
DEPT=gironde npm run build # Vercel
```

## TODO

- [x] Structure projet + page d'accueil
- [ ] options-chasse.html (tunnel souscription + Stripe)
- [ ] sinistre.html, confirmation.html, contact.html
- [ ] chatbot.html (avec proxy serverless Anthropic)
- [ ] dashboard.html (back-office, à protéger par auth)
- [ ] api/stripe-checkout.js, stripe-webhook.js, chatbot.js, claim-submit.js
- [ ] Création des produits Stripe
- [ ] Setup Firebase + Gmail SMTP
