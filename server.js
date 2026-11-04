const express = require('express');
const path = require('path');
const app = express();

app.set('trust proxy', 1);
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ============ CONFIGURATION ============
const GEMINI_KEY = process.env.GEMINI_API_KEY || null;
const liste = (valeur) => valeur.split(',').map(s => s.trim()).filter(Boolean);
// ⚠️ Si la variable GEMINI_MODEL existe sur Render, ELLE ÉCRASE cette liste !
const GEMINI_MODELS = liste(process.env.GEMINI_MODEL || 'gemini-3.8-flash,gemini-3.5-flash-lite,gemini-2.5-flash,gemini-2.5-flash-lite');

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const nbMots = (t) => String(t).split(/\s+/).filter(Boolean).length;

// ============ LIMITE DE REQUÊTES ============
const FENETRE_MS = 60 * 1000;
const MAX_PAR_FENETRE = 10;
const historique = new Map();

function tropDeRequetes(ip) {
    const now = Date.now();
    const recentes = (historique.get(ip) || []).filter(t => now - t < FENETRE_MS);
    recentes.push(now);
    historique.set(ip, recentes);
    return recentes.length > MAX_PAR_FENETRE;
}
setInterval(() => {
    const now = Date.now();
    for (const [ip, ts] of historique) {
        if (ts.every(t => now - t >= FENETRE_MS)) historique.delete(ip);
    }
}, 5 * 60 * 1000).unref();

// ============================================================
//  TYPES DE LETTRES D'AMOUR, TONS, LONGUEURS
// ============================================================
const TYPES = {
    declaration: {
        nom: 'déclaration d’amour',
        ton: 'sincère, ému, courageux — un cœur qui s’avoue enfin',
        fermeture: 'Avec tout mon cœur,',
        defaut: 'avouer enfin mes sentiments, dire depuis quand je l’aime, ce qui m’a fait craquer chez elle ou lui, et mon espoir d’être aimé en retour'
    },
    amour: {
        nom: 'lettre d’amour',
        ton: 'tendre, chaleureux, plein de gratitude',
        fermeture: 'Je t’aime,',
        defaut: 'dire mon amour au quotidien, rappeler ce que cette personne illumine dans ma vie et combien je suis heureux à ses côtés'
    },
    manque: {
        nom: 'lettre « tu me manques »',
        ton: 'doux, nostalgique, plein d’espoir de retrouvailles',
        fermeture: 'Tu me manques terriblement,',
        defaut: 'dire le vide de son absence, les petits riens qui me la rappellent chaque jour, et mon impatience de la retrouver'
    },
    excuses: {
        nom: 'lettre d’excuses à l’être aimé',
        ton: 'humble, regrettant, sans justification ni reproche',
        fermeture: 'En espérant ton pardon,',
        defaut: 'reconnaître mes torts sans chercher d’excuses, dire combien je regrette d’avoir fait du mal à la personne que j’aime et combien je tiens à nous'
    },
    anniversaire: {
        nom: 'lettre d’anniversaire amoureux',
        ton: 'joyeux, tendre, un peu ému',
        fermeture: 'Pour toujours à tes côtés,',
        defaut: 'célébrer notre histoire, le chemin parcouru ensemble, et réaffirmer mon amour pour toutes les années qui viennent'
    },
    reconquete: {
        nom: 'lettre de reconquête amoureuse',
        ton: 'sincère, doux, sans pression ni chantage affectif',
        fermeture: 'En espérant te revoir un jour,',
        defaut: 'dire ce que j’ai compris depuis la séparation, ce qui a changé en moi, et mon souhait sincère de nous redonner une chance — sans rien exiger'
    }
};

const TONS = {
    tendre: 'tendre et doux',
    passionne: 'passionné, brûlant mais digne',
    pudique: 'pudique, à demi-mot, l’émotion sous la surface',
    humour: 'taquin et léger, avec tendresse, sans moquerie',
    poetique: 'poétique, avec des images simples et lumineuses (pas de métaphores obscures)'
};

const LONGUEURS = {
    courte:  { mots: 100, paragraphes: 2 },
    moyenne: { mots: 180, paragraphes: 3 },
    longue:  { mots: 300, paragraphes: 4 }
};

const TYPES_AUTORISES = Object.keys(TYPES);
const TONS_AUTORISES = ['auto', ...Object.keys(TONS)];
const LONGUEURS_AUTORISES = Object.keys(LONGUEURS);

