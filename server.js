const express = require('express');
const axios = require('axios');
const Parser = require('srt-parser-2').default;
const path = require('path');

const app = express();

// Permitem accesul aplicației Stremio de oriunde (reguli de CORS)
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    next();
});

const memoryCache = {}; 
let globalPauseUntil = 0; 

const manifest = {
    id: 'org.stremio.rotranslator.cloud', 
    version: '1.0.0',
    name: 'RO Sub Translator',
    description: 'Traducere Premium cu Gemini. Configurat prin Interfața Web.',
    resources: ['subtitles'],
    types: ['movie', 'series'],
    catalogs: [],
    idPrefixes: ['tt']
};

// ==========================================
// 1. RUTELE SERVERULUI (FĂRĂ MODULUL SDK)
// ==========================================

// Pagina Web de Configurare
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Manifestul pentru Stremio
app.get('/:configData/manifest.json', (req, res) => {
    res.json(manifest);
});

// Funcția centrală care comunică cu Stremio pentru lista de subtitrări
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
        `https://opensubtitles-v3.strem.io/subtitles/${type}/${id}.json`,             
        `https://opensubtitles.strem.io/subtitles/${type}/${id}${extraString}.json`,  
        `https://opensubtitles.strem.io/subtitles/${type}/${id}.json`,
        `https://yifysubtitles.strem.io/subtitles/${type}/${id}${extraString}.json`,
        `https://yifysubtitles.strem.io/subtitles/${type}/${id}.json`,
        `https://subtitles.strem.io/subtitles/${type}/${id}${extraString}.json`,
        `https://subtitles.strem.io/subtitles/${type}/${id}.json`
    ];

    try {
        const fetchPromises = urlsToFetch.map(u => 
            axios.get(u, { timeout: 4500 }).catch(() => ({ data: { subtitles: [] } }))
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
        }).slice(0, 120); 

        if (engSubs.length === 0) return res.json({ subtitles: [] });

        let processedSubs = [];
        for (let i = 0; i < engSubs.length; i += 10) {
            const batch = engSubs.slice(i, i + 10);
            const batchResults = await Promise.all(batch.map(async (sub, idx) => {
                let realName = sub.id || `Varianta_${i + idx + 1}`;
                try {
                    const headRes = await axios.head(sub.url, { timeout: 2000 });
                    const disposition = headRes.headers['content-disposition'];
                    if (disposition && disposition.includes('filename')) {
                        const match = disposition.match(/filename=["']?([^"';]+)["']?/i);
                        if (match && match[1]) realName = match[1].replace(/\.srt$/gi, '');
                    }
                } catch (e) { }
                return { originalUrl: sub.url, realName, index: i + idx };
            }));
            processedSubs.push(...batchResults);
        }

        const uniqueNames = new Set();
        let diverseSubs = [];
        const trashRegex = /korsub|kor\.sub|hdcam|hd-ts|hdts|camrip|telesync|telecine|hardcoded|hc-eng|hc-sub|hc\.\w+|1xbet/i;

        for (const s of processedSubs) {
            if (trashRegex.test(s.realName)) continue;
            const cleanKey = s.realName.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
            if (!uniqueNames.has(cleanKey)) {
                uniqueNames.add(cleanKey);
                diverseSubs.push(s);
            }
        }

        const isExtendedVideo = /extended|director|dc|unrated|remastered|special|imax/i.test(userFilename);
        const fNameLower = userFilename.toLowerCase();

        diverseSubs.forEach(s => {
            s.score = 0;
            const subName = s.realName.toLowerCase();
            if (isExtendedVideo && /extended|director|dc|unrated|remastered|special|imax/i.test(subName)) s.score += 200;
            else if (!isExtendedVideo && /extended|director|dc|unrated|remastered|special|imax/i.test(subName)) s.score -= 100;

            const tags = ['rarbg', 'yts', 'yify', 'web-dl', 'webrip', 'bluray', 'brrip', 'x264', 'x265', 'amazon', 'amzn', 'nf'];
            tags.forEach(tag => {
                if (fNameLower.includes(tag) && subName.includes(tag)) s.score += 50;
            });

            if (/yts|yify|rarbg|bluray|web-dl|webrip/i.test(subName)) s.score += 15;
        });

        diverseSubs.sort((a, b) => b.score - a.score);
        diverseSubs = diverseSubs.slice(0, 12);

        const generatedSubs = diverseSubs.map((s) => {
            const encodedUrl = encodeURIComponent(s.originalUrl);
            let displayTitle = s.realName;
            const splitMatch = displayTitle.match(/(\b19\d{2}\b|\b20\d{2}\b|\b1080p\b|\b720p\b|\b2160p\b|\b4k\b|\bEXTENDED\b|\bDIRECTORS?\b|\bUNRATED\b|\bREMASTERED\b)/i);

            if (splitMatch && splitMatch.index > 3) displayTitle = displayTitle.substring(splitMatch.index);
            else if (displayTitle.length > 40) displayTitle = ".." + displayTitle.slice(-38);

            const cleanNameForId = `AI_${displayTitle.replace(/[^a-zA-Z0-9.-]/g, '_')}`;

            return {
                id: cleanNameForId,
                url: `${baseUrl}/${configData}/translate?id=${id}&targetUrl=${encodedUrl}&v=${s.index + 1}`,
                lang: 'ron'
            };
        });

        return res.json({ subtitles: generatedSubs });
    } catch (error) {
        return res.json({ subtitles: [] });
    }
}

