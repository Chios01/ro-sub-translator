const express = require('express');
const axios = require('axios');
const path = require('path');
const fs = require('fs');

const app = express();

app.use(express.json({ limit: '2mb' }));

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header(
        'Access-Control-Allow-Headers',
        'Origin, X-Requested-With, Content-Type, Accept'
    );
    next();
});

// ============================================================
// BASIC CONFIG
// ============================================================

const BROWSER_USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const CHUNK_SIZE = 165;

const CONCURRENCY_LIMIT = Math.max(
    1,
    Math.min(
        3,
        Number(process.env.TRANSLATION_CONCURRENCY) || 3
    )
);

const CONTEXT_LINES_BEFORE = 12;
const CONTEXT_LINES_AFTER = 12;
const PREVIOUS_TRANSLATION_CONTEXT = 8;

const MODEL_NAME =
    process.env.GEMINI_MODEL ||
    'gemini-3.5-flash-lite';

// ============================================================
// CONSOLE COLORS
// ============================================================

const c = {
    reset: '\x1b[0m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m'
};

// ============================================================
// MEMORY CACHE & SECRET ARCHIVE
// ============================================================

const memoryCache = Object.create(null);
const secretArchive = [];

function cleanMemoryCache() {
    const keys = Object.keys(memoryCache);
    if (keys.length > 30) {
        const excess = keys.length - 30;
        for (let i = 0; i < excess; i++) {
            delete memoryCache[keys[i]];
        }
    }
}

// ============================================================
// MANIFEST
// ============================================================

const manifest = {
    id: 'community.chios.geminitranslator',
    version: '12.30.0',
    name: 'RO Sub Translator',
    logo: 'https://raw.githubusercontent.com/Chios01/ro-sub-translator/main/Design_Litera_C_i_litera_G_sunt_suprapuse_i_se_mpletesc_ca_z.jpg',
    description: 'Subtitrări instant din Engleză în Română, traduse inteligent prin Gemini AI. Powered by Chios.',
    resources: ['subtitles'],
    types: ['movie', 'series'],
    catalogs: [],
    idPrefixes: ['tt'],
    behaviorHints: {
        configurable: true,
        configurationRequired: false
    }
};

// ============================================================
// ROOT, PING & ARHIVA SECRETA
// ============================================================

app.get('/', (req, res) => {
    const indexPath = path.join(__dirname, 'index.html');
    if (fs.existsSync(indexPath)) {
        let html = fs.readFileSync(indexPath, 'utf8');
        html = html.replace(/\{\{VERSION\}\}/g, manifest.version);
        return res.send(html);
    }
    res.send('RO Sub Translator is running.');
});

app.get('/ping', (req, res) => {
    res.send('OK');
});

app.get('/arhiva-secreta', (req, res) => {
    let html = '<html lang="ro"><head><title>Arhiva Secreta - Quality Control</title><meta name="viewport" content="width=device-width, initial-scale=1"></head>';
    html += '<body style="background:#111;color:#eee;font-family:sans-serif;padding:20px;">';
    html += '<h2 style="color:#0f0;">Arhiva Subtitrări (Ultimele 10)</h2>';
    html += '<p>Aceste fișiere sunt reținute temporar în memoria serverului. Se vor șterge la restart.</p>';
    
    if (secretArchive.length === 0) {
        html += '<p style="color:#aaa;">Nicio subtitrare tradusă momentan.</p>';
    } else {
        html += '<ul style="list-style-type:none; padding:0;">';
        secretArchive.forEach((item, index) => {
            html += `<li style="background:#222; margin-bottom:10px; padding:15px; border-radius:5px;">
                <strong style="color:#0bf;">ID: ${item.id}</strong> <span style="color:#888; font-size:0.9em;">(${item.time})</span><br><br>
                <a href="/download-srt/${index}" style="background:#0bf; color:#000; text-decoration:none; padding:8px 12px; border-radius:4px; font-weight:bold;">Descarcă fișier .srt</a>
            </li>`;
        });
        html += '</ul>';
    }
    html += '</body></html>';
    res.send(html);
});

app.get('/download-srt/:index', (req, res) => {
    const index = parseInt(req.params.index);
    if (isNaN(index) || !secretArchive[index]) {
        return res.status(404).send('Fișierul nu există sau a fost șters automat din memorie.');
    }
    const item = secretArchive[index];
    res.setHeader('Content-disposition', `attachment; filename=RO_${item.id}.srt`);
    res.setHeader('Content-type', 'text/plain; charset=utf-8');
    res.send(item.content);
});

// ============================================================
// VALIDATE GEMINI KEY & CONFIGURE
// ============================================================

app.get('/validate-key', async (req, res) => {
    const key = String(req.query.key || '').trim();

    if (!key) {
        return res.status(400).json({ valid: false, error: 'Missing API key' });
    }

    try {
        const response = await axios.get(
            'https://generativelanguage.googleapis.com/v1beta/models',
            { params: { key }, timeout: 20000 }
        );
        return res.json({ valid: true, models: response.data?.models || [] });
    } catch (error) {
        return res.status(error.response?.status || 500).json({
            valid: false,
            error: error.response?.data || error.message
        });
    }
});

app.get('/:configData/configure', (req, res) => {
    const indexPath = path.join(__dirname, 'index.html');
    if (fs.existsSync(indexPath)) {
        let html = fs.readFileSync(indexPath, 'utf8');
        html = html.replace(/\{\{VERSION\}\}/g, manifest.version);
        return res.send(html);
    }
    res.send('Configure page missing.');
});

app.get('/:configData/manifest.json', (req, res) => {
    res.json(manifest);
});

// ============================================================
// SUBTITLE FETCHING & STREMIO INTEGRATION
// ============================================================

const BROWSER_USER_AGENT_FETCH = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