// ============================================================
//  CONSIGNES — LETTRES D'AMOUR SIMPLES ET SINCÈRES
// ============================================================
const SYSTEME = `Tu écris des lettres d'amour SIMPLES et sincères en français, comme des lettres manuscrites qu'on garde précieusement toute une vie.

RÈGLE 1 — L'ÊTRE AIMÉ AVANT TOUT : la lettre s'adresse à une seule personne et ne parle que de ce qui la concerne. Chaque paragraphe lui parle directement (« tu »).

RÈGLE 2 — STRUCTURE DE LETTRE :
- une ligne d'ouverture seule, finie par une virgule (ex : « Chère Léa, », « Léa, », « Mon amour, ») ;
- des paragraphes de phrases coulées (PAS de vers, PAS de listes) ;
- une formule de fin seule sur sa ligne (ex : « Avec tout mon cœur, ») ;
- la signature seule sur sa ligne si elle est demandée.

RÈGLE 3 — SIMPLICITÉ ET SINCÉRITÉ : des mots de tous les jours, des phrases courtes. Dis des choses vraies : un sentiment, un souvenir précis, une qualité, un souhait. Pas de formules de lettre administrative, pas de phrases alambiquées.

RÈGLE 4 — UTILISE LES DÉTAILS DONNÉS : les souvenirs, qualités et moments fournis par l'utilisateur sont le cœur de la lettre. N'invente PAS de scènes sans rapport avec eux.

RÈGLE 5 — INTERDITS : markdown, listes à puces, emojis, mots anglais, clichés tout faits (« âme sœur », « mon soleil », « la flamme de mon cœur », « amour éternel »), déclarations grandiloquentes.

FORMAT DE SORTIE : la lettre brute, rien d'autre : pas de titre, pas d'introduction, pas de commentaire, pas de markdown.`;

function construireConsigne(destinataire, prompt, type, ton, longueur, signature) {
    const t = TYPES[type] || TYPES.declaration;
    const cfg = LONGUEURS[longueur] || LONGUEURS.moyenne;
    const tonTexte = ton !== 'auto' && TONS[ton] ? TONS[ton] : t.ton;
    const sujet = prompt || t.defaut;

    const user = `Écris une ${t.nom} en français.

DESTINATAIRE — la lettre lui parle directement, en la tutoyant :
« ${destinataire} »

CE QUE LA LETTRE DOIT DIRE :
« ${sujet} »

TON : ${tonTexte}

LONGUEUR : environ ${cfg.mots} mots, en ${cfg.paragraphes} paragraphes de phrases coulées.
STRUCTURE : ligne d'ouverture finie par une virgule, puis les paragraphes, puis une formule de fin seule sur sa ligne${signature ? `, puis la signature « ${signature} » seule sur la dernière ligne` : ' (pas de signature)'}.
Lettre brute uniquement : pas de titre, pas d'introduction, pas de commentaire, pas de markdown.`;

    return { system: SYSTEME, user };
}