// Rutele care interceptează exact cererile Stremio
app.get('/:configData/subtitles/:type/:id.json', handleSubtitles);
app.get('/:configData/subtitles/:type/:id/:extra.json', handleSubtitles);

// Ruta pentru traducerea propriu-zisă
app.get('/:configData/translate', async (req, res) => {
    const imdbId = req.query.id;
    const targetUrl = req.query.targetUrl;
    const configData = req.params.configData;

    if (!targetUrl) return res.status(400).send('Lipsă URL sursă.');

    let userKeys = [];
    try {
        const decoded = Buffer.from(configData, 'base64').toString('utf8');
        userKeys = JSON.parse(decoded);
    } catch(e) {
        return res.status(400).send('Configurare invalidă. Instalează addon-ul din nou.');
    }

    const cacheKey = targetUrl;

    if (memoryCache[cacheKey]) {
        try {
            const srtString = await memoryCache[cacheKey];
            res.setHeader('Content-Type', 'text/srt; charset=utf-8');
            return res.send(srtString);
        } catch (error) {
            delete memoryCache[cacheKey];
            return res.status(500).send('Eroare la cache.');
        }
    }

    console.log(`▶ Procesare cerută pentru filmul: ${imdbId}`);
    const processPromise = (async () => {
        const srtRes = await axios.get(targetUrl);
        return await translateSrtWithGemini(srtRes.data, userKeys);
    })();

    memoryCache[cacheKey] = processPromise;

    try {
        const translatedSrtString = await processPromise;
        memoryCache[cacheKey] = translatedSrtString;

        res.setHeader('Content-Type', 'text/srt; charset=utf-8');
        res.send(translatedSrtString);
        console.log(`✔ Finalizat cu succes: ${imdbId}`);
    } catch (error) {
        delete memoryCache[cacheKey];
        res.status(500).send('Eroare la procesarea subtitrării.');
    }
});

const PORT = process.env.PORT || 7000;
app.listen(PORT, () => {
    console.log(`✔ Serverul rulează pe portul: ${PORT}`);
});

// ==========================================
// 2. FUNCȚII AJUTĂTOARE & TRADUCERE
// ==========================================

