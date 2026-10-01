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
// MEMORY
// ============================================================

const memoryCache = Object.create(null);
const secretArchive = [];

function cleanMemoryCache() {
    const keys = Object.keys(memoryCache);

    if (keys.length > 30) {
        for (let i = 0; i < 5; i++) {
            if (keys[i]) {
                delete memoryCache[keys[i]];
            }
        }
    }
}

// ============================================================
// MANIFEST
// ============================================================

const manifest = {
    id: 'community.chios.geminitranslator',
    version: '12.8.0',
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
// ROOT & PING
// ============================================================

app.get('/', (req, res) => {
    const indexPath = path.join(__dirname, 'index.html');
    if (fs.existsSync(indexPath)) {
        return res.sendFile(indexPath);
    }
    res.send('RO Sub Translator is running.');
});

app.get('/ping', (req, res) => {
    res.send('OK');
});

// ============================================================
// VALIDATE GEMINI KEY
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

// ============================================================
// CONFIGURE
// ============================================================

app.get('/:configData/configure', (req, res) => {
    const indexPath = path.join(__dirname, 'index.html');
    if (fs.existsSync(indexPath)) {
        return res.sendFile(indexPath);
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
// FORMAT LINE & DICTIONARY (POST-PROCESARE SIGURĂ)
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
    text = text.replace(/([.?!])\s+[-—–−]\s+([A-ZĂÂÎȘȚ])/g, '$1\n- $2');

    const dictionar = [
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
        res.setHeader('Content-Type', 'application/x-subrip; charset=utf-8');
        return res.send(memoryCache[cacheKey]);
    }

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
            
            secretArchive.unshift({ id: imdbId, time: timeStr, content: finalSrt });
            if (secretArchive.length > 10) secretArchive.pop();
        }

        res.setHeader('Content-Type', 'application/x-subrip; charset=utf-8');
        res.setHeader('Content-Disposition', 'inline; filename="romanian.srt"');
        return res.send(finalSrt);

    } catch (error) {
        console.error('Translation error:', error.message);
        if (!res.headersSent) {
            return res.status(500).send('Translation failed: ' + error.message);
        }
        return res.end();
    }
});

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
5. NO INVENTED WORDS: Use ONLY standard Romanian words. Never invent conjugations.
6. SPLIT LINES & CONTINUITY: Subtitles are often cut mid-sentence. Read the surrounding context and translate so the sentence flows naturally across lines. 
7. CLEAN UP: Remove all audio tags (e.g., [sighs], [music]). Do not translate character names.
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
${contextBefore.map(i => `[${i.id}]${i.text}`).join('\n') || '(niciunul)'}

Context anterior tradus in Romana (pentru continuitate):
${previousTranslatedContext.map(i => `[${i.id}]${i.text}`).join('\n') || '(niciunul)'}

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
// CHUNK ENGINE CU RETRY SI RE-SPLIT
// ============================================================

async function processChunkWithRetry(chunk, allItems, chunkStart, chunkEnd, previousTranslatedContext, keyStates, depth = 0) {
    const prompt = buildTranslationPrompt(chunk, allItems, chunkStart, chunkEnd, previousTranslatedContext);
    const maxLocalAttempts = 3;
    let lastError = null;

    for (let attempt = 1; attempt <= maxLocalAttempts; attempt++) {
        let keyState = null;
        try {
            keyState = await getAvailableKey(keyStates);
            const raw = await callGemini(prompt, keyState);
            
            let cleanText = raw.trim();
            const startIdx = cleanText.indexOf('{');
            const endIdx = cleanText.lastIndexOf('}');
            if (startIdx >= 0 && endIdx > startIdx) {
                cleanText = cleanText.slice(startIdx, endIdx + 1);
            }

            const parsed = JSON.parse(cleanText);
            const dict = parsed.translations || parsed;

            const results = chunk.map(obj => {
                const val = dict[obj.id] !== undefined ? dict[obj.id] : (dict[String(obj.id)] !== undefined ? dict[String(obj.id)] : obj.text);
                return {
                    id: obj.id,
                    text: formatSubtitleLine(val)
                };
            });

            return results;
        } catch (error) {
            lastError = error;
            await sleep(1000 * attempt);
        }
    }

    if (chunk.length > 20 && depth < 2) {
        const middle = Math.floor(chunk.length / 2);
        const first = chunk.slice(0, middle);
        const second = chunk.slice(middle);

        const firstResult = await processChunkWithRetry(first, allItems, chunkStart, chunkStart + middle, previousTranslatedContext, keyStates, depth + 1);
        const secondContext = firstResult.slice(-PREVIOUS_TRANSLATION_CONTEXT);
        const secondResult = await processChunkWithRetry(second, allItems, chunkStart + middle, chunkEnd, secondContext, keyStates, depth + 1);

        return [...firstResult, ...secondResult];
    }

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

            const result = await processChunkWithRetry(chunk, items, start, end, previousTranslatedContext, keyStates);
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

        const text = lines.slice(2).join('\n').trim();
        if (!text) continue;

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
    console.log(`${c.green}🚀 RO Sub Translator v${manifest.version} pornit pe portul ${PORT}${c.green}${c.reset}`);
});