async function handleSubtitles(req, res) {
    const { configData, type, id, extra } = req.params;

    const host = req.headers.host;
    const protocol = host.includes('localhost') || host.includes('127.0.0.1') ? 'http' : 'https';
    const baseUrl = `${protocol}://${host}`;

    let extraString = '';
    let userFilename = '';

    if (extra) {
        extraString = '/' + extra;
        try {
            const params = new URLSearchParams(extra);
            userFilename = params.get('filename') || '';
        } catch (e) {}
    }

    const urlsToFetch = [
        `https://opensubtitles-v3.strem.io/subtitles/${type}/${id}${extraString}.json`, 
        `https://yifysubtitles.strem.io/subtitles/${type}/${id}${extraString}.json`,
        `https://subdl.strem.io/subtitles/${type}/${id}${extraString}.json`
    ];

    try {
        const fetchPromises = urlsToFetch.map(u => 
            axios.get(u, { 
                timeout: 3500, 
                headers: { 'User-Agent': BROWSER_USER_AGENT_FETCH } 
            }).catch(() => ({ data: { subtitles: [] } }))
        );

        const results = await Promise.all(fetchPromises);
        
        let allSubs = [];
        results.forEach(r => {
            if (r && r.data && Array.isArray(r.data.subtitles)) {
                allSubs.push(...r.data.subtitles);
            }
        });
        
        let engSubs = allSubs.filter(s => s.lang === 'eng' || s.lang === 'en' || s.lang === 'English');
        
        const uniqueUrls = new Set();
        engSubs = engSubs.filter(sub => {
            if (uniqueUrls.has(sub.url)) return false;
            uniqueUrls.add(sub.url);
            return true;
        }).slice(0, 25); 

        if (engSubs.length === 0) return res.json({ subtitles: [] });

        let diverseSubs = [];
        const trashRegex = /korsub|kor\.sub|hdcam|hd-ts|hdts|camrip|telesync|telecine|hardcoded|hc-eng|hc-sub|hc\.\w+|1xbet/i;

        engSubs.forEach((sub, idx) => {
            let realName = sub.title || sub.id || `Varianta_${idx + 1}`;
            if (!trashRegex.test(realName)) {
                diverseSubs.push({ originalUrl: sub.url, realName, index: idx });
            }
        });

        const fNameLower = userFilename.toLowerCase();
        const videoTokens = fNameLower.split(/[^a-z0-9]+/i).filter(t => t.length > 2 && !/^(mkv|mp4|avi)$/.test(t));

        diverseSubs.forEach(s => {
            s.score = 0;
            const subName = s.realName.toLowerCase();
            
            if (videoTokens.length > 0) {
                let matchCount = 0;
                videoTokens.forEach(token => {
                    if (subName.includes(token)) {
                        s.score += 60; 
                        matchCount++;
                    }
                });
                
                if (matchCount > 0 && matchCount >= videoTokens.length / 2) {
                    s.score += 300; 
                }
            }

            if (/web-dl|webdl|webrip|web|amzn|nf|dsnp|hulu|max/i.test(subName)) s.score += 40;
            if (/bluray|brrip|bdrip|bdr/i.test(subName)) s.score += 30;
            if (/yts|yify|rarbg|tgx|qxr|psa/i.test(subName)) s.score += 20;
            if (/sdh|hi\.|hearing impaired/i.test(subName)) s.score -= 15; 
            if (/sync|corregido|resync|translated|auto|machine/i.test(subName)) s.score -= 100;
        });

        diverseSubs.sort((a, b) => b.score - a.score);
        diverseSubs = diverseSubs.slice(0, 15);

        const generatedSubs = diverseSubs.map((s, index) => {
            const encodedUrl = encodeURIComponent(s.originalUrl);
            
            let vizualName = s.realName.replace(/[^a-zA-Z0-9.-]/g, ' ');
            const tagMatch = vizualName.match(/(2160p|1080p|720p|4k|bluray|web-dl|webrip|hdr|remux)/i);
            
            let labelName = `🇷🇴 RO AI [${index + 1}]`;
            if (tagMatch) {
                let cleanTag = tagMatch[0].toUpperCase();
                labelName = `🇷🇴 RO AI [${index + 1}] • ${cleanTag}`;
            }

            return {
                id: `ai_sub_${index}`,
                title: labelName, 
                url: `${baseUrl}/${configData}/translate?id=${id}&targetUrl=${encodedUrl}&v=${s.index + 1}`,
                lang: 'ron'
            };
        });

        return res.json({ subtitles: generatedSubs });
    } catch (error) {
        return res.json({ subtitles: [] });
    }
}

app.get('/:configData/subtitles/:type/:id.json', handleSubtitles);
app.get('/:configData/subtitles/:type/:id/:extra.json', handleSubtitles);

// ============================================================
// CLEAN TEXT FOR JSON 
// ============================================================

function cleanTextForJson(text) {
    if (!text) return text;
    let clean = text;

    clean = clean.replace(/\{[^}]+\}/g, '');
    clean = clean.replace(/[♪♫♬♩#]/gi, '');
    clean = clean.replace(/â™ª/gi, '');
    clean = clean.replace(/â™«/gi, '');

    clean = clean.replace(/\[\s*[^\]]*?(râsete|murmur|șuierând|muzică|aplauze|urale|fluierături|muzica|music|sighs|cheering|applause|laughter|gasping|groaning|snorts|crying|screaming|shouts|cough|sniff|music|chuckles|pant|groan|sigh|chuckle|whisper)[^\]]*?\]/gi, '');
    clean = clean.replace(/\[[^\]]*?\]/g, '');
    clean = clean.replace(/\([^)]*?(râsete|murmur|muzică|aplauze|urale|fluierături|music|sighs|cheering|applause|laughter)[^)]*?\)/gi, '');
    clean = clean.replace(/\([^)]*?\)/g, '');

    let lines = clean.split('\n').map(l => l.trim()).filter(Boolean);
    clean = lines.join('\n');

    if (!clean.trim()) return ' ';
    return clean.trim();
}

// ============================================================
// FORMAT LINE & DICTIONARY
// ============================================================

