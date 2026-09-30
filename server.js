const express = require('express');
const axios = require('axios');
const Parser = require('srt-parser-2').default;
const path = require('path');
const fs = require('fs');

console.log = (...args) => process.stdout.write(args.map(arg => typeof arg === 'object' ? JSON.stringify(arg) : arg).join(' ') + '\n');

const app = express();

app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    next();
});

app.get('/validate-key', async (req, res) => {
    const key = req.query.key;
    if (!key) return res.status(400).send('No key provided');

    try {
        const check = await axios.get(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`, { timeout: 5000 });
        if (check.status === 200) {
            return res.json({ valid: true });
        }
    } catch (e) {
        return res.json({ valid: false });
    }
});

app.get('/ping', (req, res) => {
    res.status(200).send('OK');
});

const c = {
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    red: '\x1b[31m',
    cyan: '\x1b[36m',
    magenta: '\x1b[35m',
    reset: '\x1b[0m'
};

const memoryCache = {}; 
const secretArchive = []; 

const manifest = {
    id: 'community.chios.geminitranslator', 
    version: '2.5.0',
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

const BROWSER_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

app.get('/', (req, res) => {
    fs.readFile(path.join(__dirname, 'index.html'), 'utf8', (err, data) => {
        if (err) return res.sendFile(path.join(__dirname, 'index.html'));
        const updatedHtml = data.replace(/{{VERSION}}/g, manifest.version);
        res.send(updatedHtml);
    });
});

app.get('/:configData/manifest.json', (req, res) => {
    res.json(manifest);
});

app.get('/:configData/configure', (req, res) => {
    fs.readFile(path.join(__dirname, 'index.html'), 'utf8', (err, data) => {
        if (err) return res.sendFile(path.join(__dirname, 'index.html'));
        const updatedHtml = data.replace(/{{VERSION}}/g, manifest.version);
        res.send(updatedHtml);
    });
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
                <a href="/download-srt/${index}" style="background:#0bf; color:#000; text-decoration:none; padding:8px 12px; border-radius:4px; font-weight:bold;">Descarcă fisier .srt</a>
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

    // Cache activat - previne retraducerea la derulare!
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

        if (memoryCache[cacheKey] && typeof memoryCache[cacheKey] !== 'string') {
            processPromise = memoryCache[cacheKey];
        } else {
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
        
        if (finalSrt && finalSrt.trim().length > 0) {
            const now = new Date();
            const timeStr = now.toLocaleTimeString('ro-RO') + ' ' + now.toLocaleDateString('ro-RO');
            
            secretArchive.unshift({
                id: imdbId,
                time: timeStr,
                content: finalSrt
            });
            
            if (secretArchive.length > 10) {
                secretArchive.pop();
            }
        }

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

function cleanTextForJson(text) {
    if (!text) return text;
    let clean = text;

    clean = clean.replace(/<[^>]+>/g, '');
    clean = clean.replace(/[♪♫♬♩#]/gi, '');
    clean = clean.replace(/â™ª/gi, '');
    clean = clean.replace(/â™«/gi, '');
    clean = clean.replace(/\[\s*[♪♫♬♩#]+\s*\]/gi, '');
    clean = clean.replace(/\(\s*[♪♫♬♩#]+\s*\)/gi, '');
    clean = clean.replace(/\[.*music.*\]/gi, ''); 

    clean = clean.replace(/\[[\s\S]*?\]/g, ''); 
    clean = clean.replace(/\([\s\S]*?\)/g, ''); 
    clean = clean.replace(/\{[\s\S]*?\}/g, ''); 
    clean = clean.replace(/【[\s\S]*?】/g, ''); 
    
    clean = clean.replace(/^[A-Z0-9\s-]{2,}:/gm, '');
    clean = clean.replace(/"/g, "'");

    let lines = clean.split('\n');
    lines = lines.map(line => {
        let l = line.trim();
        let changed = true;
        while(changed) {
            const match = l.match(/^([-—–−\s]*)(oh+|ah+|ooh+|aah+|uh+|ugh+|hm+|um+|mm+|mhm+|eh+|wow+|hey+|shh+)[.,!?\s]*(.*)$/i);
            if (match) {
                l = match[1] + match[3].trim();
            } else {
                changed = false;
            }
        }
        if (/^[-—–−.,!?\s]*$/.test(l)) return '';
        
        l = l.replace(/[♪♫♬♩#]/gi, '');
        l = l.replace(/\[\s*\]/g, ''); 
        l = l.replace(/\(\s*\)/g, '');
        return l;
    });

    let validLines = lines.filter(l => l !== '');
    validLines = validLines.map(l => {
        if (/^[-—–−]/.test(l)) {
            return l.replace(/^[-—–−]+\s*/, '- '); 
        }
        return l;
    });

    clean = validLines.join('\n');
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
    
    text = text.replace(/ţ/g, 'ț').replace(/Ţ/g, 'Ț').replace(/ş/g, 'ș').replace(/Ş/g, 'Ș');
    text = text.replace(/<[^>]+>/g, '');
    text = text.replace(/([.?!])\s+[-—–−]\s+([A-ZĂÂÎȘȚ])/g, '$1\n- $2');

    let lines = text.split('\n');
    lines = lines.map(l => {
        let cl = l.trim();
        if (/^([-—–−\s]*)(ă+|m+|mm+|îm+|îhî|aha|mda|oh+|ah+|um+|hm+)[.,!?\s]*$/i.test(cl)) return '';
        if (/^[-—–−.,!?\s]*$/.test(cl)) return '';
        return cl;
    });
    
    let validLines = lines.filter(l => l !== '');
    
    let mergedText = '';
    for (let i = 0; i < validLines.length; i++) {
        let l = validLines[i];
        if (i === 0) {
            mergedText = l;
        } else {
            if (/^[-—–−]/.test(l)) { 
                mergedText += '\n' + l;
            } else {
                mergedText += ' ' + l; 
            }
        }
    }
    
    let finalMergedLines = mergedText.split('\n');
    finalMergedLines = finalMergedLines.map(l => {
        return l.trim().replace(/^[-—–−]+\s*/g, ''); 
    });
    
    text = finalMergedLines.join('\n');
    
    // ==========================================
    // PLASA DE SIGURANȚĂ: EXPRESII REGULATE BLINDATE
    // ==========================================
    const dictionar = [
        // Orice inventează AI-ul cu "aire", "aimai" îl facem "ai" direct
        [/c[aă]nd\s+aire\b/gi, 'când ai'],
        [/c[aă]nd\s+aimai\b/gi, 'când ai'],
        [/un\s+secund\b/gi, 'o secundă'],

        // Orice ar inventa modelul cu "oprește-te din a-mi... sâni/decolteu/țâțe" se taie tot.
        [/opre[șs]te-te\s+din\s+a-mi.*?(s[âa]ni|decolteu|țâțe)/gi, 'nu te mai holba la sânii mei'],
        [/[îi]nceteaz[aă]\s+s[ăa]?\s+te\s+ui[țt]i.*?(\bțâțele\b|\bsânii\b)/gi, 'nu te mai holba la sânii mei'],

        // Repararea genului și a altor greșeli de context semnalate
        [/Am\s+fost\s+pl[ăa]tit\b/gi, 'Am fost plătită'],
        [/(Aproape\s+am\s+gata|Suntem\s+aproape\s+acolo)/gi, 'Imediat ajungem'],
        [/[ȚTțt]-a\s+dat-o/g, 'Ți-a dat-o'],
        [/[țt]ie\s+[țt]i-s\s+dragi/gi, 'ție îți plac'],

        // Corecturi generale
        [/ăă/gi, ''], [/hă/gi, ''], [/P-Păi/gi, 'Păi'], [/[wW]-Well/g, 'Păi'],
        [/\bfrom\b/gi, 'de la']
    ];

    for (let i = 0; i < dictionar.length; i++) {
        text = text.replace(dictionar[i][0], dictionar[i][1]);
    }

    text = text.replace(/[♪♫♬♩#]/gi, '');
    text = text.replace(/\[[\s\S]*?\]/g, ''); 
    text = text.replace(/\([\s\S]*?\)/g, '');

    text = text.replace(/,\s*,/g, ',');
    text = text.replace(/\s+,/g, ',');
    text = text.replace(/\s+\?/g, '?');
    text = text.replace(/\s+\./g, '.');
    text = text.replace(/ +/g, ' '); 
    
    text = text.replace(/[^\u0000-\u024F\u2000-\u206F\u2E00-\u2E7F\n\r]/g, "");

    if (text.trim() === '') return ' '; 

    let finalLinesText = text.split('\n').map(l => l.trim()).filter(l => l !== '');
    
    if (finalLinesText.length > 2) {
        let joined = finalLinesText.join(' ');
        let mid = Math.floor(joined.length / 2);
        let leftSpace = joined.lastIndexOf(' ', mid);
        let rightSpace = joined.indexOf(' ', mid);
        let splitIndex = (leftSpace !== -1 && rightSpace !== -1) ? 
            ((mid - leftSpace) <= (rightSpace - mid) ? leftSpace : rightSpace) : 
            Math.max(leftSpace, rightSpace);
        
        if (splitIndex !== -1) {
            finalLinesText = [joined.substring(0, splitIndex).trim(), joined.substring(splitIndex + 1).trim()];
        } else {
            finalLinesText = [joined];
        }
    } else if (finalLinesText.length === 1 && finalLinesText[0].length > 60) {
        let line = finalLinesText[0];
        let mid = Math.floor(line.length / 2);
        let leftSpace = line.lastIndexOf(' ', mid);
        let rightSpace = line.indexOf(' ', mid);
        let splitIndex = (leftSpace !== -1 && rightSpace !== -1) ? 
            ((mid - leftSpace) <= (rightSpace - mid) ? leftSpace : rightSpace) : 
            Math.max(leftSpace, rightSpace);
        
        if (splitIndex !== -1) {
            finalLinesText = [line.substring(0, splitIndex).trim(), line.substring(splitIndex + 1).trim()];
        }
    }

    return finalLinesText.map(l => l.replace(/^[-—–−\s*]/g, '')).join('\n');
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
    let contentErrorCount = 0; 
    const maxAttempts = 15; 

    let currentKeyObj = null;
    let keyIndex = -1;
    let apiKey = null;

    while (Object.keys(keysToTranslate).length > 0 && attempts < maxAttempts) {
        
        let batchToProcess = {};
        const allKeys = Object.keys(keysToTranslate);
        
        if (contentErrorCount >= 2 && allKeys.length > 5) {
            console.log(`${c.yellow}⚠ [Gemini] Calupul ${globalChunkIndex + 1} pare blocat de format. Îl împart pentru a izola problema...${c.reset}`);
            const halfLength = Math.floor(allKeys.length / 2);
            for (let i = 0; i < halfLength; i++) {
                batchToProcess[allKeys[i]] = keysToTranslate[allKeys[i]];
            }
            contentErrorCount = 0; 
        } else {
            batchToProcess = Object.assign({}, keysToTranslate);
        }

        while (Date.now() < globalRateLimitPause) {
            await new Promise(r => setTimeout(r, 1000));
        }

        if (!apiKey) {
            while (true) {
                let checkedAll = 0;
                while (checkedAll < keyState.keys.length) {
                    let candidateIndex = keyState.index % keyState.keys.length;
                    keyState.index++; 
                    checkedAll++;
                    
                    if (Date.now() >= keyState.keys[candidateIndex].pauseUntil) {
                        keyIndex = candidateIndex;
                        currentKeyObj = keyState.keys[keyIndex];
                        apiKey = currentKeyObj.value;
                        currentKeyObj.pauseUntil = Date.now() + 1500; 
                        break;
                    }
                }
                
                if (apiKey) break; 
                await new Promise(r => setTimeout(r, 1000));
            }
        }

        const modelName = 'gemini-3.5-flash-lite';
        let currentBatchSize = Object.keys(batchToProcess).length;

        try {
            if (currentBatchSize === expectedTotalCount) {
                console.log(`${c.cyan}➤ [Gemini] Traduc calup ${globalChunkIndex + 1}/${totalChunks} (Model: ${modelName} | Cheie: ${keyIndex})...${c.reset}`);
            } else {
                console.log(`${c.magenta}↻ [Gemini] Recuperez ${currentBatchSize} linii omise (Calup ${globalChunkIndex + 1} | Aceeași cheie: ${keyIndex})...${c.reset}`);
            }
            
            const prompt = `You are a professional Romanian movie translator. Your ONLY purpose is to translate an English subtitle JSON array into natural, conversational Romanian.

CRITICAL SYSTEM REQUIREMENT:
The input JSON contains EXACTLY ${currentBatchSize} items. You MUST output EXACTLY ${currentBatchSize} items. Every single key from the input must be present in the output JSON.

<rules>
1. SLANG & PROFANITY (CRITICAL): Translate slang normally. DO NOT translate profanities literally. Rephrase them into natural Romanian conversational equivalents.
2. CONTEXT & GENDER: Pay extreme attention to context. If it's clear a female is acting/speaking or being referred to, use feminine verb agreements and adjectives (e.g., "Am fost plătită").
3. NO INVENTED WORDS: Use ONLY standard Romanian words. Never invent conjugations. If an English phrase has no direct translation, adapt its meaning naturally.
4. SPLIT LINES: Subtitles are often cut mid-sentence. Read the surrounding context and translate so the sentence flows naturally across lines. DO NOT leave words unfinished.
5. CLEAN UP: Remove all audio tags (e.g., [sighs], [music]). DO NOT translate character names.
6. JSON ONLY: Reply STRICTLY with a valid JSON object matching the exact input keys. Do not add markdown or extra text.
</rules>

Translate this JSON:
${JSON.stringify(batchToProcess)}`;

            const response = await axios.post(
                `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`,
                {
                    contents: [{ parts: [{ text: prompt }] }],
                    generationConfig: { 
                        response_mime_type: "application/json",
                        temperature: 0.0
                    },
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
                const keys = Object.keys(batchToProcess);
                for (let i = 0; i < keys.length; i++) {
                    const key = keys[i];
                    const lookahead = `\\s*,?\\s*"?\\d+"?\\s*:|\\s*\\}|$)`;
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
            } else {
                attempts = 0;
                contentErrorCount = 0;
            }

            if (Object.keys(keysToTranslate).length === 0) {
                console.log(`${c.green}✔ [Gemini] Calup ${globalChunkIndex + 1}/${totalChunks} finalizat! (${expectedTotalCount}/${expectedTotalCount} linii)${c.reset}`);
                break; 
            } else {
                await new Promise(r => setTimeout(r, 2000));
            }

        } catch (error) {
            attempts++;
            if (attempts >= maxAttempts) {
                console.log(`${c.red}✖ [Gemini] Limita atinsă pentru calupul ${globalChunkIndex + 1}. Abandon!${c.reset}`);
                break; 
            }

            if (error.response && error.response.status === 429) {
                currentKeyObj.pauseUntil = Date.now() + 61000;
                globalRateLimitPause = Math.max(globalRateLimitPause, Date.now() + 10000);
                const sleepTime = Math.floor(10000 + Math.random() * 5000);
                console.log(`${c.yellow}⚠ [Gemini] 429! Cheia ${keyIndex} pe bancă. Calmez IP-ul...${c.reset}`);
                
                apiKey = null;
                
                await new Promise(r => setTimeout(r, sleepTime));
            } else if (error.response && error.response.status === 503) {
                const waitTime = 3000 + (attempts * 1500);
                console.log(`${c.yellow}⚠ [Gemini] 503 Server ocupat. Aștept ${(waitTime/1000).toFixed(1)}s (Păstrez cheia)...${c.reset}`);
                await new Promise(r => setTimeout(r, waitTime));
            } else if (error.message && error.message.toLowerCase().includes('timeout')) {
                console.log(`${c.yellow}⚠ [Gemini] Timeout. Reîncercare (Păstrez cheia)...${c.reset}`);
                await new Promise(r => setTimeout(r, 2000));
            } else {
                contentErrorCount++;
                console.log(`${c.magenta}⚠ [Gemini] Eroare format. Reîncercare (Păstrez cheia)...${c.reset}`);
                await new Promise(r => setTimeout(r, 1500));
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
        
        const batchPromises = batchChunks.map(async (chunk, indexInBatch) => {
            if (indexInBatch > 0) {
                await new Promise(r => setTimeout(r, indexInBatch * 1500));
            }
            return processChunkWithRetry(chunk, i + indexInBatch, chunks.length, keyState);
        });
        
        const batchResults = await Promise.all(batchPromises);
        batchResults.forEach(translatedTextsArray => {
            allTranslatedTexts.push(...translatedTextsArray);
        });

        await new Promise(r => setTimeout(r, 1500));
    }

    blocks.forEach((block, index) => {
        let finalStr = allTranslatedTexts[index];
        
        if (finalStr === undefined || finalStr === null) {
            finalStr = block.text;
        }
        
        block.text = formatSubtitleLine(finalStr);
    });

    return parser.toSrt(blocks);
}
