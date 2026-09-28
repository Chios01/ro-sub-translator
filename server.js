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
        if (check.status === 200) return res.json({ valid: true });
    } catch (e) {
        return res.json({ valid: false });
    }
});

const c = { green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m', magenta: '\x1b[35m', reset: '\x1b[0m' };
const memoryCache = {}; 
const secretArchive = []; 

const manifest = {
    id: 'community.chios.geminitranslator', 
    version: '2.3.34',
    name: 'RO Sub Translator',
    logo: 'https://raw.githubusercontent.com/Chios01/ro-sub-translator/main/Design_Litera_C_i_litera_G_sunt_suprapuse_i_se_mpletesc_ca_z.jpg',
    description: 'Subtitrări instant din Engleză în Română, traduse inteligent prin Gemini AI. Powered by Chios.',
    resources: ['subtitles'], types: ['movie', 'series'], catalogs: [], idPrefixes: ['tt'],
    behaviorHints: { configurable: true, configurationRequired: false }
};

const BROWSER_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

app.get('/', (req, res) => {
    fs.readFile(path.join(__dirname, 'index.html'), 'utf8', (err, data) => {
        if (err) return res.sendFile(path.join(__dirname, 'index.html'));
        res.send(data.replace(/{{VERSION}}/g, manifest.version));
    });
});

app.get('/:configData/manifest.json', (req, res) => res.json(manifest));
app.get('/:configData/configure', (req, res) => {
    fs.readFile(path.join(__dirname, 'index.html'), 'utf8', (err, data) => {
        if (err) return res.sendFile(path.join(__dirname, 'index.html'));
        res.send(data.replace(/{{VERSION}}/g, manifest.version));
    });
});

app.get('/arhiva-secreta', (req, res) => {
    let html = '<html lang="ro"><head><title>Arhiva Secreta</title><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="background:#111;color:#eee;font-family:sans-serif;padding:20px;">';
    html += '<h2 style="color:#0f0;">Arhiva Subtitrări (Ultimele 10)</h2>';
    if (secretArchive.length === 0) html += '<p>Nicio subtitrare momentan.</p>';
    else {
        html += '<ul style="list-style-type:none; padding:0;">';
        secretArchive.forEach((item, index) => {
            html += `<li style="background:#222; margin-bottom:10px; padding:15px; border-radius:5px;"><strong style="color:#0bf;">ID: ${item.id}</strong> <span style="color:#888;">(${item.time})</span><br><br><a href="/download-srt/${index}" style="background:#0bf; color:#000; padding:8px 12px; border-radius:4px; font-weight:bold; text-decoration:none;">Descarcă fisier .srt</a></li>`;
        });
        html += '</ul>';
    }
    res.send(html + '</body></html>');
});

app.get('/download-srt/:index', (req, res) => {
    const index = parseInt(req.params.index);
    if (isNaN(index) || !secretArchive[index]) return res.status(404).send('Fișier inexistent.');
    res.setHeader('Content-disposition', `attachment; filename=RO_${secretArchive[index].id}.srt`);
    res.setHeader('Content-type', 'text/plain; charset=utf-8');
    res.send(secretArchive[index].content);
});

async function handleSubtitles(req, res) {
    const { configData, type, id, extra } = req.params;
    const protocol = req.headers.host.includes('localhost') ? 'http' : 'https';
    const baseUrl = `${protocol}://${req.headers.host}`;
    let extraStr = extra ? '/' + extra : '';
    let userFilename = extra ? (new URLSearchParams(extra).get('filename') || '') : '';

    const urls = [
        `https://opensubtitles-v3.strem.io/subtitles/${type}/${id}${extraStr}.json`, 
        `https://yifysubtitles.strem.io/subtitles/${type}/${id}${extraStr}.json`,
        `https://subdl.strem.io/subtitles/${type}/${id}${extraStr}.json`
    ];

    try {
        const results = await Promise.all(urls.map(u => axios.get(u, { timeout: 3500, headers: { 'User-Agent': BROWSER_USER_AGENT } }).catch(() => ({ data: { subtitles: [] } }))));
        let engSubs = [];
        results.forEach(r => { if (r?.data?.subtitles) engSubs.push(...r.data.subtitles); });
        
        const uniqueUrls = new Set();
        engSubs = engSubs.filter(sub => (sub.lang === 'eng' || sub.lang === 'en' || sub.lang === 'English') && !uniqueUrls.has(sub.url) ? uniqueUrls.add(sub.url) : false).slice(0, 25);
        if (engSubs.length === 0) return res.json({ subtitles: [] });

        let diverseSubs = [];
        engSubs.forEach((sub, idx) => {
            let realName = sub.title || sub.id || `Varianta_${idx + 1}`;
            if (!/korsub|kor\.sub|hdcam|hd-ts|hdts|camrip|telesync|telecine|hardcoded|hc-eng|hc-sub|hc\.\w+|1xbet/i.test(realName)) diverseSubs.push({ originalUrl: sub.url, realName, index: idx, score: 0 });
        });

        const vTokens = userFilename.toLowerCase().split(/[^a-z0-9]+/i).filter(t => t.length > 2 && !/^(mkv|mp4|avi)$/.test(t));
        diverseSubs.forEach(s => {
            const sn = s.realName.toLowerCase();
            let matches = 0;
            vTokens.forEach(t => { if (sn.includes(t)) { s.score += 60; matches++; }});
            if (matches > 0 && matches >= vTokens.length / 2) s.score += 300;
            if (/web-dl|webdl|webrip|web|amzn|nf|dsnp|hulu|max/i.test(sn)) s.score += 40;
            if (/bluray|brrip|bdrip|bdr/i.test(sn)) s.score += 30;
            if (/yts|yify|rarbg|tgx|qxr|psa/i.test(sn)) s.score += 20;
            if (/sdh|hi\.|hearing impaired/i.test(sn)) s.score -= 15;
            if (/sync|corregido|resync|translated|auto|machine/i.test(sn)) s.score -= 100;
        });

        diverseSubs.sort((a, b) => b.score - a.score);
        diverseSubs = diverseSubs.slice(0, 15);

        return res.json({ subtitles: diverseSubs.map((s, idx) => {
            const tagMatch = s.realName.replace(/[^a-zA-Z0-9.-]/g, ' ').match(/(2160p|1080p|720p|4k|bluray|web-dl|webrip|hdr|remux)/i);
            return {
                id: `ai_sub_${idx}`,
                title: tagMatch ? `🇷🇴 RO AI [${idx + 1}] • ${tagMatch[0].toUpperCase()}` : `🇷🇴 RO AI [${idx + 1}]`, 
                url: `${baseUrl}/${configData}/translate?id=${id}&targetUrl=${encodeURIComponent(s.originalUrl)}&v=${s.index + 1}`, lang: 'ron'
            };
        })});
    } catch (e) { return res.json({ subtitles: [] }); }
}

app.get('/:configData/subtitles/:type/:id.json', handleSubtitles);
app.get('/:configData/subtitles/:type/:id/:extra.json', handleSubtitles);

app.get('/:configData/translate', async (req, res) => {
    const imdbId = req.query.id, targetUrl = req.query.targetUrl, configData = req.params.configData;
    if (!targetUrl) return res.status(400).send('Lipsă URL sursă.');
    let userKeys = [];
    try { userKeys = JSON.parse(Buffer.from(configData, 'base64').toString('utf8')); } catch(e) { return res.status(400).send('Configurare invalidă.'); }

    if (memoryCache[targetUrl] && typeof memoryCache[targetUrl] === 'string') {
        res.setHeader('Content-Type', 'text/srt; charset=utf-8');
        return res.send(memoryCache[targetUrl]);
    }

    res.writeHead(200, { 'Content-Type': 'text/srt; charset=utf-8', 'Transfer-Encoding': 'chunked' });
    res.flushHeaders(); 
    const keepAlive = setInterval(() => res.write(' \n'), 10000);

    try {
        if (!memoryCache[targetUrl]) {
            const startTime = Date.now();
            memoryCache[targetUrl] = (async () => {
                const srtRes = await axios.get(targetUrl, { headers: { 'User-Agent': BROWSER_USER_AGENT } });
                console.log(`${c.cyan}\n==================================================\n${c.magenta}▶ ÎNCEPE PROCESAREA PENTRU: ${imdbId}\n📑 Total linii: ${(srtRes.data.match(/-->/g)||[]).length}\n${c.cyan}==================================================\n${c.reset}`);
                return await translateSrtWithGemini(srtRes.data, userKeys);
            })();
            memoryCache[targetUrl].then(srt => {
                memoryCache[targetUrl] = srt;
                console.log(`${c.green}\n✔ FINALIZAT: ${imdbId} în ${Math.floor((Date.now() - startTime) / 1000)}s\n==================================================\n${c.reset}`);
            }).catch(() => delete memoryCache[targetUrl]);
        }
        
        const finalSrt = await memoryCache[targetUrl];
        if (finalSrt && finalSrt.trim().length > 0) {
            secretArchive.unshift({ id: imdbId, time: new Date().toLocaleTimeString('ro-RO') + ' ' + new Date().toLocaleDateString('ro-RO'), content: finalSrt });
            if (secretArchive.length > 10) secretArchive.pop();
        }
        clearInterval(keepAlive); res.write(finalSrt); res.end();
    } catch (error) { clearInterval(keepAlive); res.end(); }
});

const PORT = process.env.PORT || 7000;
app.listen(PORT, () => console.log(`${c.green}✔ Server rulează pe: ${PORT}${c.reset}`));

function cleanTextForJson(text) {
    if (!text) return text;
    let clean = text.replace(/<[^>]+>/g, '').replace(/[♪♫♬♩#]/gi, '').replace(/\[.*music.*\]/gi, '').replace(/\[[\s\S]*?\]/g, '').replace(/\([\s\S]*?\)/g, '').replace(/\{[\s\S]*?\}/g, '').replace(/【[\s\S]*?】/g, '').replace(/^[A-Z0-9\s-]{2,}:/gm, '').replace(/"/g, "'");
    return clean.split('\n').map(l => {
        let cl = l.trim();
        let changed = true;
        while(changed) {
            const match = cl.match(/^([-—–−\s]*)(oh+|ah+|ooh+|aah+|uh+|ugh+|hm+|um+|mm+|mhm+|eh+|wow+|hey+|shh+)[.,!?\s]*(.*)$/i);
            if (match) cl = match[1] + match[3].trim(); else changed = false;
        }
        return /^[-—–−.,!?\s]*$/.test(cl) ? '' : cl;
    }).filter(l => l !== '').map(l => /^[-—–−]/.test(l) ? l.replace(/^[-—–−]+\s*/, '- ') : l).join('\n').trim() || ' ';
}

function chunkArray(array, size) {
    const r = []; for (let i = 0; i < array.length; i += size) r.push(array.slice(i, i + size)); return r;
}

function formatSubtitleLine(text) {
    if (!text) return text;
    text = text.replace(/ţ/g, 'ț').replace(/Ţ/g, 'Ț').replace(/ş/g, 'ș').replace(/Ş/g, 'Ș').replace(/<[^>]+>/g, '').replace(/([.?!])\s+[-—–−]\s+([A-ZĂÂÎȘȚ])/g, '$1\n- $2');
    
    let lines = text.split('\n').map(l => {
        let cl = l.trim();
        return /^([-—–−\s]*)(ă+|m+|mm+|îm+|îhî|aha|mda|oh+|ah+|um+|hm+)[.,!?\s]*$/i.test(cl) \vert{}\vert{} /^[-—–−.,!?\s]*$/.test(cl) ? '' : cl;
    }).filter(l => l !== '');
    
    text = lines.reduce((acc, l, i) => i === 0 ? l : (/^[-—–−]/.test(l) ? acc + '\n' + l : acc + ' ' + l), '').split('\n').map(l => l.trim().replace(/^[-—–−]+\s*/g, '')).join('\n');
    text = text.replace(/[♪♫♬♩#]/gi, '').replace(/\[[\s\S]*?\]/g, '').replace(/\([\s\S]*?\)/g, '');

    const rw = (txt, search, replace, flags='g') => txt.replace(new RegExp(`(^|[^a-zA-Z0-9ăâîșțĂÂÎȘȚ])(${search})(?=[^a-zA-Z0-9ăâîșțĂÂÎȘȚ]|$)`, flags), `$1${replace}`);

    const exactReps = [
        ['ăă', ''], ['hă', ''], ['P-Păi', 'Păi'], ['\\[wW\\]-Well', 'Păi'], ['from', 'de la'], ['kensevasem', 'convinsesem'], 
        ['prăjicina', 'prăjiturica'], ['zărelul', 'zahărelul'], ['acor', 'acestor'], ['ketchuipurile', 'ketchupurile'],
        ['rțuire', 'hărțuire'], ['bacterijle', 'bacteriile'], ['rțile', 'știrile'], ['nhưng', 'dar'], ['nithe', 'niște'], 
        ['Stucați', 'Scuzați'], ['putemos', 'putem'], ['Robinei', 'lui Robin'], ['măsurą', 'măsura'], ['să fiică', 'să fie'], 
        ['Poftă\\?', 'Poftim?'], ['dădadă', 'dădacă'], ['să se fină', 'să se prefacă'], ['bet merici', 'dar meriți'], 
        ['usile', 'ușile'], ['natătăfleață', 'nătăfleață'], ['Jreți', 'vă'], ['\\[Jj\\]ă', 'vă'], ['Jți', 'Îți'], 
        ['jți', 'îți'], ['Jne', 'vă'], ['Jetați', 'vă pare rău'], ['ineam', 'țineam'], ['Ineam', 'Țineam'], 
        ['1-ar', 'l-ar'], ['aire', 'ai'], ['Aire', 'Ai'], ['aver', 'ai'], ['Aver', 'Ai'], ['Îcerci', 'Încerci'], 
        ['îcerci', 'încerci'], ['să suferit', 'să sufăr'], ['cev', 'ceva'], ['săcerci', 'să încerci'], ['Jumiți', 'Glumiți'], 
        ['jumiți', 'glumiți'], ['vumat', 'vomat'], ['unzn', 'un'], ['știen', 'știm'], ['cafond', 'profund'], 
        ['urdă', 'undă'], ['ți vei', 'îți vei'], ['nu mai te', 'nu te mai'], ['sâniile mele', 'sânii mei'], ['sâniile', 'sânii']
    ];
    exactReps.forEach(([s, r]) => { text = rw(text, s, r, 'gi'); });

    const phraseReps = [
        [/zămislirea asta/gi, 'porcăria asta'], [/onoare apre noastre/gi, 'onoarea noastră'], [/probleme cu rțile/gi, 'probleme cu știrile'], 
        [/lemnul de divorț/gi, 'divorț'], [/în toată regla/gi, 'în toată regula'], [/sunt extinși/gi, 'sunt pe cale de dispariție'],
        [/Nu-mi vine să crezi/gi, 'Nu-mi vine să cred'], [/Bâțâială fină/gi, 'Râgâială fină'], [/Aia e [sS]ânul meu/gi, 'Ăla e sânul meu'], 
        [/ție datorităție/gi, 'datorită ție'], [/îndoaie-te cu toate astea/gi, 'servește-te cu toate astea'],
        [/cuțitul de pernă/gi, 'cuțitul de sub pernă'], [/și-a predat în sfârșit pantofii/gi, 'a dat ortul popii'],
        [/Atunci\s+spune[tț]i\s+c[aă][\s.,]+(Glumi[tț]i|Jumi[tț]i|Jeta[tț]i|Jre[tț]i|Jne|[Jj]ă)\.?/gi, 'Atunci spuneți că vă pare rău.'],
        [/Trebuie\s+să\s+mă\s+(prefac|fac)\s+parcă\s+nu\s+s-a\s+întâmplat/gi, 'Trebuie să mă prefac că nu s-a întâmplat'],
        [/parcă\s+nu\s+țțineam\s+brațele\s+lui\s+Robin\s+în\s+mâinile\s+mele/gi, 'că nu țineam brațele lui Robin în mâinile mele'],
        [/țțineam/gi, 'țineam'], [/Țțineam/g, 'Țineam'], [/mă fac că nu/gi, 'mă prefac că nu'], [/prefac parcă/gi, 'prefac de parcă'], 
        [/spune[tț]i\s+c[aă]\s+[îÎ]ți\s+pare/gi, 'spuneți că vă pare'], [/\b1(?=[a-zăâîșțĂÂÎȘȚ]{2,})/gi, ''], [/man spui/gi, 'îmi spui'], 
        [/Fă-ca acasă/gi, 'Simte-te ca acasă'], [/ât ai clipi/gi, 'cât ai clipi'], [/să veimă mănânci/gi, 'să mănânci'], [/ești nevoie/gi, 'este nevoie'],
        [/să fi ratat-o/gi, 'să fi ratat'], [/Mă pornesc la trei/gi, 'Pornesc la trei'], [/nu toată binevenită/gi, 'nu tocmai binevenită'],
        [/,\s*,/g, ','], [/\s+,/g, ','], [/\s+\?/g, '?'], [/\s+\./g, '.'], [/ +/g, ' '], [/[^\u0000-\u024F\u2000-\u206F\u2E00-\u2E7F\n\r]/g, ""]
    ];
    phraseReps.forEach(([s, r]) => { text = text.replace(s, r); });

    if (text.trim() === '') return ' '; 
    let finalLines = text.split('\n').map(l => l.trim()).filter(l => l !== '');
    let wrappedLines = [];
    for (let line of finalLines) {
        if (line.length <= 45) wrappedLines.push(line);
        else {
            let mid = Math.floor(line.length / 2), ls = line.lastIndexOf(' ', mid), rs = line.indexOf(' ', mid);
            let si = (ls !== -1 && rs !== -1) ? ((mid - ls) <= (rs - mid) ? ls : rs) : (ls !== -1 ? ls : rs !== -1 ? rs : -1);
            if (si !== -1) { wrappedLines.push(line.substring(0, si).trim()); wrappedLines.push(line.substring(si + 1).trim()); }
            else wrappedLines.push(line);
        }
    }
    return wrappedLines.map(l => l.replace(/^[-—–−]+\s*/g, '')).join('\n');
}

function fixBrokenJson(text) {
    return text.replace(/"(\d+)":\s*([^",}\n]+)([,}\n])/g, (m, k, v, t) => {
        let cv = v.trim();
        return (!cv.startsWith('"')) ? `"${k}": "${cv.replace(/^b['"]|['"]$/g, '')}"${t}` : m;
    });
}

let globalRateLimitPause = 0;

async function processChunkWithRetry(chunkObjArray, globalChunkIndex, totalChunks, keyState) {
    let keysToTranslate = {};
    chunkObjArray.forEach(obj => keysToTranslate[obj.id] = obj.text);
    let finalTranslatedDict = {};
    let expectedTotalCount = Object.keys(keysToTranslate).length;
    let attempts = 0, contentErrorCount = 0; 
    const maxAttempts = 15; 

    while (Object.keys(keysToTranslate).length > 0 && attempts < maxAttempts) {
        let batchToProcess = {};
        const allKeys = Object.keys(keysToTranslate);
        
        if (contentErrorCount >= 2 && allKeys.length > 5) {
            console.log(`${c.yellow}⚠ [Gemini] Calupul ${globalChunkIndex + 1} pare blocat. Îl împart...${c.reset}`);
            for (let i = 0; i < Math.floor(allKeys.length / 2); i++) batchToProcess[allKeys[i]] = keysToTranslate[allKeys[i]];
            contentErrorCount = 0; 
        } else {
            batchToProcess = Object.assign({}, keysToTranslate);
        }

        while (Date.now() < globalRateLimitPause) await new Promise(r => setTimeout(r, 1000));

        let currentKeyObj = null, keyIndex = -1, apiKey = null;
        while (true) {
            let availableIndices = keyState.keys.map((k, i) => Date.now() >= k.pauseUntil ? i : -1).filter(i => i !== -1);
            if (availableIndices.length > 0) {
                keyIndex = availableIndices[Math.floor(Math.random() * availableIndices.length)];
                currentKeyObj = keyState.keys[keyIndex];
                apiKey = currentKeyObj.value;
                currentKeyObj.pauseUntil = Date.now() + 1500;
                break;
            }
            await new Promise(r => setTimeout(r, 1000));
        }

        // MODELUL CORECT CARE ȘTIM SIGUR CĂ MERGE PENTRU TINE
        const modelName = 'gemini-3.5-flash-lite'; 
        let currentBatchSize = Object.keys(batchToProcess).length;

        try {
            if (currentBatchSize === expectedTotalCount) console.log(`${c.cyan}➤ [Gemini] Traduc calup ${globalChunkIndex + 1}/${totalChunks} (Model: ${modelName} | Cheie: ${keyIndex})...${c.reset}`);
            else console.log(`${c.magenta}↻ [Gemini] Recuperez ${currentBatchSize} linii pentru calupul ${globalChunkIndex + 1}...${c.reset}`);
            
            // PROMPTUL VECHI ȘI STABIL
            const prompt = `Translate the following English subtitles into natural, conversational Romanian.
RULES:
1. DIACRITICS, SPELLING & GRAMMAR (CRITICAL): Use correct Romanian diacritics (ă, â, î, ș, ț). Ensure PERFECT Romanian spelling and grammar. Use standard, dictionary-approved vocabulary.
2. GENDER BLINDNESS: You cannot see the video. To avoid gender mistakes for "I", use neutral phrasing ("Mi-am primit banii" instead of "Am fost plătit/plătită").
3. TV BROADCAST CENSORSHIP (CRITICAL): To prevent safety blocks, DO NOT translate extreme swear words literally. Soften vulgarities to PG-13 TV standards. Preserve the scene's tension but maintain civilized language. Omit swear words entirely if they are just filler words.
4. IDIOMS & SLANG: "Why do I give a shit?" = "Ce-mi pasă mie?". "Man" = "omule". "Stop doing X" = "Nu mai face X". Do NOT translate "fucking looking" as "fute ochiul", use "te holbezi".
5. NOISES, HESITATIONS & STUTTERS: Completely remove audio tags like [music]. Completely remove ALL hesitations, stutters, and interjections (e.g., Oh, Ah, Uh, Ăă, hă) from EVERYWHERE in the sentence.
6. NO DIGITS IN WORDS: Never put numbers inside words. 
7. STRICT ACCURACY (CRITICAL): DO NOT invent words (e.g. do not write 'unzn' instead of 'un'). DO NOT skip letters. DO NOT replace the letter 'L' with the number '1' (e.g. write 'l-ar', never '1-ar'). Check your spelling carefully before outputting the JSON.
8. FORMAT: You MUST reply ONLY with a valid JSON object. Keep the exact same keys as the input. Do NOT add extra text.

Input JSON:
${JSON.stringify(batchToProcess)}`;

            const response = await axios.post(
                `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`,
                { contents: [{ parts: [{ text: prompt }] }], generationConfig: { response_mime_type: "application/json", temperature: 0.1 }, safetySettings: [{ category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" }, { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" }, { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" }, { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }] },
                { headers: { 'Content-Type': 'application/json' }, timeout: 120000 }
            );

            if (!response.data?.candidates?.[0]?.content) throw new Error(response.data?.promptFeedback?.blockReason ? `Filtrat de Google (${response.data.promptFeedback.blockReason})` : "Răspuns invalid sau gol");

            let textResponse = response.data.candidates[0].content.parts[0].text;
            let startIndex = textResponse.indexOf('{'), endIndex = textResponse.lastIndexOf('}');
            if (startIndex !== -1 && endIndex !== -1) textResponse = textResponse.substring(startIndex, endIndex + 1);

            let parsedDict = {};
            try { parsedDict = JSON.parse(fixBrokenJson(textResponse)); } 
            catch (e) {
                const keys = Object.keys(batchToProcess);
                for (let i = 0; i < keys.length; i++) {
                    const regex = new RegExp(`"?${keys[i]}"?\\s*:\\s*(.*?)(?=${keys[i + 1] ? `\\s*,?\\s*"?(?:${keys[i + 1]})"?\\s*:\vert{}\\s*\\}\vert{}$)` : `\\s*\\}|$)`}`, 's');
                    const match = textResponse.match(regex);
                    if (match) {
                        let val = match[1].trim();
                        if (val.endsWith(',')) val = val.substring(0, val.length - 1).trim();
                        val = val.replace(/^["']|["']$/g, '').replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\'/g, "'");
                        parsedDict[keys[i]] = val.trim();
                    }
                }
            }

            let newlyTranslatedCount = 0;
            for (let key in parsedDict) {
                if (keysToTranslate[key] !== undefined) {
                    finalTranslatedDict[key] = parsedDict[key];
                    delete keysToTranslate[key]; newlyTranslatedCount++;
                }
            }

            if (newlyTranslatedCount === 0) throw new Error("Nu a extras nicio linie validă.");
            else { attempts = 0; contentErrorCount = 0; }

            if (Object.keys(keysToTranslate).length === 0) {
                console.log(`${c.green}✔ [Gemini] Calup ${globalChunkIndex + 1}/${totalChunks} finalizat!${c.reset}`); break; 
            } 

        } catch (error) {
            attempts++;
            if (attempts >= maxAttempts) { console.log(`${c.red}✖ [Gemini] Limita atinsă (calup ${globalChunkIndex + 1}). Abandon!${c.reset}`); break; }

            let errMsg = error.response?.data?.error?.message || error.message || "";
            let status = error.response?.status;

            if (status === 429) {
                currentKeyObj.pauseUntil = Date.now() + 61000;
                globalRateLimitPause = Math.max(globalRateLimitPause, Date.now() + 10000);
                let sleepTime = Math.floor(10000 + Math.random() * 5000);
                console.log(`${c.yellow}⚠ [Gemini] 429! Cheia ${keyIndex} pe bancă. Aștept ${(sleepTime/1000).toFixed(1)}s${c.reset}`);
                await new Promise(r => setTimeout(r, sleepTime));
            } else if (status === 503) {
                console.log(`${c.yellow}⚠ [Gemini] 503 Server Google ocupat. Reîncercare (${attempts}/${maxAttempts})...${c.reset}`);
                await new Promise(r => setTimeout(r, 2000));
            } else if (status === 400 || status === 403 || status === 404) {
                console.log(`${c.red}✖ [EROARE GOOGLE] Status ${status}: ${errMsg}${c.reset}`);
                contentErrorCount++; await new Promise(r => setTimeout(r, 2000));
            } else if (errMsg.toLowerCase().includes('timeout')) {
                console.log(`${c.yellow}⚠ [Gemini] Timeout. Reîncercare (${attempts}/${maxAttempts})...${c.reset}`);
                await new Promise(r => setTimeout(r, 2000));
            } else {
                contentErrorCount++;
                console.log(`${c.magenta}⚠ [Gemini] Eroare format/cenzură. Reîncercare (${attempts}/${maxAttempts})...${c.reset}`);
                await new Promise(r => setTimeout(r, 1000));
            }
        }
    }
    return chunkObjArray.map(obj => finalTranslatedDict[obj.id] !== undefined ? finalTranslatedDict[obj.id] : obj.text);
}

async function translateSrtWithGemini(srtText, userKeys) {
    const parser = new Parser(); const blocks = parser.fromSrt(srtText);
    const textsToTranslate = blocks.map((b, i) => ({ id: i, text: cleanTextForJson(b.text) }));
    const chunks = chunkArray(textsToTranslate, 165);
    let allTranslatedTexts = [];
    const keyState = { keys: userKeys.map(k => ({ value: k, pauseUntil: 0 })), index: 0 };

    for (let i = 0; i < chunks.length; i += 3) {
        const batchPromises = chunks.slice(i, i + 3).map((chunk, idx) => processChunkWithRetry(chunk, i + idx, chunks.length, keyState));
        (await Promise.all(batchPromises)).forEach(res => allTranslatedTexts.push(...res));
    }

    blocks.forEach((block, index) => {
        let finalStr = allTranslatedTexts[index];
        block.text = formatSubtitleLine(finalStr === undefined || finalStr === null ? block.text : finalStr);
    });
    return parser.toSrt(blocks);
}