function formatSubtitleLine(text) {
    if (!text) return text;
    let lowerText = text.toLowerCase();
    
    if (lowerText.includes('înțeles') && lowerText.includes('hei') && lowerText.includes('când')) {
        return 'Am înțeles. Hei, când ai o secundă...';
    }
    
    if ((lowerText.includes('holba') || lowerText.includes('uita') || lowerText.includes('ochii') || lowerText.includes('holbezi') || lowerText.includes('oprește-te') || lowerText.includes('termină')) && (/\bsân(i|ii)?\b/.test(lowerText) || lowerText.includes('țâțe') || lowerText.includes('decolteu') || lowerText.includes('tăiței') || lowerText.includes('piept'))) {
        return 'Nu te mai holba la sânii mei.';
    }
    
    text = text.replace(/(^|[\s])([cCsS])(?=[\s.,!?:;]|$)/gm, function(match, spatiu, litera) {
        return spatiu + litera + 'ă';
    });
    
    text = text.replace(/(^|[\s])([Aa]dic)(?=[\s.,!?:;]|$)/gm, '$1$2ă');

    text = text.replace(/ţ/g, 'ț').replace(/Ţ/g, 'Ț').replace(/ş/g, 'ș').replace(/Ş/g, 'Ș');
    text = text.replace(/<[^>]+>/g, '');
    
    let lines = text.split('\n').map(l => {
        let cleanLine = l.trim();
        cleanLine = cleanLine.replace(/^[-—–−]+\s*/, '');
        return cleanLine;
    }).filter(Boolean);

    let wrappedLines = [];
    for (let line of lines) {
        if (line.length > 55) {
            let mid = Math.floor(line.length / 2);
            let leftSpace = line.lastIndexOf(' ', mid);
            let rightSpace = line.indexOf(' ', mid);
            let splitIndex = (leftSpace !== -1 && rightSpace !== -1) ? 
                ((mid - leftSpace) <= (rightSpace - mid) ? leftSpace : rightSpace) : 
                Math.max(leftSpace, rightSpace);
            if (splitIndex !== -1) {
                wrappedLines.push(line.substring(0, splitIndex).trim());
                wrappedLines.push(line.substring(splitIndex + 1).trim());
            } else {
                wrappedLines.push(line);
            }
        } else {
            wrappedLines.push(line);
        }
    }
    if (wrappedLines.length > 2) {
        text = wrappedLines.slice(0, 2).join('\n');
    } else {
        text = wrappedLines.join('\n');
    }

    const dictionar = [
        [/\btat-tu\b/gi, 'tatăl tău'],
        [/\btat-meu\b/gi, 'tatăl meu'],
        [/\bmerici\b/gi, 'meriți'],
        [/\bcuânt\b/gi, 'cuvânt'],
        [/\bbrioșelea aia\b/gi, 'brioșele alea'],
        [/Sânișor Kournikova/gi, 'Rusoaica Pectorală'],
        [/fundul tău strâns/gi, 'fundul tău scorțos'],
        [/\bînța\b/gi, 'apuca'],
        [/cafondist/gi, 'mojic'],
        [/Pu[țt]in-Kournikova/gi, 'Rusoaica Pectorală'],
        [/ghicercici/gi, 'ghicești'],
        [/dafirma/gi, 'da afară'],
        [/judicativ[aă]/gi, 'plină de prejudecăți'],
        [/le-atâmită/gi, 'le tâmpește'],
        [/\bEu poartă\b/gi, 'Eu port'],
        [/\bAleile aia\b/gi, 'Chestia aia'],
        [/s-ți/gi, 'să-ți'],
        [/s-l/gi, 'să-l']
    ];

    for (let i = 0; i < dictionar.length; i++) {
        text = text.replace(dictionar[i][0], dictionar[i][1]);
    }

    return text;
}

// ============================================================
// MASTER CINEMATIC TRANSLATION PROMPT
// ============================================================

const MASTER_TRANSLATION_PROMPT = `
You are a professional cinematic Romanian translator. Your ONLY purpose is to translate an English subtitle JSON array into natural, conversational Romanian.

<translation_master_rules>
1. THE GOLDEN RULE: Translate the scene, not just the words. Recreate the dialogue naturally in Romanian. Do not use literal translations, mechanical phrasing, or English word order.
2. SLANG & PROFANITY: Preserve the original register. Do not censor "fuck", "shit", etc. Adapt them into natural Romanian equivalents (e.g., vulgarity stays vulgar, slang stays slang).
3. CONTEXT & GENDER: Pay extreme attention to context. If it's clear a female is speaking, use feminine verb agreements ("Am fost plătită"). 
4. SARCASM & HUMOR: Sarcasm, irony, and jokes must survive the translation. Adapt puns if necessary so the Romanian viewer gets the same emotional effect.
5. NO INVENTED WORDS: Use ONLY standard Romanian dictionary words. Never invent conjugations, mashups, or non-existent words.
6. SPLIT LINES & CONTINUITY: Subtitles are often cut mid-sentence. Read the surrounding context and translate so the sentence flows naturally across lines. 
7. CLEAN UP: Remove all audio tags (e.g., [sighs], [music]). Do not translate character names.
8. 100% TRANSLATION: Do NOT leave any English words or phrases untranslated. Everything must be in Romanian.
9. NO ALTERNATIVES: Never provide multiple options in brackets like (varianta 1 | varianta 2). Make a firm choice and provide only the final Romanian text.
10. NO FOREIGN SCRIPTS: Use only the Latin alphabet and standard Romanian diacritics (ă, â, î, ș, ț). Never generate Asian, Cyrillic, or other foreign characters.
</translation_master_rules>

<few_shot_examples>
- Idiom: "Give me a break." -> "Hai, lasă-mă."
- Sarcasm: "Great. Just great." -> "Minunat. Pur și simplu minunat."
- Natural phrasing: "Are you coming with us?" -> "Vii cu noi?"
- Slang/Casual: "What the hell, man?" -> "Ce naiba, frate?"
- Contextual meaning: "You better watch yourself." -> "Ai grijă."
- Short & Natural: "I'm gonna kill you." -> "Te omor."
</few_shot_examples>

JSON ONLY: Reply STRICTLY with a valid JSON object matching the exact input keys. Do not add markdown, explanations, or extra text.
`;