// ============================================================
//  APPEL GEMINI — défensif (retry en config minimale si HTTP 400)
// ============================================================
async function appelerGemini(modele, system, user) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modele)}:generateContent`;
    const headers = { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_KEY };
    const corpsBase = {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }]
    };

    let generationConfig = { maxOutputTokens: 4096 };
    if (/2\.5/.test(modele)) {
        generationConfig.temperature = 0.85;
        generationConfig.topP = 0.95;
        generationConfig.thinkingConfig = { thinkingBudget: 0 };
    }

    let r = await fetch(url, {
        method: 'POST', headers,
        body: JSON.stringify({ ...corpsBase, generationConfig }),
        signal: AbortSignal.timeout(30000)
    });

    if (r.status === 400) {
        const jErr = await r.json().catch(() => ({}));
        console.warn(`[IA] ${modele} : HTTP 400 (${jErr?.error?.message || '?'}) → essai en config minimale`);
        generationConfig = { maxOutputTokens: 4096 };
        r = await fetch(url, {
            method: 'POST', headers,
            body: JSON.stringify({ ...corpsBase, generationConfig }),
            signal: AbortSignal.timeout(30000)
        });
    }

    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`HTTP ${r.status} – ${j?.error?.message || 'réponse inattendue'}`);
    const parts = j?.candidates?.[0]?.content?.parts || [];
    const texte = parts.filter(p => p.text && !p.thought).map(p => p.text).join('').trim();
    if (!texte) {
        const blocage = j?.promptFeedback?.blockReason;
        throw new Error(blocage ? `réponse bloquée (${blocage})` : 'réponse vide');
    }
    return texte;
}

// ============================================================
//  MISE EN FORME : ouverture + paragraphes + formule de fin + signature
// ============================================================
const MOTS_FERMETURE = /(embrasse|amour|cœur|amiti|affection|reconnaissance|pardon|courage|confiance|tendrement|affectueusement|bien à toi|à bientôt|prends soin|pense à toi|manques|sincèrement)/i;

function decouperParagraphes(texte, n) {
    const phrases = texte.split(/(?<=[.!?…])\s+/).filter(Boolean);
    if (phrases.length <= n) return [texte];
    const par = [];
    const cible = Math.ceil(phrases.length / n);
    for (let i = 0; i < phrases.length; i += cible) par.push(phrases.slice(i, i + cible).join(' '));
    return par;
}

function bornerMots(paragraphes, maxMots) {
    let total = paragraphes.reduce((s, p) => s + nbMots(p), 0);
    while (total > maxMots && paragraphes.length > 1) {
        total -= nbMots(paragraphes.pop());
    }
    if (total > maxMots && paragraphes.length === 1) {
        const phrases = paragraphes[0].split(/(?<=[.!?…])\s+/);
        const acc = [];
        let compte = 0;
        for (const ph of phrases) {
            if (compte + nbMots(ph) > maxMots && acc.length) break;
            acc.push(ph);
            compte += nbMots(ph);
        }
        if (acc.length) paragraphes[0] = acc.join(' ');
    }
    return paragraphes;
}

function mettreEnFormeLettre(brut, { longueur, signature, destinataire, type }) {
    if (!brut) return null;
    const cfg = LONGUEURS[longueur] || LONGUEURS.moyenne;
    const t = TYPES[type] || TYPES.declaration;

    let lignes = brut
        .replace(/\r/g, '')
        .replace(/```[a-z]*/gi, '')
        .split('\n')
        .map(l => l.replace(/[*_#>]/g, '').replace(/^[-•]\s+/, '').trim())
        .filter(l => l === '' || !/^(voici (ma|la|ta|votre|une)?|bien sûr|d'accord|certainement|avec plaisir)/i.test(l));

    while (lignes.length && !lignes[0]) lignes.shift();
    while (lignes.length && !lignes[lignes.length - 1]) lignes.pop();
    if (!lignes.length) return null;

    // --- Signature : retirée du corps si le modèle l'a écrite, puis remise proprement
    let sig = null;
    if (signature) {
        const idx = lignes.findIndex(l => l.toLowerCase() === signature.toLowerCase());
        if (idx !== -1) lignes.splice(idx, 1);
        sig = signature;
    }

    // --- Formule de fin : dernière ligne courte si elle y ressemble
    let fermeture = null;
    if (lignes.length) {
        const derniere = lignes[lignes.length - 1];
        const m = nbMots(derniere);
        if (m <= 10 && (MOTS_FERMETURE.test(derniere) || /[,…]\s*$/.test(derniere) || (m <= 6 && !/[.!?]$/.test(derniere)))) {
            fermeture = lignes.pop().replace(/[,:\s]+$/, ',');
        }
    }
    if (!fermeture) fermeture = t.fermeture;

    // --- Ligne d'ouverture : première ligne courte finie par virgule / deux-points
    let ouverture = null;
    if (lignes.length) {
        const premiere = lignes[0];
        const estOuverture =
            (premiere.length <= 60 && /[,:]\s*$/.test(premiere) && nbMots(premiere) <= 8) ||
            (/^(cher|chère|mon|ma|mes|bien-aimé|bien-aimée)/i.test(premiere) && premiere.length <= 60);
        if (estOuverture) {
            ouverture = lignes.shift().replace(/["«“'‘\s]+|["»”'’\s]+$/g, '').replace(/[,:\s]+$/, ',');
        }
    }
    if (!ouverture) {
        const court = destinataire.split(',')[0].trim();
        ouverture = `${court},`;
    }
    ouverture = cap(ouverture);

    // --- Paragraphes du corps (regroupés par lignes vides)
    let paragraphes = [];
    let courant = [];
    const flush = () => { if (courant.length) { paragraphes.push(courant.join(' ')); courant = []; } };
    for (const l of lignes) {
        if (!l) flush();
        else courant.push(l);
    }
    flush();

    if (paragraphes.length === 1 && cfg.paragraphes > 1) {
        paragraphes = decouperParagraphes(paragraphes[0], cfg.paragraphes);
    }
    if (paragraphes.length > cfg.paragraphes + 1) paragraphes = paragraphes.slice(0, cfg.paragraphes);
    paragraphes = bornerMots(paragraphes, Math.round(cfg.mots * 1.35));

    const motsCorps = paragraphes.reduce((s, p) => s + nbMots(p), 0);
    if (!paragraphes.length || motsCorps < 40) return null;

    const fermetureBloc = sig ? `${fermeture}\n${sig}` : fermeture;
    const letter = `${ouverture}\n\n${paragraphes.join('\n\n')}\n\n${fermetureBloc}`;
    return { letter, parts: { ouverture, paragraphes, fermeture, signature: sig } };
}

// ============================================================
//  GÉNÉRATION
// ============================================================
async function lettreParIA(destinataire, prompt, type, ton, longueur, signature) {
    const { system, user } = construireConsigne(destinataire, prompt, type, ton, longueur, signature);
    let probleme = 'aucun modèle configuré';

    for (const modele of GEMINI_MODELS) {
        try {
            const brut = await appelerGemini(modele, system, user);
            const lettre = mettreEnFormeLettre(brut, { longueur, signature, destinataire, type });
            if (lettre) return { lettre, probleme: null };
            probleme = `${modele} : réponse inexploitable`;
            console.warn(`[IA] ${probleme} → "${String(brut).slice(0, 80).replace(/\n/g, ' / ')}"`);
        } catch (e) {
            probleme = `${modele} : ${e.message}`;
            console.error(`[IA] ${probleme}`);
        }
    }
    return { lettre: null, probleme };
}

// ============ ROUTES API ============
app.post('/generate-letter', async (req, res) => {
    if (tropDeRequetes(req.ip)) {
        return res.status(429).json({ error: 'Trop de demandes : patiente une minute.' });
    }

    const corps = req.body || {};
    const destinataire = String(corps.destinataire || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!destinataire) return res.status(400).json({ error: 'Le destinataire est vide.' });

    const prompt = String(corps.prompt || '').replace(/\s+/g, ' ').trim().slice(0, 500);
    const type = TYPES_AUTORISES.includes(corps.type) ? corps.type : 'declaration';
    const ton = TONS_AUTORISES.includes(corps.ton) ? corps.ton : 'auto';
    const longueur = LONGUEURS_AUTORISES.includes(corps.length) ? corps.length : 'moyenne';
    const signature = String(corps.signature || '').replace(/\s+/g, ' ').trim().slice(0, 40);

    let lettre = null;
    let probleme = 'GEMINI_API_KEY absente sur le serveur (Render → Environment)';

    if (GEMINI_KEY) {
        try {
            const resultat = await lettreParIA(destinataire, prompt, type, ton, longueur, signature);
            lettre = resultat.lettre;
            probleme = resultat.probleme;
        } catch (e) {
            probleme = `erreur inattendue : ${e.message}`;
            console.error('[IA]', probleme);
        }
    }

    if (lettre) {
        console.log(`[lettre] type=${type} ton=${ton} longueur=${longueur} source=ia`);
        return res.json({ letter: lettre.letter, parts: lettre.parts, source: 'ia' });
    }

    console.log(`[lettre] ÉCHEC (${probleme})`);
    res.json({
        letter: `Le plumitif est momentanément indisponible.\n\nCause : ${probleme}\n\nRéessaie dans un instant — ou ouvre /test-ia pour le diagnostic complet.`,
        source: 'erreur'
    });
});

// ============ DIAGNOSTIC : /test-ia ============
app.get('/test-ia', async (req, res) => {
    if (!GEMINI_KEY) {
        return res.send(`<h2>🔍 Diagnostic IA</h2>
            <p><b>Clé GEMINI_API_KEY : ABSENTE.</b></p>
            <p>Ajoute-la dans Render → Settings → Environment → GEMINI_API_KEY, puis redéploie.</p>`);
    }
    const rapports = [];
    for (const modele of GEMINI_MODELS) {
        try {
            const t0 = Date.now();
            const brut = await appelerGemini(modele, 'Tu réponds en une seule phrase courte.', 'Dis bonjour en une phrase.');
            rapports.push(`✅ <b>${escHtml(modele)}</b> — OK en ${Date.now() - t0} ms : « ${escHtml(brut.slice(0, 60))} »`);
        } catch (e) {
            rapports.push(`❌ <b>${escHtml(modele)}</b> — ${escHtml(e.message)}`);
        }
    }
    res.send(`<h2>🔍 Diagnostic IA</h2>
        <p>Clé : présente. Modèles testés dans l'ordre d'utilisation :</p>
        <ul>${rapports.map(r => `<li>${r}</li>`).join('')}</ul>
        <p>Si une ligne est en ❌, copie-la et colle-la moi.</p>`);
});

// Health check
app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 10000;
if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`💌 Serveur Peprimet Lettres d'Amour démarré sur le port ${PORT}`);
        if (!GEMINI_KEY) {
            console.warn('⚠️  PAS DE CLÉ GEMINI_API_KEY → ajoute-la dans Render → Environment');
        } else {
            console.log(`   Gemini : ${GEMINI_MODELS.join(' → ')}`);
        }
    });
}

module.exports = { app, lettreParIA, construireConsigne };
