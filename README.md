# Verger

Un générateur de répertoires d'ouvertures calibré sur les adversaires réels de ton niveau.
Tu donnes ton Elo, ta couleur et ta cadence. L'arbre pousse là où les joueurs de ton niveau jouent vraiment (Opening Explorer de Lichess), et tes coups sont choisis par Stockfish selon leur jouabilité.

## Lancer

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # tests de l'algorithme (Explorer et moteur simulés)
```

L'Opening Explorer de Lichess exige un **jeton d'accès personnel** (aucune permission à cocher) :
<https://lichess.org/account/oauth/token/create?description=Verger>. Le jeton reste dans le `localStorage` du navigateur.

## Comment l'arbre pousse

C'est toi qui construis le répertoire, coup par coup, sur l'échiquier. La logique est dans [src/lib/session.ts](src/lib/session.ts) et [src/lib/repertoire.ts](src/lib/repertoire.ts).

- **À ton tour** : Stockfish propose les N meilleurs coups (3 par défaut), sans dépasser `maxLoss` centipions de perte par rapport au meilleur. Tu en joues un sur l'échiquier ; les autres coups sont refusés.
- **Au tour adverse** : l'app joue le coup le plus fréquent chez les joueurs de ta tranche d'Elo (±150) et de ta cadence. Un seul coup adverse entre dans l'arbre à la fois.
- **Fin de ligne** : à la profondeur choisie, ou quand Lichess n'a plus de données.
- **Ligne suivante** : l'app ouvre automatiquement la réponse adverse non préparée **la plus probable dans tout l'arbre** (produit des fréquences depuis le début de la partie), rejoue la position et continue. L'ordre est imposé.
- **Budget** : le répertoire est terminé quand il compte autant de lignes que le budget. « + 5 lignes » relance la construction.
- **Remplacer un de mes coups** efface sa suite et redemande le choix à cette position.
- **Transpositions** : un coup qui mène à une position déjà présente dans l'arbre (même position, même demi-coup) devient un renvoi « ↪ ». La ligne s'arrête là et ne compte pas dans le budget. Les probabilités de tous les chemins qui mènent à une même position s'additionnent.
- **Fiabilité** : un coup adverse n'entre dans le répertoire que s'il a été joué au moins `minGames` fois (30 par défaut) à ton niveau. Pour tes candidats, l'app affiche aussi le score obtenu à ton niveau, quand l'échantillon est suffisant.

Indicateurs :

- **Couverture** : la probabilité de rester dans le répertoire jusqu'au coup N, c'est-à-dire le produit des fréquences adverses le long des branches.
- **Pièges** : un coup adverse joué dans au moins 10 % des parties et qui perd au moins 1,2 pion.

L'export PGN produit une seule partie avec variantes et commentaires de fréquence, importable dans une étude Lichess. La progression est sauvegardée dans le navigateur et reprend au rechargement.

## Stack

React + TypeScript (Vite), chess.js, chessground, Stockfish 19 *lite* mono-thread en WASM dans un Web Worker (`public/stockfish/`, pas besoin d'isolation cross-origin), et un cache IndexedDB pour les réponses de l'Explorer. Après un 429, l'app attend 60 s comme le demande Lichess.

Licence : Stockfish est sous GPL v3 (`public/stockfish/Copying.txt`). Si l'app est distribuée, elle doit l'être sous une licence compatible.

## Prochaines étapes (MVP)

1. ~~Construction assistée du répertoire~~ ✔
2. Entraîneur : drill avec répétition espacée (ts-fsrs), et mode « sortie de livre ».
3. Import des parties Lichess : comparer le répertoire à ce que tu joues vraiment, élaguer les lignes jamais rencontrées et recalibrer quand l'Elo monte.
