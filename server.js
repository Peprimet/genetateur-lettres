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

const VERS_AUTORISES = [4, 8, 16, 24, 32];
const THEMES_AUTORISES = ['libre', 'amour', 'tristesse', 'nature', 'nuit', 'espoir'];

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

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
//  CONSIGNES — POÈMES SIMPLES ET DIRECTS
// ============================================================
const TONS = {
    amour: 'tendre, sincère, chaleureux',
    tristesse: 'doux et triste, à voix basse',
    nature: 'émerveillé, simple, vivant',
    nuit: 'calme, doux, apaisé',
    espoir: 'sincère, lumineux, encourageant',
    general: 'sincère, simple, humain'
};

const SYSTEME = `Tu écris des poèmes SIMPLES et sincères, en français, à la manière d'une chanson ou d'une lettre qu'on garde précieusement.

RÈGLE 1 — LE SUJET AVANT TOUT : le poème parle uniquement du sujet demandé. Si la demande est « un poème d'amour pour Juliette », chaque vers parle de Juliette et de l'amour pour elle. Rien d'autre.

RÈGLE 2 — SIMPLICITÉ ABSOLUE : des mots de tous les jours, des phrases courtes et claires. Chaque vers doit être compris immédiatement, du premier coup. Écris comme on parle quand on est sincère.

RÈGLE 3 — DIS LES CHOSES : chaque vers dit clairement quelque chose sur le sujet — un sentiment (« ton rire me manque »), une qualité (« tu rends mes journées plus belles »), un souhait (« je voudrais te garder près de moi »). N'invente PAS de scènes sans rapport avec le sujet (une table, un train, du thé froid, un atelier…). Une ou deux images simples suffisent, et elles doivent servir le sujet.

RÈGLE 4 — RIMES SIMPLES : rimes naturelles en ABAB ou AABB (le même schéma partout). Si une rime oblige à écrire quelque chose de bizarre, change la phrase, pas le sens.

RÈGLE 5 — INTERDITS : vocabulaire compliqué ou rare, métaphores obscures, clichés (tu es mon soleil, mon amour éternel, mon âme sœur), mots anglais.

FORMAT DE SORTIE : ligne 1 = un titre court, simple et correct, lié au sujet (exemples : « Pour Juliette », « Ton sourire », « Juliette »). Ligne vide. Puis les vers, en strophes de 4 vers séparées par une ligne vide. Rien d'autre : pas d'introduction, pas de commentaire, pas de markdown.`;