// ============================================================
// PROMPT BUILDER CU CONTEXT
// ============================================================

function buildTranslationPrompt(chunk, allItems, chunkStart, chunkEnd, previousTranslatedContext) {
    const contextBefore = allItems.slice(Math.max(0, chunkStart - CONTEXT_LINES_BEFORE), chunkStart);
    const contextAfter = allItems.slice(chunkEnd, Math.min(allItems.length, chunkEnd + CONTEXT_LINES_AFTER));

    const keysToTranslate = {};
    chunk.forEach(obj => { keysToTranslate[obj.id] = obj.text; });

    return `
${MASTER_TRANSLATION_PROMPT}

Context inainte (pentru referinta):
${contextBefore.map(i => `[${i.id}] ${i.text}`).join('\n') || '(niciunul)'}

Context anterior tradus in Romana (pentru continuitate):
${previousTranslatedContext.map(i => `[${i.id}] ${i.text}`).join('\n') || '(niciunul)'}

Tradu STRICT urmatorul obiect JSON, păstrând exact aceleași chei numerice:
${JSON.stringify(keysToTranslate, null, 2)}
`;
}

// ============================================================
// API KEY STATE & MANAGEMENT
// ============================================================

function createKeyState(keys) {
    return keys.map(key => ({ key, pausedUntil: 0, disabled: false, failures: 0, lastUsed: 0 }));
}

async function getAvailableKey(keyStates) {
    while (true) {
        const now = Date.now();
        const available = keyStates
            .filter(s => !s.disabled && s.pausedUntil <= now)
            .sort((a, b) => a.lastUsed - b.lastUsed);

        if (available.length) {
            const state = available[0];
            state.lastUsed = Date.now();
            return state;
        }

        const waits = keyStates
            .filter(s => !s.disabled && s.pausedUntil > now)
            .map(s => s.pausedUntil - now);

        if (!waits.length) throw new Error('Toate cheile Gemini sunt dezactivate.');

        const waitMs = Math.max(250, Math.min(...waits));
        await sleep(waitMs);
    }
}

async function callGemini(prompt, keyState) {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME}:generateContent`;
    const maxAttempts = 6;
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const response = await axios.post(
                endpoint,
                {
                    contents: [{ parts: [{ text: prompt }] }],
                    generationConfig: { temperature: 0.0, responseMimeType: 'application/json' },
                    safetySettings: [
                        { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
                        { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
                        { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
                        { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' }
                    ]
                },
                { params: { key: keyState.key }, timeout: 120000, headers: { 'Content-Type': 'application/json' } }
            );

            const raw = response.data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
            if (!raw.trim()) throw new Error('Gemini a returnat conținut gol.');
            keyState.failures = 0;
            return raw;
        } catch (error) {
            lastError = error;
            const status = error.response?.status;
            if (status === 401 || status === 403) {
                keyState.disabled = true;
                throw new Error(`Cheie Gemini invalidă (${status}).`);
            }
            if (status === 429) {
                keyState.pausedUntil = Date.now() + 61000;
                await sleep(2000);
                continue;
            }
            if (attempt < maxAttempts) {
                await sleep(2000 * attempt);
                continue;
            }
        }
    }
    throw lastError || new Error('Gemini request failed.');
}

// ============================================================
// QC V6 FULL — verificare integrală SOURCE → TRANSLATION
// ============================================================

const QC_MODEL_NAME = MODEL_NAME;

const QC_TIMEOUT_MS = Math.min(
    45000,
    Math.max(15000, Number(process.env.QC_TIMEOUT_MS) || 30000)
);

const QC_MAX_ATTEMPTS = Math.max(
    2,
    Math.min(3, Number(process.env.QC_MAX_ATTEMPTS) || 3)
);

const QC_RATE_LIMIT_PAUSE_MS = Math.max(
    3000,
    Number(process.env.QC_RATE_LIMIT_PAUSE_MS) || 8000
);

const QC_MAX_503_RETRIES = 1;

const QC_FULL_PROMPT = `
You are the FINAL QUALITY CONTROL editor for professional English → Romanian subtitles.

Your task is NOT to rewrite the translation.
Your task is to CHECK EVERY SOURCE → TRANSLATION PAIR and return ONLY translations
that contain a REAL, OBJECTIVE ERROR.

You receive:
- the original English subtitle
- the current Romanian translation

You MUST compare them directly.

============================================================
WHAT YOU MUST CORRECT
============================================================

Correct a subtitle ONLY when there is a genuine problem such as:

1. TYPOGRAPHICAL ERRORS
- missing letters
- duplicated letters
- malformed words
- obvious corrupted words
- obvious accidental characters
- broken Romanian words

Examples:
"cinva" → "cineva"
"rebuie" → "trebuie"
"uudzi" → "uzi"

2. GRAMMATICAL ERRORS
- incorrect verb conjugation
- incorrect subject/verb agreement
- incorrect noun/adjective agreement
- clearly missing grammatical words
- incorrect prepositions
- clearly incomplete constructions

Examples:
"Eu poart căciuli." → "Eu port căciuli."
"Nu am crezut că va doare." → "Nu am crezut că va durea."

3. MISSING WORDS
If the Romanian sentence clearly omits a word that is necessary
to preserve the meaning of the English source, correct it.

Example:
"Habar n-are despre vorbește."
→ "Habar n-are despre ce vorbește."

4. WRONG OR MISSING NEGATION
If the English meaning is negated and Romanian loses the negation,
or vice versa, correct it.

5. CLEAR MEANING ERRORS
If the Romanian translation clearly changes the meaning of the
English source, correct it.

6. UNTRANSLATED ORDINARY ENGLISH
If a normal English word or phrase was accidentally left untranslated,
correct it.

DO NOT classify names, brands, titles, places, technical terms,
intentional English expressions, slang or dialogue fragments as errors
unless the source clearly requires translation.

7. CORRUPTED / TRUNCATED WORDS
Pay special attention to words that look like the translation process
cut, merged, duplicated or damaged a word.

