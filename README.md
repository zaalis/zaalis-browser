# zaalis Browser for macOS

Le navigateur qui prolonge **zaalis labs ide** sur le Web.

zaalis Browser transforme la navigation en espace de travail : il réunit une
expérience macOS rapide, des espaces personnels isolés, des contrôles de
confidentialité précis et une assistance contextuelle connectée à zaalis labs
ide. Le résultat : moins d'interruptions entre la recherche, la lecture,
l'organisation et l'action.

## Conçu pour le travail moderne

L'interface reste familière, tout en apportant les outils qui comptent au
quotidien : les onglets restent synchronisés, les pages publiées se
réactualisent proprement, et l'assistance de zaalis labs ide est accessible
directement dans le navigateur lorsqu'elle est disponible localement.

## Fonctionnalités

- Onglets, favoris, historique et raccourcis persistants
- Vue fractionnée pour comparer deux pages côte à côte
- Profils indépendants : cookies, autorisations, favoris et historique séparés
- Navigation privée avec session temporaire
- Actualisation sans cache et revalidation des onglets restés en arrière-plan
- Panneau d'informations par site : connexion, cookies, données et permissions
- HTTPS, contrôle des permissions et protection contre les sites dangereux
- Recherche, recherche vocale et suggestions de navigation
- Assistant contextuel, recherche IA et interaction guidée avec les pages via
  zaalis labs ide
- Téléchargements, contrôles média et applications web épinglées
- Interface macOS moderne, adaptée aux Mac Apple Silicon et Intel

## Installation

Téléchargez le fichier correspondant à votre Mac depuis les releases :

- `zaalisBrowser-*-arm64.dmg` — Mac Apple Silicon (M1, M2, M3, M4…)
- `zaalisBrowser-*-x64.dmg` — Mac Intel

Ouvrez le DMG, puis glissez **zaalis browser** dans le dossier
**Applications**.

> Les versions de développement peuvent ne pas être signées par Apple. macOS
> peut demander une confirmation lors de la première ouverture.

## Développement

```bash
npm install
npm start
```

Pour construire les images disque macOS :

```bash
npm run pack:all
```

## Licence et marque

Le code source est publié sous [GNU AGPLv3](LICENSE). Toute version modifiée
ou redistribuée doit conserver cette licence et rendre son code source
disponible dans les conditions prévues par l'AGPLv3.

Le nom **zaalis**, les logos et l'identité visuelle ne sont pas concédés par
cette licence. Ils ne peuvent pas être utilisés pour présenter un produit
dérivé comme un produit officiel ou approuvé par zaalis.
