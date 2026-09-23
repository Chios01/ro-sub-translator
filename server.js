const express = require('express');
const axios = require('axios');
const Parser = require('srt-parser-2').default;
const path = require('path');

console.log = (...args) => process.stdout.write(args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : arg).join(' ') + '\n');

const app = express();

app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    next();
});

// === CULORI PENTRU CONSOLĂ ===
const c = {
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    red: '\x1b[31m',
    cyan: '\x1b[36m',
    magenta: '\x1b[35m',
    reset: '\x1b[0m'
};

const memoryCache = {}; 

// === MANIFESTUL TĂU OPTIMIZAT PENTRU STREMIO ===
const manifest = {
    id: 'community.chios.geminitranslator', 
    version: '1.0.0',
    name: 'RO Sub Translator',
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

const BROWSER_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

// ==========================================
// 1. RUTELE SERVERULUI
// ==========================================

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/:configData/manifest.json', (req, res) => {
    res.json(manifest);
});

app.get('/:configData/configure', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

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

    // Încărcare paralelă ultra-rapidă pentru a elimina delay-ul din Stremio
    const urlsToFetch = [
        `https://opensubtitles-v3.strem.io/subtitles/${type}/${id}${extraString}.json`, 
        `https://opensubtitles.strem.io/subtitles/${type}/${id}${extraString}.json`,  
        `https://yifysubtitles.strem.io/subtitles/${type}/${id}${extraString}.json`,
        `https://subdl.strem.io/subtitles/${type}/${id}${extraString}.json`
    ];

    try {
        const fetchPromises = urlsToFetch.map(u => 
            axios.get(u, { 
                timeout: 3000, 
                headers: { 'User-Agent': BROWSER_USER_AGENT } 
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
        }).slice(0, 20); 

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
            if (/sync|corregido|resync|translated|auto|machine/i.test(subName)) s.score -= 100;
        });

        diverseSubs.sort((a, b) => b.score - a.score);
        diverseSubs = diverseSubs.slice(0, 15);

        const generatedSubs = diverseSubs.map((s, index) => {
            const encodedUrl = encodeURIComponent(s.originalUrl);
            
            let vizualName = s.realName.replace(/[^a-zA-Z0-9.-]/g, ' ');
            const tagMatch = vizualName.match(/(1080p|720p|2160p|4k|bluray|web-dl|webrip|yts|yify|rarbg)/i);
            
            let labelName = `[${index + 1}] RO AI`;
            if (tagMatch) {
                let cleanTag = tagMatch[0].toUpperCase();
                labelName = `[${index + 1}] RO AI (${cleanTag})`;
            }

            return {
                id: `ai_sub_${index}`,
                title: labelName, 
                url: `${baseUrl}/${configData}/translate?id=${id}&targetUrl=${encodedUrl}&v=${s.index + 1}`,
                lang: 'ron' // Forțează limba română ca să apară selectată instant în Stremio
            };
        });

        return res.json({ subtitles: generatedSubs });
    } catch (error) {
        return res.json({ subtitles: [] });
    }
}

