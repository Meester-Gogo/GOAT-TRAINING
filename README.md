# GOAT Trail

Générateur de plan d'entraînement trail et ultra, piloté par le **km-effort** (`km + D+/100`).

L'application construit une préparation complète jusqu'au jour J : montée en charge progressive, week-ends choc, blocs PIC CHOC, macrocycles, et répartition des séances en fonction de tes disponibilités réelles.

---

## Publier sur GitHub Pages

### 1. Créer le dépôt

Sur GitHub, crée un dépôt (par exemple `goat-trail`), puis dépose ces fichiers à la racine.

Si tu importes fichier par fichier via l'interface web, respecte l'arborescence :

```
goat-trail/
├── index.html
├── package.json
├── vite.config.js
├── tailwind.config.js
├── postcss.config.js
├── .gitignore
├── README.md
├── public/
│   └── manifest.webmanifest
├── src/
│   ├── App.jsx
│   ├── main.jsx
│   └── index.css
└── .github/
    └── workflows/
        └── deploy.yml
```

> L'interface web de GitHub ne permet pas de créer un dossier vide : pour créer `src/App.jsx`, clique « Add file → Create new file » et saisis le chemin complet `src/App.jsx` dans le champ du nom.

### 2. Activer Pages

Dans le dépôt : **Settings → Pages → Source → GitHub Actions**.

### 3. Déployer

Le déploiement part automatiquement à chaque `push` sur `main`. Suis-le dans l'onglet **Actions**.

Ton application sera disponible sur :
`https://<ton-pseudo>.github.io/<nom-du-depot>/`

Ouvre ce lien sur ton téléphone, puis « Ajouter à l'écran d'accueil » pour l'utiliser comme une vraie application.

---

## Développement local

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # génère dist/
npm run preview  # prévisualise le build
```

---

## Le chat IA : ce qui change sur le web

Les trois assistants conversationnels (remplir un objectif, saisir son historique, planifier une semaine) appellent l'API Anthropic.

Dans l'environnement Claude, ces appels étaient relayés par l'hôte. **Un site statique n'a pas ce relais** : tu dois fournir ta propre clé API, dans l'onglet **Profil**.

**Tout le reste fonctionne sans clé** : génération du plan, périodisation, week-ends choc, PIC CHOC, bibliothèque de séances, export `.FIT`, statistiques. Le chat est la seule fonctionnalité concernée.

### À savoir avant d'ajouter une clé

- La clé est stockée dans le `localStorage` de ton navigateur et envoyée directement à Anthropic depuis la page.
- Elle est donc **visible dans les outils de développement**. C'est acceptable pour un usage personnel sur ton propre appareil ; ça ne l'est pas sur un poste partagé, et il ne faut pas diffuser la clé.
- La consommation est facturée sur ton compte Anthropic.
- Pour une diffusion réellement publique, il faudrait un petit service intermédiaire (fonction serverless) qui garde la clé côté serveur. Ce n'est pas inclus ici.

Créer une clé : [console.anthropic.com](https://console.anthropic.com).

---

## Données

Tout est stocké **localement dans ton navigateur** (`localStorage`) : objectif, plan généré, bibliothèque de séances, profil, historique. Rien n'est envoyé sur un serveur.

Conséquences à connaître :

- Changer de navigateur ou d'appareil = repartir de zéro.
- Vider les données du site efface le plan.
- Le mode navigation privée ne conserve rien.

---

## Export vers la montre

Chaque séance peut être exportée en `.FIT` depuis l'onglet Semaine. Le fichier est généré directement dans le navigateur.

- **Garmin** : importer le fichier dans Garmin Connect, puis synchroniser la montre.
- **Coros** : le format `.FIT` est accepté, mais je ne l'ai pas testé — à vérifier de ton côté.

---

## Limites connues

- Le moteur est conçu pour le **trail et l'ultra**. La logique route existe (bascule automatique sous ~55 km-éq) mais reste incomplète : le travail en zones et les allures cibles ne sont pas encore développés.
- Les estimations de temps de course sont des fourchettes larges, pas des promesses. Le km-effort sous-estime l'effort au-delà de 50 km et sur terrain très technique.
- L'application ne remplace pas un entraîneur. Les avertissements de risque de blessure sont des garde-fous, pas un avis médical.