Examples:
"cinva" → "cineva"
"aceași" → "aceeași"
"dădadă" → only correct if the English source confirms the intended word.

============================================================
VERY IMPORTANT — CHECK THE ENGLISH SOURCE
============================================================

Do NOT correct Romanian merely because another Romanian formulation
sounds more natural to you.

A translation may use:
- synonyms
- colloquial language
- slang
- profanity
- contractions
- short constructions
- unusual but valid Romanian
- cinematic dialogue
- intentionally incomplete dialogue

These are NOT errors by themselves.

The English SOURCE is the authority for meaning.

If the Romanian translation is grammatically valid AND preserves the
meaning of the English source, KEEP IT EXACTLY AS IT IS.

============================================================
DO NOT OVER-EDIT
============================================================

This is extremely important.

DO NOT:
- rewrite correct sentences
- improve style
- make dialogue more elegant
- replace valid synonyms
- change sentence structure just because you prefer another version
- make the Romanian more formal
- remove slang
- soften profanity
- alter character voice
- change names
- change brands
- change places
- change technical terminology
- change intentional fragments

Your job is ERROR CORRECTION, not STYLE EDITING.

============================================================
DECISION TEST
============================================================

Before changing a translation, ask yourself:

1. Is there a demonstrable error?
2. Can I prove the error by comparing it with the English source
   or by clear Romanian grammar?
3. Would a professional Romanian subtitle editor consider it objectively
   incorrect rather than merely stylistically different?

If the answer is NOT clearly YES:
KEEP THE EXISTING TRANSLATION.

When uncertain, KEEP the existing translation.

============================================================
IMPORTANT REAL ERROR EXAMPLES
============================================================

These are examples of the TYPE of errors that must be detected.
They are NOT mandatory substitutions.

"Eu poart căciuli tricotate."
→ "Eu port căciuli tricotate."

"N avem nimic în comun."
→ "N-avem nimic în comun."
or
→ "Nu avem nimic în comun."

"Habar n-are despre vorbește."
→ "Habar n-are despre ce vorbește."

"rebuie să plec."
→ "trebuie să plec."

"Mă uudzi."
→ "Mă uzi."

"cinva a purtat uniforma asta."
→ "cineva a purtat uniforma asta."

"Nu am crezut că va doare atât de tare."
→ "Nu am crezut că va durea atât de tare."

Again:
ONLY make such corrections when the actual source/translation pair
shows that they are genuinely errors.

============================================================
PRESERVE SUBTITLE STRUCTURE
============================================================

Do not change subtitle IDs.

Do not create new IDs.

Do not remove IDs.

Do not merge subtitles.

Do not split subtitles.

Return ONLY corrections.

============================================================
OUTPUT FORMAT
============================================================

Return ONLY valid JSON.

Format:

{
  "corrections": {
    "123": "corrected Romanian text",
    "456": "corrected Romanian text"
  }
}

If there are NO genuine errors:

{
  "corrections": {}
}

The object must contain ONLY IDs that genuinely require correction.

Do not include explanations.
Do not include comments.
Do not include markdown.
Do not include alternative translations.

============================================================
FINAL RULE
============================================================

CHECK EVERY LINE.

But CHANGE ONLY REAL ERRORS.

The safest behavior is:

