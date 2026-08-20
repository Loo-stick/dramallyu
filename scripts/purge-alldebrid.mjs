// Purge des magnets qu'AllDebrid garde pour rien.
//
// POURQUOI. La verification de cache televerse des empreintes chez AllDebrid pour
// savoir lesquelles sont pretes ; celles qui ne le sont pas s'y mettent en
// telechargement. Elles sont normalement retirees aussitot, mais une garde defaillante
// a laisse s'accumuler des centaines d'entrees (corrige le 2026-08-20 — ce script
// nettoie l'existant, il ne remplace pas le correctif).
//
// NE SUPPRIME QUE DES CAS SURS, et rien d'autre :
//   - les magnets dont le NOM est une empreinte nue : AllDebrid n'a jamais recu de
//     metadonnees, c'est la signature d'un depot de verification. Un fichier que vous
//     avez lance porte un nom de release ;
//   - les statuts d'echec definitif : « No peer after 30 minutes », « Download took
//     more than 3 days », « Expired ».
//
// NE TOUCHE JAMAIS a un magnet « Ready » nomme, ni a un telechargement en cours : ce
// sont ceux que vous avez demandes.
//
// USAGE. Le script tourne DANS le conteneur : la configuration est chiffree et
// `TOKEN_SECRET`, qui seul permet de la lire, n'existe que la.
//
//   docker exec -e SEG='<votre lien de configuration>' dramallyu \
//     node /app/scripts/purge-alldebrid.mjs                 # montre, ne supprime rien
//   docker exec -e SEG='...' dramallyu \
//     node /app/scripts/purge-alldebrid.mjs --supprimer
//
// Sans `--supprimer`, RIEN n'est efface : le script affiche exactement ce qu'il ferait.
// La cle passe par SEG et par le decodeur de l'addon — elle n'apparait donc jamais en
// clair dans la ligne de commande, ni dans l'historique du shell, ni dans `ps`.

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const BASE = 'https://api.alldebrid.com/v4';
const BASE_STATUS = 'https://api.alldebrid.com/v4.1'; // /magnet/status a bascule en v4.1
const AGENT = 'dramallyu';

const ECHECS = [/no peer/i, /took more than/i, /expired/i, /error/i];
const estHashNu = (nom) => /^[a-f0-9]{40}$/i.test(String(nom || '').trim());

function cle() {
  const seg = process.env.SEG || '';
  if (!seg) {
    console.error('SEG manquant : passez votre lien de configuration en variable SEG.');
    process.exit(2);
  }
  // On passe par le decodeur de l'addon : la cle ne transite pas par la ligne de
  // commande et n'apparait donc ni dans l'historique du shell ni dans `ps`.
  const { parseConfig } = require('/app/dist/core/config');
  const cfg = parseConfig(seg);
  if (!cfg.ad) {
    console.error('Ce lien ne porte pas de cle AllDebrid.');
    process.exit(2);
  }
  return cfg.ad;
}

async function magnets(apiKey) {
  const r = await fetch(`${BASE_STATUS}/magnet/status?agent=${AGENT}&apikey=${apiKey}`);
  const d = await r.json();
  if (d?.status !== 'success') throw new Error(JSON.stringify(d?.error || d).slice(0, 200));
  return d.data?.magnets ?? [];
}

const octets = (n) => (n > 0 ? `${(n / 1024 ** 3).toFixed(1)} Go` : '—');

async function main() {
  const apiKey = cle();
  const supprimer = process.argv.includes('--supprimer');
  const tous = await magnets(apiKey);

  const candidats = tous.filter((m) => {
    const statut = String(m.status || '');
    if (/downloading|processing|uploading/i.test(statut)) return false; // en cours : jamais
    return estHashNu(m.filename) || ECHECS.some((re) => re.test(statut));
  });

  const parStatut = {};
  for (const m of tous) parStatut[m.status] = (parStatut[m.status] || 0) + 1;

  console.log(`Compte : ${tous.length} magnet(s)`);
  for (const [s, n] of Object.entries(parStatut).sort((a, b) => b[1] - a[1])) {
    console.log(`   ${String(n).padStart(4)}  ${s}`);
  }
  console.log(`\nCandidats a la purge : ${candidats.length}`);
  for (const m of candidats.slice(0, 40)) {
    const raison = estHashNu(m.filename) ? 'nom = empreinte nue' : 'echec definitif';
    console.log(`   ${String(m.status).padEnd(32)} ${octets(m.size)}  ${raison}`);
    console.log(`      ${String(m.filename || '').slice(0, 78)}`);
  }
  if (candidats.length > 40) console.log(`   … et ${candidats.length - 40} autre(s)`);

  const gardes = tous.length - candidats.length;
  console.log(`\nConserves : ${gardes} (« Ready » nommes, et tout ce qui est en cours)`);

  if (!supprimer) {
    console.log('\nRien n a ete supprime. Relancez avec --supprimer pour appliquer.');
    return;
  }

  let ok = 0;
  let ko = 0;
  for (const m of candidats) {
    const r = await fetch(`${BASE}/magnet/delete?agent=${AGENT}&apikey=${apiKey}&id=${m.id}`);
    const d = await r.json().catch(() => null);
    if (d?.status === 'success') ok++;
    else {
      ko++;
      if (ko <= 3) console.log(`   echec sur ${m.id} : ${JSON.stringify(d?.error || d).slice(0, 120)}`);
    }
  }
  console.log(`\nSupprimes : ${ok}/${candidats.length}${ko ? ` — ${ko} en echec` : ''}`);
}

main().catch((e) => {
  console.error('Echec :', e.message);
  process.exit(1);
});
