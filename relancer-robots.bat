@echo off
rem Robots de trading : retelecharge l'historique, relance la recherche et refait le rapport
rem de l'onglet "Robots de trading". A lancer a la main ou chaque semaine (Planificateur de taches).
cd /d "%~dp0"
if not exist node_modules call npm install
echo Compilation du labo...
call node scripts/robots/build.mjs
echo Mise a jour de l'historique complet (crypto Binance, HistData M1, indices Yahoo)...
call node robots/.build/history.mjs
echo Telechargement Yahoo et perpetuels Binance...
call node scripts/robots/fetch-data.mjs --force
rem les resultats precedents vont dans robots\archive (le rapport ne garde que la nouvelle recherche)
if not exist robots\archive mkdir robots\archive
if exist robots\results\*.json move /y robots\results\*.json robots\archive\ >nul
echo Recherche (serie 1 puis affinage)...
call node robots/.build/lab.mjs --plan r1 --round semaine-r1
call node robots/.build/lab.mjs --plan r2 --round semaine-r2
echo Rapport...
call node robots/.build/report.mjs
echo Termine : ouvrez l'onglet "Robots de trading".