app.get('/:configData/subtitles/:type/:id.json', handleSubtitles);
app.get('/:configData/subtitles/:type/:id/:extra.json', handleSubtitles);

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

    if (memoryCache[cacheKey] && typeof memoryCache[cacheKey] === 'string') {
        res.setHeader('Content-Type', 'text/srt; charset=utf-8');
        return res.send(memoryCache[cacheKey]);
    }

    res.writeHead(200, {
        'Content-Type': 'text/srt; charset=utf-8',
        'Transfer-Encoding': 'chunked'
    });
    res.flushHeaders(); 

    const keepAlive = setInterval(() => {
        res.write(' \n');
    }, 10000);

    try {
        let processPromise;
        let isNew = false;

        if (memoryCache[cacheKey] && typeof memoryCache[cacheKey] !== 'string') {
            processPromise = memoryCache[cacheKey];
        } else {
            isNew = true;
            const startTime = Date.now();
            
            processPromise = (async () => {
                const srtRes = await axios.get(targetUrl, {
                    headers: { 'User-Agent': BROWSER_USER_AGENT }
                });
                
                const totalLinesCount = (srtRes.data.match(/-->/g) || []).length;
                console.log(`${c.cyan}\n==================================================${c.reset}`);
                console.log(`${c.magenta}▶ ÎNCEPE PROCESAREA PENTRU: ${imdbId}${c.reset}`);
                console.log(`${c.magenta}📑 Total linii de tradus: ${totalLinesCount}${c.reset}`);
                console.log(`${c.cyan}==================================================\n${c.reset}`);
                
                return await translateSrtWithGemini(srtRes.data, userKeys);
            })();
            
            memoryCache[cacheKey] = processPromise;
            
            processPromise.then(translatedSrtString => {
                memoryCache[cacheKey] = translatedSrtString;
                const durationSeconds = Math.floor((Date.now() - startTime) / 1000);
                let timeFormatted = durationSeconds < 60 ? `${durationSeconds} sec` : `${Math.floor(durationSeconds / 60)} min și ${durationSeconds % 60} sec`;
                
                console.log(`${c.green}\n✔ PROCESARE FINALIZATĂ CU SUCCES PENTRU: ${imdbId}${c.reset}`);
                console.log(`${c.green}⏱ Timp total de traducere: ${timeFormatted}${c.reset}`);
                console.log(`${c.cyan}==================================================\n${c.reset}`);
            }).catch(() => {
                delete memoryCache[cacheKey];
            });
        }

        const finalSrt = await processPromise;
        
        clearInterval(keepAlive);
        res.write(finalSrt);
        res.end();

    } catch (error) {
        clearInterval(keepAlive);
        res.end(); 
    }
});

const PORT = process.env.PORT || 7000;
app.listen(PORT, () => {
    console.log(`${c.green}✔ Serverul rulează pe portul: ${PORT}${c.reset}`);
});

// ==========================================
// 2. FUNCȚII AJUTĂTOARE & TRADUCERE (10 CHEI + SELECȚIE ALEATORIE SIGURĂ)
// ==========================================

