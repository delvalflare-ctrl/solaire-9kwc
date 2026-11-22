# Application & Alertes Solaires 9 kWc (Infoclimat GFS)

## Réglages modifiables
- **Dans `index.html` (`⚙️ Réglages`)** : modifie directement le seuil de fenêtre solaire (W), le seuil d'alerte push +30 min (W), l'horaire du bilan quotidien (`HH:MM`) et la plage horaire active pour les push temps réel (`HH:MM-HH:MM`). Ces choix sont sauvegardés sur ton téléphone.
- **Sur GitHub Actions (`alerte.js` + `.github/workflows/push.yml`)** : modifie `WINDOW_WATTS`, `PUSH_WATTS`, `MORNING_PUSH_TIME` et `REALTIME_WINDOW` dans **Settings → Secrets and variables → Actions** (Variables ou Secrets) sans avoir à réécrire le code.