function construireConsigne(prompt, nombreVers, themeChoisi) {
    const ton = TONS[themeChoisi] || TONS.general;
    const nbStrophes = Math.ceil(nombreVers / 4);

    const user = `Écris un poème simple en français.

SUJET — tout le poème doit parler de ça, chaque vers :
« ${prompt} »

TON : ${ton}

- Chaque vers dit clairement quelque chose sur le sujet : un sentiment, une qualité, un souvenir, un souhait.
- Si le sujet est une personne, dis simplement ce qu'elle représente pour toi : sa présence, son rire, ce qu'elle change dans tes journées, ce que tu lui souhaites.
- Mots simples du quotidien, phrases courtes, vers de 8 à 12 syllabes.
- Exactement ${nombreVers} vers, en ${nbStrophes} strophe${nbStrophes > 1 ? 's' : ''} de 4 vers séparées par une ligne vide.
- Le titre aussi doit être simple et parler du sujet.`;

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
        generationConfig.temperature = 0.85;   // moins d'hallucinations, toujours varié
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
//  TITRES : correction + filets de sécurité
// ============================================================
const PETITS_MOTS = new Set(['de', 'du', 'des', 'à', 'au', 'aux', 'en', 'et', 'ni', 'ou', 'pour', 'par', 'sous', 'sur', 'dans', 'chez', 'avec', 'sans', 'contre', 'vers', 'le', 'la', 'les', 'un', 'une', 'mon', 'ma', 'ton', 'ta', 'son', 'sa']);

// Mots anglais qui apparaissent parfois par erreur → on jette le titre
const MOTS_ANGLAIS = /\b(the|and|of|for|with|from|four|love|night|moon|star|my|your|you|is|are|our|her|his)\b/i;

// Retourne un titre corrigé, ou null si le titre est douteux (→ repli)
function corrigerTitre(titre) {
    if (MOTS_ANGLAIS.test(titre)) return null;

    const mots = titre.split(/\s+/);
    if (mots.length < 2) return titre;

    const dernier = mots[mots.length - 1];
    const avantDernier = mots[mots.length - 2];
    if (!avantDernier) return titre;

    const dernierEstNomPropre = /^[A-ZÀ-ÖØ-ÞŒÆ][a-zà-ÿ]+$/.test(dernier);

    if (dernierEstNomPropre) {
        const apresClitique = avantDernier.replace(/^(l'|d')/i, '');
        if (PETITS_MOTS.has(avantDernier.toLowerCase())) return titre; // déjà correct (« Pour Juliette »)

        if (/^[a-zà-ÿ]/.test(apresClitique)) {
            // « L'escalier Juliette » → « L'escalier de Juliette »
            mots.splice(-1, 0, /^[aeiouyéèêàâîôûh]/i.test(dernier) ? "d'" : 'de');
            return mots.join(' ');
        }
        // « Four Juliette » : deux mots douteux juxtaposés → titre invalide
        return null;
    }
    return titre;
}

// Titre de repli intelligent : détecte un prénom dans la demande
function titreDeRepli(prompt) {
    const exclus = new Set(['Un', 'Une', 'Le', 'La', 'Les', 'Mon', 'Ma', 'Mes', 'Ton', 'Ta', 'Tes', 'Son', 'Sa', 'Ses', 'Pour', 'Avec', 'Dans', 'Sur', 'Sous', 'Nous', 'Vous', 'Elle', 'Il', 'Ils', 'Elles', 'Dieu', 'Paris']);
    const prénom = prompt
        .split(/\s+/)
        .find((m, i) => i > 0 && /^[A-ZÀ-ÖØ-ÞŒÆ][a-zà-ÿ]+$/.test(m) && m.length >= 3 && !exclus.has(m));
    if (prénom) return `Pour ${prénom}`;

    const p = prompt.replace(/[.!?…]+$/, '').trim();
    if (p.length <= 40) return cap(p);
    return 'Sans titre';
}

// ============================================================
//  MISE EN FORME : titre + strophes de 4 vers
// ============================================================
function mettreEnForme(brut, nombreVers, prompt) {
    if (!brut) return null;

    const lignes = brut
        .replace(/\r/g, '')
        .replace(/```[a-z]*/gi, '')
        .replace(/[*_#]/g, '')
        .split('\n')
        .map(l => l.replace(/^[-•]\s+/, '').trim())
        .filter(l => l && !/^(voici (le|un|ton|votre|mon)|bien sûr|d'accord|certainement)/i.test(l));
    if (lignes.length < 2) return null;

    const premiere = lignes.shift();
    let titre = premiere
        .replace(/^titre\s*:\s*/i, '')
        .replace(/^["«“'‘\s]+|["»”'’\s]+$/g, '')
        .replace(/[.:;,!?]+$/, '')
        .trim();

    const titreCorrige = corrigerTitre(titre);

    // Pas de titre, titre trop long, ou titre douteux → repli
    if (!titre || titre.split(' ').length > 7 || !titreCorrige) {
        lignes.unshift(premiere);
        titre = titreDeRepli(prompt);
    } else {
        titre = titreCorrige;
    }

    const vers = lignes.slice(0, nombreVers);
    if (vers.length < Math.max(2, Math.ceil(nombreVers * 0.6))) return null;

    const strophes = [];
    for (let i = 0; i < vers.length; i += 4) strophes.push(vers.slice(i, i + 4).join('\n'));
    return `${cap(titre)}\n\n${strophes.join('\n\n')}`;
}

// ============================================================
//  GÉNÉRATION
// ============================================================
async function poemeParIA(prompt, nombreVers, themeChoisi) {
    const { system, user } = construireConsigne(prompt, nombreVers, themeChoisi);
    let probleme = 'aucun modèle configuré';

    for (const modele of GEMINI_MODELS) {
        try {
            const brut = await appelerGemini(modele, system, user);
            const poeme = mettreEnForme(brut, nombreVers, prompt);
            if (poeme) return { poeme, probleme: null };
            probleme = `${modele} : réponse inexploitable`;
            console.warn(`[IA] ${probleme} → "${String(brut).slice(0, 80).replace(/\n/g, ' / ')}"`);
        } catch (e) {
            probleme = `${modele} : ${e.message}`;
            console.error(`[IA] ${probleme}`);
        }
    }
    return { poeme: null, probleme };
}

// ============ ROUTES API ============
app.post('/generate-poem', async (req, res) => {
    if (tropDeRequetes(req.ip)) {
        return res.status(429).json({ error: 'Trop de demandes : patiente une minute.' });
    }

    const corps = req.body || {};
    const prompt = String(corps.prompt || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    if (!prompt) return res.status(400).json({ error: 'Le prompt est vide.' });

    const lignes = parseInt(corps.lines, 10);
    const nombreVers = VERS_AUTORISES.includes(lignes) ? lignes : 16;
    const themeDemande = THEMES_AUTORISES.includes(corps.theme) ? corps.theme : 'libre';
    const themeChoisi = themeDemande === 'libre' ? 'general' : themeDemande;

    let poeme = null;
    let probleme = 'GEMINI_API_KEY absente sur le serveur (Render → Environment)';

    if (GEMINI_KEY) {
        try {
            const resultat = await poemeParIA(prompt, nombreVers, themeChoisi);
            poeme = resultat.poeme;
            probleme = resultat.probleme;
        } catch (e) {
            probleme = `erreur inattendue : ${e.message}`;
            console.error('[IA]', probleme);
        }
    }

    if (poeme) {
        console.log(`[poème] thème=${themeChoisi} vers=${nombreVers} source=ia`);
        return res.json({ poem: poeme, source: 'ia' });
    }

    console.log(`[poème] ÉCHEC (${probleme})`);
    res.json({
        poem: `Le poète est momentanément indisponible.\n\nCause : ${probleme}\n\nRéessaie dans un instant — ou ouvre /test-ia pour le diagnostic complet.`,
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
        console.log(`🪶 Serveur Plume d'Étoile démarré sur le port ${PORT}`);
        if (!GEMINI_KEY) {
            console.warn('⚠️  PAS DE CLÉ GEMINI_API_KEY → ajoute-la dans Render → Environment');
        } else {
            console.log(`   Gemini : ${GEMINI_MODELS.join(' → ')}`);
        }
    });
}

module.exports = { app, poemeParIA, construireConsigne };