function cleanTextForJson(text) {
    if (!text) return text;
    let clean = text;
    clean = clean.replace(/[\[\(\*\{][\s\S]*?[\]\)\*\}]/g, '');
    clean = clean.replace(/^[A-Z0-9\s-]{2,}:/gm, '');
    clean = clean.replace(/[♪#♫]/g, '');
    clean = clean.replace(/â™ª/gi, '');
    clean = clean.replace(/â™«/gi, '');
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

function formatSubtitleLine(text) {
    if (!text) return text;
    if (text.includes('\n')) return text;

    const MAX_LEN = 45; 
    if (text.length > MAX_LEN) {
        let mid = Math.floor(text.length / 2);
        let leftSpace = text.lastIndexOf(' ', mid);
        let rightSpace = text.indexOf(' ', mid);
        let splitIndex = -1;

        if (leftSpace !== -1 && rightSpace !== -1) {
            splitIndex = (mid - leftSpace) <= (rightSpace - mid) ? leftSpace : rightSpace;
        } else if (leftSpace !== -1) {
            splitIndex = leftSpace;
        } else if (rightSpace !== -1) {
            splitIndex = rightSpace;
        }

        if (splitIndex !== -1) {
            return text.substring(0, splitIndex).trim() + '\n' + text.substring(splitIndex + 1).trim();
        }
    }
    return text;
}

function fixBrokenJson(text) {
    let fixed = text;
    fixed = fixed.replace(/"(\d+)":\s*([^",}\n]+)([,}\n])/g, function(match, key, value, terminator) {
        let cleanVal = value.trim();
        if (!cleanVal.startsWith('"')) {
            cleanVal = cleanVal.replace(/^b['"]|['"]$/g, '');
            return `"${key}": "${cleanVal}"${terminator}`;
        }
        return match;
    });
    return fixed;
}

let globalRateLimitPause = 0;

async function processChunkWithRetry(chunkObjArray, globalChunkIndex, totalChunks, keyState) {
    let keysToTranslate = {};
    chunkObjArray.forEach(obj => {
        keysToTranslate[obj.id] = obj.text;
    });

    let finalTranslatedDict = {};
    let expectedTotalCount = Object.keys(keysToTranslate).length;
    let attempts = 0;
    const maxAttempts = 15;

    while (Object.keys(keysToTranslate).length > 0 && attempts < maxAttempts) {
        while (Date.now() < globalRateLimitPause) {
            await new Promise(r => setTimeout(r, 1000));
        }

        let currentKeyObj = null;
        let keyIndex = -1;
        let apiKey = null;

        while (true) {
            let availableIndices = [];
            for (let i = 0; i < keyState.keys.length; i++) {
                if (Date.now() >= keyState.keys[i].pauseUntil) {
                    availableIndices.push(i);
                }
            }

            if (availableIndices.length > 0) {
                let randomIndex = Math.floor(Math.random() * availableIndices.length);
                keyIndex = availableIndices[randomIndex];
                currentKeyObj = keyState.keys[keyIndex];
                apiKey = currentKeyObj.value;

                currentKeyObj.pauseUntil = Date.now() + 1500;
                break;
            }

            await new Promise(r => setTimeout(r, 1000));
        }

        const modelName = 'gemini-3.5-flash-lite';
        let currentBatchSize = Object.keys(keysToTranslate).length;

        try {
            if (currentBatchSize === expectedTotalCount) {
                console.log(`${c.cyan}➤ [Gemini] Traduc calup ${globalChunkIndex + 1}/${totalChunks} (Model: ${modelName} | Cheie: ${keyIndex})...${c.reset}`);
            } else {
                console.log(`${c.magenta}↻ [Gemini] Recuperez ${currentBatchSize} linii omise pentru calupul ${globalChunkIndex + 1}...${c.reset}`);
            }
            
            const prompt = `Ești un traducător profesionist de subtitrări. Traduce din engleză în română.
RESPECTĂ STRICT URMĂTOARELE REGULI (FĂRĂ EXCEPȚII):

1. GRAMATICĂ ȘI ACORDURI (CRITIC): 
   -> Articulează corect substantivele la plural (ex: "sânii mei", NU "sâni mei").
   -> Folosește corect genul substantivelor comune (ex: "o secundă", NU "un secund").
   -> Nu scrie niciodată "Mi s-a plătit" în loc de "Am fost plătit(ă)".

2. INTERZIS TRADUCEREA ZGOMOTELOR: Nu traduce și nu scrie NICIODATĂ cuvinte ca: "Oh", "Ah", "Wow", "Ugh", "Mhm", "Uh-huh", "Ha", "Vai".
   -> Dacă replica engleză este doar un zgomot, returnează OBLIGATORIU un spațiu gol: " ". 

3. INTERZIS LINIUȚE ORFANE: Dacă ștergi un zgomot de pe un rând nou, trebuie SĂ ȘTERGI ȘI LINIUȚA DE DIALOG (-). Nu lăsa liniuțe suspendate.

4. INTERZIS SLANG ENGLEZESC: Nu scrie NICIODATĂ "man", "bro", "dude".

5. FĂRĂ TRADUCERI LITERALE (IDIOMS): Adaptează sensul la româna naturală. (ex: "Te-a distrus", nu "Te-a făcut desființată").

6. CUVINTE COMPLETE: Nu tăia niciodată prima literă a cuvântului, mai ales la diacritice (ex: scrie "Încă", nu "ncă").

7. ELIMINĂ SUNETELE DE FUNDAL (SDH): Șterge complet orice text aflat între paranteze rotunde (...) sau drepte [...]. Păstrează exclusiv dialogul.

JSON de tradus:
${JSON.stringify(keysToTranslate)}`;

            const response = await axios.post(
                `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`,
                {
                    contents: [{ parts: [{ text: prompt }] }],
                    generationConfig: { response_mime_type: "application/json" },
                    safetySettings: [
                        { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
                        { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
                        { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
                        { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
                    ]
                },
                { 
                    headers: { 'Content-Type': 'application/json' },
                    timeout: 120000 
                }
            );

            if (!response.data || !response.data.candidates || response.data.candidates.length === 0 || !response.data.candidates[0].content) {
                if (response.data && response.data.promptFeedback && response.data.promptFeedback.blockReason) {
                    throw new Error(`Filtrat de Google (${response.data.promptFeedback.blockReason})`);
                }
                throw new Error("Răspuns invalid sau gol primit de la API.");
            }

            let textResponse = response.data.candidates[0].content.parts[0].text;
            
            let startIndex = textResponse.indexOf('{');
            let endIndex = textResponse.lastIndexOf('}');

            if (startIndex !== -1 && endIndex !== -1) {
                textResponse = textResponse.substring(startIndex, endIndex + 1);
            }

            let parsedDict = {};
            try {
                let cleanText = fixBrokenJson(textResponse);
                parsedDict = JSON.parse(cleanText);
            } catch (e) {
                const keys = Object.keys(keysToTranslate);
                for (let i = 0; i < keys.length; i++) {
                    const key = keys[i];
                    const nextKey = keys[i + 1];
                    
                    let lookahead = `\\s*\\}|$)`;
                    if (nextKey) {
                        lookahead = `\\s*,?\\s*"?(?:${nextKey})"?\\s*:|\\s*\\}|$)`;
                    }
                    
                    const regex = new RegExp(`"?${key}"?\\s*:\\s*(.*?)(?=${lookahead}`, 's');
                    const match = textResponse.match(regex);
                    if (match) {
                        let val = match[1].trim();
                        if (val.endsWith(',')) val = val.substring(0, val.length - 1).trim();
                        if (val.startsWith('"') || val.startsWith("'")) val = val.substring(1);
                        if (val.endsWith('"') || val.endsWith("'")) val = val.substring(0, val.length - 1);
                        val = val.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\'/g, "'");
                        parsedDict[key] = val.trim();
                    }
                }
            }

            let newlyTranslatedCount = 0;
            for (let key in parsedDict) {
                if (keysToTranslate[key] !== undefined) {
                    finalTranslatedDict[key] = parsedDict[key];
                    delete keysToTranslate[key]; 
                    newlyTranslatedCount++;
                }
            }

            if (newlyTranslatedCount === 0) {
                throw new Error("Nu a extras nicio linie validă.");
            }

            if (Object.keys(keysToTranslate).length === 0) {
                console.log(`${c.green}✔ [Gemini] Calup ${globalChunkIndex + 1}/${totalChunks} finalizat! (${expectedTotalCount}/${expectedTotalCount} linii)${c.reset}`);
                break; 
            } else {
                attempts++;
            }

        } catch (error) {
            if (error.response && error.response.status === 429) {
                currentKeyObj.pauseUntil = Date.now() + 61000;
                globalRateLimitPause = Math.max(globalRateLimitPause, Date.now() + 10000);
                
                const sleepTime = Math.floor(10000 + Math.random() * 5000);
                console.log(`${c.yellow}⚠ [Gemini] 429! Cheia ${keyIndex} pe bancă. Calmez IP-ul 10s... (Aștept ${(sleepTime/1000).toFixed(1)}s)${c.reset}`);
                attempts++;
                
                await new Promise(r => setTimeout(r, sleepTime));
            } else if (error.response && error.response.status === 503) {
                console.log(`${c.yellow}⚠ [Gemini] 503 Server Google ocupat. Reîncercare...${c.reset}`);
                attempts++;
                await new Promise(r => setTimeout(r, 2000));
            } else {
                console.log(`${c.red}⚠ [Gemini] Eroare calup ${globalChunkIndex + 1}: ${error.message}${c.reset}`);
                attempts++;
                await new Promise(r => setTimeout(r, 1000));
            }
        }
    }

    const finalTranslatedArray = chunkObjArray.map(obj => {
        return finalTranslatedDict[obj.id] !== undefined ? finalTranslatedDict[obj.id] : obj.text;
    });

    return finalTranslatedArray;
}

async function translateSrtWithGemini(srtText, userKeys) {
    const parser = new Parser();
    const blocks = parser.fromSrt(srtText);
    
    const textsToTranslate = blocks.map((b, index) => {
        return { id: index, text: cleanTextForJson(b.text) };
    });
    
    const CHUNK_SIZE = 165; 
    const chunks = chunkArray(textsToTranslate, CHUNK_SIZE);
    
    let CONCURRENCY_LIMIT = 3; 

    let allTranslatedTexts = [];

    const keyState = { 
        keys: userKeys.map(k => ({ value: k, pauseUntil: 0 })), 
        index: 0 
    };

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
        let finalStr = allTranslatedTexts[index] || block.text; 
        block.text = formatSubtitleLine(finalStr);
    });

    return parser.toSrt(blocks);
}