CORRECT ERROR → change it.
CORRECT TRANSLATION → preserve it exactly.
UNCERTAIN CASE → preserve it.
`;

function createQcKeyState(keys) {
    return keys.map((key, index) => ({
        key,
        index,
        disabledUntil: 0,
        rateLimitedUntil: 0,
        busy: false
    }));
}

function getImmediateQcKey(qcKeyStates) {
    const now = Date.now();

    const available = qcKeyStates.find(state =>
        !state.busy &&
        state.disabledUntil <= now &&
        state.rateLimitedUntil <= now
    );

    if (available) {
        available.busy = true;
        return available;
    }

    const fallback = qcKeyStates.find(state =>
        state.disabledUntil <= now
    );

    if (fallback) {
        fallback.busy = true;
        return fallback;
    }

    return null;
}

function extractQcJsonObject(raw) {
    if (!raw || typeof raw !== 'string') {
        throw new Error('QC returned empty response');
    }

    let text = raw.trim();

    text = text
        .replace(/^```json\s*/i, '')
        .replace(/^```\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();

    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');

    if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
        throw new Error('QC did not return a JSON object');
    }

    text = text.slice(firstBrace, lastBrace + 1);

    return JSON.parse(text);
}

function buildQcChunkPayload(originalChunk, translatedChunk) {
    return originalChunk.map((sourceItem, index) => ({
        id: String(sourceItem.id),
        source: String(sourceItem.text || ''),
        translation: String(
            translatedChunk[index]?.text ??
            translatedChunk[index]?.translation ??
            ''
        )
    }));
}

async function callGeminiQc(prompt, qcKeyStates) {

    let lastError = null;
    let retries503 = 0;

    const endpoint = `[https://generativelanguage.googleapis.com/v1beta/models/$](https://generativelanguage.googleapis.com/v1beta/models/$){QC_MODEL_NAME}:generateContent`;

    for (let attempt = 1; attempt <= QC_MAX_ATTEMPTS; attempt++) {

        const state = getImmediateQcKey(qcKeyStates);

        if (!state) {
            throw new Error('No QC API key available');
        }

        const key = state.key;

        try {

            const response = await axios.post(
                endpoint,
                {
                    contents: [
                        {
                            parts: [
                                {
                                    text: prompt
                                }
                            ]
                        }
                    ],

                    generationConfig: {
                        temperature: 0,
                        responseMimeType: 'application/json'
                    },

                    safetySettings: [
                        {
                            category: 'HARM_CATEGORY_HARASSMENT',
                            threshold: 'BLOCK_NONE'
                        },
                        {
                            category: 'HARM_CATEGORY_HATE_SPEECH',
                            threshold: 'BLOCK_NONE'
                        },
                        {
                            category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT',
                            threshold: 'BLOCK_NONE'
                        },
                        {
                            category: 'HARM_CATEGORY_DANGEROUS_CONTENT',
                            threshold: 'BLOCK_NONE'
                        }
                    ]
                },
                {
                    params: { key },
                    timeout: QC_TIMEOUT_MS,
                    headers: {
                        'Content-Type': 'application/json'
                    }
                }
            );

            state.busy = false;

            const raw =
                response?.data?.candidates?.[0]?.content?.parts
                    ?.map(part => part.text || '')
                    .join('') || '';

            if (!raw.trim()) {
                throw new Error(
                    'QC Gemini a returnat conținut gol'
                );
            }

            return raw;

        } catch (error) {

            state.busy = false;
            lastError = error;

            const status = error?.response?.status;

            // 401 / 403
            if (status === 401 || status === 403) {

                state.disabledUntil =
                    Date.now() + 10 * 60 * 1000;

                console.log(
                    `⚠ [QC] Cheia ...${String(key).slice(-4)} ` +
                    `dezactivată temporar (${status}).`
                );

                continue;
            }

            // 429
            if (status === 429) {

                state.rateLimitedUntil =
                    Date.now() + QC_RATE_LIMIT_PAUSE_MS;

                console.log(
                    `⚠ [QC] 429 pe cheia ...${String(key).slice(-4)}. ` +
                    `Pauză ${QC_RATE_LIMIT_PAUSE_MS}ms.`
                );

                await sleep(QC_RATE_LIMIT_PAUSE_MS);

                continue;
            }

            // 503 — maximum un retry
            if (status === 503) {

                if (retries503 < QC_MAX_503_RETRIES) {

                    retries503++;

                    console.log(
                        `⚠ [QC] 503. Retry unic în 1.5 secunde...`
                    );

                    await sleep(1500);

                    continue;
                }

                throw error;
            }

            // 500 / 502 / 504
            if (
                status === 500 ||
                status === 502 ||
                status === 504
            ) {

                const delay = 1200 * attempt;

                console.log(
                    `⚠ [QC] HTTP ${status}. ` +
                    `Retry în ${delay}ms...`
                );

                await sleep(delay);

                continue;
            }

            // timeout / network
            if (
                error?.code === 'ECONNABORTED' ||
                error?.code === 'ETIMEDOUT' ||
                error?.code === 'ECONNRESET' ||
                error?.code === 'ENOTFOUND' ||
                error?.code === 'ECONNREFUSED'
            ) {

                const delay = 1000 * attempt;

                console.log(
                    `⚠ [QC] ${error?.code || 'network error'}. ` +
                    `Retry în ${delay}ms...`
                );

                await sleep(delay);

                continue;
            }

            // Nu transformăm o eroare necunoscută
            // într-un fals "timeout".
            throw error;
        }
    }

    throw lastError || new Error('QC failed');
}

function sanitizeQcCorrections(
    corrections,
    translatedChunk,
    originalChunk
) {
    const clean = {};

    if (
        !corrections ||
        typeof corrections !== 'object' ||
        Array.isArray(corrections)
    ) {
        return clean;
    }

    const validIds = new Set(
        originalChunk.map(item => String(item.id))
    );

    for (const [id, value] of Object.entries(corrections)) {
        const stringId = String(id);

        if (!validIds.has(stringId)) {
            continue;
        }

        if (typeof value !== 'string') {
            continue;
        }

        const corrected = value.trim();

        if (!corrected) {
            continue;
        }

        if (corrected.includes('')) {
            continue;
        }

        const currentItem = translatedChunk.find(
            item => String(item.id) === stringId
        );

        if (!currentItem) {
            continue;
        }

        const currentText = String(currentItem.text || '');

        if (corrected === currentText) {
            continue;
        }

        if (corrected.length > Math.max(2000, currentText.length * 4)) {
            continue;
        }

        clean[stringId] = corrected;
    }

    return clean;
}

async function qcChunkFull(
    originalChunk,
    translatedChunk,
    qcKeyStates,
    chunkIndex,
    totalChunks
) {
    if (
        !Array.isArray(originalChunk) ||
        !Array.isArray(translatedChunk) ||
        originalChunk.length === 0
    ) {
        return translatedChunk;
    }

    console.log(
        `⚠ [QC V6] Verific integral ` +
        `${translatedChunk.length} linii din calupul ` +
        `${chunkIndex}/${totalChunks}...`
    );

    const payload = buildQcChunkPayload(
        originalChunk,
        translatedChunk
    );

    const prompt =
        QC_FULL_PROMPT +
        '\n\n============================================================\n' +
        'SUBTITLES TO CHECK\n' +
        '============================================================\n\n' +
        JSON.stringify(payload);

    try {
        const raw = await callGeminiQc(
            prompt,
            qcKeyStates
        );

        const parsed = extractQcJsonObject(raw);

        const corrections = sanitizeQcCorrections(
            parsed?.corrections,
            translatedChunk,
            originalChunk
        );

        const correctionCount =
            Object.keys(corrections).length;

        if (correctionCount === 0) {
            console.log(
                `✔ [QC V6] Calupul ${chunkIndex}/${totalChunks}: ` +
                `0 corecții reale.`
            );

            return translatedChunk;
        }

        console.log(
            `🔧 [QC V6] Calupul ${chunkIndex}/${totalChunks}: ` +
            `${correctionCount} corecții reale.`
        );

        const correctedChunk = translatedChunk.map(item => {
            const id = String(item.id);

            if (!Object.prototype.hasOwnProperty.call(corrections, id)) {
                return item;
            }

            console.log(
                `   ↳ ID ${id}: "${item.text}" → "${corrections[id]}"`
            );

            return {
                ...item,
                text: formatSubtitleLine(corrections[id])
            };
        });

        return correctedChunk;

    } catch (error) {
        console.log(
            `⚠ [QC V6] QC eșuat pentru calupul ` +
            `${chunkIndex}/${totalChunks}: ` +
            `${error?.message || error}`
        );

        console.log(
            `↪ [QC V6] Păstrez traducerea originală pentru acest calup.`
        );

        return translatedChunk;
    }
}

// ============================================================
// TRANSLATION ROUTE
// ============================================================

app.get('/:configData/translate', async (req, res) => {
    const imdbId = req.query.id;
    const targetUrl = req.query.targetUrl || req.query.url;
    const configData = req.params.configData;

    if (!targetUrl) return res.status(400).send('Lipsă URL sursă.');

    let userKeys = [];
    try {
        const decoded = Buffer.from(configData, 'base64').toString('utf8');
        userKeys = JSON.parse(decoded);
    } catch(e) {
        return res.status(400).send('Configurare invalidă. Instalează addon-ul din nou.');
    }

    if (!Array.isArray(userKeys)) userKeys = [];
    userKeys = userKeys.map(k => String(k).trim()).filter(Boolean);

    if (!userKeys.length) {
        return res.status(400).send('Nu există chei Gemini configurate.');
    }

    const cacheKey = targetUrl;

    if (memoryCache[cacheKey] && typeof memoryCache[cacheKey] === 'string') {
        console.log(`${c.green}⚡ [Cache RAM] Servit instant pentru: ${imdbId}${c.reset}`);
        res.setHeader('Content-Type', 'application/x-subrip; charset=utf-8');
        return res.send(memoryCache[cacheKey]);
    }

    res.writeHead(200, {
        'Content-Type': 'application/x-subrip; charset=utf-8',
        'Transfer-Encoding': 'chunked'
    });
    res.flushHeaders();

    const keepAlive = setInterval(() => {
        res.write(' \n');
    }, 8000);

    req.on('close', () => {
        clearInterval(keepAlive);
    });

    try {
        let processPromise;

        if (memoryCache[cacheKey] && typeof memoryCache[cacheKey] !== 'string') {
            processPromise = memoryCache[cacheKey];
        } else {
            const startTime = Date.now();
            
            processPromise = (async () => {
                const srtRes = await axios.get(targetUrl, {
                    headers: { 'User-Agent': BROWSER_USER_AGENT },
                    timeout: 30000,
                    responseType: 'text'
                });
                
                const totalLinesCount = (String(srtRes.data || '').match(/-->/g) || []).length;
                console.log(`${c.cyan}\n==================================================${c.reset}`);
                console.log(`${c.magenta}▶ ÎNCEPE PROCESAREA PENTRU: ${imdbId}${c.reset}`);
                console.log(`${c.magenta}📑 Total linii de tradus: ${totalLinesCount}${c.reset}`);
                console.log(`${c.cyan}==================================================\n${c.reset}`);
                
                return await translateSrtWithGemini(String(srtRes.data || ''), userKeys);
            })();
            
            memoryCache[cacheKey] = processPromise;
            cleanMemoryCache(); 
            
            processPromise.then(translatedSrtString => {
                memoryCache[cacheKey] = translatedSrtString;
                cleanMemoryCache(); 
                
                const durationSeconds = Math.floor((Date.now() - startTime) / 1000);
                const timeFormatted = durationSeconds < 60 ? `${durationSeconds} sec` : `${Math.floor(durationSeconds / 60)} min și ${durationSeconds % 60} sec`;
                
                console.log(`${c.green}\n✔ PROCESARE FINALIZATĂ CU SUCCES PENTRU: ${imdbId}${c.reset}`);
                console.log(`${c.green}⏱ Timp total de traducere: ${timeFormatted}${c.reset}`);
                console.log(`${c.cyan}==================================================\n${c.reset}`);
                
            }).catch((err) => {
                console.log(`${c.red}✖ EROARE PROCESARE PENTRU: ${imdbId} - ${err.message}${c.reset}`);
                delete memoryCache[cacheKey];
            });
        }

        const finalSrt = await processPromise;
        
        if (finalSrt && finalSrt.trim().length > 0) {
            const now = new Date();
            const timeStr = now.toLocaleTimeString('ro-RO') + ' ' + now.toLocaleDateString('ro-RO');
            
            const existingIndex = secretArchive.findIndex(item => item.id === imdbId);
            if (existingIndex !== -1) {
                secretArchive.splice(existingIndex, 1);
            }

            secretArchive.unshift({ id: imdbId, time: timeStr, content: finalSrt });
            if (secretArchive.length > 10) secretArchive.pop();
        }

        clearInterval(keepAlive);
        res.write(finalSrt);
        res.end();

    } catch (error) {
        clearInterval(keepAlive);
        console.error('Translation error:', error.message);
        if (!res.headersSent) {
            res.status(500).send('Translation failed: ' + error.message);
        } else {
            res.end();
        }
    }
});

// ============================================================
// CHUNK ENGINE CU RETRY SI RE-SPLIT
// ============================================================

function chunkArray(array, size) {
    const chunks = [];
    for (let i = 0; i < array.length; i += size) {
        chunks.push(array.slice(i, i + size));
    }
    return chunks;
}

async function processChunkWithRetry(chunk, allItems, chunkStart, chunkEnd, previousTranslatedContext, keyStates, qcKeyStates, globalChunkIndex, totalChunks, depth = 0) {
    const prompt = buildTranslationPrompt(chunk, allItems, chunkStart, chunkEnd, previousTranslatedContext);
    const maxLocalAttempts = 3;
    let lastError = null;

    for (let attempt = 1; attempt <= maxLocalAttempts; attempt++) {
        let keyState = null;
        try {
            keyState = await getAvailableKey(keyStates);
            
            const keyMask = '...' + keyState.key.slice(-4);
            console.log(`${c.cyan}➤ [Gemini] Traduc calup ${globalChunkIndex + 1}/${totalChunks} (Model: ${MODEL_NAME} | Cheie: ${keyMask})...${c.reset}`);

            const raw = await callGemini(prompt, keyState);
            
            let cleanText = raw.trim();
            const startIdx = cleanText.indexOf('{');
            const endIdx = cleanText.lastIndexOf('}');
            if (startIdx >= 0 && endIdx > startIdx) {
                cleanText = cleanText.slice(startIdx, endIdx + 1);
            }

            const parsed = JSON.parse(cleanText);
            const dict = parsed.translations || parsed;

            const initialResultsDict = {};
            chunk.forEach(obj => {
                const val = dict[obj.id] !== undefined ? dict[obj.id] : (dict[String(obj.id)] !== undefined ? dict[String(obj.id)] : obj.text);
                initialResultsDict[obj.id] = formatSubtitleLine(val);
            });

            let result = chunk.map(obj => ({
                id: obj.id,
                text: initialResultsDict[obj.id]
            }));

            // ========================================================
            // QC V6 - VERIFICARE FINALĂ
            // ========================================================

            result = await qcChunkFull(
                chunk,
                result,
                qcKeyStates,
                globalChunkIndex + 1,
                totalChunks
            );

            console.log(`${c.green}✔ [Gemini] Calup ${globalChunkIndex + 1}/${totalChunks} finalizat! (${chunk.length}/${chunk.length} linii)${c.reset}`);
            return result;
        } catch (error) {
            lastError = error;
            console.log(`${c.yellow}⚠ [Gemini] Eroare la calupul ${globalChunkIndex + 1} (Încercarea ${attempt}/${maxLocalAttempts}): ${error.message}${c.reset}`);
            await sleep(1000 * attempt);
        }
    }

    if (chunk.length > 20 && depth < 2) {
        const middle = Math.floor(chunk.length / 2);
        const first = chunk.slice(0, middle);
        const second = chunk.slice(middle);

        console.log(`${c.yellow}⚠ [Gemini] Împart calupul ${globalChunkIndex + 1} în două părți din cauza erorilor repetate...${c.reset}`);

        const firstResult = await processChunkWithRetry(first, allItems, chunkStart, chunkStart + middle, previousTranslatedContext, keyStates, qcKeyStates, globalChunkIndex, totalChunks, depth + 1);
        const secondContext = firstResult.slice(-PREVIOUS_TRANSLATION_CONTEXT);
        const secondResult = await processChunkWithRetry(second, allItems, chunkStart + middle, chunkEnd, secondContext, keyStates, qcKeyStates, globalChunkIndex, totalChunks, depth + 1);

        return [...firstResult, ...secondResult];
    }

    console.log(`${c.red}✖ [Gemini] Calupul ${globalChunkIndex + 1} a eșuat definitiv.${c.reset}`);
    throw lastError || new Error('Chunk translation failed.');
}

// ============================================================
// MOTORUL PRINCIPAL DE TRADUCERE SRT
// ============================================================

async function translateSrtWithGemini(srtText, apiKeys) {
    const items = parseSrt(srtText);
    if (!items.length) throw new Error('Nu s-au găsit subtitrări valide.');

    const cleanKeys = Array.from(new Set(apiKeys.map(k => String(k).trim()).filter(Boolean)));
    if (!cleanKeys.length) throw new Error('Nu există chei Gemini valide.');

    const keyStates = createKeyState(cleanKeys);
    const qcKeyStates = createQcKeyState(cleanKeys);
    const chunks = chunkArray(items, CHUNK_SIZE);

    const translatedById = Object.create(null);
    let previousTranslatedContext = [];

    for (let batchStart = 0; batchStart < chunks.length; batchStart += CONCURRENCY_LIMIT) {
        const batch = chunks.slice(batchStart, batchStart + CONCURRENCY_LIMIT);

        const promises = batch.map(async (chunk, localIndex) => {
            const globalIndex = batchStart + localIndex;
            const start = globalIndex * CHUNK_SIZE;
            const end = start + chunk.length;

            if (localIndex > 0) await sleep(800 * localIndex);

            const result = await processChunkWithRetry(chunk, items, start, end, previousTranslatedContext, keyStates, qcKeyStates, globalIndex, chunks.length);
            return { globalIndex, result };
        });

        const results = await Promise.all(promises);
        results.sort((a, b) => a.globalIndex - b.globalIndex);

        for (const batchResult of results) {
            for (const item of batchResult.result) {
                translatedById[String(item.id)] = item.text;
            }
        }

        const lastResult = results[results.length - 1];
        if (lastResult && lastResult.result) {
            previousTranslatedContext = lastResult.result.slice(-PREVIOUS_TRANSLATION_CONTEXT);
        }
    }

    const output = items.map(item => {
        const translated = translatedById[String(item.id)] || item.text;
        return `${item.id}\n${item.start} --> ${item.end}\n${translated}\n`;
    }).join('\n');

    return output.trim() + '\n';
}

// ============================================================
// SRT PARSER NATIV 
// ============================================================

function parseSrt(srt) {
    const normalized = String(srt || '').replace(/\r/g, '').replace(/^\uFEFF/, '');
    const blocks = normalized.split(/\n{2,}/);
    const result = [];

    for (const block of blocks) {
        const lines = block.split('\n').map(l => l.trimEnd());
        if (lines.length < 3) continue;

        const id = Number(lines[0].trim());
        if (!Number.isInteger(id)) continue;

        const timing = lines[1].trim();
        const match = timing.match(/^(\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2},\d{3})(?:.*)?$/);
        if (!match) continue;

        let rawText = lines.slice(2).join('\n');
        const text = cleanTextForJson(rawText);

        if (!text || text === ' ') continue;

        result.push({ id, start: match[1], end: match[2], text });
    }

    return result;
}

// ============================================================
// UTILS & START
// ============================================================

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

app.get('/health', (req, res) => {
    res.json({ ok: true, service: 'RO Sub Translator', model: MODEL_NAME, version: manifest.version });
});

const PORT = Number(process.env.PORT) || 7000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`${c.green}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}`);
    console.log(`${c.green}🚀 RO Sub Translator v${manifest.version} pornit${c.reset}`);
    console.log(`${c.green}🌐 Port: ${PORT}${c.reset}`);
    console.log(`${c.green}🤖 Model: ${MODEL_NAME}${c.reset}`);
    console.log(`${c.green}📦 Chunk: ${CHUNK_SIZE} linii${c.reset}`);
    console.log(`${c.green}⚡ Paralelism: ${CONCURRENCY_LIMIT} chunk-uri${c.reset}`);
    console.log(`${c.green}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}`);
});