function cleanTextForJson(text) {
    if (!text) return text;
    let clean = text;
    clean = clean.replace(/[\[\(\*\{][\s\S]*?[\]\)\*\}]/g, '');
    clean = clean.replace(/^[A-Z0-9\s-]{2,}:/gm, '');
    clean = clean.replace(/[♪#♫]/g, '');
    clean = clean.replace(/"/g, "'");
    if (clean.trim() === '') return ' ';
    return clean.trim();
}

function chunkArray(array, size) {
    const result = [];
    for (let i = 0; i < array.length; i += size) {
        result.push(array.slice(i, i + size));
    }
    return result;
}

async function processChunkWithRetry(chunkObjArray, globalChunkIndex, totalChunks, keyState) {
    const chunkDict = {};
    chunkObjArray.forEach(obj => {
        chunkDict[obj.id] = obj.text;
    });

    const expectedKeysCount = Object.keys(chunkDict).length;
    let attempts = 0;
    const maxAttempts = keyState.keys.length * 4;

    while (attempts < maxAttempts) {
        if (Date.now() < globalPauseUntil) {
            const waitTime = globalPauseUntil - Date.now();
            await new Promise(r => setTimeout(r, waitTime));
        }

        const apiKey = keyState.keys[keyState.index];
        keyState.index = (keyState.index + 1) % keyState.keys.length;

        const modelName = (attempts < 2) ? 'gemini-3.5-flash' : 'gemini-3.5-flash-lite';

        try {
            const prompt = `Ești un traducător profesionist de subtitrări de film din engleză în română.
Sarcina ta este să traduci ABSOLUT TOATE valorile următorului obiect JSON.

REGULI LINGVISTICE PREMIUM (ROMÂNĂ):
1. Precizie și Naturalețe: Traducerea trebuie să fie precisă și firească. Nu traduce literar (cuvânt cu cuvânt), dar NICI NU INVENTA sensuri noi sau argou inexistent. Păstrează exact ideea originală!
2. Fără Cenzură: Nu cenzura nimic. Menține exact același nivel de limbaj (inclusiv înjurături, argou sau limbaj licențios) ca în original.
3. Pronume (Tutuire): Folosește pronumele de tutuire ("tu", "voi") implicit.
4. Gen (Masculin implicit): Pentru cuvintele care depind de gen, folosește forma de masculin implicit.
5. FORMAT ȘI SDH: Păstrează etichetele HTML (<i>, <b>) și liniile noi (Enter/\\n). Dacă o linie conține DOAR un sunet descriptiv (ex: ENGINE ROARS), tradu-o doar cu un spațiu gol: " ". Nu lăsa niciun cuvânt netradus.

CONSTRÂNGERI CRITICE DE FORMAT (JSON ABSOLUT):
1. Returnează DOAR un singur obiect JSON plat. Fără text pe lângă, fără markdown (fără \`\`\`json).
2. TRADUCE EXACT ${expectedKeysCount} LINII. Nu omite și nu adăuga nicio cheie!
3. Format așteptat: {"ID": "text tradus", "ID2": "text tradus"}
4. NU folosi ghilimele duble (") în interiorul textului tradus. Folosește doar ghilimele simple (').

English subtitles:
${JSON.stringify(chunkDict)}`;

            const response = await axios.post(
                `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`,
                {
                    contents: [{ parts: [{ text: prompt }] }],
                    generationConfig: { response_mime_type: "application/json" }
                },
                { headers: { 'Content-Type': 'application/json' } }
            );

            let textResponse = response.data.candidates[0].content.parts[0].text;
            
            let openBraces = 0;
            let startIndex = textResponse.indexOf('{');
            let endIndex = -1;

            if (startIndex !== -1) {
                for (let i = startIndex; i < textResponse.length; i++) {
                    if (textResponse[i] === '{') openBraces++;
                    if (textResponse[i] === '}') {
                        openBraces--;
                        if (openBraces === 0) {
                            endIndex = i;
                            break;
                        }
                    }
                }
            }

            if (startIndex !== -1 && endIndex !== -1) {
                textResponse = textResponse.substring(startIndex, endIndex + 1);
            }

            const translatedDict = JSON.parse(textResponse);
            const receivedKeysCount = Object.keys(translatedDict).length;
            if (receivedKeysCount < expectedKeysCount) {
                 throw new Error(`AI-ul a omis replici!`);
            }

            const finalTranslatedArray = chunkObjArray.map(obj => {
                return translatedDict[obj.id] !== undefined ? translatedDict[obj.id] : obj.text;
            });

            return finalTranslatedArray;

        } catch (error) {
            if (error.response && error.response.status === 429) {
                const delay = 6000 + (attempts * 1500) + Math.floor(Math.random() * 1000); 
                const newPause = Date.now() + delay;
                if (newPause > globalPauseUntil) globalPauseUntil = newPause;
                attempts++;
                await new Promise(r => setTimeout(r, delay));
            } else {
                attempts++;
                await new Promise(r => setTimeout(r, 1000));
            }
        }
    }
    throw new Error(`Calupul a eșuat definitiv.`);
}

async function translateSrtWithGemini(srtText, userKeys) {
    const parser = new Parser();
    const blocks = parser.fromSrt(srtText);
    
    const textsToTranslate = blocks.map((b, index) => {
        return { id: index, text: cleanTextForJson(b.text) };
    });
    
    const CHUNK_SIZE = 120; 
    const chunks = chunkArray(textsToTranslate, CHUNK_SIZE);
    
    const CONCURRENCY_LIMIT = 3; 
    let allTranslatedTexts = [];

    const keyState = { keys: userKeys, index: 0 };

    for (let i = 0; i < chunks.length; i += CONCURRENCY_LIMIT) {
        const batchChunks = chunks.slice(i, i + CONCURRENCY_LIMIT);
        const batchPromises = batchChunks.map((chunk, indexInBatch) => {
            return processChunkWithRetry(chunk, i + indexInBatch, chunks.length, keyState);
        });
        
        const batchResults = await Promise.all(batchPromises);
        batchResults.forEach(translatedTextsArray => {
            allTranslatedTexts.push(...translatedTextsArray);
        });
    }

    blocks.forEach((block, index) => {
        block.text = allTranslatedTexts[index] || block.text; 
    });

    return parser.toSrt(blocks);
}
