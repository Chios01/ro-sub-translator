const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const dns = require('dns').promises;
const net = require('net');
const { AsyncLocalStorage } = require('async_hooks');

// Asociază logurile fiecărei traduceri cu titlul corect și ascunde mesajele de
// succes repetitive. Erorile API, retry-urile importante și QA-ul final rămân vizibile.
const translationLogContext = new AsyncLocalStorage();
const nativeConsoleLog = console.log.bind(console);
function getPlainLogMessage(args) {
    return args.map(value => typeof value === 'string' ? value : String(value ?? ''))
        .join(' ').replace(/\x1b\[[0-9;]*m/g, '').trim();
}
function recordRoutineTranslationMetrics(args, ctx) {
    if (!ctx) return;
    if (!ctx.routineMetrics) ctx.routineMetrics = { automatedInterventions: 0 };
    const message = getPlainLogMessage(args);
    const add = value => { ctx.routineMetrics.automatedInterventions += Math.max(0, Number(value) || 0); };
    let match;
    if ((match = message.match(/\[POST-CHECK\] Încheiat; (\d+) corectări aplicate\./))) add(match[1]);
    else if ((match = message.match(/✔ \[Grammar Review\] Verificarea s-a încheiat; (\d+) corectări aplicate\./))) add(match[1]);
    else if ((match = message.match(/\[GRAMATICĂ\] Verificare locală încheiată; (\d+) corecții directe aplicate\./))) add(match[1]);
    else if ((match = message.match(/✔ \[Continuări\] (\d+) fragmente continuate au primit literă mică la început\./))) add(match[1]);
    else if ((match = message.match(/\[RETRY FINAL\] (\d+) replici reparate\./))) add(match[1]);
    else if ((match = message.match(/✔ \[Quality Retry\] (\d+) verificate punctual, (\d+) corectate\./))) add(match[2]);
    else if ((match = message.match(/\[Quality Recheck\] (\d+) reverificate, (\d+) corectate la a doua verificare\./))) add(match[2]);
    else if ((match = message.match(/\[Final Repair\] Verificare finală încheiată; (\d+) corectări aplicate\./))) add(match[1]);
}
function shouldSuppressRoutineTranslationLog(args) {
    const message = getPlainLogMessage(args);
    if (!message) return true;
    const ctx = translationLogContext.getStore();
    // Nu filtrăm logurile normale ale serverului, doar zgomotul dintr-o traducere.
    if (!ctx || !ctx.mediaId) return false;

    // Aceste două statusuri sunt operațional importante și nu se ascund niciodată.
    if (/\b(?:429|503)\b|status code (?:429|503)/i.test(message)) return false;

    // Păstrăm progresul fiecărui calup și raportul final de integritate.
    if (/➤ \[Gemini\] Traduc calup \d+\/\d+\.\.\.|✔ \[Gemini\] Calup \d+\/\d+ finalizat!|\[QA FINAL\]|\[DONE\]|ID-uri fără traducere|\[SRT\] Sursă:/i.test(message)) return false;

    // Pași normali/rezultate fără valoare operațională: sumarul numeric apare la final.
    const routinePatterns = [
        /\[Gemini\] Calupuri inițiale finalizate:/,
        /✔ \[Gemini Control\] 3 cereri reușite; concurența crește controlat/,
        /\[POST-CHECK\] Verificare contextuală după finalizarea calupurilor/,
        /\[POST-CHECK\] Încheiat; \d+ corectări aplicate\./,
        /✔ \[Grammar Review\] Calup \d+\/\d+: \d+ corectate/,
        /✔ \[Grammar Review\] Verificarea s-a încheiat; \d+ corectări aplicate\./,
        /🎯 VERIFICARE PUNCTUALĂ — GRAMATICĂ \+ TRADUCERE/,
        /📝 VERIFICARE SUPLIMENTARĂ — GRAMATICĂ \+ TRADUCERE/,
        /^Verificate: \d+ replici$/,
        /✔ \[Continuări\] \d+ fragmente continuate au primit literă mică la început\./,
        /\[GRAMATICĂ\] Verificare locală încheiată; \d+ corecții directe aplicate\./,
        /\[Semantic Spot Check\] Verificare punctuală încheiată\./,
        /\[RETRY FINAL\] \d+ replici reparate\./,
        /✔ \[Quality Retry\] Nicio replică nu a declanșat verificarea AI punctuală/,
        /✔ \[Quality Retry\] \d+ verificate punctual, \d+ corectate\./,
        /\[Final Repair\] Corectare contextuală finală pentru \d+ replici candidate/,
        /\[Final Repair\] Verificare finală încheiată;/,
        /✔ \[Aliniere\].*(?:finalizat|nu mai detectează decalarea inițială)/,
        /\[(?:(?:Final )?(?:Calup \d+ )?)?Empty Recovery Retry\] ID \d+ (?:respins|nerecuperat|recuperat|a eșuat)/,
        /\[(?:Final )?Empty Recovery\] ID \d+ respins:/,
        /\[Final Empty Recovery\].*(?:Toate cele \d+ traduceri goale au fost recuperate local|Nu repet retry-ul individual|Rămase goale după încercările anterioare|Recuperate:)/i,
        /\[Empty Recovery\].*(?:traduceri goale detectate|replici nu au potrivire locală sigură|Gemini omis:|Recuperate:)/i,
        /\[Gemini\] Calupul \d+: \d+ ID-uri (?:lipsă sau cu traducere goală|încă goale)|\[Gemini\] Calupul \d+: rămân \d+ traduceri goale/,
        /\[QA FINAL\] Verificările de după traducere s-au încheiat\./,
        /\[Gemini Diagnostic\] 429:/
    ];

    // În timpul traducerii, afișăm erori de cotă/serviciu 429 și 503; celelalte
    // avertismente de etape interne sunt sintetizate în QA FINAL, ca să nu înece Render.
    if (/(?:⚠|✖|\bERROR\b|\bfailed\b|\beșuat\b|\beroare\b|\btimeout\b|\btimed out\b|\binvalid JSON\b)/i.test(message)) return true;
    return routinePatterns.some(pattern => pattern.test(message));
}
console.log = (...args) => {
    const ctx = translationLogContext.getStore();
    recordRoutineTranslationMetrics(args, ctx);
    if (shouldSuppressRoutineTranslationLog(args)) return;
    if (ctx && ctx.mediaId) nativeConsoleLog(`[${ctx.mediaId}]`, ...args);
    else nativeConsoleLog(...args);
};

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
const CONCURRENCY_LIMIT = 3;

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
// MEMORY CACHE & SECRET ARCHIVE (MAX 30 ELEMENTE)
// ============================================================

const memoryCache = new Map();
const secretArchive = [];

// Textul englez sursă, păstrat temporar ca să poată fi descărcat din arhivă (comparație calitate).
const originalSources = Object.create(null);
const mediaTitleCache = Object.create(null);

// Rezolvă numele filmului/serialului din Cinemeta pentru antetul de început.
// Dacă metadatele lipsesc, traducerea continuă folosind ID-ul.
async function fetchMediaTitle(mediaId) {
    const rawId = String(mediaId || '').trim();
    const match = rawId.match(/^(tt\d+)(?::\d+(?::\d+)?)?$/i);
    if (!match) return '';

    const baseId = match[1];
    const mediaType = rawId.includes(':') ? 'series' : 'movie';
    const cacheKey = `${mediaType}:${baseId}`;
    if (Object.prototype.hasOwnProperty.call(mediaTitleCache, cacheKey)) {
        return mediaTitleCache[cacheKey];
    }

    try {
        const response = await axios.get(
            `https://v3-cinemeta.strem.io/meta/${mediaType}/${baseId}.json`,
            { timeout: 2500, headers: { 'User-Agent': BROWSER_USER_AGENT } }
        );
        const meta = response.data?.meta || response.data?.item?.meta || {};
        const title = String(meta.name || meta.title || '')
            .replace(/[\r\n\t]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        mediaTitleCache[cacheKey] = title;
        return title;
    } catch (_) {
        // O eroare la preluarea numelui nu trebuie să oprească traducerea.
        mediaTitleCache[cacheKey] = '';
        return '';
    }
}

function logTranslationStart(mediaId, mediaTitle) {
    const headline = '🎬 ÎNCEPE TRADUCEREA';
    const cleanId = String(mediaId || 'ID necunoscut')
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    const cleanTitle = String(mediaTitle || '')
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    const details = cleanTitle ? `${cleanId} — ${cleanTitle}` : cleanId;

    // Delimitare compactă, cu o singură linie înainte și una după antet.
    // Separatorul este suficient de scurt ca să nu se rupă pe ecranele înguste.
    const divider = '\x1b[90m────────────────────────────────────\x1b[0m';
    console.log(divider);
    console.log(`\x1b[96m${headline}\x1b[0m`);
    console.log(`\x1b[93m${details}\x1b[0m`);
    console.log(divider);
}
function rememberOriginalSource(key, text) {
    originalSources[key] = text;
    const keys = Object.keys(originalSources);
    if (keys.length > 12) {
        for (let i = 0; i < keys.length - 12; i++) delete originalSources[keys[i]];
    }
}

// Returnează o intrare și o mută la finalul Map-ului pentru o ordine LRU simplă.
function getMemoryCacheEntry(key) {
    if (!memoryCache.has(key)) return undefined;
    const value = memoryCache.get(key);
    memoryCache.delete(key);
    memoryCache.set(key, value);
    return value;
}

// Limitează cache-ul la 30 de rezultate finalizate. Promisiunile active nu sunt
// evacuate: altfel o cerere identică ar putea porni o a doua traducere Gemini.
// protectedKey este păstrată în timpul curățării pentru a nu elimina tocmai
// rezultatul accesat sau finalizat cel mai recent.
function cleanMemoryCache(protectedKey = null) {
    if (memoryCache.size <= 30) return;

    for (const [key, value] of memoryCache) {
        if (memoryCache.size <= 30) break;
        if (key === protectedKey) continue;
        if (typeof value === 'string') {
            memoryCache.delete(key);
        }
    }
}

// ============================================================
// MANIFEST
// ============================================================

const manifest = {
    id: 'community.chios.geminitranslator',
    version: '12.78.158',
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

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>\"']/g, character => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '\"': '&quot;',
        "'": '&#39;'
    })[character]);
}

// ID-ul este folosit și în numele fișierului atașat. Păstrăm doar caractere
// sigure pentru un nume portabil și evităm caractere de control/header injection.
function safeAttachmentId(value) {
    const safe = String(value ?? 'subtitle')
        .replace(/[^a-zA-Z0-9._:-]/g, '_')
        .replace(/\.{2,}/g, '.')
        .slice(0, 100);
    return safe || 'subtitle';
}

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
                <strong style="color:#0bf;">ID: ${escapeHtml(item.id)}</strong> <span style="color:#888; font-size:0.9em;">(${escapeHtml(item.time)})</span><br><br>
                <a href="/download-srt/${index}" style="background:#0bf; color:#000; text-decoration:none; padding:8px 12px; border-radius:4px; font-weight:bold;">Descarcă fișier .srt</a>
                ${item.original ? `<a href="/download-srt-en/${index}" style="background:#555; color:#fff; text-decoration:none; padding:8px 12px; border-radius:4px; font-weight:bold; margin-left:8px;">Original (EN)</a>` : ''}
            </li>`;
        });
        html += '</ul>';
    }
    html += '</body></html>';
    res.send(html);
});

app.get('/download-srt-en/:index', (req, res) => {
    const index = parseInt(req.params.index);
    if (isNaN(index) || !secretArchive[index] || !secretArchive[index].original) {
        return res.status(404).send('Originalul nu există sau a fost șters automat din memorie.');
    }
    const item = secretArchive[index];
    res.setHeader('Content-disposition', `attachment; filename="EN_${safeAttachmentId(item.id)}.srt"`);
    res.setHeader('Content-type', 'text/plain; charset=utf-8');
    res.send(item.original);
});

app.get('/download-srt/:index', (req, res) => {
    const index = parseInt(req.params.index);
    if (isNaN(index) || !secretArchive[index]) {
        return res.status(404).send('Fișierul nu există sau a fost șters automat din memorie.');
    }
    const item = secretArchive[index];
    res.setHeader('Content-disposition', `attachment; filename="RO_${safeAttachmentId(item.id)}.srt"`);
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
        }).slice(0, 35); 

        if (engSubs.length === 0) {
            console.log(`${c.yellow}⚠ Nu s-au găsit subtitrări sursă EN pentru: ${id}${c.reset}`);
            return res.json({ subtitles: [] });
        }

        let diverseSubs = [];
        const trashRegex = /korsub|kor\.sub|hdcam|hd-ts|hdts|camrip|telesync|telecine|hardcoded|hc-eng|hc-sub|hc\.\w+|1xbet/i;

        engSubs.forEach((sub, idx) => {
            let realName = sub.title || sub.id || `Varianta_${idx + 1}`;
            if (!trashRegex.test(realName)) {
                diverseSubs.push({ originalUrl: sub.url, realName, index: idx, sourceData: sub });
            }
        });

        const fNameLower = userFilename.toLowerCase();

        // ============================================================
        // RANKING SUBTITRARE (Îmbunătățit cu Cuts/Editions/IMAX/PROPER)
        // ============================================================
        const normalizeReleaseName = (name) => String(name || '')
            .toLowerCase()
            .replace(/[._-]+/g, ' ')
            .replace(/\b(web[-. ]?dl|web[-. ]?rip)\b/g, ' web ')
            .replace(/\b(bluray|blu[-. ]?ray|brrip|bdrip|bdr)\b/g, ' bluray ')
            .replace(/\b(2160p|4k|uhd)\b/g, ' 2160p ')
            .replace(/\b(1080p)\b/g, ' 1080p ')
            .replace(/\b(720p)\b/g, ' 720p ')
            .replace(/\b(480p|576p|sd)\b/g, ' sd ')
            .replace(/\s+/g, ' ')
            .trim();

        const getMetaText = (sub) => {
            const data = sub && sub.sourceData ? sub.sourceData : {};
            const preferredKeys = [
                'movieReleaseName', 'releaseName', 'releaseGroup', 'releaseFormat',
                'movieRelease', 'release', 'name', 'title', 'filename', 'fileName',
                'source', 'sourceName', 'provider', 'group', 'format', 'tags'
            ];
            const parts = [sub && sub.realName ? sub.realName : ''];
            for (const key of preferredKeys) {
                const value = data[key];
                if (value !== undefined && value !== null && String(value).trim()) {
                    parts.push(String(value));
                }
            }
            return normalizeReleaseName(parts.join(' '));
        };

        const videoName = normalizeReleaseName(fNameLower);

        const extractSeasonEpisode = (name) => {
            const m = String(name || '').match(/\bs(\d{1,2})e(\d{1,2})\b/i);
            return m ? `s${m[1]}e${m[2]}` : '';
        };

        const extractReleaseGroup = (name) => {
            const raw = String(name || '').replace(/\.[a-z0-9]{2,4}$/i, '');
            const bracket = raw.match(/\[([^\]]+)\](?:\s*)$/);
            if (bracket) return bracket[1].trim().toLowerCase();

            const tokens = normalizeReleaseName(raw).split(' ').filter(Boolean);
            const stop = new Set([
                'the','boys','season','episode','instant','white','hot','wild','series',
                '2160p','1080p','720p','480p','576p','sd','web','bluray','x264','x265',
                'h264','h265','hevc','avc','10bit','8bit','aac','ac3','eac3','ddp',
                'dd','5','1','2','0','1ch','2ch','5ch','6ch','7ch','hdr','hdr10','dv',
                'dolby','vision','amzn','amazon','nf','netflix','dsnp','disney','hulu','max',
                'webrip','brrip','bdrip','bdr','torrentgalaxy','mkv','mp4','avi',
                'proper','repack','rerip','extended','unrated','theatrical','remastered','director','directors','cut','imax'
            ]);
            const technical = /^(s\d{1,2}e\d{1,2}|19\d{2}|20\d{2}|\d{1,4}p|x\d+|h\d+|\d+bit|\d+(?:\.\d+)?ch?)$/i;
            const candidates = tokens.filter(t => !stop.has(t) && !technical.test(t));
            return candidates.length ? candidates[candidates.length - 1] : '';
        };

        const detectFamily = (name) => {
            const n = ` ${normalizeReleaseName(name)} `;
            if (/\bbluray\b/.test(n)) return 'bluray';
            if (/\bweb\b/.test(n) || /\b(amzn|amazon|nf|netflix|dsnp|disney|hulu|max)\b/.test(n)) return 'web';
            if (/\bdvdrip\b|\bdvd\b/.test(n)) return 'dvd';
            if (/\bhdtv\b/.test(n)) return 'hdtv';
            return '';
        };

        const detectProviders = (name) => {
            const n = ` ${normalizeReleaseName(name)} `;
            const found = [];
            if (/\b(amzn|amazon)\b/.test(n)) found.push('amzn');
            if (/\b(nf|netflix)\b/.test(n)) found.push('nf');
            if (/\b(dsnp|disney)\b/.test(n)) found.push('dsnp');
            if (/\bhulu\b/.test(n)) found.push('hulu');
            if (/\bmax\b/.test(n)) found.push('max');
            return found;
        };

        const detectFlags = (name) => {
            const n = ` ${normalizeReleaseName(name)} `;
            return {
                hdr: /\bhdr\b/.test(n),
                hdr10: /\bhdr10\b/.test(n),
                dv: /\bdv\b|\bdolby\s+vision\b/.test(n),
                bit10: /\b10bit\b/.test(n),
                fps: (n.match(/\b(\d{2,3}(?:\.\d+)?)\s*fps\b/) || [])[1] || ''
            };
        };

        const extractEdition = (name) => {
            const n = ` ${normalizeReleaseName(name)} `;
            const match = n.match(/\b(extended|director'?s(?:\s*cut)?|unrated|theatrical|recut|special|ultimate|redux|final(?:\s*cut)?|roadshow|assembly|open\s*matte|tv(?:\s*cut)?|international|european|us|uk|cannes|alternative|remastered|anniversary|collector'?s|criterion|definitive|limited|workprint|imax)\b/i);
            return match ? match[1].replace(/['\s]/g, '').toLowerCase() : '';
        };

        const isProperOrRepack = (name) => {
            const n = ` ${normalizeReleaseName(name)} `;
            return /\b(proper|repack|rerip)\b/i.test(n);
        };

        const videoSeasonEpisode = extractSeasonEpisode(videoName);
        const videoFamily = detectFamily(videoName);
        const videoProviders = detectProviders(videoName);
        const videoGroup = extractReleaseGroup(fNameLower);
        const videoFlags = detectFlags(videoName);
        const videoResolution = (videoName.match(/\b(2160p|1080p|720p|sd)\b/) || [])[1] || '';
        const videoEdition = extractEdition(videoName);

        const countMeaningfulOverlap = (a, b) => {
            const ignore = new Set([
                'the','boys','season','episode','series','instant','white','hot','wild',
                'year','s03','s04','s05','mkv','mp4','avi',
                'proper','repack','rerip','imax','extended','unrated','theatrical','remastered',
                'director','directors','cut','special','edition'
            ]);
            const aTokens = [...new Set(String(a || '').split(/\s+/).filter(x => x.length > 2 && !ignore.has(x)))];
            if (!aTokens.length) return 0;
            const bSet = new Set(String(b || '').split(/\s+/));
            return aTokens.filter(t => bSet.has(t)).length / aTokens.length;
        };

        diverseSubs.forEach((s, originalOrder) => {
            const subName = getMetaText(s);
            const subData = s.sourceData || {};
            const subFamily = detectFamily(subName);
            const subProviders = detectProviders(subName);
            const subGroupRaw = String(subData.releaseGroup || subData.group || extractReleaseGroup(s.realName) || '').toLowerCase().trim();
            const subGroup = normalizeReleaseName(subGroupRaw);
            const subFlags = detectFlags(subName);
            const subResolution = (subName.match(/\b(2160p|1080p|720p|sd)\b/) || [])[1] || '';
            const subEpisode = extractSeasonEpisode(subName);
            const subEdition = extractEdition(subName);
            const subIsProper = isProperOrRepack(subName);
            const overlap = countMeaningfulOverlap(videoName, subName);

            s.score = 0;
            s._rankingOrder = originalOrder;

            if (videoSeasonEpisode && subEpisode === videoSeasonEpisode) s.score += 1400;
            else if (videoSeasonEpisode && subEpisode) s.score -= 700;

            if (videoEdition && subEdition) {
                if (videoEdition === subEdition) s.score += 1500;
                else s.score -= 2000; 
            } else if (videoEdition || subEdition) {
                s.score -= 400; 
            }

            if (subIsProper) {
                s.score += 50; 
            }

            if (videoFamily && subFamily) {
                if (videoFamily === subFamily) s.score += 1100;
                else s.score -= 1100;
            }

            if (videoProviders.length && subProviders.length) {
                const providerMatch = videoProviders.some(p => subProviders.includes(p));
                if (providerMatch) s.score += 700;
                else s.score -= 450;
            }

            if (videoGroup && subGroup) {
                if (subGroup === normalizeReleaseName(videoGroup)) s.score += 1300;
                else if (subGroup.includes(normalizeReleaseName(videoGroup)) || normalizeReleaseName(videoGroup).includes(subGroup)) s.score += 500;
            }

            if (videoFlags.hdr && subFlags.hdr) s.score += 220;
            if (videoFlags.dv && subFlags.dv) s.score += 220;
            if (videoFlags.bit10 && subFlags.bit10) s.score += 160;
            if (videoFlags.fps && subFlags.fps) {
                if (videoFlags.fps === subFlags.fps) s.score += 120;
                else s.score -= 60;
            }

            if (videoResolution && subResolution) {
                if (videoResolution === subResolution) s.score += 250;
                else s.score -= 80;
            }

            if (overlap >= 0.85) s.score += 500;
            else if (overlap >= 0.60) s.score += 300;
            else if (overlap >= 0.35) s.score += 120;

            if (/\bsdh\b|\bhi\b|hearing\s*impaired/i.test(subName)) s.score -= 80;
            if (/forced|machine|auto|translated|resync|re-sync|retime|syncfix/i.test(subName)) s.score -= 250;
        });

        diverseSubs.sort((a, b) => (b.score - a.score) || (a._rankingOrder - b._rankingOrder));
        diverseSubs = diverseSubs.slice(0, 15);
        

        // ============================================================
        // VIZUALIZARE UI STREMIO (ETICHETE DETALIATE)
        // ============================================================
        const generatedSubs = diverseSubs.map((s, index) => {
            const encodedUrl = encodeURIComponent(s.originalUrl);
            
            let vizualName = s.realName.replace(/[^a-zA-Z0-9.-]/g, ' ');
            const foundTags = [];
            
            // 1. Extragem Rezoluția
            const resMatch = vizualName.match(/\b(2160p|1080p|720p|4k|sd)\b/i);
            if (resMatch) foundTags.push(resMatch[1].toUpperCase());
            
            // 2. Extragem Sursa
            const sourceMatch = vizualName.match(/\b(bluray|web-dl|webrip|remux|hdtv)\b/i);
            if (sourceMatch) foundTags.push(sourceMatch[1].toUpperCase());
            
            // 3. Extragem Ediția, Fix-urile și Tehnologia (max 2-3 elemente ca să nu umplem ecranul)
            const extraMatch = vizualName.match(/\b(imax|proper|repack|extended|unrated|director'?s cut|hdr10|hdr|dv)\b/ig);
            if (extraMatch) {
                const uniqueExtras = [...new Set(extraMatch.map(t => t.toUpperCase().replace(/\s+/g, ' ')))];
                foundTags.push(...uniqueExtras.slice(0, 3));
            }

            let labelName = `🇷🇴 RO AI [${index + 1}]`;
            if (foundTags.length > 0) {
                labelName += ` • ${foundTags.join(' | ')}`;
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
// EMPTY SOURCE BLOCK PROTECTION
// Ignoră blocurile care conțin doar spații sau caractere invizibile
// (zero-width/BOM/formatting/mark-uri Unicode). Acestea nu reprezintă
// replici reale și nu trebuie să ajungă în pipeline-ul Gemini.
// ============================================================

function isEffectivelyEmptySubtitleText(text) {
    // Considerăm gol orice text format doar din whitespace, caractere de control/format,
    // semne Unicode invizibile SAU entități HTML care reprezintă astfel de caractere.
    // Verificarea este folosită doar pentru DETECTAREA GOLULUI; nu modifică textul real.
    let clean = String(text || '')
        .replace(/<[^>]+>/g, '');

    // Unele SRT-uri encodează spațiile/caracterele invizibile ca entități HTML.
    // Le decodăm doar în scopul detectării golului.
    clean = clean.replace(/&#x([0-9a-f]+);?/gi, (_, hex) => {
        const codePoint = Number.parseInt(hex, 16);
        return Number.isFinite(codePoint) && codePoint >= 0 && codePoint <= 0x10FFFF
            ? String.fromCodePoint(codePoint)
            : '';
    });

    clean = clean.replace(/&#(\d+);?/g, (_, decimal) => {
        const codePoint = Number.parseInt(decimal, 10);
        return Number.isFinite(codePoint) && codePoint >= 0 && codePoint <= 0x10FFFF
            ? String.fromCodePoint(codePoint)
            : '';
    });

    clean = clean
        .replace(/&(?:nbsp);?/gi, ' ')
        .replace(/&(?:zwsp|zwnj|zwj|lrm|rlm|shy|feff);?/gi, '')
        .replace(/[\p{C}\p{M}\s]/gu, '')
        .trim();

    return clean === '';
}

// ============================================================
// STANDALONE INTERJECTIONS / FILLERS
// ============================================================

const STANDALONE_SOURCE_FILLERS = new Set((
    // Vocalizări/reacții și marcatori de atenție folosiți ca umplutură; nu includem „ok/okay”
    // deoarece „Bine.” este un răspuns real, nu un sunet de umplutură. „Hey/Hei” se elimină
    // ca marcator de atenție; „na” se elimină ca tic conversațional, păstrând restul replicii.
    'aa aaaa aaa aaaaah aaaah aaah aah aargh agh ah a-ha aha ahem ahh ahhh argh aw aww awww bleah eh ehh ehhh ehm er erm err errr gah ha hahaha heh hm hmm hmmm hmph hoho hoo huh mh mhm mm mmhmm mm-hmm mmm mmmm mwah oh ohh ohhh oo ooh ooh-la-la oooh oof aâ aoleu oops ops ouch ow oww pf pff pfff pffft pfft phew pssh psst sh shh shhh ssh ssshh sst uf uff ugh ughh uh uh-oh uh-huh uhh uhhh uhm uhmm uhu uhuu um umm uu whew whoa whoo whoo-hoo woo-hoo whoop whoops whup wooh wow yikes yoo yoo-hoo haha hehe hey hei na ă ăă ăăă îhî ptiu brr'
).split(/\s+/));

function isOnlyStandaloneFillerSequence(text) {
    const clean = String(text || '').replace(/<[^>]*>/g, ' ').trim();
    if (!clean) return false;
    const normalized = clean
        .replace(/^[-–—\s]+/, '')
        .toLocaleLowerCase('ro-RO')
        .replace(/[.,!?;:…]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (!normalized) return false;
    const tokens = normalized.split(' ').filter(Boolean);
    return tokens.length > 0 && tokens.every(token => STANDALONE_SOURCE_FILLERS.has(token));
}

// Elimină reacțiile/vocalizările cunoscute oriunde apar în text, inclusiv în
// traducerea generată de AI. Păstrează cuvintele cu sens din aceeași replică.
// „ok/okay” sunt intenționat excluse: ca răspuns, se traduc natural prin „Bine.”.
// „hey/hei” și „na” sunt eliminate ca marcatori de umplutură; cuvintele următoare rămân.
function stripKnownInterjectionTokens(text, extraTokens = []) {
    let cleaned = String(text || '');
    // „Ha-Hai” este ezitare vocală alipită de cuvântul real „Hai”; păstrăm cuvântul.
    cleaned = cleaned.replace(/\b(?:ha|haha|heh|hehe)\s*[-–—]\s*(hai|haide)\b/giu, '$1');
    const allTokens = new Set([...STANDALONE_SOURCE_FILLERS, ...extraTokens]);
    const escapedTokens = Array.from(allTokens)
        .filter(token => token !== 'ok' && token !== 'okay')
        .sort((a, b) => b.length - a.length)
        .map(token => token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    // Variantele prelungite sunt prinse fără a folosi potriviri în interiorul cuvintelor.
    const variableSounds = [
        'ă+', 'a+h+', 'e+h+', 'u+h+', 'u+m+', 'o+h+', 'h+m+', 'm+h+m+',
        'm{2,}', 'w+o+w+', 'p+f+f+t*', 's+h+'
    ];
    const tokenPattern = [...variableSounds, ...escapedTokens].join('|');
    const re = new RegExp('(^|[,;:]\\s*|[.!?…]\\s*|\\s+)(?:' + tokenPattern + ')(?=$|[\\s,;:.!?…])[,;:.!?…]*', 'giu');
    const beforeTokenRemoval = cleaned;
    cleaned = cleaned.replace(re, (match, prefix, offset, whole) => {
        // Păstrează punctele de suspensie dacă tokenul eliminat este la finalul
        // unei replici întrerupte („Nu știu, na...” -> „Nu știu...”).
        const atEnd = offset + match.length >= whole.length;
        const terminalPunctuation = (match.match(/([.!?…]+)\s*$/) || [])[1] || '';
        const hasFollowingContent = offset + match.length < whole.length;
        // Dacă marcatorul era a doua replică după liniuță, eliminăm și separatorul
        // său și nu transferăm exclamația vocalizării în replica precedentă.
        if (atEnd && /(?:^|\s)[-–—]\s*$/.test(prefix)) return '';
        if (atEnd && terminalPunctuation) {
            if (/[,;:]\s*$/.test(prefix)) return ' ' + terminalPunctuation;
            return (prefix || '') + terminalPunctuation;
        }
        // Păstrăm granița dintre două propoziții când interjecția este între ele:
        // „Bine, uau. Ok...” -> „Bine. Ok...”, dar „Uau. Foarte...” -> „Foarte...”.
        if (hasFollowingContent && terminalPunctuation) {
            if (/[.!?…]\s*$/.test(prefix)) return prefix;
            if (!String(prefix || '').trim()) return '';
            return terminalPunctuation + ' ';
        }
        if (!prefix) return '';
        // Păstrează punctuația dinaintea tokenului, dar elimină separatorul
        // care lega interjecția de restul cuvintelor.
        if (/[.!?…]\s*$/.test(prefix)) return prefix;
        if (/[,;:]\s*$/.test(prefix)) return ' ';
        return prefix;
    });
    cleaned = cleaned
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/\s+([,;:.!?…])/g, '$1')
        .replace(/([,;:])\s*([,;:])/g, '$2')
        .replace(/[,;:]\s*([.!?…])/g, '$1')
        .replace(/\(\s*\)|\[\s*\]/g, '')
        .replace(/^\s+|\s+$/g, '');
    // Dacă eliminăm toată a doua replică după separator, nu lăsăm o liniuță orfană.
    if (cleaned !== beforeTokenRemoval) {
        cleaned = cleaned.replace(/\s+[-–—]\s*[.!?…]*\s*$/g, '').trim();
    }
    // O vocalizare izolată precum „Oh.” nu trebuie să lase un simplu punct,
    // care altfel ar face blocul să pară nenul și l-ar trimite inutil la Gemini.
    if (!/[\p{L}\p{N}]/u.test(cleaned)) return '';
    return cleaned;
}

// Interjecții românești pe care modelul le poate adăuga chiar dacă sursa a fost curățată.
// Sunt filtrate doar în textul-țintă, niciodată din sursa engleză: „of” este o prepoziție
// englezească foarte frecventă și nu trebuie eliminată din expresii precum „U of M”.
const ROMANIAN_OUTPUT_INTERJECTIONS = new Set(['vai', 'uau', 'păi']);

function stripRomanianOutputInterjections(text) {
    let cleaned = String(text || '');

    // „Mă rog...” folosit ca umplutură; nu atingem „mă rog la/pentru...” cu sens literal.
    cleaned = cleaned.replace(
        /(^|[.!?…]\s+)mă\s+rog(?=\s*(?:[,;:]|\.{2,}|[!?…]+|$))\s*(?:[,;:]|\.{2,}|[!?…]+)?/giu,
        '$1'
    );

    // „Vai de mine!” este o reacție completă, nu păstrăm fragmentul „de mine!”.
    cleaned = cleaned.replace(
        /(^|[.!?…]\s*)(?:vai|aoleu)\s+de\s+mine[.!?…]*/giu,
        '$1'
    );

    // „Of, ...” este o interjecție; nu atingem „of” în denumiri sau construcții ca „U of M”.
    cleaned = cleaned.replace(
        /(^|[.!?…;,]\s*)of(?=\s*[,;:!?…])[,;:!?…]*\s*/giu,
        '$1'
    );

    cleaned = stripKnownInterjectionTokens(cleaned, ROMANIAN_OUTPUT_INTERJECTIONS);
    cleaned = cleaned
        .replace(/^[\s,;:]+/, '')
        .replace(/[,;:]\s*([.!?…])/g, '$1')
        .replace(/([,;:])\s*([,;:])/g, '$2')
        .replace(/\s{2,}/g, ' ')
        .trim();

    // Dacă au rămas doar semne de punctuație după eliminarea vocalizărilor, blocul e gol.
    if (!cleaned || /^[-–—\s.,;:!?…'"’]+$/.test(cleaned)) return '';
    return cleaned;
}

function isOnlyStandaloneOutputInterjection(text) {
    const raw = String(text || '').trim();
    return raw.length > 0 && !stripRomanianOutputInterjections(raw).trim();
}

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

    clean = clean.replace(/<[iIbBuU]>\s*(?:ah|oh|uh|agh|aâ|aoleu|ăă|mhm|îhî|ugh|argh|aah|oof|uf)[!.,?\s-]*\s*<\/[iIbBuU]>/gi, '');
    clean = clean.replace(/<[iIbBuU]>\s*<\/[iIbBuU]>/gi, '');

    clean = clean.replace(/\[\s*[^\]]*?(râsete|murmur|șuierând|muzică|aplauze|urale|fluierături|muzica|music|sighs|cheering|applause|laughter|gasping|groaning|snorts|crying|screaming|shouts|cough|sniff|music|chuckles|pant|groan|sigh|chuckle|whisper)[^\]]*?\]/gi, '');
    clean = clean.replace(/\[[^\]]*?\]/g, '');
    clean = clean.replace(/\([^)]*?(râsete|murmur|muzică|aplauze|urale|fluierături|music|sighs|cheering|applause|laughs|laughing|laughter|gasping|groaning|snorts|crying|screaming|shouts|cough|sniff|chuckles|pant|groan|sigh|chuckle|whisper)[^)]*?\)/gi, '');
    // Nu eliminăm parantezele în mod global: pot conține dialog real (de ex. (I mean)).
    // Sunt eliminate doar parantezele care conțin indicații sonore, mai sus.

    // SubStudio curăță etichetele de vorbitor cu majuscule înainte de traducere.
    // Aplicăm aceeași idee strict la începutul unei linii și numai înainte de două puncte.
    clean = clean.replace(/(^|\n)(\s*[-–—]?\s*)[A-ZÀ-Ü][A-ZÀ-Ü0-9. \t]{1,27}:\s*/g, '$1$2');

    // Elimină o linie alcătuită numai din vocalizări ÎNAINTE de a curăța tokenurile;
    // altfel „Oh.” putea deveni temporar „.” și rămânea în lista trimisă lui Gemini.
    // Pe liniile care conțin și dialog, eliminăm doar tokenul și păstrăm textul util.
    clean = clean.split('\n').map(line => {
        if (isOnlyStandaloneFillerSequence(line)) return '';
        return stripKnownInterjectionTokens(line);
    }).join('\n');

    // Normalize spacing left behind after removed sound labels.
    clean = clean.replace(/[ \t]{2,}/g, ' ');

    // Eliminăm replicile alcătuite exclusiv din interjecții, inclusiv secvențe
    // precum „Um... hmm.”. Expresiile cu sens, de ex. „Oh my God”, rămân.
    let lines = clean.split('\n').map(l => l.trim()).filter(Boolean).filter(line => {
        return !isOnlyStandaloneFillerSequence(line);
    });
    clean = lines.join('\n');

    if (!clean.trim()) return ' ';
    return clean.trim();
}

// ============================================================
// FORMAT LINE & DICTIONARY
// ============================================================

function deepCleanSubtitleText(text) {
    if (!text) return text;
    
    let trimmed = text.trim();
    if (/^(-|\–|\—)(\s*(-|\–|\—))*$/g.test(trimmed)) return '';

    let cleaned = text.replace(/^<[^>]+>\s*(?:ah|oh|uh|agh|aâ|aoleu|ăă|mhm|îhî|ugh|argh|aah|oof|uf|shh|psst|sh|mwah|brr|ptiu)[!.,?\s-]*\s*<\/[^>]+>$/gmi, '');
    cleaned = cleaned.replace(/<[^>]+>/g, ' ');
    cleaned = stripKnownInterjectionTokens(cleaned);
    // Elimină bâlbâiala de tip „V-vin”, „M-mă”, „S-sunt” → „Vin”, „Mă”, „Sunt”.
    cleaned = cleaned.replace(/\b([A-Za-zĂÂÎȘȚăâîșț])-\1(?=[A-Za-zĂÂÎȘȚăâîșț])/gi, '$1');

    // Varianta foarte scurtă „E-E”, „A-A”, „M-M” etc.
    // Regex-ul de mai sus nu o prinde deoarece cere încă o literă după al doilea caracter.
    // Se elimină doar repetarea unei singure litere, nu cuvinte întregi.
    cleaned = cleaned.replace(
        /\b([A-Za-zĂÂÎȘȚăâîșț])\s*[-–—]\s*\1\b/gi,
        '$1'
    );

    // Elimină repetarea imediată a aceluiași cuvânt după o pauză: „o să... o să...” → „o să...”.
    cleaned = cleaned.replace(/\b([A-Za-zĂÂÎȘȚăâîșț]+(?:\s+[A-Za-zĂÂÎȘȚăâîșț]+)?)\s*\.{2,}\s*\1\b/gi, '$1...');

    cleaned = cleaned.replace(/[^\S\r\n]+/g, ' ');

    // După eliminarea unei ezitări, repară majuscula de început de propoziție.
    // Nu forța majuscula după „...” (propoziția continuă) și nici după abrevieri uzuale (dl., dna, nr., etc.).
    cleaned = cleaned.replace(/(^|(?<!\.)(?<!\b(?:[Dd]l|[Dd]na|[Dd]r|[Nn]r|[Ee]tc|[Ee]x))[.!?]\s+)([a-zăâîșț])/g, (m, prefix, letter) => prefix + letter.toUpperCase());
    
    if (/^(ah|oh|uh|agh|aâ|aoleu|ăă|ugh|argh|aah|oof|uf)[!.]*$/gmi.test(cleaned)) return '';
    if (/^[-–—\s.?!,;:'"]+$/.test(cleaned)) return '';

    cleaned = cleaned.replace(/\\+/g, ' ');
    cleaned = cleaned.replace(/\b(nu|de|ce|pe|la)1\b/gi, '$1');

    // Normalizează apostroful curb și semnul „…”, apoi păstrează ghilimelele românești „ ” și “ ”.
    cleaned = cleaned.replace(/[\u2018\u2019]/g, "'").replace(/\u2026/g, '...');
    cleaned = cleaned.replace(/[^\u0000-\u024F\u1E00-\u1EFF\s.,!?:;\-–—'"()\[\]<>\/\u201C\u201D\u201E]/g, '');
    // Nu eliminăm generic parantezele terminale: pot conține dialog real.
    // Indicațiile sonore sunt filtrate explicit mai sus, după conținut.

    if (!cleaned.trim()) return '';

    cleaned = cleaned.replace(/\bman-ar\b/gi, 'mi-ar');
    cleaned = cleaned.replace(/\bman-a\b/gi, 'mi-a');
    cleaned = cleaned.replace(/(?<![\p{L}\p{N}_])[Dd]e ce man pas[aă](?![\p{L}\p{N}_])/giu, m => m[0] === m[0].toLowerCase() ? 'de ce mi-ar păsa' : 'De ce mi-ar păsa');
    cleaned = cleaned.replace(/\b[Dd]e ce man-ar pasa\b/gi, 'De ce mi-ar păsa');
    cleaned = cleaned.replace(/\bDe ce man spui\b/gi, 'De ce îmi spui');
    cleaned = cleaned.replace(/\bLasă-man\b/gi, 'Lasă-mă');
    
    cleaned = cleaned.replace(/(?<![\p{L}\p{N}_])șă-i(?![\p{L}\p{N}_])/gu, 'să-i');
    cleaned = cleaned.replace(/(?<![\p{L}\p{N}_])Șă-i(?![\p{L}\p{N}_])/gu, 'Să-i');
    cleaned = cleaned.replace(/(?<![\p{L}\p{N}_])șă-ți(?![\p{L}\p{N}_])/gu, 'să-ți');
    cleaned = cleaned.replace(/(?<![\p{L}\p{N}_])Șă-ți(?![\p{L}\p{N}_])/gu, 'Să-ți');
    cleaned = cleaned.replace(/(?<![\p{L}\p{N}_])șă-și(?![\p{L}\p{N}_])/gu, 'să-și');
    cleaned = cleaned.replace(/(?<![\p{L}\p{N}_])Șă-și(?![\p{L}\p{N}_])/gu, 'Să-și');

    cleaned = cleaned.replace(/^[aA]?[,\s]*mi s-a plătit\.?/gi, 'Mi-am primit banii.');
    cleaned = cleaned.replace(/^[aA]?[,\s]*am fost plătit[aă]?\.?/gi, 'Mi-am primit banii.');
    cleaned = cleaned.replace(/(?<![\p{L}\p{N}_])distraggă(?![\p{L}\p{N}_])/giu, 'distragă');

    return cleaned;
}

function applyDeterministicSemanticFix(original, translation) {
    if (translation == null) return translation;

    const originalNorm = String(original || '')
        .toLowerCase()
        .replace(/[“”„”]/g, '"')
        .replace(/\s+/g, ' ')
        .trim();

    let text = String(translation);
    const textNorm = text.toLowerCase().replace(/\s+/g, ' ').trim();

    // Aceste corecții sunt intenționat STRICTE: se aplică numai când
    // originalul englezesc corespunde clar cazului deja verificat.
    if (/^get out of my head[.!?]*$/.test(originalNorm)) {
        if (/^ieși-mi din cap[.!?]*$/.test(textNorm) ||
            /^ieși din minte[.!?]*$/.test(textNorm)) {
            return 'Ieși din capul meu.';
        }
    }

    if (/^it['’]s a fucking oven in here[.!?]*$/.test(originalNorm)) {
        if (/^e un cuptor (?:dracului|al dracului|al naibii) aici[.!?]*$/i.test(textNorm)) {
            return 'E un cuptor al naibii aici.';
        }
    }

    if (/^and then we f(?:u|\*)cked to celebrate[.!?]*$/.test(originalNorm) ||
        /^and then we f(?:u|\*)\*{2,}t to celebrate[.!?]*$/.test(originalNorm)) {
        if (/^și pe urmă (?:am fut-o|am fumat-o|am f\*+ut|am f\*+t) ca să sărbătorim[.!?]*$/i.test(textNorm)) {
            return 'Și pe urmă ne-am futut ca să sărbătorim.';
        }
    }

    return text;
}

function splitSubtitleIntoTwoLines(value, maxChars = 43) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (!text) return [];
    if (text.length <= maxChars) return [text];

    const candidates = [];
    for (let i = 1; i < text.length - 1; i++) {
        if (text[i] !== ' ') continue;
        const left = text.slice(0, i).trim();
        const right = text.slice(i + 1).trim();
        if (!left || !right || left.length > maxChars || right.length > maxChars) continue;

        const leftLastWord = (left.match(/\S+$/) || [''])[0].toLowerCase();
        const rightFirstWord = (right.match(/^\S+/) || [''])[0].toLowerCase();
        let penalty = 0;
        if (/^(?:a|al|ai|ale|cu|de|din|în|la|lângă|pe|pentru|prin|să|și|un|o|ori|că|ca|îi|i|le|mi|ți|ne|vă)$/i.test(leftLastWord)) penalty += 8;
        if (/^(?:de|din|în|la|pe|pentru|și|să|cu|că|care|un|o)$/i.test(rightFirstWord)) penalty += 3;
        if (/[.!?…,:;]$/.test(left)) penalty -= 4;
        const balancePenalty = Math.abs(left.length - right.length) * 0.35;
        candidates.push({ left, right, score: balancePenalty + penalty });
    }
    if (candidates.length) {
        candidates.sort((a, b) => a.score - b.score);
        return [candidates[0].left, candidates[0].right];
    }

    // If the complete text is longer than two 43-character lines, a strict
    // 43/43 layout is mathematically impossible without rewriting or dropping
    // words. Keep exactly two balanced lines and preserve the full translation.
    const allBreaks = [];
    for (let i = 1; i < text.length - 1; i++) {
        if (text[i] !== ' ') continue;
        const left = text.slice(0, i).trim();
        const right = text.slice(i + 1).trim();
        if (!left || !right) continue;
        const leftLastWord = (left.match(/\S+$/) || [''])[0].toLowerCase();
        const penalty = /^(?:a|al|ai|ale|cu|de|din|în|la|pe|pentru|prin|să|și|un|o|că|ca)$/i.test(leftLastWord) ? 8 : 0;
        allBreaks.push({ left, right, score: Math.abs(left.length - right.length) + penalty });
    }
    if (allBreaks.length) {
        allBreaks.sort((a, b) => a.score - b.score);
        return [allBreaks[0].left, allBreaks[0].right];
    }
    return [text];
}

function formatSubtitleLayout(value) {
    const rawLines = String(value || '')
        .replace(/\r/g, '')
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean);
    if (!rawLines.length) return ' ';

    let entries = [];
    for (const raw of rawLines) {
        // Split inline two-speaker dialogue even when the first speaker already
        // has a leading dash. A separator after completed sentence punctuation
        // is required so ordinary hyphenated prose is not split accidentally.
        const prefixedDoubleDialogue = raw.match(/^\s*[-–—]\s*(.+?[.!?…])\s+[-–—]\s*(.+)$/);
        if (prefixedDoubleDialogue) {
            entries.push({ text: prefixedDoubleDialogue[1].trim(), dialogue: true });
            entries.push({ text: prefixedDoubleDialogue[2].trim(), dialogue: true });
            continue;
        }
        const inlineDialogue = raw.match(/^\s*(.+?[.!?…])\s+[-–—]\s+(.+)$/);
        if (inlineDialogue) {
            entries.push({ text: inlineDialogue[1].trim(), dialogue: true });
            entries.push({ text: inlineDialogue[2].trim(), dialogue: true });
            continue;
        }

        // Preserve a speaker marker if present. Normalize it to "- " and use
        // a capital letter after the dash, as required by SubStudio formatting.
        const marked = raw.match(/^[-–—]+\s*(.*?)\s*$/);
        if (marked && marked[1]) {
            entries.push({ text: marked[1].trim(), dialogue: true });
            continue;
        }
        entries.push({ text: raw, dialogue: false });
    }

    // If the model produces more than two lines, keep the complete content and
    // compact the overflow into the second line instead of silently truncating it.
    if (entries.length > 2) {
        const first = entries[0];
        const remainder = entries.slice(1).map(entry => entry.dialogue ? `- ${entry.text}` : entry.text).join(' ');
        entries = [first, { text: remainder, dialogue: false }];
    }

    const capFirst = value => String(value || '').replace(/^([a-zăâîșț])/u, ch => ch.toLocaleUpperCase('ro-RO'));
    const emit = entry => entry.dialogue ? `- ${capFirst(entry.text)}` : entry.text;

    if (entries.length === 1) {
        const entry = entries[0];
        if (entry.dialogue) {
            const parts = splitSubtitleIntoTwoLines(entry.text, 41);
            if (parts.length === 2) return `- ${capFirst(parts[0])}\n${parts[1]}`;
            return `- ${capFirst(parts[0])}`;
        }
        return splitSubtitleIntoTwoLines(entry.text, 43).join('\n') || ' ';
    }

    // Two explicit speaker lines must stay two speaker lines; never remove the
    // dashes or wrap them into extra lines. The translation prompt asks the model
    // to rephrase overly long dialogue before returning it.
    if (entries.length === 2 && entries.every(entry => entry.dialogue)) {
        return entries.map(emit).join('\n');
    }

    if (entries.length === 2 && entries.some(entry => entry.dialogue)) {
        return entries.map(emit).join('\n');
    }

    if (entries.every(entry => entry.text.length <= 43)) {
        return entries.map(entry => entry.text).join('\n');
    }
    return splitSubtitleIntoTwoLines(entries.map(entry => entry.text).join(' '), 43).join('\n') || ' ';
}

function formatSubtitleLine(text) {
    if (!text) return ' ';

    text = deepCleanSubtitleText(text);
    if (!text.trim()) return ' ';

    let lowerText = text.toLowerCase();

    // Doar litere mici izolate (trunchieri „c”/„s” → „că”/„să”); majusculele („Vitamina C”, „Harry S. Truman”) rămân neatinse.
    text = text.replace(/(?<!\d)(^|[\s])([cs])(?=[\s.,!?:;]|$)/gm, function(match, spatiu, litera) {
        return spatiu + litera + 'ă';
    });
    text = text.replace(/(^|[\s])([Aa]dic)(?=[\s.,!?:;]|$)/gm, '$1$2ă');
    text = text.replace(/ţ/g, 'ț').replace(/Ţ/g, 'Ț').replace(/ş/g, 'ș').replace(/Ş/g, 'Ș');
    text = text.replace(/<[^>]+>/g, '');

    // Corecții mecanice certe confirmate în verificările recente.
    // Sunt intenționat specifice pentru a evita corecții globale riscante.
    const dictionar = [
        // Forme generate variabil de model pentru aceeași construcție semantică.
        // Sunt limitate la expresii confirmate ca greșite în acest proiect.
        [/\b(?:Iași|Iasi|Ieși|Iesi)[- ]mi din cap\b/gi, 'Ieși din capul meu'],
        [/\b(?:Ia|I-a) mâna după mine\b/gi, 'Ia mâna de pe mine'],
        [/(?<![A-Za-zĂÂÎȘȚăâîșț])Și pe urmă am fut-o ca să sărbătorim(?![A-Za-zĂÂÎȘȚăâîșț])/gi, (m) => (m[0] === m[0].toLowerCase() ? 'și pe urmă ne-am futut ca să sărbătorim' : 'Și pe urmă ne-am futut ca să sărbătorim')],
        [/\b(?:Și|Si) pe urmă am f\*{2,}ut ca să sărbătorim\b/gi, 'Și pe urmă ne-am futut ca să sărbătorim'],
        [/\b(?:Și|Si) pe urmă am f\*{2,}t ca să sărbătorim\b/gi, 'Și pe urmă ne-am futut ca să sărbătorim'],
        [/\bE un cuptor dracului aici\b/gi, 'E un cuptor al naibii aici'],
        [/(?<![A-Za-zĂÂÎȘȚăâîșț])Rezoluția Concurrentă(?![A-Za-zĂÂÎȘȚăâîșț])/g, 'Rezoluția Concurentă'],
        [/\bun cerc de încrederi\b/gi, 'un cerc de încredere'],
        [/\bcuando îți zic\b/gi, 'când îți zic'],
        [/\bmult așteptatului film\b/gi, 'mult așteptatul film'],
        [/\bnăibii\b/gi, 'naibii'],
        [/\blar că sunteți aici\b/gi, 'că sunteți aici'],
        [/\bn-am gânit\b/gi, 'n-am gândit'],
        [/(?<![A-Za-zĂÂÎȘȚăâîșț])nicodată(?![A-Za-zĂÂÎȘȚăâîșț])/gi, 'niciodată'],
        [/\bNu iau sifilis de Schifter\b/gi, 'Nu iau sifilis de Shapeshifter'],
        [/\bCa sămă înveți\b/gi, 'Ca să mă înveți'],
        [/\bCititoare de minți\b/gi, 'Cititoare de gânduri'],
        [/\bA dat C-ul din sac\b/gi, 'S-a aflat secretul'],
        [/\bsingurul tău prieten rămas pe dracu\'\b/gi, 'singurul tău prieten care ți-a mai rămas'],
        [/\bsub pământ jucând biliard în buzunar\b/gi, 'sub pământ frecând menta'],

        [/\bjhonson\b/gi, 'Johnson'],
        [/\bsuch a detailed indictment\b/gi, 'un rechizitoriu atât de detaliat'],
        [/\bHowever,\b/gi, 'Cu toate acestea,'],
        [/\bdilettante\b/gi, 'diletant'],
        [/\babroach\b/gi, 'abordare'],
        [/\bfrom project\b/gi, 'din proiect'],
        [/\bbanca acuzaților bancul acuzaților\b/gi, 'pe banca acuzaților'],
        [/(?<![\p{L}\p{N}_])în joi(?![\p{L}\p{N}_])/giu, 'joi'],
        [/\bde la embedding itself in a mudbank\.?/gi, 'de la a se înfige într-un mal de noroi.'],
        [/\bembedding itself in a mudbank\.?/gi, 'a se înfige într-un mal de noroi.'],
        [/\bN-a fost nic67\b/gi, 'Nu era niciun loc aici?'],
        // Corecție contextuală păstrată; regula globală „background → trecut” a fost eliminată.
        [/\bbackground juridic\b/gi, 'trecut juridic'],
        [/\bCă\.E\.A\./gi, 'A.E.C.'],
        [/\bpro Jean Tatlock\b/gi, 'despre Jean Tatlock'],
        [/(?<![\p{L}\p{N}_])în ș\s*\./giu, 'în șah.'],
        [/(?<![\p{L}\p{N}_])în ș(?![\p{L}\p{N}_])/giu, 'în șah'],
        [/\bsomom\b/gi, 'somon'],
        [/\bdilettant\b/gi, 'diletant'],
        [/\bcowboys\b/gi, 'cowboy'],
        [/\bThey need us\.?\b/gi, 'Au nevoie de noi.'],
        [/\bMaybe a little too well,?\s*Robert\.?\b/gi, 'Poate puțin prea bine, Robert.'],
        [/\bInterestingly enough,?\b/gi, 'Destul de interesant,'],
        [/\bthese men\b/gi, 'acești oameni'],
        [/\beverybody take a welder's glass\b/gi, 'toată lumea să ia o mască de sudură'],
        [/Everybody take a welder's glass\./gi, 'Toată lumea să ia o mască de sudură.'],

        // Etichete de personaje uitate în engleză
        [/^DRIVER:\s*/gmi, 'ȘOFER: '],
        [/\bDRIVER:\s*/gi, 'ȘOFER: '],
        [/^GUARD:\s*/gmi, 'GARDĂ: '],
        [/\bGUARD:\s*/gi, 'GARDĂ: '],
        [/^OFFICER:\s*/gmi, 'OFIȚER: '],
        [/\bOFFICER:\s*/gi, 'OFIȚER: '],
        [/^COP:\s*/gmi, 'POLIȚIST: '],
        [/\bCOP:\s*/gi, 'POLIȚIST: '],

        // Scăpări și anomalii identificate anterior
        [/\bCcat\b/gi, 'Căcat'],
        [/\bbănuiuiesc\b/gi, 'bănuiesc'],
        [/(?<![\p{L}\p{N}_])împotriva asta(?![\p{L}\p{N}_])/giu, 'împotriva acestui lucru'],
        [/\bI tăiați capul\b/gi, 'Îi tăiați capul'],
        [/\bnam niciun fel\b/gi, 'n-am niciun fel'],
        [/\bnarțiune\b/gi, 'narațiune'],
        [/\binteriorul acestei cupe\b/gi, 'interiorul acestei cuști'],
        [/\bspuneți-i saluta\b/gi, 'spuneți-i salut'],
        [/(?<![A-Za-zĂÂÎȘȚăâîșț])cea mai izolatã(?![A-Za-zĂÂÎȘȚăâîșț])/gi, 'cea mai izolată'],
        [/\brebuie să știm\b/gi, 'trebuie să știm'],
        [/\buficient de mult\b/gi, 'suficient de mult'],
        [/(?<![A-Za-zĂÂÎȘȚăâîșț])îi cureț(?![A-Za-zĂÂÎȘȚăâîșț])/gi, 'îi curăț'],
        [/\bArată foarte atleți\b/gi, 'Arată foarte atletici'],
        [/(?<![A-Za-zĂÂÎȘȚăâîșț])în toată regla(?![A-Za-zĂÂÎȘȚăâîșț])/gi, 'în toată regula'],
        [/\bI se strânge noțul\b/gi, 'I se strânge lațul'],
        [/\bdeatât un câine\b/gi, 'decât un câine'],
        [/\bBandurile cu spini\b/gi, 'Benzile cu țepi'],
        [/\bacești tipii\b/gi, 'acești tipi'],
        [/\bla aeriport\b/gi, 'la aeroport'],
        [/\bVine un camioane\b/gi, 'Vine un camion'],
        [/\bDos beri\b/gi, 'Două beri'],
        [/\bbervezas\b/gi, 'beri'],
        [/\bTrapiste pline de praf\b/gi, 'Uși-capcană pline de praf'],
        [/\bl-ai tras în piepie\b/gi, 'l-ai tras în piept'],
        [/\bCâți-va insule\b/gi, 'Câțiva inși'],
        [/\bDRS inamic\b/gi, 'Dronă inamică'],
        [/\bce ai\?y\b/gi, 'ce ai?'],
        [/\bse molmoșește\b/gi, 'dă greș'],
        [/\bnu-mi mai aparține!\b/gi, 'că nu-mi mai aparține!'],
        [/\bscoateți-o pe mama pe insulă\b/gi, 'scoateți-o pe mama de pe insulă'],
        [/\bva face denunț\b/gi, 'îi va denunța'],
        [/(?<![A-Za-zĂÂÎȘȚăâîșț])Ț-am cerut(?![A-Za-zĂÂÎȘȚăâîșț])/gi, (m) => (m[0] === m[0].toLowerCase() ? 'ți-am cerut' : 'Ți-am cerut')],
        [/\bcearsăfuri\b/gi, 'cearșafuri'],
        [/(?<![A-Za-zĂÂÎȘȚăâîșț])șă ne ținem(?![A-Za-zĂÂÎȘȚăâîșț])/gi, 'să ne ținem'],
        [/\boevacuare\b/gi, 'o evacuare'],
        [/\btat-tu\b/gi, 'tatăl tău'],
        [/\btat-meu\b/gi, 'tatăl meu'],
        [/\bmerici\b/gi, 'meriți'],
        [/\bcuânt\b/gi, 'cuvânt'],
        [/\bbrioșelea aia\b/gi, 'brioșele alea'],
        [/Sânișor Kournikova/gi, 'Rusoaica Pectorală'],
        [/fundul tău strâns/gi, 'fundul tău scorțos'],
        [/cafondist/gi, 'mojic'],
        [/Pu[țt]in-Kournikova/gi, 'Rusoaica Pectorală'],
        [/ghicercici/gi, 'ghicești'],
        [/dafirma/gi, 'da afară'],
        [/judicativ[aă]/gi, 'plină de prejudecăți'],
        [/le-atâmită/gi, 'le tâmpește'],
        [/(?<![A-Za-zĂÂÎȘȚăâîșț])Eu poartă(?![A-Za-zĂÂÎȘȚăâîșț])/gi, (m) => (m[0] === m[0].toLowerCase() ? 'eu port' : 'Eu port')],
        [/\bAleile aia\b/gi, 'Chestia aia'],
        [/(?<![A-Za-zĂÂÎȘȚăâîșț])s-(ți|l)(?![A-Za-zĂÂÎȘȚăâîșț])/gi, (m, a) => (m[0] === 'S' ? 'Să-' : 'să-') + a],
        [/\bEu poart\b/gi, 'Eu port'],
        [/\btîmpenie\b/gi, 'tâmpenie'],
        [/\bjobul asta\b/gi, 'jobul ăsta'],
        [/\bNu știe despre vorbește\b/gi, 'Nu știe despre ce vorbește'],
        [/\bom străzii\b/gi, 'om al străzii'],
        [/\bcoatul\b/gi, 'cotul'],
        [/\bketchuipurile\b/gi, 'ketchupurile'],
        [/\ble-atâmbesc\b/gi, 'le amețesc'],
        [/\buții\b/gi, 'utili'],
        [/\bfute-n cur de prostie\b/gi, 'al dracului de prost'],
        [/\bsevraică\b/gi, 'mahmură'],
        [/\bhoțul afla-nărav o fi spart\b/gi, 'vreun hoț o fi spart'],
        [/\breînălța ea a trebuit\b/gi, 'ea a trebuit'],
        [/\ba fute-o pe o pește-clovn\b/gi, 'a futut un pește-clovn'],
        [/(?<![A-Za-zĂÂÎȘȚăâîșț])țeață(?![A-Za-zĂÂÎȘȚăâîșț])/gi, 'țeavă'],
        [/\bnite amenzi\b/gi, 'niște amenzi'],
        [/\bFlore la ureche\b/gi, 'Floare la ureche'],
        [/\blaptepentru\b/gi, 'lapte pentru'],
        [/\bc-total\b/gi, 'total'],
        [/(?<![A-Za-zĂÂÎȘȚăâîșț])Întreabă--i(?![A-Za-zĂÂÎȘȚăâîșț])/gi, (m) => (m[0] === m[0].toLowerCase() ? 'întreabă-i' : 'Întreabă-i')],
        [/「/g, ''],
        [/\bdirectorenul\b/gi, 'directorul'],
        [/\bstorcești\b/gi, 'strivești'],
        [/(?<![A-Za-zĂÂÎȘȚăâîșț])cea mai albitură(?![A-Za-zĂÂÎȘȚăâîșț])/gi, 'cea mai albă'],
        [/\bcroșetă-n branhii\b/gi, 'croșeu în branhii'],
        [/\bfătat de prostie\b/gi, 'futut de prostie'],
        [/\bpsihoopat\b/gi, 'psihopat'],
        [/\bregrei\b/gi, 'regreți'],
        [/\bo 26\b/gi, 'asta'],
        [/\bputiul\b/gi, 'puțoiul'],
        [/\bPlătitorul de pește\b/gi, 'Strivitorul de calcan'],
        [/\bCentura de Rugină\b/gi, 'Rust Belt'],
        [/\bm-ar ține de șase De șase\b/gi, 'mi-aș păzi spatele'],
        [/\batacat cuvântat\b/gi, 'atacat dur'],
        [/\bMica Nină\b/gi, 'Little Nina'],
        [/\bmass-media principală\b/gi, 'presa mainstream'],
        [/\bun drac de cuvânt\b/gi, 'o vorbă'],
        [/\bScoală-ți-o zile în șir\b/gi, 'Scoală-n puii mei non-stop'],
        [/\b(un)?\s*modist\s*(\d+)?\b/gi, 'un modest'],
        [/\bprânat\b/gi, 'prins'],
        [/\b(s|S)troș\b/gi, 'Strauss'],
        [/\bștiu la mașină\b/gi, 'știu să dactilografiez'],
        [/\bse bucură de prea multă binefacere\b/gi, 'sunt bineveniți'],
        [/\bce-ți veni\b/gi, 'ce-ai pățit'],
        [/(?<![A-Za-zĂÂÎȘȚăâîșț])marșă de manevră(?![A-Za-zĂÂÎȘȚăâîșț])/gi, 'marjă de manevră'],
        [/\b(Ah|Oh|Uh|Agh|Aoleu)[!.]+$/gmi, ''],
        [/\bV Dumneata\b/gi, 'Dumneata'],
        [/\bnăscut Borden\b/gi, 'pe nume Borden'],
        [/\bca să o demonstr\b/gi, 'ca să o demonstrăm'],
        [/\bde ce n-a fost asocierile\b/gi, 'de ce n-au fost asocierile'],
        [/\bialaltăieri\b/gi, 'alaltăieri'],
        [/\beceam\b/gi, 'eram'],
        [/\bcei-o fi\b/gi, 'ce i-o fi'],
        [/\btoți leau\b/gi, 'șleau'],
        [/\bfeșciști\b/gi, 'fasciști'],
        [/(?<![\p{L}\p{N}_])Î j cunosc(?![\p{L}\p{N}_])/giu, 'Îi cunosc'],
        [/\bororbit\b/gi, 'orbit'],
        [/\bi-ale refuze\b/gi, 'să le refuze'],
        [/\bsecreției\b/gi, 'secretomaniei'],
        [/\baliții\b/gi, 'aliații'],
        [/\bnimiște\b/gi, 'niște'],
        [/\bclasifiat\b/gi, 'clasificat'],
        [/\bsomong\b/gi, 'somon'],
        [/\bopt bancă\b/gi, 'banca'],
        [/\bpa,\s*o să-ți\b/gi, 'păi, o să-ți'],
        [/\bSunt tot un an de uium\.?\b/gi, 'Eram un dezastru'],
        [/\bunnea\b/gi, 'un'],
        [/\bparuri\b/gi, 'pariuri'],
        [/\bpaharele lui Berzelius și poțiuni\b/gi, 'eprubetele și poțiunile'],
        [/\bniliște\b/gi, 'niște'],
        [/\bcalmază-te\b/gi, 'calmează-te'],
        [/\bbuclușă\b/gi, 'bucluc'],
        [/\bmai justifică scuzle\b/gi, 'scuză mijloacele'],
        [/\bcEA\b/g, 'cea'],
        [/\bilealalte\b/gi, 'celelalte'],
        [/\blu'\s*Oppenheimer\b/gi, 'lui Oppenheimer'],
        [/\bsommon\b/gi, 'somon'],
        [/\bmi-amintești bine\b/gi, 'îmi amintesc bine'],
        [/\bca s-o spunem pe drăcea-n față\b/gi, 'ca s-o spunem pe șleau'],
        [/\bceteva\b/gi, 'câteva'],
        [/\bpentru a obține concesii consemnând de la ruși\b/gi, 'pentru a obține garanții de la ruși'],
        [/\bfacem bomba sigură\b/gi, 'securizăm bomba'],
        [/\binteresată de provocate\b/gi, 'interesată de capcane'],
        [/\bjiul\b/gi, 'fel'],
        [/\bdupă o oră și 58 de minute\b/gi, 'în exact o oră și 58 de minute'],
        [/\bil voi suna pe Lloyd Garrison\b/gi, 'îl voi suna pe Lloyd Garrison'],
        [/\bpe banca acuzaților bancă\b/gi, 'pe banca acuzaților'],
        [/\bAlgebră e ca partitura\b/gi, 'Algebra este ca o partitură'],
        [/\bpropriz\b/gi, 'proprie'],
        [/\bÎ j sun\b/gi, 'Îl sun'],
        [/\bsticlă de sudor\b/gi, 'sticlă de sudură'],
        [/\bsomomon\b/gi, 'somon'],
        [/\bAcestcomitet\b/gi, 'Acest comitet'],
        [/\bLeft-wing political activities\b/gi, 'activități politice de stânga'],
        [/\bHitler's dead, it's true\b/gi, 'Hitler e mort, e adevărat'],
        [/\bProgress\b/gi, 'Progres'],
        [/\bBut Mr\. Borden was\b/gi, 'Dar domnul Borden a fost?'],
        [/\bThat's a very serious accusation, Senator\b/gi, 'Aceasta este o acuzație foarte gravă, senatore'],
        [/\bRural free deliveries\b/gi, 'Livrări poștale rurale'],
        [/\bfești\b/gi, 'fasciști'],
        [/\b2dansezi\b/gi, 'dansezi'],
        [/\bdespăre\b/gi, 'despre'],
        [/\bhabar navea\b/gi, 'habar n-avea'],
        [/(?<![A-Za-zĂÂÎȘȚăâîșț])Eu acționează(?![A-Za-zĂÂÎȘȚăâîșț])/gi, (m) => (m[0] === m[0].toLowerCase() ? 'eu acționez' : 'Eu acționez')],
        [/\bSă te fwt\b/gi, 'Să te fut'],
        [/\bcolțișorezi\b/gi, 'încolțești'],
        [/\bcolțișorești\b/gi, 'încolțești'],
        [/\btreabei\b/gi, 'trebii'],
        [/\bnimer\b/gi, 'vreo'],
        [/\bvalorizez\b/gi, 'valorez'],
        [/\bn o să te\b/gi, 'n-o să te'],
        [/\bnaiba să the ia\b/gi, 'naiba să te ia'],
        [/\bCoche\b/gi, 'Mașină'],
        [/\bcervezas\b/gi, 'beri'],
        [/\bn-auzeam\b/gi, 'n-am auzit'],
        [/\bpropriutei\b/gi, 'propriei'],
        [/\bmi-a învățat\b/gi, 'm-a învățat'],
        [/\bcred că își vor recupera\b/gi, 'crede că își va recupera'],
        [/\bprima șoarece\b/gi, 'primul șoarece'],
        [/\bPrefeți\b/gi, 'Preferi'],
        [/\bniciunfel\b/gi, 'niciun fel'],
        [/\bUrco\b/gi, 'Urc-o'],
        [/\bn o să\b/gi, 'n-o să'],
        [/\bpenthouses-ul\b/gi, 'penthouse-ul'],
        [/\bpenthousul\b/gi, 'penthouse-ul'],
        [/\bîn a mea mea\b/gi, 'în puii mei'],
        [/\bTrapdoor-uri\b/gi, 'Uși-capcană'],
        [/\bTrapuri\b/gi, 'Capcane'],
        [/\bîn a naibii\b/gi, 'întreagă, la naiba'],
        [/\bAltor orte\b/gi, 'Alcuiva'],

        // Corecții mecanice certe observate în verificările recente.
        // Erori recurente confirmate: corecții native, deterministe.
        [/\bca să\.\.\.rbătorim\b/gi, 'ca să sărbătorim'],
        [/\bM-am cerut în căsătorie cu\b/gi, 'L-am cerut în căsătorie pe'],
        [/\bCitească-gânduri\b/gi, 'Cititoare de gânduri'],
        [/\bdemocracția\b/gi, 'democrația'],
        [/\bMă reasigur în patru ani\b/gi, 'Să fiu realeasă în patru ani'],
        [/(?<![A-Za-zĂÂÎȘȚăâîșț])S-a dus totul pe râpă(?![A-Za-zĂÂÎȘȚăâîșț])/gi, (m) => (m[0] === m[0].toLowerCase() ? 's-a dus totul de râpă' : 'S-a dus totul de râpă')],
        [/\bo bullet\b/gi, 'un glonț'],
        [/\bmergem orbești\b/gi, 'mergem orbește'],
        [/(?<![A-Za-zĂÂÎȘȚăâîșț])o favoră(?![A-Za-zĂÂÎȘȚăâîșț])/gi, 'o favoare'],
        [/\bMă închizi într-o cușcă\s*\/\s*dacă nu accept să fii arma ta\b/gi, 'Mă închizi într-o cușcă / dacă nu accept să fiu arma ta'],
        [/\bȘi pe urmă am fumat-o de sărbătoare\b/gi, 'Și pe urmă ne-am futut ca să sărbătorim'],
        [/(?<![A-Za-zĂÂÎȘȚăâîșț])Rezoluția Concurrentă(?![A-Za-zĂÂÎȘȚăâîșț])/gi, (m) => (m[0] === m[0].toLowerCase() ? 'rezoluția Concurentă' : 'Rezoluția Concurentă')],
        [/\bun cerc de încrederi\b/gi, 'un cerc de încredere'],

        // Sunt intenționat conservative: repară doar forme clar corupte/typo.
        [/\bDe ce (?:ne|mi|ți|v|i)-ar pasa\b/gi, m => m.replace(/pasa\b/gi, 'păsa')],
        [/\bmizerijile\b/gi, 'mizeriile'],
        [/\bfrecându-menta\b/gi, 'frecând menta'],
        [/\bT-Ar trebui\b/g, 'Ar trebui'],
        [/\btuți\b/gi, 'toți'],
        [/(?<![\p{L}\p{N}_])țin-ținta(?![\p{L}\p{N}_])/giu, 'ținta'],
        [/\bfãcut-o\b/gi, 'făcut-o'],
        [/\bca i-au făcut\b/gi, 'cum i-au făcut'],
        [/\bpână la adânci bătrânețe\b/gi, 'până la adânci bătrâneți'],
        [/(?<![\p{L}\p{N}_])reeligitată(?![\p{L}\p{N}_])/giu, 'realeasă'],
        [/\bîn ourselves\b/gi, 'înșine'],
        [/\bMă-nvățați\b/g, 'mă-nvățați'],
        [/\bmi l-a învățat tata\b/gi, 'm-a învățat tata'],
        [/\bvirusul ăla naibii\b/gi, 'virusul ăla al naibii'],
        [/\bDe ce ne-ar pasa\b/gi, 'De ce ne-ar păsa'],
        [/\bDe ce i-ar pasa\b/gi, 'De ce i-ar păsa'],
        [/\bcomuniștii erau periculoase\b/gi, 'comuniștii erau periculoși'],
        [/(?<![A-Za-zĂÂÎȘȚăâîșț])în ziua în care(?![A-Za-zĂÂÎȘȚăâîșț])/gi, 'în ziua în care'],
        [/\.icon\b/gi, ''],

        // „fucking” calchiat: „Ce a dracului…” nu există în română.
        [/(?<![A-Za-zĂÂÎȘȚăâîșț])(ce|cine|unde|cum|când|cât|care) a (dracului|naibii)(?![A-Za-zĂÂÎȘȚăâîșț])/gi,
            (m, w, k) => w + ' ' + (k.toLowerCase() === 'dracului' ? "dracu'" : 'naiba')],
        // „nici o/un” → „nicio/niciun” (nu se atinge „nici un singur” și structurile „nici… nici…”).
        [/(?<![A-Za-zĂÂÎȘȚăâîșț])nici (o|un)(?![A-Za-zĂÂÎȘȚăâîșț])(?!\s+singur)/gi,
            (m, a, offset, whole) => {
                const rest = String(whole).slice(offset + m.length);
                const before = String(whole).slice(0, offset);
                if (/(?<![A-Za-zĂÂÎȘȚăâîșț])nici(?![A-Za-zĂÂÎȘȚăâîșț])/i.test(rest) || /(?<![A-Za-zĂÂÎȘȚăâîșț])nici(?![A-Za-zĂÂÎȘȚăâîșț])/i.test(before)) return m;
                return (m[0] === 'N' ? 'N' : 'n') + 'ici' + a.toLowerCase();
            }],
        // Imperativ trunchiat: „păstreaz-o” → „păstrează-o”.
        [/(?<![A-Za-zĂÂÎȘȚăâîșț])([a-zăâîșț]+ea)z-(o|l|i|le|mi|ți|ne|vă)(?![A-Za-zĂÂÎȘȚăâîșț])/gi, (m, stem, cl) => stem + 'ză-' + cl]
    ];

    for (let i = 0; i < dictionar.length; i++) {
        text = text.replace(dictionar[i][0], dictionar[i][1]);
    }

    // Ultimul filtru după toate corecțiile mecanice: nicio etapă de formatare/dicționar
    // nu trebuie să reintroducă interjecții pe care utilizatorul a cerut să nu le afișăm.
    text = stripRomanianOutputInterjections(text);
    if (!text) return ' ';
    // După eliminarea unei interjecții de la început, majuscula revine pe primul
    // cuvânt real al replicii; pentru replicile marcate cu liniuță capitalizăm după separator.
    text = text.replace(/^(\s*[-–—]\s*)([a-zăâîșț])/u,
        (_, prefix, letter) => prefix + letter.toLocaleUpperCase('ro-RO'));
    text = text.replace(/^([a-zăâîșț])/u, letter => letter.toLocaleUpperCase('ro-RO'));

    return formatSubtitleLayout(text);
}

// ============================================================
// MASTER CINEMATIC TRANSLATION PROMPT
// ============================================================

const MASTER_TRANSLATION_PROMPT = `MISSION
Translate every supplied English subtitle block into natural, modern spoken Romanian for films and TV. Localize the intended meaning and tone; do not copy English word order when it sounds unnatural in Romanian.

OUTPUT — CRITICAL
- Return ONLY a valid JSON array, with exactly one object for every supplied ID, in the original order.
- Every object must have exactly these fields: {"id": integer, "text": "Romanian translation"}.
- Preserve IDs exactly. Never omit, duplicate, invent, merge, or move content to a neighboring ID.
- Input IDs may contain gaps when subtitle blocks were filtered before translation. Never renumber by position or infer an ID from its neighbors: copy each supplied ID exactly, even when the numbers are not consecutive.
- Before returning, verify that every text belongs to the English block with the same ID; do not shift translations forward or backward when a block is unusual, numeric, empty-looking, or difficult to translate.
- Do not return markdown, code fences, comments, or explanations.

TRANSLATION AND CONTEXT
- Translate every meaningful sentence, phrase, joke, idiom, slang expression, and fragment into Romanian. Preserve names and established foreign expressions only when they genuinely belong in the source.
- Use neighboring English subtitles and the supplied Romanian context only to understand the scene, speaker, references, grammar, jokes, and continuity. Translate only the text belonging to the current ID.
- If a sentence continues across IDs, understand the whole sentence but keep each fragment under its original ID. Never move words between subtitle IDs.
- If the English block begins with a lowercase letter, or the previous block ends without terminal punctuation, it continues the previous sentence: begin its Romanian text with a lowercase letter unless the first word is a proper noun.
- Preserve the complete meaning: who performs the action, who or what receives it, location versus direct object, possession, negation, tense, person, gender, number, relationships, humor, and emotional intent.
- Use contemporary, idiomatic, spoken Romanian. Avoid literal calques, awkward English syntax, stiff or overly formal phrasing, and childish or timid wording that does not match the character.
- Preserve the original level of directness, intimacy, vulgarity, sarcasm, hostility, and informality. Do not censor or soften explicit dialogue, but do not make it more vulgar than the source.
- When the source explicitly names an anatomical or sexual term, use an accurate Romanian equivalent. Do not replace it with vague euphemisms such as „jos” or „acolo”. Preserve the grammatical relationship too: for example, “the sound that dries my vagina” means „sunetul care-mi usucă vaginul”, not „sunetul care mă usucă în vagin”.
- Preserve singular/plural, gender, and the identity of the object. A singular source noun such as “a hat” must not become plural „căciuli”. Do not add diminutives such as „căciuliță” unless smallness, affection, or a diminutive is actually expressed by the source.
- Translate idioms and profanity by their function in context, not by mechanically matching each English word. For example, “fucking” may be an intensifier, an insult, or a literal verb; choose the Romanian equivalent for that function.
- Romanian profanity: after an interrogative word use „dracu'” or „naiba” directly („Ce dracu' faci?”, „Despre ce naiba vorbești?”, „Cine dracu' ești?”); NEVER write „ce a dracului” or „cine a dracului”. As an intensifier use „al naibii de”, „la naiba”, „pe naiba”, or put „al naibii/al dracului” after a masculine noun group. Do not append „dracului” to every sentence and do not keep the English word order of “fucking”; often it is better dropped or rendered by a natural interjection. Examples: “What the fuck is in Switzerland?” → „Ce dracu' e în Elveția?”; “No fucking way.” → „Nici gând, la naiba.”; “It's a fucking disaster.” → „E un dezastru al naibii.”; “Shut the fuck up.” → „Taci dracului din gură.”
- Choose terms of endearment according to the relationship and context; do not translate “babe”, “honey”, or “baby” mechanically every time.
- Translate “But” as „Dar” when it begins a clause. Do not leave ordinary English dialogue untranslated.
- Use correct Romanian grammar, spelling, punctuation, and diacritics (ă, â, î, ș, ț). Use complete real Romanian words; never truncate, merge, invent, or corrupt a word. Check pronouns, clitics, prepositions, conjugation, and agreement.
- Convert ordinary imperial measurements to metric where natural and safe: feet to metres, miles to kilometres, pounds to kilograms, Fahrenheit to Celsius. Do not convert plot-critical or idiomatic measurements. Translate “lakh” as 100,000 and “crore” as 10 million when relevant.

SUBTITLE FORMATTING
- Keep each visible line at or below 43 characters whenever the wording allows. Use no more than TWO text lines per subtitle block.
- Split at natural phrase boundaries, not arbitrary points; if necessary, rephrase concisely without losing meaning.
- If the thought continues on the second visual line, start that line lowercase unless a proper noun or new sentence requires otherwise.
- If two speakers share one source block, keep both under the SAME ID on separate lines, each with “- ” and a capitalized first word. Never move a speaker to another ID.
- Preserve meaningful text from all source lines in the block. Do not silently drop content when fitting the layout.

INTERJECTIONS AND FILLERS — STRICT OUTPUT RULE
- Do NOT display sound-based reaction/filler interjections in Romanian subtitles. Remove standalone interjections and meaningless hesitation/vocalization tokens, including “Ah”, “Eh”, “Uh”, “Um”, “Oh”, “Hmm”, “Mwah”, “Mm-hmm”, “Wow”, “Whoa”, “Oops”, “Ouch”, “ă”, “ăă”, “mhm”, “uff”, and similar sounds. Also omit attention markers “Hey/Hei” and conversational filler “na” when they add no content; keep the rest of the sentence.
- If such a token appears inside a meaningful sentence, remove only the interjection and keep/rephrase the meaningful words; fix punctuation and capitalization. Never replace it with a Romanian filler or reaction (including “ă”, “ăă”, “ăăă”, “hmm”, “mhm”, “Păi”, “Vai”, “Uau” or “Mă rog”) when that word merely fills the pause.
- If the source is an idiom or expressive phrase that would normally begin with an interjection (for example “Oh my God”), translate its intended meaning naturally without rendering an interjection literally. Do not discard the meaningful content of the phrase.
- Do not create a subtitle block for a source line consisting only of non-semantic vocalization/reaction noise. Remove non-dialogue sound labels and standalone grunts when they are just subtitle noise.
- Keep meaningful spoken acknowledgements and dialogue words (for example “yes”, “no”, “sorry”, and “okay” meaning “Bine.”); these are content, not filler noises.

FINAL CHECK
Before returning JSON, proofread every translation against its English source and context. Verify meaning, natural Romanian syntax, direct-object/preposition relationships, singular/plural, register, explicitness, spelling, diacritics, line lengths, dialogue format, filler cleanup, and one-to-one ID alignment. Correct clear errors without adding or deleting meaning.
`;

// ============================================================
// PROMPT BUILDER CU CONTEXT
// ============================================================

function buildTranslationPrompt(chunk, allItems, chunkStart, chunkEnd, previousTranslatedContext) {
    const contextBefore = allItems.slice(Math.max(0, chunkStart - CONTEXT_LINES_BEFORE), chunkStart);
    const contextAfter = allItems.slice(chunkEnd, Math.min(allItems.length, chunkEnd + CONTEXT_LINES_AFTER));

    // Fiecare replică primește câteva replici vecine direct în obiectul JSON.
    // Astfel Gemini poate lega gramatical replica de ceea ce vine imediat înainte/după,
    // fără request-uri suplimentare și fără a modifica numărul de linii traduse.
    // Context direct pentru fiecare replică: o linie înainte și una după.
    // Nu creează request-uri suplimentare; este trimis în același JSON.
    const keysToTranslate = chunk.map((obj, localIndex) => {
        const absoluteIndex = chunkStart + localIndex;
        const previous = allItems[absoluteIndex - 1];
        const next = allItems[absoluteIndex + 1];

        return {
            id: obj.id,
            text: obj.text,
            context_anterior: previous ? `[${previous.id}] ${previous.text}` : '(niciunul)',
            context_urmator: next ? `[${next.id}] ${next.text}` : '(niciunul)'
        };
    });

    return `
${MASTER_TRANSLATION_PROMPT}

Context inainte (pentru referinta):
${contextBefore.map(i => `[${i.id}]${i.text}`).join('\n') || '(niciunul)'}

Context dupa (pentru referinta):
${contextAfter.map(i => `[${i.id}]${i.text}`).join('\n') || '(niciunul)'}

Context anterior tradus in Romana (pentru continuitate):
${previousTranslatedContext.map(i => `[${i.id}]${i.text}`).join('\n') || '(niciunul)'}

Tradu STRICT următoarele replici și returnează un ARRAY JSON cu exact câte un obiect pentru fiecare ID:
[
  {"id": 123, "text": "traducerea în română"}
]
Nu modifica ID-urile și nu omite nicio replică.
Câmpurile context_anterior și context_urmator sunt DOAR pentru înțelegerea replicii curente; NU le traduce și NU le include în răspuns.
Folosește contextul pentru acord, pronume, continuitate, topică și sens, dar modifică DOAR câmpul text al ID-ului curent.

REPLICILE DE TRADUS:
${JSON.stringify(keysToTranslate, null, 2)}
`;
}

// ============================================================
// API KEY STATE & MANAGEMENT
// ============================================================

// Un singur controler pentru toate cererile Gemini ale acestui proces Node.
// Astfel, două subtitrări procesate simultan nu își ignoră reciproc pauza de 429.
const geminiRequestControl = {
    active: 0,
    maxConcurrent: CONCURRENCY_LIMIT,
    targetConcurrent: CONCURRENCY_LIMIT,
    cooldownUntil: 0,
    nextStartAt: 0,
    waiters: new Set(),
    consecutive429: 0,
    consecutive5xx: 0,
    successesSinceThrottle: 0
};

function notifyGeminiRequestWaiters() {
    for (const wake of Array.from(geminiRequestControl.waiters)) wake();
}

function waitForGeminiRequestChange(timeoutMs = 250) {
    return new Promise(resolve => {
        let settled = false;
        let timer;
        const finish = () => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            geminiRequestControl.waiters.delete(finish);
            resolve();
        };
        geminiRequestControl.waiters.add(finish);
        timer = setTimeout(finish, Math.max(10, timeoutMs));
    });
}

async function acquireGeminiRequestSlot() {
    while (true) {
        const now = Date.now();
        const cooldownMs = Math.max(0, geminiRequestControl.cooldownUntil - now);
        const pacingMs = Math.max(0, geminiRequestControl.nextStartAt - now);

        if (cooldownMs <= 0 && pacingMs <= 0 && geminiRequestControl.active < geminiRequestControl.maxConcurrent) {
            geminiRequestControl.active++;
            geminiRequestControl.nextStartAt = Date.now() + 200;
            let released = false;
            return () => {
                if (released) return;
                released = true;
                geminiRequestControl.active = Math.max(0, geminiRequestControl.active - 1);
                notifyGeminiRequestWaiters();
            };
        }

        const waitMs = cooldownMs > 0
            ? Math.min(cooldownMs, 1000)
            : pacingMs > 0 && geminiRequestControl.active < geminiRequestControl.maxConcurrent
                ? Math.min(pacingMs, 1000)
                : 1000;
        await waitForGeminiRequestChange(waitMs);
    }
}

function noteGeminiRequestSuccess(keyState = null) {
    const now = Date.now();
    const lane = getLaneForKeyState(keyState);
    let poolGateCleared = false;
    if (lane) {
        lane.lastTouchedAt = now;
        lane.consecutive429 = 0;
        lane.cooldownUntil = Math.min(Number(lane.cooldownUntil || 0), now);
        const pool = keyState?._keyPool;
        const previousPoolGate = Number(pool?._global429Until || 0);
        if (pool) updateGlobal429GateIfPoolExhausted(pool);
        poolGateCleared = previousPoolGate > now && Number(pool?._global429Until || 0) <= now;
    }
    if (poolGateCleared) notifyGeminiRequestWaiters();
    if (now < geminiRequestControl.cooldownUntil) return;

    if (geminiRequestControl.maxConcurrent < geminiRequestControl.targetConcurrent) {
        geminiRequestControl.successesSinceThrottle++;
        if (geminiRequestControl.successesSinceThrottle >= 3) {
            const previousLimit = geminiRequestControl.maxConcurrent;
            geminiRequestControl.maxConcurrent = Math.min(
                geminiRequestControl.targetConcurrent,
                geminiRequestControl.maxConcurrent + 1
            );
            geminiRequestControl.successesSinceThrottle = 0;
            if (geminiRequestControl.maxConcurrent >= geminiRequestControl.targetConcurrent) {
                geminiRequestControl.consecutive429 = 0;
                geminiRequestControl.consecutive5xx = 0;
            }
            console.log(`${c.green}✔ [Gemini Control] 3 cereri reușite; concurența crește controlat ${previousLimit}→${geminiRequestControl.maxConcurrent}/${geminiRequestControl.targetConcurrent}.${c.reset}`);
            notifyGeminiRequestWaiters();
        }
    } else {
        geminiRequestControl.consecutive429 = 0;
        geminiRequestControl.consecutive5xx = 0;
        geminiRequestControl.successesSinceThrottle = 0;
    }
}

function getGeminiPoolAvailability(keyStates, now = Date.now()) {
    const pool = Array.isArray(keyStates) ? keyStates : [];
    const candidates = pool.filter(state => {
        const lane = getLaneForKeyState(state);
        return !state.disabled && !lane?.disabled;
    });
    const entries = candidates.map(state => {
        const lane = getLaneForKeyState(state);
        return {
            state,
            lane,
            dailyUntil: Math.max(Number(state.dailyQuotaUntil || 0), Number(lane?.dailyQuotaUntil || 0)),
            pausedUntil: lane ? Number(lane.cooldownUntil || 0) : Number(state.pausedUntil || 0)
        };
    });
    return {
        candidates,
        entries,
        available: entries.filter(entry => entry.dailyUntil <= now && entry.pausedUntil <= now),
        temporarilyPaused: entries.filter(entry => entry.dailyUntil <= now && entry.pausedUntil > now),
        dailyPaused: entries.filter(entry => entry.dailyUntil > now)
    };
}

function updateGlobal429GateIfPoolExhausted(keyStates, options = {}) {
    if (!Array.isArray(keyStates) || !keyStates.length) return { allBlocked: false };
    const now = Date.now();
    const snapshot = getGeminiPoolAvailability(keyStates, now);

    // Cât timp există cel puțin un proiect eligibil, NU există pauză globală.
    if (snapshot.available.length) {
        keyStates._global429Until = 0;
        keyStates._global429LoggedUntil = 0;
        return { allBlocked: false, available: snapshot.available.length };
    }

    if (!snapshot.candidates.length) return { allBlocked: true, disabledOnly: true };

    // Dacă toate proiectele rămase au cota zilnică epuizată, selectorul va opri
    // procesarea cu eroare explicită; nu setăm o pauză scurtă care ar induce în eroare.
    if (!snapshot.temporarilyPaused.length && snapshot.dailyPaused.length === snapshot.entries.length) {
        keyStates._global429Until = 0;
        if (options.log && !keyStates._globalDailyQuotaLogged) {
            keyStates._globalDailyQuotaLogged = true;
            console.log(`${c.yellow}⚠ [Gemini Control] Toate proiectele disponibile sunt marcate cu cotă zilnică epuizată; nu mai există un proiect pentru retry până la resetarea cotei.${c.reset}`);
        }
        return { allBlocked: true, dailyOnly: true, available: 0 };
    }

    if (snapshot.temporarilyPaused.length) {
        // Pauza globală începe doar când fiecare proiect din acest pool este
        // indisponibil. Ea se încheie când devine eligibil primul proiect.
        const resumeAt = Math.min(...snapshot.temporarilyPaused.map(entry => entry.pausedUntil));
        const previous = Number(keyStates._global429Until || 0);
        keyStates._global429Until = resumeAt;
        if (options.log && (Math.abs(previous - resumeAt) > 1000 || !keyStates._global429LoggedUntil)) {
            keyStates._global429LoggedUntil = resumeAt;
            console.log(`${c.yellow}⏸ [Gemini Control] Toate proiectele din pool sunt temporar indisponibile; pauză globală până când primul proiect devine disponibil (aprox. ${Math.max(1, Math.ceil((resumeAt - now) / 1000))}s). Concurența normală rămâne ${geminiRequestControl.maxConcurrent}/${geminiRequestControl.targetConcurrent}.${c.reset}`);
        }
        return { allBlocked: true, resumeAt, available: 0 };
    }

    return { allBlocked: true, available: 0 };
}

function registerGlobalGemini429(cooldownMs, quotaKind = 'unknown', keyState = null) {
    const now = Date.now();
    const pauseMs = Math.max(1000, Number(cooldownMs) || 15000);
    const lane = getLaneForKeyState(keyState);
    geminiRequestControl.consecutive429++;
    geminiRequestControl.consecutive5xx = 0;
    geminiRequestControl.successesSinceThrottle = 0;

    if (lane) {
        lane.last429At = now;
        lane.lastTouchedAt = now;
        lane.consecutive429++;
        if (quotaKind === 'daily') {
            const resetAt = Math.max(Number(lane.dailyQuotaUntil || 0), Number(keyState?.dailyQuotaUntil || 0), getNextPacificMidnightMs(now));
            lane.dailyQuotaUntil = resetAt;
            lane.cooldownUntil = 0;
            if (keyState) {
                keyState.dailyQuotaUntil = Math.max(Number(keyState.dailyQuotaUntil || 0), resetAt);
                keyState.pausedUntil = 0;
            }
        } else {
            lane.cooldownUntil = Math.max(Number(lane.cooldownUntil || 0), now + pauseMs);
            if (keyState) keyState.pausedUntil = Math.max(Number(keyState.pausedUntil || 0), lane.cooldownUntil);
        }
    }

    const pool = keyState?._keyPool;
    const poolStatus = updateGlobal429GateIfPoolExhausted(pool, { log: true });
    const projectLabel = lane ? lane.fingerprint.slice(0, 8) : 'necunoscut';
    const previousLimit = geminiRequestControl.maxConcurrent;
    const availableText = poolStatus.available > 0
        ? ` Rămân ${poolStatus.available} proiecte disponibile; concurența globală rămâne ${previousLimit}/${geminiRequestControl.targetConcurrent}.`
        : poolStatus.dailyOnly
            ? ' Toate proiectele din pool au cotă zilnică epuizată.'
            : poolStatus.allBlocked
                ? ' Nu mai există proiecte eligibile momentan; selectorul va aștepta primul proiect disponibil.'
                : '';
    console.log(`${c.yellow}⚠ [Gemini Control] 429 pe proiectul ${projectLabel} (${quotaKind}); doar acest proiect intră în pauză ${quotaKind === 'daily' ? 'până la resetarea cotei' : `${Math.ceil(pauseMs / 1000)}s`}.${availableText}${c.reset}`);
    notifyGeminiRequestWaiters();
}

function registerGlobalGemini5xx(status) {
    const now = Date.now();
    geminiRequestControl.consecutive5xx++;
    geminiRequestControl.consecutive429 = 0;
    geminiRequestControl.maxConcurrent = Math.max(1, geminiRequestControl.maxConcurrent - 1);
    geminiRequestControl.successesSinceThrottle = 0;
    const backoffBaseMs = Math.min(30000, 2000 * Math.pow(2, geminiRequestControl.consecutive5xx - 1));
    const jitterMs = Math.floor(Math.random() * Math.min(1500, Math.max(250, backoffBaseMs * 0.25)));
    const pauseMs = backoffBaseMs + jitterMs;
    geminiRequestControl.cooldownUntil = Math.max(geminiRequestControl.cooldownUntil, now + pauseMs);
    console.log(`${c.yellow}⚠ [Gemini Control] API ${status}; pauză comună ${Math.ceil(pauseMs / 1000)}s și concurență redusă la ${geminiRequestControl.maxConcurrent}/${geminiRequestControl.targetConcurrent}.${c.reset}`);
    notifyGeminiRequestWaiters();
}

function getNextPacificMidnightMs(nowMs = Date.now()) {
    const timeZone = 'America/Los_Angeles';
    const partsFormatter = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
    });
    const dateParts = partsFormatter.formatToParts(new Date(nowMs));
    const pick = type => Number(dateParts.find(part => part.type === type)?.value);
    const tomorrowUtcDate = new Date(Date.UTC(pick('year'), pick('month') - 1, pick('day') + 1));
    const targetYear = tomorrowUtcDate.getUTCFullYear();
    const targetMonth = tomorrowUtcDate.getUTCMonth() + 1;
    const targetDay = tomorrowUtcDate.getUTCDate();
    const targetWallTime = Date.UTC(targetYear, targetMonth - 1, targetDay, 0, 0, 0);
    let guess = targetWallTime;

    // Conversie iterativă a miezului nopții din Los Angeles în UTC, inclusiv DST.
    for (let i = 0; i < 4; i++) {
        const localParts = partsFormatter.formatToParts(new Date(guess));
        const get = type => Number(localParts.find(part => part.type === type)?.value);
        const observedAsUtc = Date.UTC(
            get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')
        );
        guess += targetWallTime - observedAsUtc;
    }
    return Math.max(nowMs + 60000, guess);
}

function classifyGeminiQuotaError(error) {
    const providerError = error?.response?.data?.error || {};
    const message = String(providerError.message || error?.response?.data?.message || '').replace(/\s+/g, ' ').trim();
    const details = Array.isArray(providerError.details) ? providerError.details : [];
    const detailsText = details.map(detail => {
        if (!detail || typeof detail !== 'object') return String(detail || '');
        return [detail.quotaMetric, detail.quotaId, detail.reason, detail.retryDelay,
            detail.metadata ? JSON.stringify(detail.metadata) : ''].filter(Boolean).join(' ');
    }).join(' ');
    const combined = `${message} ${detailsText}`;
    let kind = 'unknown';
    if (/(?:requests?|tokens?|generatecontent).{0,40}(?:per.?day|perday)|(?:per.?day).{0,30}(?:quota|project|model)|daily\s+quota/i.test(combined)) {
        kind = 'daily';
    } else if (/(?:per.?minute|per.?second|requestsperminute|tokensperminute|\bRPM\b|\bTPM\b|rate.?limit|too many requests)/i.test(combined)) {
        kind = 'rate';
    }
    const diagnosticDetail = detailsText.replace(/\s+/g, ' ').trim().slice(0, 500);
    return { kind, message: message.slice(0, 300), detailsText: diagnosticDetail };
}

function parseRetryAfterMs(retryAfterHeader, fallbackMs = 30000) {
    const now = Date.now();
    const raw = String(retryAfterHeader ?? '').trim();
    if (raw) {
        const seconds = Number(raw);
        if (Number.isFinite(seconds) && seconds >= 0) {
            return Math.max(1000, Math.ceil(seconds * 1000));
        }

        // Retry-After poate fi fie număr de secunde, fie dată HTTP.
        const retryAt = Date.parse(raw);
        if (Number.isFinite(retryAt) && retryAt > now) {
            return Math.max(1000, retryAt - now);
        }
    }
    return fallbackMs == null ? null : Math.max(1000, Number(fallbackMs) || 30000);
}

function extractGeminiRetryDelayMs(error, fallbackMs) {
    const headers = error?.response?.headers || {};
    const fromHeader = parseRetryAfterMs(headers['retry-after'] ?? headers['Retry-After'], null);
    if (fromHeader != null) return fromHeader;

    const details = error?.response?.data?.error?.details;
    if (Array.isArray(details)) {
        for (const detail of details) {
            const retryDelay = String(detail?.retryDelay || '').trim();
            const match = retryDelay.match(/^(\d+(?:\.\d+)?)s$/i);
            if (match) return Math.max(1000, Math.ceil(Number(match[1]) * 1000));
        }
    }
    return fallbackMs;
}

// Selector global pentru proiectele Gemini folosite în acest proces Node.
// Conform configurării addon-ului, fiecare cheie distinctă trebuie să provină
// dintr-un proiect Google Cloud distinct. Amprentarea SHA-256 permite coordonarea
// fără păstrarea cheii API ca identificator și fără afișarea ei în loguri.
const geminiProjectLanes = new Map();
const GEMINI_RECENT_REQUEST_WINDOW_MS = 60_000;

function getGeminiProjectLane(apiKey) {
    const fingerprint = crypto.createHash('sha256').update(String(apiKey)).digest('hex');
    const now = Date.now();
    let lane = geminiProjectLanes.get(fingerprint);
    if (!lane) {
        lane = {
            fingerprint,
            lastSelectedAt: 0,
            lastRequestAt: 0,
            recentRequestStarts: [],
            activeRequests: 0,
            reservations: 0,
            selections: 0,
            cooldownUntil: 0,
            dailyQuotaUntil: 0,
            disabled: false,
            consecutive429: 0,
            last429At: 0,
            lastTouchedAt: now
        };
        geminiProjectLanes.set(fingerprint, lane);
    }
    lane.lastTouchedAt = now;

    // Limitează creșterea memoriei dacă instanța primește configurații foarte
    // multe și diferite. Nu eliminăm niciodată o bandă activă, rezervată sau blocată.
    if (geminiProjectLanes.size > 2000) {
        const staleBefore = now - 6 * 60 * 60 * 1000;
        for (const [id, candidate] of geminiProjectLanes) {
            if (geminiProjectLanes.size <= 1500) break;
            if (
                candidate.activeRequests === 0 &&
                candidate.reservations === 0 &&
                candidate.cooldownUntil <= now &&
                candidate.dailyQuotaUntil <= now &&
                candidate.lastTouchedAt < staleBefore
            ) {
                geminiProjectLanes.delete(id);
            }
        }
    }
    return lane;
}

function getLaneForKeyState(keyState) {
    if (!keyState) return null;
    if (!keyState.globalLane) keyState.globalLane = getGeminiProjectLane(keyState.key);
    keyState.globalLane.lastTouchedAt = Date.now();
    return keyState.globalLane;
}

function consumeGlobalKeyReservation(keyState) {
    const lane = getLaneForKeyState(keyState);
    if (!lane || Number(keyState._pendingGlobalReservations || 0) <= 0) return false;
    keyState._pendingGlobalReservations--;
    lane.reservations = Math.max(0, lane.reservations - 1);
    lane.lastTouchedAt = Date.now();
    return true;
}

function getRecentProjectRequestCount(lane, now) {
    lane.recentRequestStarts = (lane.recentRequestStarts || [])
        .filter(timestamp => now - timestamp < GEMINI_RECENT_REQUEST_WINDOW_MS);
    return lane.recentRequestStarts.length;
}

function createKeyState(keys) {
    const states = keys.map(key => ({
        key,
        pausedUntil: 0,
        dailyQuotaUntil: 0,
        disabled: false,
        failures: 0,
        lastUsed: 0,
        globalLane: getGeminiProjectLane(key),
        _pendingGlobalReservations: 0
    }));
    // Asociere internă (nu conține valori noi în payload-uri/loguri): permite
    // fiecărei erori 429 să determine dacă mai există proiecte disponibile.
    for (const state of states) state._keyPool = states;
    return states;
}

function getGlobal429Until(keyStates) { return Number(keyStates._global429Until || 0); }

function register429(keyStates, cooldownMs, forceGlobal = false) {
    // 429-ul este înregistrat în callGemini pe banda proiectului exact care l-a
    // primit. Nu punem întreaga subtitrare în pauză: celelalte proiecte trebuie
    // să poată prelua cererile rămase. Păstrăm funcția drept wrapper pentru
    // apelurile existente din Grammar Review/recuperare.
    return false;
}

async function waitFor429Gate(keyStates) {
    let lastLoggedUntil = 0;
    while (true) {
        const waitMs = getGlobal429Until(keyStates) - Date.now();
        if (waitMs <= 0) return;
        const gateUntil = getGlobal429Until(keyStates);
        if (gateUntil !== lastLoggedUntil) {
            console.log(`${c.yellow}⏳ [429 Gate] Toate proiectele din acest pool sunt temporar indisponibile. Aștept aproximativ ${Math.ceil(waitMs / 1000)}s până la primul proiect disponibil.${c.reset}`);
            lastLoggedUntil = gateUntil;
        }
        // Recheck cel puțin o dată pe secundă: o cerere activă poate reuși între timp
        // și elibera un proiect, caz în care nu mai trebuie așteptată vechea poartă.
        await waitForGeminiRequestChange(Math.min(waitMs, 1000));
    }
}

async function getAvailableKey(keyStates) {
    while (true) {
        await waitFor429Gate(keyStates);
        const now = Date.now();
        const nonDisabled = keyStates.filter(state => {
            const lane = getLaneForKeyState(state);
            return !state.disabled && !lane.disabled;
        });
        const statusFor = state => {
            const lane = getLaneForKeyState(state);
            return {
                lane,
                dailyUntil: Math.max(Number(state.dailyQuotaUntil || 0), Number(lane.dailyQuotaUntil || 0)),
                pausedUntil: lane ? Number(lane.cooldownUntil || 0) : Number(state.pausedUntil || 0)
            };
        };

        const available = nonDisabled
            .map(state => ({ state, ...statusFor(state) }))
            .filter(entry => entry.dailyUntil <= now && entry.pausedUntil <= now)
            .sort((a, b) => {
                // Mai întâi proiectele mai puțin solicitate simultan, apoi cele
                // cu mai puține cereri în ultimul minut și, la egalitate, cele
                // folosite cel mai demult. Rezervările împiedică procesările
                // concurente să aleagă toate aceeași cheie înainte de start.
                const aLoad = a.lane.activeRequests + a.lane.reservations;
                const bLoad = b.lane.activeRequests + b.lane.reservations;
                if (aLoad !== bLoad) return aLoad - bLoad;
                const aRecent = getRecentProjectRequestCount(a.lane, now);
                const bRecent = getRecentProjectRequestCount(b.lane, now);
                if (aRecent !== bRecent) return aRecent - bRecent;
                if (a.lane.lastSelectedAt !== b.lane.lastSelectedAt) {
                    return a.lane.lastSelectedAt - b.lane.lastSelectedAt;
                }
                return a.lane.selections - b.lane.selections;
            });

        if (available.length) {
            const selected = available[0].state;
            const lane = getLaneForKeyState(selected);
            lane.reservations++;
            lane.selections++;
            lane.lastSelectedAt = now;
            lane.lastTouchedAt = now;
            selected._pendingGlobalReservations = Number(selected._pendingGlobalReservations || 0) + 1;
            selected.lastUsed = now;
            // Sincronizăm starea locală cu pauza globală a acestei chei/proiect.
            selected.pausedUntil = Number(lane.cooldownUntil || 0);
            selected.dailyQuotaUntil = Math.max(Number(selected.dailyQuotaUntil || 0), lane.dailyQuotaUntil);
            return selected;
        }

        const dailyBlocked = nonDisabled
            .map(state => ({ state, ...statusFor(state) }))
            .filter(entry => entry.dailyUntil > now);
        if (nonDisabled.length > 0 && dailyBlocked.length === nonDisabled.length) {
            const nextReset = Math.min(...dailyBlocked.map(entry => entry.dailyUntil));
            const error = new Error(`429: Cota zilnică Gemini este epuizată pentru toate proiectele disponibile; următoarea resetare estimată este ${new Date(nextReset).toISOString()}. Oprire fără reîncercări inutile.`);
            error.isRateLimit429 = true;
            error.isDailyQuota429 = true;
            error.isPermanentQuotaBlock = true;
            throw error;
        }

        const waitingEntries = nonDisabled
            .map(state => ({ state, ...statusFor(state) }))
            .filter(entry => entry.dailyUntil <= now && entry.pausedUntil > now);

        if (!waitingEntries.length) {
            throw new Error('Toate proiectele Gemini configurate sunt dezactivate sau blocate de cotă.');
        }

        // Pauza globală este justificată numai după ce NU mai există niciun
        // proiect eligibil în pool. O singură cheie limitată nu oprește celelalte.
        updateGlobal429GateIfPoolExhausted(keyStates, { log: true });
        const nextAvailableAt = Math.min(...waitingEntries.map(entry => entry.pausedUntil));
        keyStates._global429Until = nextAvailableAt;
        await waitFor429Gate(keyStates);
    }
}

async function callGemini(prompt, keyState, options = {}) {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME}:generateContent`;
    const timeout = Number.isInteger(options.timeout) ? options.timeout : 120000;
    const responseSchema = options.responseSchema || {
        type: 'ARRAY',
        minItems: 1,
        items: {
            type: 'OBJECT',
            properties: {
                id: { type: 'INTEGER' },
                text: { type: 'STRING' }
            },
            required: ['id', 'text'],
            propertyOrdering: ['id', 'text']
        }
    };

    // SubStudio folosește nivelul de gândire MEDIUM pentru motoarele Gemini 3.
    // Gemini 3.5 Flash-Lite îl suportă; parametrul temperature este omis deoarece
    // documentația Gemini 3.5 îl marchează drept depreciat/ignorat pentru aceste modele.
    // Fallback-ul plainText este folosit numai când Grammar Review returnează
    // JSON invalid chiar și pentru o singură replică. Toate cererile obișnuite
    // păstrează schema JSON existentă.
    const generationConfig = options.plainText
        ? {}
        : {
            responseMimeType: 'application/json',
            responseSchema
        };
    // Implicit, păstrăm MEDIUM pentru apelurile normale (în special traducere).
    // O etapă poate trece thinkingLevel: null pentru a lăsa modelul să folosească
    // nivelul implicit. Grammar Review folosește această excepție.
    const thinkingLevel = Object.prototype.hasOwnProperty.call(options, 'thinkingLevel')
        ? options.thinkingLevel
        : 'MEDIUM';
    if (/^gemini-3(?:\.|-)/i.test(String(MODEL_NAME)) && typeof thinkingLevel === 'string' && thinkingLevel) {
        generationConfig.thinkingConfig = { thinkingLevel };
    }

    // Permisul este la nivelul procesului, nu al unei singure subtitrări.
    // Fiecare cheie are și o bandă globală de proiect: active, rezervări,
    // frecvență recentă și pauză după 429. Cheia nu este logată sau păstrată
    // ca identificator în selector.
    let releaseGeminiSlot = null;
    let lane = getLaneForKeyState(keyState);
    let laneRequestStarted = false;
    try {
        releaseGeminiSlot = await acquireGeminiRequestSlot();
        lane = getLaneForKeyState(keyState);
        const preflightNow = Date.now();
        const laneDailyUntil = lane ? Number(lane.dailyQuotaUntil || 0) : Number(keyState.dailyQuotaUntil || 0);
        const laneCooldownUntil = lane ? Number(lane.cooldownUntil || 0) : Number(keyState.pausedUntil || 0);
        if (keyState.disabled || lane?.disabled || laneDailyUntil > preflightNow || laneCooldownUntil > preflightNow) {
            const blockedUntil = laneDailyUntil > preflightNow ? laneDailyUntil : laneCooldownUntil;
            const error = new Error(
                laneDailyUntil > preflightNow
                    ? '429: Proiectul selectat a fost marcat între timp cu o cotă zilnică epuizată; selectorul va alege alt proiect.'
                    : '429: Proiectul selectat a intrat în pauză înainte de pornirea cererii; selectorul va alege alt proiect.'
            );
            error.isRateLimit429 = true;
            error.isProjectQuota429 = true;
            error.isDailyQuota429 = laneDailyUntil > preflightNow;
            error.retryAfterMs = Math.max(1000, blockedUntil - preflightNow);
            throw error;
        }
        consumeGlobalKeyReservation(keyState);
        if (lane) {
            lane.activeRequests++;
            lane.lastRequestAt = Date.now();
            lane.lastTouchedAt = lane.lastRequestAt;
            lane.recentRequestStarts.push(lane.lastRequestAt);
            getRecentProjectRequestCount(lane, lane.lastRequestAt);
            laneRequestStarted = true;
        }
        const response = await axios.post(
            endpoint,
            {
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig,
                safetySettings: [
                    { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
                    { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
                    { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
                    { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' }
                ]
            },
            { params: { key: keyState.key }, timeout, headers: { 'Content-Type': 'application/json' } }
        );

        const raw = response.data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
        if (!raw.trim()) throw new Error('Gemini a returnat conținut gol.');
        keyState.failures = 0;
        noteGeminiRequestSuccess(keyState);
        return raw;
    } catch (error) {
        const status = error.response?.status;
        if (status === 401 || status === 403) {
            keyState.disabled = true;
            const invalidLane = getLaneForKeyState(keyState);
            if (invalidLane) invalidLane.disabled = true;
            throw new Error(`Cheie Gemini invalidă (${status}).`);
        }
        if (status === 429) {
            const quotaInfo = classifyGeminiQuotaError(error);
            lane = getLaneForKeyState(keyState);
            // Backoff-ul progresiv este separat pentru fiecare proiect, nu pentru
            // întregul pool: 15, 30, 60, apoi 120s (+ jitter), dacă Google nu dă
            // Retry-After/RetryInfo explicit.
            const project429Count = Number(lane?.consecutive429 || 0);
            const fallbackCooldown = Math.min(120000, 15000 * Math.pow(2, Math.min(3, project429Count))) + Math.floor(Math.random() * 1500);
            const cooldownMs = extractGeminiRetryDelayMs(error, fallbackCooldown);
            keyState.pausedUntil = Math.max(Number(keyState.pausedUntil || 0), Date.now() + cooldownMs);
            if (quotaInfo.kind === 'daily') keyState.dailyQuotaUntil = Math.max(Number(keyState.dailyQuotaUntil || 0), getNextPacificMidnightMs());
            registerGlobalGemini429(cooldownMs, quotaInfo.kind, keyState);

            const providerMessage = quotaInfo.message;
            const details = providerMessage ? ` Detaliu Google: ${providerMessage}` : '';
            const structuredDetails = quotaInfo.detailsText ? ` Detalii cotă: ${quotaInfo.detailsText}` : '';
            const diagnosis = quotaInfo.kind === 'daily'
                ? 'limită zilnică indicată explicit de metadatele Google'
                : quotaInfo.kind === 'rate'
                    ? 'limită de frecvență indicată de metadatele Google'
                    : 'tipul exact al cotei nu este precizat de răspunsul Google';
            console.log(`${c.yellow}ℹ [Gemini Diagnostic] 429: ${diagnosis}.${structuredDetails}${quotaInfo.kind === 'daily' ? ` Cheia curentă este pusă în pauză până la resetarea estimată ${new Date(keyState.dailyQuotaUntil).toISOString()}.` : ''}${c.reset}`);

            const retryError = new Error(`Limită Gemini 429; pauză ${Math.ceil(cooldownMs / 1000)}s.${details}${structuredDetails}`);
            retryError.isRateLimit429 = true;
            retryError.isProjectQuota429 = /resource has been exhausted|quota/i.test(providerMessage);
            retryError.isDailyQuota429 = quotaInfo.kind === 'daily';
            retryError.quotaKind = quotaInfo.kind;
            retryError.retryAfterMs = cooldownMs;
            retryError.providerMessage = providerMessage;
            throw retryError;
        }
        if (Number.isInteger(status) && status >= 500 && status <= 599) {
            registerGlobalGemini5xx(status);
        }
        throw error;
    } finally {
        if (laneRequestStarted && lane) {
            lane.activeRequests = Math.max(0, lane.activeRequests - 1);
            lane.lastTouchedAt = Date.now();
        } else if (keyState && Number(keyState._pendingGlobalReservations || 0) > 0) {
            // Dacă apelul nu a ajuns să pornească după rezervare, nu lăsăm un
            // slot fantomă să influențeze selecția globală.
            consumeGlobalKeyReservation(keyState);
        }
        if (releaseGeminiSlot) releaseGeminiSlot();
    }
}

// ============================================================
// SAFE JSON PARSER (SANITIZER)
// ============================================================

function safeJsonParse(rawText) {
    let clean = String(rawText || '').replace(/^\uFEFF/, '').trim();

    clean = clean.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

    const firstObject = clean.indexOf('{');
    const firstArray = clean.indexOf('[');
    let startIdx = -1;
    let opener = '';
    if (firstObject >= 0 && (firstArray < 0 || firstObject < firstArray)) {
        startIdx = firstObject;
        opener = '{';
    } else if (firstArray >= 0) {
        startIdx = firstArray;
        opener = '[';
    }
    const closer = opener === '[' ? ']' : '}';
    const endIdx = startIdx >= 0 ? clean.lastIndexOf(closer) : -1;
    if (startIdx >= 0 && endIdx > startIdx) clean = clean.slice(startIdx, endIdx + 1);

    function sanitize(input) {
        let out = '';
        let inString = false;
        let escaped = false;

        for (let i = 0; i < input.length; i++) {
            const ch = input[i];

            if (!inString) {
                if (ch === '“' || ch === '”') { out += '"'; inString = true; escaped = false; continue; }
                out += ch;
                if (ch === '"') { inString = true; escaped = false; }
                continue;
            }

            if (escaped) {
                if ('"\\/bfnrt'.includes(ch)) out += '\\' + ch;
                else if (ch === 'u' && /^[0-9a-fA-F]{4}$/.test(input.slice(i + 1, i + 5))) {
                    out += '\\u' + input.slice(i + 1, i + 5); i += 4;
                } else {
                    out += '\\\\' + ch;
                }
                escaped = false;
                continue;
            }

            if (ch === '\\') { escaped = true; continue; }
            if (ch === '"' || ch === '”') { out += '"'; inString = false; continue; }
            if (ch === '\n') { out += '\\n'; continue; }
            if (ch === '\r') { out += '\\r'; continue; }
            if (ch === '\t') { out += '\\t'; continue; }
            if (ch.charCodeAt(0) < 0x20) { out += ' '; continue; }
            out += ch;
        }
        if (escaped) out += '\\\\';
        return out;
    }

    function repairStructure(input) {
        let x = input;
        x = x.replace(/([{,]\s*)([A-Za-z0-9_-]+)(\s*:)/g, '$1"$2"$3');
        x = x.replace(/,\s*([}\]])/g, '$1');
        x = x.replace(/([}\]"\d])\s*\n\s*("[^"\n]+"\s*:)/g, '$1,\n$2');
        x = x.replace(/("(?:\\.|[^"\\])*")\s+("[^"\n]+"\s*:)/g, '$1, $2');
        return x;
    }

    const candidates = [];
    const base = sanitize(clean);
    candidates.push(base);
    candidates.push(repairStructure(base));
    candidates.push(repairStructure(base.replace(/[“”„]/g, '"')));

    for (const candidate of candidates) {
        try { return JSON.parse(candidate); } catch (_) {}
    }

    const relaxed = candidates[candidates.length - 1].replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ');
    try { return JSON.parse(relaxed); } catch (err) {
        throw new Error(`JSON Parse failed: ${err.message}`);
    }
}

// ============================================================
// CHUNK ENGINE CU RETRY, RE-SPLIT SI VERIFICARE ENGLEZA
// ============================================================

function chunkArray(array, size) {
    const chunks = [];
    for (let i = 0; i < array.length; i += size) {
        chunks.push(array.slice(i, i + size));
    }
    return chunks;
}

// Detectează local un tipar statistic puternic în care textele traduse ale mai
// multor ID-uri seamănă, ca lungime și structură de cuvinte, cu replicile EN
// imediat precedente/următoare, nu cu originalele lor. Este un semnal de alarmă,
// nu o dovadă semantică; de aceea declanșează retraducere, nu mutarea textelor.
const ALIGNMENT_WINDOW_SIZE = 28;
const ALIGNMENT_WINDOW_STEP = 8;
const ALIGNMENT_REPAIR_CHUNK_SIZE = 35;

function alignmentTextMetrics(text) {
    const clean = String(text || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    return {
        chars: clean.length,
        words: (clean.match(/[\p{L}\p{N}]+/gu) || []).length
    };
}

function alignmentPearson(pairs) {
    if (pairs.length < 18) return null;
    const xs = pairs.map(pair => pair[0]);
    const ys = pairs.map(pair => pair[1]);
    const meanX = xs.reduce((sum, value) => sum + value, 0) / xs.length;
    const meanY = ys.reduce((sum, value) => sum + value, 0) / ys.length;
    let numerator = 0;
    let sumX = 0;
    let sumY = 0;
    for (let i = 0; i < pairs.length; i++) {
        const dx = xs[i] - meanX;
        const dy = ys[i] - meanY;
        numerator += dx * dy;
        sumX += dx * dx;
        sumY += dy * dy;
    }
    const denominator = Math.sqrt(sumX * sumY);
    return denominator > 0 ? numerator / denominator : null;
}

function scoreAlignmentWindow(sourceItems, targetById, start, end, offset) {
    const charPairs = [];
    const wordPairs = [];
    for (let index = start; index <= end; index++) {
        const target = String(targetById.get(String(sourceItems[index].id)) || '');
        const targetMetrics = alignmentTextMetrics(target);
        // Ignorăm blocurile goale și foarte scurte, care nu oferă semnal util.
        if (targetMetrics.chars < 5 || targetMetrics.words < 1) continue;
        const sourceIndex = index + offset;
        if (sourceIndex < 0 || sourceIndex >= sourceItems.length) continue;
        const sourceMetrics = alignmentTextMetrics(sourceItems[sourceIndex].text);
        if (sourceMetrics.chars < 5 || sourceMetrics.words < 1) continue;
        charPairs.push([sourceMetrics.chars, targetMetrics.chars]);
        wordPairs.push([sourceMetrics.words, targetMetrics.words]);
    }

    if (charPairs.length < 18) return { score: null, pairs: charPairs.length };
    const correlations = [alignmentPearson(charPairs), alignmentPearson(wordPairs)]
        .filter(value => value !== null && Number.isFinite(value));
    if (!correlations.length) return { score: null, pairs: charPairs.length };
    return {
        score: correlations.reduce((sum, value) => sum + value, 0) / correlations.length,
        pairs: charPairs.length
    };
}

function detectTranslationAlignmentShift(sourceItems, translatedItems) {
    if (!Array.isArray(sourceItems) || sourceItems.length < ALIGNMENT_WINDOW_SIZE + ALIGNMENT_WINDOW_STEP) return null;
    const targetById = new Map((translatedItems || []).map(item => [String(item.id), String(item.text || '')]));
    const offsets = [-2, -1, 0, 1, 2];
    const hits = [];

    for (let start = 0; start + ALIGNMENT_WINDOW_SIZE <= sourceItems.length; start += ALIGNMENT_WINDOW_STEP) {
        const end = start + ALIGNMENT_WINDOW_SIZE - 1;
        const scores = Object.create(null);
        for (const offset of offsets) {
            scores[offset] = scoreAlignmentWindow(sourceItems, targetById, start, end, offset);
        }
        const baseline = scores[0].score;
        const alternatives = offsets.filter(offset => offset !== 0 && scores[offset].score !== null);
        if (!alternatives.length) continue;
        alternatives.sort((a, b) => scores[b].score - scores[a].score);
        const shift = alternatives[0];
        const best = scores[shift].score;
        const base = baseline === null ? 0 : baseline;
        if (best >= 0.80 && best - base >= 0.35 && scores[shift].pairs >= 18) {
            hits.push({ start, end, shift, score: best, baseline: base });
        }
    }

    if (!hits.length) return null;
    const clusters = [];
    for (const hit of hits) {
        const previous = clusters[clusters.length - 1];
        if (previous && previous.shift === hit.shift && hit.start <= previous.end + ALIGNMENT_WINDOW_STEP) {
            previous.start = Math.min(previous.start, hit.start);
            previous.end = Math.max(previous.end, hit.end);
            previous.hits.push(hit);
        } else {
            clusters.push({ start: hit.start, end: hit.end, shift: hit.shift, hits: [hit] });
        }
    }

    const supported = clusters.filter(cluster => {
        if (cluster.hits.length >= 2 && cluster.end - cluster.start + 1 >= 36) return true;
        const hit = cluster.hits[0];
        return cluster.hits.length === 1 && hit.score >= 0.94 && hit.score - hit.baseline >= 0.55;
    });
    if (!supported.length) return null;
    supported.sort((a, b) => {
        const spanA = a.end - a.start + 1;
        const spanB = b.end - b.start + 1;
        return (b.hits.length * spanB) - (a.hits.length * spanA);
    });
    const chosen = supported[0];
    return {
        start: chosen.start,
        end: chosen.end,
        shift: chosen.shift,
        windows: chosen.hits.length,
        score: chosen.hits.reduce((sum, hit) => sum + hit.score, 0) / chosen.hits.length,
        baseline: chosen.hits.reduce((sum, hit) => sum + hit.baseline, 0) / chosen.hits.length
    };
}

function canRetranslateAlignmentItem(item) {
    const source = String(item?.text || '').trim();
    if (!source || isEffectivelyEmptySubtitleText(source) || isJunkOrInterjection(source)) return false;
    // Formatterul curent elimină cifrele și punctuația fără litere; nu repetăm
    // cereri pentru coduri numerice pe care ieșirea nu le poate păstra oricum.
    return /[\p{L}]/u.test(source);
}

async function repairTranslationAlignmentRange(sourceChunk, currentResult, detection, allItems,
    absoluteChunkStart, keyStates, globalChunkIndex, totalChunks) {
    const start = Math.max(0, detection.start - 2);
    const end = Math.min(sourceChunk.length - 1, detection.end + 2);
    const currentById = new Map((currentResult || []).map(item => [String(item.id), String(item.text || '')]));
    const replacementById = new Map();
    let index = start;

    while (index <= end) {
        if (!canRetranslateAlignmentItem(sourceChunk[index])) {
            index++;
            continue;
        }
        const runStart = index;
        while (index <= end && index - runStart < ALIGNMENT_REPAIR_CHUNK_SIZE && canRetranslateAlignmentItem(sourceChunk[index])) {
            index++;
        }
        const piece = sourceChunk.slice(runStart, index);
        if (!piece.length) continue;
        const absoluteStart = absoluteChunkStart + runStart;
        const repaired = await processChunkWithRetry(
            piece,
            allItems,
            absoluteStart,
            absoluteStart + piece.length,
            [],
            keyStates,
            globalChunkIndex,
            totalChunks,
            0,
            true
        );
        for (const item of repaired) replacementById.set(String(item.id), String(item.text || ''));
    }

    return sourceChunk.map(item => {
        const id = String(item.id);
        if (replacementById.has(id)) return { id: item.id, text: replacementById.get(id) };
        return { id: item.id, text: currentById.get(id) || ' ' };
    });
}

function isJunkOrInterjection(text) {
    const clean = String(text || '').replace(/<[^>]+>/g, '').trim();
    if (!clean) return true;

    // Marcatori goi/tehnici care nu reprezintă dialog real. Sunt ignorați
    // complet de verificările de traducere, ca să nu apară în loguri ca suspecți.
    if (/^[\s0-9\-–—._,;:!?…'"~^`´‚„“”‘’()\[\]{}|\\/♪♫♬♩#]+$/.test(clean)) return true;

    if (/^(?:[-–—\s]*)(ah|oh|uh|agh|aâ|aoleu|ăă|mhm|îhî|ugh|argh|aah|oof|uf|shh|psst|sh)[!.,?\s-]*$/i.test(clean)) return true;
    if (isOnlyStandaloneFillerSequence(clean)) return true;
    return false;
}

function hasUntranslatedEnglish(original, translated) {
    if (!original || !translated) return false;

    const origClean = String(original).replace(/<[^>]+>/g, '').trim();
    const transClean = String(translated).replace(/<[^>]+>/g, '').trim();
    if (isJunkOrInterjection(origClean) || !transClean || transClean.length <= 2) return false;

    const normalize = value => String(value)
        .toLowerCase().replace(/[“”„"’']/g, "'").replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim();
    const originalNorm = normalize(origClean);
    const translatedNorm = normalize(transClean);

    const strongEnglish = new Set([
        'the','and','but','if','then','than','they','them','their','we','us','our','you','your','he','him','his','she','her','it','its',
        'this','that','these','those','what','which','who','where','when','why','how','with','from','into','onto','about','after','before',
        'without','against','between','through','because','while','would','could','should','will','shall','can','cannot','do','does','did',
        'have','has','had','not',"don't","isn't","won't","can't","didn't",'please','sorry','thanks','thank','yes','okay','ok',
        'for','of','in','on','at','to','by','as'
    ]);
    const englishMarkers = new Set([...strongEnglish,
        'need','needs','needed','want','wants','wanted','know','knows','knew','think','thought','mean','means','look','looks','looked',
        'make','makes','made','get','gets','got','go','goes','went','come','comes','came','take','takes','took','give','gives','gave',
        'see','sees','saw','say','says','said','tell','tells','told','find','finds','found','leave','leaves','left','keep','keeps','kept',
        'disregard','forget','ignore','remember','good','bad','right','wrong','now','here','there','very','really','just','only','still',
        'already','first','last','next','back','again','colonel','minutes','ready','killed','enough','nothing','maybe','little','well','sure',
        'itself','himself','herself','themselves','myself','yourself','such','indictment','however','although','though','perhaps','rather','still',
        // Cuvinte englezești izolate care au fost observate în output și care
        // nu sunt forme românești valide. Sunt folosite doar ca semnal de control.
        'innate'
    ]);

    const tokenize = value => value.match(/[a-zăâîșț]+(?:'[a-zăâîșț]+)?/g) || [];
    const tw = tokenize(translatedNorm);
    const ow = tokenize(originalNorm);

    const namedTitle = /\b(?:The\s+[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,5}|Nobody\s+Beats\s+the\s+Wiz)\b/.test(transClean);
    const romanianSignals = /\b(?:și|să|se|este|sunt|era|erau|nu|da|că|ca|cu|de|din|în|pe|la|un|o|eu|tu|el|ea|noi|voi|ei|ele|mai|foarte|pentru|dar|sau|care|ce|cine|cum|unde|când|aici|acolo|trebuie|poate|fost|avea|am|ai|are|au|mă|te|îl|îi|mi|ți|lor|lui|mea|ta|tău|meu)\b/i;

    if (originalNorm === translatedNorm) {
        if (namedTitle && !romanianSignals.test(transClean) && tw.length <= 8) return false;
        const strong = tw.filter(w => strongEnglish.has(w)).length;
        const markers = tw.filter(w => englishMarkers.has(w)).length;
        if (strong >= 1 || markers >= 2) return true;
        if (tw.length >= 5 && markers >= 2) return true;
        return false;
    }

    const distinctive = new Set(['the','from','however','although','because','without','between','maybe','please','sorry','thanks','thank','your','would','could','should','cannot','itself','such','indictment']);
    const distinctiveHits = tw.filter(w => distinctive.has(w));

    // Protejează numele proprii păstrate intenționat din original, inclusiv
    // nume de forma „Tyler, the Creator”. Dacă secvența englezească apare
    // identic și în ORIGINAL și este clar parte dintr-un nume propriu, nu o
    // marca drept cuvânt netradus.
    const properNameMatches = transClean.match(/\b[A-Z][A-Za-zÀ-ÖØ-öø-ÿ]+(?:\s+[A-Z][A-Za-zÀ-ÖØ-öø-ÿ]+){0,3}(?:,\s*the\s+[A-Z][A-Za-zÀ-ÖØ-öø-ÿ]+)?\b/g) || [];
    const hasPreservedProperName = properNameMatches.some(name => {
        const normalizedName = normalize(name);
        return normalizedName.length >= 4 && originalNorm.includes(normalizedName);
    });

    if (distinctiveHits.length) {
        if (hasPreservedProperName && distinctiveHits.every(w => w === 'the' || w === 'a' || w === 'an')) return false;
        if (namedTitle && distinctiveHits.every(w => w === 'the' || w === 'a' || w === 'an')) return false;
        return true;
    }

    if (tw.length <= 8) {
        const strong = tw.filter(w => strongEnglish.has(w)).length;
        const originalStrong = ow.filter(w => strongEnglish.has(w)).length;
        const originalMarkers = ow.filter(w => englishMarkers.has(w)).length;
        if (strong >= 2 && (originalStrong >= 1 || originalMarkers >= 2)) return true;

        const obviousPhrases = [
            /\b(need|want|know|think|look|come|go|get|take|give|tell|find|leave|keep)\s+(me|us|you|him|her|them|it)\b/,
            /\b(i|you|we|they|he|she)\s+(need|want|know|think|have|can|will|would|could|should)\b/,
            /\b(and|but|or)\s+(disregard|forget|ignore|remember)\b/
        ];
        if (obviousPhrases.some(rx => rx.test(translatedNorm))) return true;
    }

    if (tw.length >= 4) {
        const markerCount = tw.filter(w => englishMarkers.has(w)).length;
        const strongCount = tw.filter(w => strongEnglish.has(w)).length;
        const ratio = markerCount / tw.length;
        if (markerCount >= 5 && ratio >= 0.30) return true;
        if (strongCount >= 3 && ratio >= 0.35) return true;
    }
    return false;
}

function hasCorruptedSubtitleText(text, originalText) {
    if (isJunkOrInterjection(originalText)) return false;

    const s = String(text || '').replace(/<[^>]+>/g, '').trim();
    if (!s) return true;
    if (/^(?:[-–—\s.?!,;:'"])+$/.test(s)) return true;
    if (/[\u0400-\u04FF\u4E00-\u9FFF\u3040-\u30FF]/.test(s)) return true;

    return false;
}

// ============================================================
// SOURCE-TERM FIDELITY GUARD — TERMENI ANATOMICI EXPLICIȚI
// Adaugă o verificare conservatoare când sursa numește direct un organ.
// Nu înlocuiește formularea automat; doar declanșează o reverificare țintită
// și împiedică Grammar Review să accepte o rescriere care pierde termenul.
// ============================================================
const EXPLICIT_ANATOMICAL_TERM_GUARDS = [
    {
        label: 'vagina',
        source: /\bvagina(?:s)?\b/i,
        target: /vagin[\p{L}-]*/iu
    },
    {
        label: 'vulva',
        source: /\bvulva(?:s)?\b/i,
        target: /vulv[\p{L}-]*/iu
    },
    {
        label: 'clitoris',
        source: /\bclitoris\b|\bclitoral\b/i,
        target: /clitor[\p{L}-]*/iu
    },
    {
        label: 'penis',
        source: /\bpenis(?:es)?\b/i,
        target: /(?:^|[^\p{L}])(?:penis[\p{L}-]*|pul(?:ă|a|ii|ile|e|ului))(?=$|[^\p{L}])/iu
    },
    {
        label: 'breasts/boobs/tits',
        source: /\bbreasts?\b|\bboobs?\b|\btits?\b/i,
        target: /(?:^|[^\p{L}])(?:sân(?:ul|ului|i|ii|ilor)?|țâț[\p{L}-]*|tâț[\p{L}-]*)(?=$|[^\p{L}])/iu
    },
    {
        label: 'nipples',
        source: /\bnipples?\b/i,
        target: /sfârc[\p{L}-]*|mamel[\p{L}-]*/iu
    }
];

function getMissingExplicitAnatomicalTerms(original, translation) {
    const sourceText = String(original || '').replace(/<[^>]+>/g, ' ');
    const translatedText = String(translation || '').replace(/<[^>]+>/g, ' ');
    if (!sourceText.trim() || !translatedText.trim()) return [];

    return EXPLICIT_ANATOMICAL_TERM_GUARDS
        .filter(rule => {
            if (!rule.source.test(sourceText) || rule.target.test(translatedText)) return false;

            // În română, „silicoane” este o echivalare naturală pentru „breast implants”.
            // Nu forțăm adăugarea cuvântului „sâni” dacă originalul spune explicit
            // „breast implants” și traducerea transmite deja același sens.
            if (rule.label === 'breasts/boobs/tits' &&
                /\bbreast\s+implants?\b/i.test(sourceText) &&
                /\bsilicoan[\p{L}]*\b/iu.test(translatedText)) {
                return false;
            }

            return true;
        })
        .map(rule => rule.label);
}

function getSourceFidelityIssues(original, translation) {
    const sourceText = String(original || '').replace(/<[^>]+>/g, ' ');
    const targetText = String(translation || '').replace(/<[^>]+>/g, ' ');
    if (!sourceText.trim() || !targetText.trim()) return [];

    const issues = getMissingExplicitAnatomicalTerms(sourceText, targetText)
        .map(term => `termen explicit „${term}” absent sau înlocuit cu o formulare vagă`);
    const sourceNorm = sourceText.toLocaleLowerCase('en-US').replace(/\s+/g, ' ').trim();
    const targetNorm = targetText.toLocaleLowerCase('ro-RO').replace(/\s+/g, ' ').trim();

    // Semnale conservatoare pentru câteva forme românești evident suspecte.
    // Nu rescriem automat replica; post-check-ul o retrimite contextual.
    const obviousRomanianQualityGuards = [
        {
            pattern: /(?<![\p{L}])lucrura(?![\p{L}])/iu,
            message: 'posibilă eroare ortografică în forma „lucrura”'
        },
        {
            pattern: /(?<![\p{L}])acesa(?![\p{L}])/iu,
            message: 'posibilă eroare ortografică în forma „acesa”'
        },
        {
            pattern: /(?<![\p{L}])întregă(?![\p{L}])/iu,
            message: 'posibilă eroare de acord în forma „întregă”'
        },
        {
            pattern: /(?<![\p{L}])din\s+cauză\s+la(?![\p{L}])/iu,
            message: 'construcție gramaticală suspectă „din cauză la”'
        }
    ];
    for (const guard of obviousRomanianQualityGuards) {
        if (guard.pattern.test(targetNorm)) issues.push(guard.message);
    }

    // Relație semantică: „dries my vagina” numește vaginul ca obiect direct.
    // Prezența cuvântului „vagin” într-o construcție locativă nu este suficientă.
    if (/\b(?:dry|dries|dried|drying)\s+(?:my|your|her|his|their|the)\s+vagina\b/i.test(sourceNorm) &&
        /\b(?:mă|ma)\s+usuc[ăa]\s+(?:în|in|la)\s+vagin(?:ul)?\b/iu.test(targetNorm)) {
        issues.push('relație semantică greșită: „dry my vagina” a devenit „mă usucă în vagin” în locul unei construcții cu „vaginul” ca obiect direct');
    }

    // Conservă numărul gramatical pentru substantive uzuale de tip „hat/cap”.
    // Este activ doar când sursa are clar un singur obiect numărabil.
    const hasSingularHatSource = /\b(?:a|an|one)\s+(?:(?:[a-z]+)\s+){0,2}(?:hat|cap|beanie|bonnet)\b/i.test(sourceNorm);
    const sourceAlsoNamesPluralHats = /\b(?:hats|caps|beanies|bonnets)\b/i.test(sourceNorm);
    if (hasSingularHatSource && !sourceAlsoNamesPluralHats) {
        const pluralHat = /(?<![\p{L}\p{N}_])(?:căciuli(?:le)?|caciuli(?:le)?|căciulițe|caciulite|șepci|sepci|fesuri|bonete|pălării|palarii)(?![\p{L}\p{N}_])/iu.test(targetNorm);
        const singularHat = /(?<![\p{L}\p{N}_])(?:căciulă|caciula|căciuliță|caciulita|șapcă|sapca|fes|bonetă|boneta|pălărie|palarie)(?![\p{L}\p{N}_])/iu.test(targetNorm);
        if (pluralHat && !singularHat) {
            issues.push('număr gramatical schimbat: un obiect singular „hat/cap/beanie” a fost tradus la plural');
        }
        const diminutivesWithoutSourceCue = /(?<![\p{L}\p{N}_])(?:căciuliță|caciulita|șepcuță|sepcuta)(?![\p{L}\p{N}_])/iu.test(targetNorm) &&
            !/\b(?:little|small|tiny|miniature|cute|baby|adorable)\b/i.test(sourceNorm);
        if (diminutivesWithoutSourceCue) {
            issues.push('diminutiv introdus fără suport evident în sursă');
        }
    }

    // NU folosim o euristică generică de tipul „sursa conține o negație, iar
    // traducerea nu conține «nu/nici»”. Aceasta produce alarme false pentru
    // propoziții reformulate firesc în română și pentru replici împărțite între
    // blocuri. O posibilă pierdere de sens nu se deduce doar din absența unui
    // marcator lexical; rămân active verificările de engleză netradusă,
    // text corupt și regulile semantice înguste, legate de expresii concrete.

    // „following orders” înseamnă a urma/a executa ordinele, nu „ordinea de zi”.
    // Semnalăm numai combinația de sursă și traducere care indică precis acest
    // schimb de sens; remedierea se face prin retry-ul contextual deja existent.
    if (/\bfollow(?:ing|ed)?\s+(?:the\s+)?orders\b/i.test(sourceNorm) &&
        /(?<![\p{L}])(?:la\s+)?ordinea\s+(?:de\s+zi|zilei)(?![\p{L}])/iu.test(targetNorm)) {
        issues.push('expresia „following orders” pare tradusă cu sensul de „ordinea de zi”');
    }

    return issues;
}

function hasLostExplicitSourceTerm(original, translation) {
    // Păstrăm numele funcției pentru compatibilitate cu toate protecțiile existente,
    // dar verificarea acoperă acum și relația semantică și numărul, nu doar vocabularul.
    return getSourceFidelityIssues(original, translation).length > 0;
}

function applyBecauseOfWhatISaidCorrection(original, translation) {
    let text = String(translation || '');
    const sourceNorm = String(original || '').replace(/<[^>]+>/g, ' ').toLocaleLowerCase('en-US').replace(/\s+/g, ' ').trim();
    if (!/\bbecause of what i said\b/i.test(sourceNorm)) return text;
    return text.replace(/(?<![\p{L}])din\s+cauz[ăa]\s+la\s+ce(?![\p{L}])/iu, match => {
        const replacement = 'din cauza a ceea ce';
        if (match === match.toLocaleUpperCase('ro-RO')) return replacement.toLocaleUpperCase('ro-RO');
        return match[0] === match[0].toLocaleUpperCase('ro-RO')
            ? replacement.charAt(0).toLocaleUpperCase('ro-RO') + replacement.slice(1)
            : replacement;
    });
}

function applySourceGroundedSemanticFixes(original, translation) {
    let text = applyBecauseOfWhatISaidCorrection(original, translation);
    const sourceText = String(original || '').replace(/<[^>]+>/g, ' ');
    const sourceNorm = sourceText.toLocaleLowerCase('en-US').replace(/\s+/g, ' ').trim();

    // Reparație foarte îngustă, activată numai dacă engleza conține verbul tranzitiv
    // „dry + my/the vagina”. Nu schimbă alte utilizări ale lui „mă usucă”.
    if (/\b(?:dry|dries|dried|drying)\s+(?:my|the)\s+vagina\b/i.test(sourceNorm)) {
        text = text.replace(/\b(mă|ma)\s+usuc[ăa]\s+(?:în|in|la)\s+vagin(?:ul)?\b/giu, match => {
            const startsUpper = match[0] === match[0].toLocaleUpperCase('ro-RO');
            return startsUpper ? 'Îmi usucă vaginul' : 'îmi usucă vaginul';
        });
    }

    // Pentru un singur hat/cap/beanie în sursă, conservăm întâi numărul gramatical.
    // Normalizăm doar un mic set de echivalente evidente pentru acoperământul de cap.
    const hasSingularHatSource = /\b(?:a|an|one)\s+(?:(?:[a-z]+)\s+){0,2}(?:hat|cap|beanie|bonnet)\b/i.test(sourceNorm);
    const sourceAlsoNamesPluralHats = /\b(?:hats|caps|beanies|bonnets)\b/i.test(sourceNorm);
    const hasDiminutiveCue = /\b(?:little|small|tiny|miniature|cute|baby|adorable)\b/i.test(sourceNorm);
    if (hasSingularHatSource && !sourceAlsoNamesPluralHats) {
        const numberReplacements = [
            [/(?<![\p{L}\p{N}_])căciuli(?:le)?(?![\p{L}\p{N}_])/giu, 'căciulă'],
            [/(?<![\p{L}\p{N}_])caciuli(?:le)?(?![\p{L}\p{N}_])/giu, 'căciulă'],
            [/(?<![\p{L}\p{N}_])șepci(?![\p{L}\p{N}_])/giu, 'șapcă'],
            [/(?<![\p{L}\p{N}_])sepci(?![\p{L}\p{N}_])/giu, 'șapcă'],
            [/(?<![\p{L}\p{N}_])fesuri(?![\p{L}\p{N}_])/giu, 'fes'],
            [/(?<![\p{L}\p{N}_])bonete(?![\p{L}\p{N}_])/giu, 'bonetă'],
            [/(?<![\p{L}\p{N}_])pălării(?![\p{L}\p{N}_])/giu, 'pălărie'],
            [/(?<![\p{L}\p{N}_])palarii(?![\p{L}\p{N}_])/giu, 'pălărie']
        ];
        for (const [pattern, replacement] of numberReplacements) {
            text = text.replace(pattern, match => {
                const startsUpper = match[0] === match[0].toLocaleUpperCase('ro-RO');
                return startsUpper ? replacement[0].toLocaleUpperCase('ro-RO') + replacement.slice(1) : replacement;
            });
        }
        // Pluralul diminutivelor devine singular, păstrând diminutivul doar când sursa îl susține.
        if (hasDiminutiveCue) {
            text = text.replace(/(?<![\p{L}\p{N}_])căciulițe(?![\p{L}\p{N}_])/giu, 'căciuliță');
            text = text.replace(/(?<![\p{L}\p{N}_])caciulite(?![\p{L}\p{N}_])/giu, 'căciuliță');
            text = text.replace(/(?<![\p{L}\p{N}_])șepcuțe(?![\p{L}\p{N}_])/giu, 'șepcuță');
            text = text.replace(/(?<![\p{L}\p{N}_])sepcute(?![\p{L}\p{N}_])/giu, 'șepcuță');
        } else {
            text = text.replace(/(?<![\p{L}\p{N}_])căciulițe(?![\p{L}\p{N}_])/giu, 'căciulă');
            text = text.replace(/(?<![\p{L}\p{N}_])caciulite(?![\p{L}\p{N}_])/giu, 'căciulă');
            text = text.replace(/(?<![\p{L}\p{N}_])căciuliță(?![\p{L}\p{N}_])/giu, match => match[0] === match[0].toLocaleUpperCase('ro-RO') ? 'Căciulă' : 'căciulă');
            text = text.replace(/(?<![\p{L}\p{N}_])caciulita(?![\p{L}\p{N}_])/giu, match => match[0] === match[0].toLocaleUpperCase('ro-RO') ? 'Căciulă' : 'căciulă');
            text = text.replace(/(?<![\p{L}\p{N}_])șepcuțe(?![\p{L}\p{N}_])/giu, 'șapcă');
            text = text.replace(/(?<![\p{L}\p{N}_])sepcute(?![\p{L}\p{N}_])/giu, 'șapcă');
            text = text.replace(/(?<![\p{L}\p{N}_])șepcuță(?![\p{L}\p{N}_])/giu, match => match[0] === match[0].toLocaleUpperCase('ro-RO') ? 'Șapcă' : 'șapcă');
            text = text.replace(/(?<![\p{L}\p{N}_])sepcuta(?![\p{L}\p{N}_])/giu, match => match[0] === match[0].toLocaleUpperCase('ro-RO') ? 'Șapcă' : 'șapcă');
        }
    }

    // Corecții strict ancorate în sursă pentru erori de traducere demonstrate.
    // Se activează doar dacă originalul confirmă sensul; nu sunt reguli globale de vocabular.
    if (/\bresponse\b/i.test(sourceNorm) && /(?<![\p{L}])retrasul(?![\p{L}])/iu.test(text)) {
        text = text.replace(/(?<![\p{L}])retrasul(?![\p{L}])/iu, match =>
            match[0] === match[0].toLocaleUpperCase('ro-RO') ? 'Răspunsul' : 'răspunsul');
    }

    if (/\b(?:but\s+)?you(?:'re|\s+are)\s+not\s+sorry\b/i.test(sourceNorm) &&
        /(?<![\p{L}])nu\s+ești\s+(?:nici\s+)?părere\s+de\s+rău(?![\p{L}])/iu.test(text)) {
        text = text.replace(/(?<![\p{L}])nu\s+ești\s+(?:nici\s+)?părere\s+de\s+rău(?![\p{L}])/iu, match =>
            match[0] === match[0].toLocaleUpperCase('ro-RO') ? 'Nu-ți pare rău' : 'nu-ți pare rău');
    }

    if (/\bshould\s+at\s+least\s+tell\b/i.test(sourceNorm)) {
        text = text.replace(/(?<![\p{L}])ar\s+trebui\s+măcar\s+(le|îi|mi|ne|vă|te|mă)\s+(spunem|spun|zicem|dăm|dau|spunem|anunțăm|anuntam)(?![\p{L}])/iu,
            (match, pronoun, verb) => {
                const corrected = `ar trebui măcar să ${pronoun.toLocaleLowerCase('ro-RO')} ${verb.toLocaleLowerCase('ro-RO')}`;
                return match[0] === match[0].toLocaleUpperCase('ro-RO')
                    ? corrected.charAt(0).toLocaleUpperCase('ro-RO') + corrected.slice(1)
                    : corrected;
            });
    }

    if (/\bcould\s+i\s+have\s+a\s+word\b/i.test(sourceNorm) &&
        /(?<![\p{L}])pot\s+să\s+vorbim(?![\p{L}])/iu.test(text)) {
        text = text.replace(/(?<![\p{L}])pot\s+să\s+vorbim(?![\p{L}])/iu, match =>
            match[0] === match[0].toLocaleUpperCase('ro-RO') ? 'Pot să vorbesc' : 'pot să vorbesc');
    }

    // Elimină engleza redundantă numai când aceeași informație a fost deja tradusă corect.
    if (/\boutnumbered\b/i.test(sourceNorm) && /\boutnumbered\b/i.test(text) &&
        /(?:depășiți numeric|în inferioritate numerică)/iu.test(text)) {
        text = text.replace(/(?<![\p{L}])([Ee]ram|[Ss]untem|[Ee]rau)\s+outnumbered\s*(?:[.!?…]{1,3})?\s*\1\s+/iu, '$1 ');
        text = text.replace(/\s{2,}/g, ' ').replace(/\s+([,.!?;:])/g, '$1').trim();
    }

    return text;
}

function normalizeTranslationPayload(parsed) {
    if (Array.isArray(parsed)) {
        const dict = Object.create(null);
        for (const item of parsed) {
            if (!item || item.id === undefined) continue;
            dict[String(item.id)] = item.text === undefined ? '' : String(item.text);
        }
        return dict;
    }
    if (parsed && typeof parsed === 'object') {
        const source = parsed.translations && typeof parsed.translations === 'object'
            ? parsed.translations
            : parsed;
        return source;
    }
    return Object.create(null);
}

async function processChunkWithRetry(chunk, allItems, chunkStart, chunkEnd, previousTranslatedContext, keyStates, globalChunkIndex, totalChunks, depth = 0, alignmentRepair = false) {
    const prompt = buildTranslationPrompt(chunk, allItems, chunkStart, chunkEnd, previousTranslatedContext);
    let lastError = null;

    // Rotație ca în v148: un 429 pune în pauză proiectul afectat, apoi selectorul
    // încearcă alte proiecte disponibile. Bugetul crește după primul 429 la cel
    // puțin trei treceri prin pool; 503 folosește retry-ul normal și poarta globală.
    const maxKeyAttempts = 8;
    const maxRateLimitAttempts = Math.max(8, keyStates.length * 3);
    let sawRateLimit429 = false;

    for (let attempt = 1; attempt <= (sawRateLimit429 ? maxRateLimitAttempts : maxKeyAttempts); attempt++) {
        let keyState = null;
        try {
            // Alegem proiectul la nivel global, ținând cont de toate traducerile
            // active în acest proces și evitând proiectele aflate în pauză după 429.
            keyState = await getAvailableKey(keyStates);

            if (alignmentRepair) {
                console.log(`${c.cyan}➤ [Aliniere] Retraduc segment punctual (${chunk.length} replici)...${c.reset}`);
            } else {
                console.log(`${c.cyan}➤ [Gemini] Traduc calup ${globalChunkIndex + 1}/${totalChunks}...${c.reset}`);
            }

            const raw = await callGemini(prompt, keyState);
            const parsed = JSON.parse(String(raw).trim());
            const dict = normalizeTranslationPayload(parsed);

            // Verificăm rezultatul DUPĂ același formatter care va fi folosit la ieșire.
            // Astfel, un răspuns format doar din ezitări/interjecții eliminate de formatter
            // este tratat drept gol și reparat în calupul curent, nu abia la Empty Recovery.
            // Cache-ul evită să rulăm formatterul repetat pentru aceeași valoare a aceluiași ID.
            const formattedTranslationCache = new Map();
            const getUsableFormattedTranslation = (id, value) => {
                if (value === undefined || value === null) return '';
                const raw = String(value);
                const cacheKey = String(id);
                const cached = formattedTranslationCache.get(cacheKey);
                if (cached && cached.raw === raw) return cached.formatted;

                if (!raw.replace(/<[^>]+>/g, '').trim()) {
                    formattedTranslationCache.set(cacheKey, { raw, formatted: '' });
                    return '';
                }

                let formatted = '';
                try {
                    formatted = formatSubtitleLine(raw);
                } catch (_) {
                    formatted = '';
                }
                if (!String(formatted || '').replace(/<[^>]+>/g, '').trim()) formatted = '';
                formattedTranslationCache.set(cacheKey, { raw, formatted });
                return formatted;
            };
            const hasUsableTranslation = (id, value) => Boolean(getUsableFormattedTranslation(id, value));

            const missingItems = chunk.filter(obj => !hasUsableTranslation(obj.id, dict[String(obj.id)]));
            if (missingItems.length > 12) {
                throw new Error(`Răspuns Gemini sever incomplet: ${missingItems.length} ID-uri lipsă sau cu traduceri goale.`);
            }
            if (missingItems.length) {
                console.log(`${c.yellow}⚠ [Gemini] Calupul ${globalChunkIndex + 1}: ${missingItems.length} ID-uri lipsă sau cu traducere goală. Cerere punctuală...${c.reset}`);
                const missingPrompt = `
${MASTER_TRANSLATION_PROMPT}

Returnează STRICT un ARRAY JSON valid pentru TOATE replicile de mai jos care lipsesc sau au primit text gol. Nu omite niciun ID și nu modifica ID-urile:
[
  {"id": 123, "text": "traducerea română"}
]

LINIILE LIPSĂ SAU GOALE:
${JSON.stringify(missingItems, null, 2)}
`;
                try {
                    const missingRaw = await callGemini(missingPrompt, keyState, { timeout: 20000 });
                    const missingJson = JSON.parse(String(missingRaw).trim());
                    const missingDict = normalizeTranslationPayload(missingJson);
                    for (const obj of missingItems) {
                        const value = missingDict[String(obj.id)];
                        if (hasUsableTranslation(obj.id, value)) dict[String(obj.id)] = value;
                    }
                } catch (missingError) {
                    const is429 = missingError?.isRateLimit429 === true || /\b429\b/i.test(String(missingError?.message || ''));
                    if (is429) {
                        register429(
                            keyStates,
                            Number(missingError.retryAfterMs) || 15000,
                            missingError.isProjectQuota429 === true
                        );
                    }
                    const quotaBlocked = markEmptyRecoveryQuotaBlock(keyStates, missingError);
                    console.log(`${c.yellow}  ⚠ [Gemini] Cererea punctuală a eșuat: ${missingError.message}${quotaBlocked ? ' Oprind alte cereri de recuperare din cauza limitei Gemini.' : ''}${c.reset}`);
                }
            }

            // Dacă cererea punctuală pentru întregul set tot a lăsat unele texte goale,
            // încercăm fiecare ID separat. Nu retrimitem calupul întreg și oprim la primul 429.
            let stillMissing = chunk.filter(obj => !hasUsableTranslation(obj.id, dict[String(obj.id)]));
            if (stillMissing.length && !keyStates._emptyRecoveryQuotaBlocked) {
                console.log(`${c.yellow}⚠ [Gemini] Calupul ${globalChunkIndex + 1}: ${stillMissing.length} ID-uri încă goale; încercări individuale...${c.reset}`);
                for (const item of stillMissing) {
                    if (keyStates._emptyRecoveryQuotaBlocked) break;
                    const singleResult = Object.create(null);
                    const recovered = await retryEmptyTranslationIndividually(
                        item, singleResult, keyStates, `Calup ${globalChunkIndex + 1} Empty Recovery`
                    );
                    if (recovered && hasUsableTranslation(item.id, singleResult[String(item.id)])) {
                        dict[String(item.id)] = singleResult[String(item.id)];
                    }
                }
            } else if (stillMissing.length && keyStates._emptyRecoveryQuotaBlocked) {
                console.log(`${c.yellow}⚠ [Gemini] Calupul ${globalChunkIndex + 1}: ${stillMissing.length} ID-uri rămân goale; cererile individuale sunt oprite din cauza cotei/429 și vor fi lăsate pentru etapa finală/locală.${c.reset}`);
            }

            stillMissing = chunk.filter(obj => !hasUsableTranslation(obj.id, dict[String(obj.id)]));
            if (stillMissing.length) {
                console.log(`${c.yellow}⚠ [Gemini] Calupul ${globalChunkIndex + 1}: rămân ${stillMissing.length} traduceri goale după recuperarea punctuală; vor fi verificate din nou după finalizarea calupurilor.${c.reset}`);
            }

            const results = chunk.map(obj => ({
                id: obj.id,
                // Un text gol rămâne detectabil de Empty Recovery; nu eșuăm și nu retrimitem tot calupul.
                text: getUsableFormattedTranslation(obj.id, dict[String(obj.id)]) || ' '
            }));

            // Verificările de limbă și fidelitate rulează o singură dată după toate calupurile,
            // unde pot corecta problemele contextual în loc să emită avertismente premature.

            const translatedCount = results.filter(item => String(item.text || '').trim()).length;
            if (alignmentRepair) {
                console.log(`${c.green}✔ [Aliniere] Segment punctual finalizat (${translatedCount}/${chunk.length} replici cu text).${c.reset}`);
            } else {
                console.log(`${c.green}✔ [Gemini] Calup ${globalChunkIndex + 1}/${totalChunks} finalizat! (${translatedCount}/${chunk.length} replici cu text)${c.reset}`);
            }
            return results;
        } catch (error) {
            lastError = error;
            const is429 = error.isRateLimit429 === true || error.message.includes('429');
            if (is429) sawRateLimit429 = true;
            if (is429 && keyState) {
                register429(
                    keyStates,
                    Number(error.retryAfterMs) || 15000,
                    error.isProjectQuota429 === true
                );
            }
            const isDailyQuotaBlocked = error.isPermanentQuotaBlock === true;
            const is5xx = /status code 5\d\d|\b5\d\d\b/.test(String(error.message || ''));
            const isEmptyProviderResponse = /Gemini a returnat conținut gol|empty content/i.test(String(error.message || ''));
            const isTransient = !isDailyQuotaBlocked && (is429 || is5xx || isEmptyProviderResponse);

            if (!isTransient) break;
            const retryLimit = sawRateLimit429 ? maxRateLimitAttempts : maxKeyAttempts;
            if (attempt < retryLimit && (is429 || is5xx || isEmptyProviderResponse)) {
                // Nu abandonăm calupul la primul 429: getAvailableKey rotește spre
                // următorul proiect disponibil, iar 503 respectă poarta comună.
                continue;
            }
        }
    }

    if (lastError?.isPermanentQuotaBlock) {
        throw lastError;
    }

    if (chunk.length > 20 && depth < 2) {
        console.log(`${c.yellow}⚠ [Gemini] Împart calupul ${globalChunkIndex + 1} în două părți imediat după eșec...${c.reset}`);

        const middle = Math.floor(chunk.length / 2);
        const first = chunk.slice(0, middle);
        const second = chunk.slice(middle);

        const firstResult = await processChunkWithRetry(first, allItems, chunkStart, chunkStart + middle, previousTranslatedContext, keyStates, globalChunkIndex, totalChunks, depth + 1, alignmentRepair);
        const secondContext = firstResult.slice(-PREVIOUS_TRANSLATION_CONTEXT);
        const secondResult = await processChunkWithRetry(second, allItems, chunkStart + middle, chunkEnd, secondContext, keyStates, globalChunkIndex, totalChunks, depth + 1, alignmentRepair);

        return [...firstResult, ...secondResult];
    }

    console.log(`${c.red}✖ [Gemini] Calupul ${globalChunkIndex + 1} a eșuat definitiv.${c.reset}`);
    throw lastError || new Error('Chunk translation failed.');
}

// ============================================================
// GLOBAL POST-CHECK + TARGETED RETRY
// ============================================================

function isOkOnlySubtitle(text) {
    const clean = String(text || '').replace(/<[^>]+>/g, '').trim();
    return /^(?:[-–—\s]*(?:ok|okay)(?:[.!?…]+)?[-–—\s]*)$/i.test(clean);
}

async function globalPostCheck(items, translatedById, keyStates, maxPasses = 1) {
    let totalFixed = 0;

    const findSuspicious = () => items.filter(item => {
        const originalClean = isEffectivelyEmptySubtitleText(item.text)
            ? ''
            : String(item.text || '').replace(/<[^>]+>/g, '').trim();
        if (!originalClean || isJunkOrInterjection(item.text)) return false;

        const translated = translatedById[String(item.id)];
        if (isOkOnlySubtitle(translated)) return false;
        const transClean = String(translated || '').replace(/<[^>]+>/g, '').trim();
        if (!transClean) return true;

        return hasUntranslatedEnglish(item.text, translated) ||
            hasCorruptedSubtitleText(translated, item.text) ||
            hasLostExplicitSourceTerm(item.text, translated);
    });

    console.log(`${c.cyan}[POST-CHECK] Verificare contextuală după finalizarea calupurilor...${c.reset}`);
    for (let pass = 1; pass <= maxPasses; pass++) {
        const suspicious = findSuspicious();

        if (!suspicious.length) {
            console.log(`${c.green}[POST-CHECK] Încheiat; ${totalFixed} corectări aplicate.${c.reset}`);
            return { fixed: totalFixed, remaining: [] };
        }

        // Toate replicile ce necesită intervenție sunt trimise împreună la verificarea
        // contextuală. Nu afișăm lista de suspiciuni; logul păstrează doar rezultatul.


        const before = new Map(suspicious.map(item => [
            String(item.id), String(translatedById[String(item.id)] || '')
        ]));
        const reasonById = Object.create(null);
        for (const item of suspicious) {
            const id = String(item.id);
            const current = translatedById[id] || '';
            const reasons = [];
            if (!String(current).trim()) reasons.push('traducere goală');
            if (hasUntranslatedEnglish(item.text, current)) reasons.push('posibil fragment englezesc netradus');
            if (hasCorruptedSubtitleText(current, item.text)) reasons.push('posibil text corupt');
            reasons.push(...getSourceFidelityIssues(item.text, current));
            reasonById[id] = [...new Set(reasons)].join('; ');
        }

        try {
            const reviewResult = await grammarTranslationReview(
                suspicious,
                translatedById,
                keyStates,
                {
                    mode: 'targeted',
                    contextItems: items,
                    reasonById
                }
            );
            totalFixed += Number(reviewResult?.fixed || 0);
        } catch (error) {
            console.log(`${c.yellow}[POST-CHECK] Verificarea grupată nu a putut fi terminată: ${String(error?.message || error).slice(0, 300)}${c.reset}`);
        }

        const remaining = findSuspicious();
        if (!remaining.length) {
            console.log(`${c.green}[POST-CHECK] Încheiat; ${totalFixed} corectări aplicate.${c.reset}`);
            return { fixed: totalFixed, remaining: [] };
        }

        const anyChanged = suspicious.some(item =>
            String(translatedById[String(item.id)] || '') !== before.get(String(item.id))
        );

        // Nu repetăm automat aceeași cerere fără progres: ar adăuga trafic și risc 429.
        if (!anyChanged) return { fixed: totalFixed, remaining };
    }

    const remaining = findSuspicious();
    console.log(`${c.green}[POST-CHECK] Încheiat; ${totalFixed} corectări aplicate.${c.reset}`);
    return { fixed: totalFixed, remaining };
}

// ============================================================
// FILTRU SUPLIMENTAR — GRAMATICĂ + CALITATEA TRADUCERII
// Rulează separat de mecanismul principal și aplică doar corecții certe.
// ============================================================

const GRAMMAR_REVIEW_BATCH_SIZE = 120;
const GRAMMAR_REVIEW_TIMEOUT_MS = 120000;
const GRAMMAR_REVIEW_TIMEOUT_RETRY_MS = 3000;
const GRAMMAR_REVIEW_JSON_RETRY_DELAY_MS = 1200;
const GRAMMAR_REVIEW_JSON_RETRY_LIMIT = 1;
// La eroare JSON se izolează prin split până la replică individuală, dacă este nevoie.
const GRAMMAR_REVIEW_JSON_SPLIT_MIN = 1;

function shouldSplitGrammarReviewBatch(batchLength, isJsonError, message) {
    return batchLength > GRAMMAR_REVIEW_JSON_SPLIT_MIN &&
        (Boolean(isJsonError) || /conținut gol|empty content/i.test(String(message || '')));
}

function cleanPlainTextReviewResponse(rawText) {
    let clean = String(rawText || '').trim();
    clean = clean.replace(/^```(?:text|txt|plaintext)?\s*/i, '').replace(/\s*```$/i, '').trim();
    if (!clean) return '';
    // Dacă modelul a ignorat modul plain-text și a întors JSON/explicații, nu
    // acceptăm un răspuns ambiguu ca traducere.
    if (/^\s*(?:\{|\[)\s*(?:[\"']?id[\"']?\s*:)?/i.test(clean)) return '';
    if (/^(?:traducerea(?: corectată)?|textul corectat|varianta corectată|răspunsul)\s*:/iu.test(clean)) return '';
    return clean;
}

async function grammarTranslationReview(items, translatedById, keyStates, options = {}) {
    const contextItems = options.contextItems || items;
    const isTargetedReview = options.mode === 'targeted';

    const candidates = items.filter(item => {
        const original = String(item.text || '').replace(/<[^>]+>/g, '').trim();
        const translated = String(translatedById[String(item.id)] || '').replace(/<[^>]+>/g, '').trim();
        if (!original || (!translated && !isTargetedReview)) return false;
        if (isJunkOrInterjection(item.text)) return false;
        if (isOkOnlySubtitle(translated)) return false;
        return true;
    });

    if (!candidates.length) {
        console.log(`${c.green}✔ [Grammar Review] Nu există replici eligibile pentru verificare.${c.reset}`);
        return { checked: 0, fixed: 0 };
    }

    if (isTargetedReview) {
        console.log(`\n${c.cyan}🎯 VERIFICARE PUNCTUALĂ — GRAMATICĂ + TRADUCERE${c.reset}`);
    } else {
        console.log(`\n${c.cyan}📝 VERIFICARE SUPLIMENTARĂ — GRAMATICĂ + TRADUCERE${c.reset}`);
    }
    console.log(`   Verificate: ${candidates.length} replici`);

    const batches = chunkArray(candidates, GRAMMAR_REVIEW_BATCH_SIZE);
    let fixed = 0;
    const verifiedIds = new Set();
    const rejectedQualityReasonsById = Object.create(null);

    const rateLimitRetryQueue = [];
    const rateLimitFailedQueue = [];

    const processGrammarBatch = async (batch, batchIndex, label) => {
        const batchFixedBefore = fixed;

        const payload = batch.map(item => {
            const index = contextItems.findIndex(x => String(x.id) === String(item.id));
            const previous = index > 0 ? contextItems[index - 1] : null;
            const next = index >= 0 && index < contextItems.length - 1 ? contextItems[index + 1] : null;

            return {
                id: item.id,
                original: item.text,
                translation: translatedById[String(item.id)],
                context_anterior_en: previous ? `[${previous.id}] ${previous.text}` : '(niciunul)',
                context_urmator_en: next ? `[${next.id}] ${next.text}` : '(niciunul)',
                context_anterior_ro: previous ? `[${previous.id}] ${translatedById[String(previous.id)] || ''}` : '(niciunul)',
                context_urmator_ro: next ? `[${next.id}] ${translatedById[String(next.id)] || ''}` : '(niciunul)',
                avertisment_semantic: [
                    getSourceFidelityIssues(item.text, translatedById[String(item.id)] || '').join('; '),
                    options.reasonById ? (options.reasonById[String(item.id)] || '') : ''
                ].filter(Boolean).join('; ')
            };
        });

        const prompt = `Ești un editor profesionist de subtitrări ENGLEZĂ → ROMÂNĂ. Revizuiești traducerea existentă, nu o retraducești automat.

SCOP
Returnează numai corecțiile pentru greșeli clare și demonstrabile de sens, gramatică, vocabular, ortografie sau naturalețe românească. Dacă traducerea este deja corectă și suficient de naturală, nu o modifica. Nu face rescrieri doar din preferință stilistică.

VERIFICĂ ÎN ORDINE
1. Compară ORIGINALUL, traducerea și contextul imediat înainte/după. Verifică sensul complet, expresiile idiomatice, cine face acțiunea și cine/ce o primește.
2. Verifică relațiile gramaticale, nu doar prezența cuvintelor: obiect direct versus loc, prepoziții, pronume/clitice, posesie, negație, timp, persoană, gen și număr. De exemplu, pentru EN “the sound that dries my vagina”, „îmi usucă vaginul” păstrează relația de obiect direct; „mă usucă în vagin” schimbă sensul.
3. Păstrează termenii expliciți și sensul direct când sursa îi folosește. Nu îi înlocui cu eufemisme și nu transforma intensificatorii/înjurăturile în obiecte, acțiuni sau insulte diferite.
4. Păstrează singularul/pluralul și referentul. De exemplu, “a hat” nu trebuie tradus „căciuli”. Nu adăuga diminutive precum „căciuliță” dacă sursa nu exprimă micime, afecțiune sau diminutiv.
5. Repară româna nenaturală sau calchiată numai dacă poți stabili din original și context ce înseamnă sursa și poți produce o variantă clar mai corectă. Verifică și cuvinte tăiate, forme inexistente, clitice greșite, diacritice, acorduri și fragmente englezești rămase.
6. Păstrează tonul personajului, inclusiv vulgaritatea, sarcasmul și colocvialismul. Nu infantiliza și nu formaliza dialogul.
7. Dacă obiectul conține „avertisment_semantic”, verifică explicit problema indicată. Nu considera problema rezolvată doar fiindcă un anumit cuvânt apare în traducere; verifică și relația de sens.
8. Dacă avertismentul menționează un conector repetat între două subtitrări consecutive, compară ambele originale și ambele traduceri din context. Păstrează conectorul în fragmentul al cărui original îl conține. Dacă originalul fragmentului curent NU începe/nu se termină cu acel conector, dar traducerea îl adaugă la limită, elimină doar conectorul adăugat inutil din replica curentă; nu șterge conectorul justificat de următorul/precedentul original. Dacă dovezile nu sunt clare, nu rescrie.
9. Dacă avertismentul indică un fragment englezesc netradus, o secvență englezească deteriorată sau un text corupt și originalul/contextul permit stabilirea sensului, corectează efectiv fragmentul în română. Nu lăsa secvența deteriorată în text și nu omite corectura doar pentru că restul replicii este românește. Dacă semnalul este un fals pozitiv și formularea românească transmite deja sensul originalului, păstreaz-o.

REGULĂ DE PRUDENȚĂ
Nu schimba o replică validă doar ca să sune diferit. Dacă există mai multe variante plauzibile și nu poți demonstra care este necesară, păstrează traducerea. Returnează doar câmpul „text” pentru ID-urile realmente corectate; nu modifica ID-uri și nu atinge contextul.
${isTargetedReview && batch.some(entry => !String(translatedById[String(entry.id)] || '').trim()) ? '\nIMPORTANT: dacă un obiect are câmpul „translation” gol, nu există text de păstrat pentru acel ID. Tradu acel original în română pe baza contextului și returnează textul pentru acel ID; nu-l omite.\n' : ''}
DATE DE VERIFICAT:
Fiecare obiect include id, original, translation, context_anterior_en, context_urmator_en, context_anterior_ro, context_urmator_ro și, uneori, avertisment_semantic. Contextul este doar pentru înțelegere; corectează numai replica curentă.
${JSON.stringify(payload, null, 2)}

Returnează DOAR JSON valid:
[
  {"id": 123, "text": "traducerea corectată"}
]
Pentru ID-urile fără o greșeală clară, returnează un array gol: [].`;

        let lastJsonError = null;

        // JSON-ul Gemini poate fi invalid ocazional chiar dacă promptul cere
        // explicit JSON valid. Facem un retry pe același calup; dacă răspunsul
        // rămâne invalid, îl împărțim repetat până la replici individuale.
        // Dimensiunea normală rămâne 120; split-ul apare doar la eroare de format
        // și evită ca un singur răspuns invalid să lase neverificat tot grupul.
        for (let jsonAttempt = 0; jsonAttempt <= GRAMMAR_REVIEW_JSON_RETRY_LIMIT; jsonAttempt++) {
            try {
                if (jsonAttempt > 0) {
                    console.log(`${c.yellow}↻ [Grammar Review] JSON invalid la ${batch.length} replici; retry ${jsonAttempt}/${GRAMMAR_REVIEW_JSON_RETRY_LIMIT}...${c.reset}`);
                    await sleep(GRAMMAR_REVIEW_JSON_RETRY_DELAY_MS);
                }

                const keyState = await getAvailableKey(keyStates);
                const requestPrompt = jsonAttempt > 0
                    ? `${prompt}\n\nRETRY TEHNIC: Returnează DOAR JSON valid, fără markdown sau explicații. Format exact: [{\"id\":123,\"text\":\"...\"}]. Pentru nicio corecție returnează exact []. Nu modifica ID-urile. Escapă toate ghilimelele interne din text.`
                    : prompt;
                const raw = await callGemini(requestPrompt, keyState, {
                    timeout: GRAMMAR_REVIEW_TIMEOUT_MS,
                    // Grammar Review lasă thinkingConfig nedefinit pentru ca modelul
                    // să folosească nivelul implicit; traducerea rămâne MEDIUM.
                    thinkingLevel: null,
                    responseSchema: {
                        type: 'ARRAY',
                        minItems: 0,
                        maxItems: batch.length,
                        items: {
                            type: 'OBJECT',
                            properties: {
                                id: { type: 'INTEGER' },
                                text: { type: 'STRING' }
                            },
                            required: ['id', 'text'],
                            propertyOrdering: ['id', 'text']
                        }
                    }
                });
                const parsed = safeJsonParse(raw);
                const parsedDict = normalizeTranslationPayload(parsed);

                for (const checkedItem of batch) verifiedIds.add(String(checkedItem.id));

                for (const item of batch) {
                    const id = String(item.id);
                const candidateRaw = parsedDict[id];
                if (candidateRaw == null) continue;

                const current = formatSubtitleLine(String(translatedById[id] || ''));
                const candidate = formatSubtitleLine(String(candidateRaw || ''));

                if (!candidate || candidate === current) continue;

                // Filtrul suplimentar poate aplica doar o corecție care rămâne
                // compatibilă cu verificările deja existente.
                if (hasUntranslatedEnglish(item.text, candidate) ||
                    hasCorruptedSubtitleText(candidate, item.text) ||
                    hasLostExplicitSourceTerm(item.text, candidate)) {
                    // Corectura suspectă este respinsă fără a încărca logul cu detalii per replică.
                    continue;
                }

                // Nu acceptăm o corectură AI dacă ea introduce o problemă lingvistică
                // sau semantică de înaltă încredere pe care versiunea anterioară nu o avea.
                const previousQualityReasons = collectQualityReviewReasons(
                    item, current, contextItems, translatedById
                );
                const candidateQualityReasons = collectQualityReviewReasons(
                    item, candidate, contextItems, translatedById
                );
                const newlyIntroducedQualityReasons = candidateQualityReasons.filter(
                    reason => !previousQualityReasons.includes(reason)
                );
                if (newlyIntroducedQualityReasons.length) {
                    rejectedQualityReasonsById[id] = [...new Set([
                        ...(rejectedQualityReasonsById[id] || []),
                        ...newlyIntroducedQualityReasons
                    ])];
                    // Corectura care introduce un semnal nou este respinsă; raportăm doar totalul corecturilor acceptate.
                    continue;
                }

                translatedById[id] = candidate;
                fixed++;
                }

                // IMPORTANT: dacă răspunsul JSON a fost valid și am procesat calupul,
                // calupul este REUȘIT. Nu lăsăm bucla de retry să cadă ulterior în
                // fallback-ul „eroare necunoscută” și să dubleze contorul checked.
                const batchFixed = fixed - batchFixedBefore;
                console.log(`${c.green}✔ [Grammar Review] Calup ${batchIndex + 1}/${batches.length}: ${batchFixed} corectate${c.reset}`);
                return { success: true, is429: false };
            } catch (error) {
                lastJsonError = error;
                const message = String(error?.message || '');
                const is429 = error?.isRateLimit429 === true || /429/.test(message);
                const isTimeout = error?.code === 'ECONNABORTED' ||
                    error?.code === 'ETIMEDOUT' ||
                    /timeout|timed out/i.test(message);

                // 429 și timeout-ul au propriul mecanism de retry/split.
                // Nu le tratăm ca eroare JSON.
                if (is429 || isTimeout) {
                    if (isTimeout && batch.length > 20) {
                        const middle = Math.ceil(batch.length / 2);
                        const left = batch.slice(0, middle);
                        const right = batch.slice(middle);

                        console.log(`${c.yellow}⚠ [Grammar Review] Timeout la ${batch.length} replici; împart calupul în ${left.length}+${right.length} și reîncerc...${c.reset}`);
                        await sleep(GRAMMAR_REVIEW_TIMEOUT_RETRY_MS);

                        const leftResult = await processGrammarBatch(
                            left,
                            batchIndex,
                            `${label} — partea 1/${2}`
                        );
                        const rightResult = await processGrammarBatch(
                            right,
                            batchIndex,
                            `${label} — partea 2/${2}`
                        );

                        return {
                            success: leftResult.success && rightResult.success,
                            is429: leftResult.is429 || rightResult.is429
                        };
                    }

                    // Grammar Review trebuie să activeze aceeași poartă globală
                    // folosită de traducerea principală, nu doar pauza cheii curente.
                    if (is429) {
                        const cooldownMs = Number(error?.retryAfterMs) || 30000;
                        register429(keyStates, cooldownMs);
                        const providerDetails = String(error?.providerMessage || message || 'fără detalii suplimentare')
                            .replace(/\s+/g, ' ').trim().slice(0, 300);
                        console.log(`${c.yellow}⚠ [Gemini 429] Limită/quota atinsă; pauză ${Math.ceil(cooldownMs / 1000)}s. Detaliu Google: ${providerDetails}${c.reset}`);
                        return { success: false, is429: true };
                    }

                    // Timeout pe calup mic: păstrăm comportamentul existent.
                    console.log(`${c.yellow}⚠ [Grammar Review] Calupul ${batchIndex + 1} a expirat și nu mai poate fi împărțit.${c.reset}`);
                    return { success: false, is429: false };
                }

                const isJsonError = /JSON Parse failed|Unexpected token|Unexpected end of JSON|Expected ',' or '}'|Expected property name/i.test(message);

                // Prima eroare JSON/conținut gol: retry pe același calup, cu prompt
                // explicit de reparare. Nu împărțim încă pentru a păstra viteza normală.
                if ((isJsonError || /conținut gol|empty content/i.test(message)) &&
                    jsonAttempt < GRAMMAR_REVIEW_JSON_RETRY_LIMIT) {
                    lastJsonError = error;
                    continue;
                }

                // După retry-ul JSON, împărțim numai dacă răspunsul rămâne invalid
                // sau gol. Erorile API nelegate de format nu declanșează split
                // suplimentar; dacă un singleton tot nu produce JSON valid, îl
                // lăsăm explicit neverificat în raportul final.
                // Dacă JSON-ul este invalid chiar și la o singură replică, nu
                // repetăm la nesfârșit aceeași formă. Cerem o singură dată text simplu,
                // fără responseSchema, apoi folosim aceleași controale de fidelitate
                // și de regresie ca la o corectură JSON. Dacă fallback-ul e ambiguu,
                // Dacă fallback-ul eșuează, traducerea curentă se păstrează; nu se emite raport per ID.
                if (isJsonError && batch.length === 1 && jsonAttempt >= GRAMMAR_REVIEW_JSON_RETRY_LIMIT) {
                    const item = batch[0];
                    const id = String(item.id);
                    const current = formatSubtitleLine(String(translatedById[id] || ''));
                    const singlePayload = payload.find(entry => String(entry.id) === id) || payload[0];
                    console.log(`${c.yellow}↻ [Grammar Review] JSON invalid la o singură replică (ID ${id}); încerc o singură rezervă text simplu...${c.reset}`);
                    try {
                        const fallbackPrompt = `Ești un corector profesionist de subtitrări ENGLEZĂ → ROMÂNĂ. Verifică DOAR replica descrisă mai jos, comparând originalul, traducerea curentă și contextul.

Corectează numai dacă există o greșeală clară de sens, gramatică, vocabular sau ortografie. Dacă traducerea este deja corectă, returnează exact traducerea curentă. Păstrează sensul, persoana, timpul și punctuația justificată de context. Nu inventa text.

DATE:
${JSON.stringify(singlePayload, null, 2)}

Returnează DOAR textul final al replicii românești, fără JSON, fără markdown, fără ghilimele adăugate în jurul întregii replici și fără explicații.`;
                        const fallbackKey = await getAvailableKey(keyStates);
                        const fallbackRaw = await callGemini(fallbackPrompt, fallbackKey, {
                            timeout: GRAMMAR_REVIEW_TIMEOUT_MS,
                            thinkingLevel: null,
                            plainText: true
                        });
                        const fallbackText = cleanPlainTextReviewResponse(fallbackRaw);
                        const candidate = formatSubtitleLine(fallbackText);
                        if (!candidate) throw new Error('răspunsul plain-text a fost gol, JSON sau conținea explicații');

                        if (candidate !== current) {
                            if (hasUntranslatedEnglish(item.text, candidate) ||
                                hasCorruptedSubtitleText(candidate, item.text) ||
                                hasLostExplicitSourceTerm(item.text, candidate)) {
                                throw new Error('corectura plain-text nu a trecut verificările existente de fidelitate');
                            }
                            const previousQualityReasons = collectQualityReviewReasons(item, current, contextItems, translatedById);
                            const candidateQualityReasons = collectQualityReviewReasons(item, candidate, contextItems, translatedById);
                            const newlyIntroducedQualityReasons = candidateQualityReasons.filter(reason => !previousQualityReasons.includes(reason));
                            if (newlyIntroducedQualityReasons.length) {
                                rejectedQualityReasonsById[id] = [...new Set([...(rejectedQualityReasonsById[id] || []), ...newlyIntroducedQualityReasons])];
                                throw new Error(`corectura a introdus un semnal nou: ${newlyIntroducedQualityReasons.join('; ')}`);
                            }
                            translatedById[id] = candidate;
                            fixed++;
                            console.log(`${c.green}✔ [Grammar Review] ID ${id}: fallback text simplu acceptat după validare.${c.reset}`);
                        } else {
                            console.log(`${c.green}✔ [Grammar Review] ID ${id}: fallback text simplu confirmă textul existent; nicio modificare necesară.${c.reset}`);
                        }
                        verifiedIds.add(id);
                        return { success: true, is429: false };
                    } catch (fallbackError) {
                        // Fallback-ul nu a trecut validarea; păstrăm traducerea existentă și evităm logul per replică.
                        return { success: false, is429: false };
                    }
                }

                if (shouldSplitGrammarReviewBatch(batch.length, isJsonError, message)) {
                    const middle = Math.ceil(batch.length / 2);
                    const left = batch.slice(0, middle);
                    const right = batch.slice(middle);

                    console.log(`${c.yellow}⚠ [Grammar Review] Calupul ${batch.length} nu a putut fi returnat ca JSON; împart în ${left.length}+${right.length} și reîncerc separat...${c.reset}`);

                    const leftResult = await processGrammarBatch(
                        left,
                        batchIndex,
                        `${label} — JSON split 1/${2}`
                    );
                    const rightResult = await processGrammarBatch(
                        right,
                        batchIndex,
                        `${label} — JSON split 2/${2}`
                    );

                    return {
                        success: leftResult.success && rightResult.success,
                        is429: leftResult.is429 || rightResult.is429
                    };
                }

                console.log(`${c.yellow}⚠ [Grammar Review] Calupul ${batchIndex + 1} nu a putut fi verificat: ${message || 'eroare necunoscută'}${c.reset}`);
                return { success: false, is429: false };
            }
        }

        // Protecție teoretică; bucla de mai sus fie returnează, fie reia retry-ul.
        console.log(`${c.yellow}⚠ [Grammar Review] Calupul ${batchIndex + 1} a eșuat: ${lastJsonError?.message || 'eroare necunoscută'}${c.reset}`);
        return { success: false, is429: false };
    };

    // Prima trecere: dacă un calup primește 429, nu îl abandonăm definitiv.
    // Îl punem la coadă și îl reîncercăm după ce terminăm toate calupurile normale.
    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
        const batch = batches[batchIndex];
        const result = await processGrammarBatch(
            batch,
            batchIndex,
            `Calup ${batchIndex + 1}/${batches.length}`
        );

        if (result.is429) {
            rateLimitRetryQueue.push({ batch, batchIndex });
        }
    }

    // Maximum 2 reîncercări suplimentare DOAR pentru calupurile care au eșuat cu 429.
    // Nu modificăm aici logica 429 a traducerii principale sau a altor etape.
    for (let retryRound = 1; retryRound <= 2 && rateLimitRetryQueue.length; retryRound++) {
        const pending = rateLimitRetryQueue.splice(0);
        console.log(`${c.cyan}🔄 [Grammar Review] Reîncerc 429: ${pending.length} calupuri (runda ${retryRound}/2)...${c.reset}`);

        for (const queued of pending) {
            const result = await processGrammarBatch(
                queued.batch,
                queued.batchIndex,
                `Reîncercare 429 — Calup ${queued.batchIndex + 1}/${batches.length} (runda ${retryRound}/2)`
            );

            if (result.is429) {
                if (retryRound < 2) {
                    rateLimitRetryQueue.push(queued);
                } else {
                    // Nu pierdem evidența eșecurilor din ultima rundă.
                    rateLimitFailedQueue.push(queued);
                }
            }
        }
    }

    // Nu construim liste de ID-uri pentru raportarea la final a replicilor
    // neverificate. Erorile API și limitările 429 rămân vizibile în log în momentul apariției.
    const checked = verifiedIds.size;
    console.log(`${c.green}✔ [Grammar Review] Verificarea s-a încheiat; ${fixed} corectări aplicate.${c.reset}`);
    return { checked, fixed, rejectedQualityReasonsById };
}

// ============================================================
// MICRO-CHECK LOCAL — ORTOGRAFIE + GRAMATICĂ EVIDENTĂ
// Nu folosește Gemini. Aplică doar corecții cu încredere foarte mare
// și marchează restul pentru o verificare punctuală.
// ============================================================

const LOCAL_GRAMMAR_FIXES = [
    // Greșeli reale observate în verificări manuale ale subtitrărilor.
    [/\brenumererațiile\b/gi, 'remunerațiile'],
    [/\brenumererație\b/gi, 'remunerație'],
    [/\brenumererația\b/gi, 'remunerația'],
    [/\brenumererației\b/gi, 'remunerației'],
    [/\brenumererațiilor\b/gi, 'remunerațiilor'],
    [/\brenumererați\b/gi, 'remunerați'],
    [/\brenumererate\b/gi, 'remunerate'],
    [/(?<![A-Za-zĂÂÎȘȚăâîșț])renumerată(?![A-Za-zĂÂÎȘȚăâîșț])/gi, 'remunerată'],
    [/\brenumerat\b/gi, 'remunerat'],
    [/\brenumerare\b/gi, 'remunerare'],
    [/\brenumerarea\b/gi, 'remunerarea'],
    [/\brenumerării\b/gi, 'remunerării'],
    [/\brenumerările\b/gi, 'remunerările'],
    [/\brenumerațiile\b/gi, 'remunerațiile'],
    [/\brenumerație\b/gi, 'remunerație'],
    [/\brenumerația\b/gi, 'remunerația'],
    [/\brenumerației\b/gi, 'remunerației'],
    [/\brenumerațiilor\b/gi, 'remunerațiilor'],
    [/\brenumerați\b/gi, 'remunerați'],
    [/\brenumerate\b/gi, 'remunerate'],
    [/\bsugist\b/gi, 'sugi'],

    // Corecții locale suplimentare cu încredere foarte mare, validate în QA.
    [/\bdeciizi\b/gi, 'decizi'],
    [/\bco\s+cerul\b/gi, 'că cerul'],
    [/\bAlelea\b/gi, 'Alea'],
    [/\bn-mai\b/gi, 'nu mai'],
    [/\bBine,,/gi, 'Bine,'],
    [/\bpropria\s+noastre\b/gi, 'propria noastră'],
    [/\binnascute\b/gi, 'înnăscute'],
    [/\binnascuta\b/gi, 'înnăscută'],
    [/\binnascut\b/gi, 'înnăscut'],
    [/\binnascuti\b/gi, 'înnăscuți'],
    [/(?<![\p{L}])ți-a\s+pasat\b/iu, 'ți-a păsat'],
    // Corectări ortografice de încredere ridicată observate în verificarea v121.
    [/(?<![\p{L}])resuscitatăm(?![\p{L}])/giu, 'resuscităm'],
    [/(?<![\p{L}])nimani(?![\p{L}])/giu, 'nimeni'],
    [/(?<![\p{L}])lasă-mi-te(?![\p{L}])/giu, 'lasă-mă'],
    [/\bnite\b/giu, 'niște'],
    [/\bnare(?=\s+(?:niciun(?:ul|a)?|nicio|nimic|sens|rost)\b)/giu, 'n-are']
];

function applyLocalGrammarDeterministicFixes(text) {
    let result = String(text || '');
    for (const [pattern, replacement] of LOCAL_GRAMMAR_FIXES) {
        result = result.replace(pattern, match => {
            if (match === match.toUpperCase()) return replacement.toUpperCase();
            if (match[0] === match[0].toUpperCase()) {
                return replacement.charAt(0).toUpperCase() + replacement.slice(1);
            }
            return replacement;
        });
    }
    return result;
}

function detectLocalGrammarReviewReasons(text) {
    const clean = String(text || '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    if (!clean) return [];

    const reasons = [];

    // Semnale pentru deformări și construcții românești cu risc mare.
    // Nu rescriem automat: sunt trimise la verificare AI numai replicile marcate.
    const highConfidenceRomanianQualityGuards = [
        { pattern: /(?<![\p{L}])introm(?![\p{L}])/iu, message: 'posibil cuvânt trunchiat/inexistent „introm”' },
        { pattern: /(?<![\p{L}])eau\s+(?:de\s+)?\d+(?:\s*,\s*\d+)?(?![\p{L}])/iu, message: 'posibil cuvânt trunchiat înaintea unui număr („eau de 12, 15”)' },
        { pattern: /(?<![\p{L}])necesiți(?![\p{L}])/iu, message: 'formă verbală românească suspectă „necesiți”' },
        { pattern: /(?<![\p{L}])flori[-\s]+soarelui(?![\p{L}])/iu, message: 'posibil calc/declinare greșită „flori-soarelui”' },
        { pattern: /(?<![\p{L}])modalitate\s+noi\s+\p{L}+(?![\p{L}])/iu, message: 'construcție gramaticală suspectă după „modalitate noi”' },
        { pattern: /(?<![\p{L}])din\s+cauz[ăa]\s+la(?![\p{L}])/iu, message: 'construcție gramaticală suspectă „din cauză la”; necesită verificare contextuală' },
        { pattern: /(?<![\p{L}])din\s+cauza\s+(?:voastră|voștri|voastre),?\s*a\s+doi(?![\p{L}])/iu, message: 'construcție suspectă „din cauza voastră, a doi”' },
        { pattern: /(?<![\p{L}])lăsați-mi\s+(?:echipa|grupul|echipajul|oamenii|soldații|soldatii)\s+să(?![\p{L}])/iu, message: 'posibilă ordine greșită a pronumelui în construcția „lăsați-mi ... să”' },
        { pattern: /(?<![\p{L}])(?:lucrura|acesa|întregă|nite|introm|nimani|resuscitatăm)(?![\p{L}])/iu, message: 'posibilă deformare/greșeală ortografică' },
        { pattern: /(?<![\p{L}])lasă-mi-te(?![\p{L}])/iu, message: 'succesiune de clitice agramaticală „lasă-mi-te”' },
        { pattern: /(?<![\p{L}])pot\s+să\s+(?:vorbim|mergem|facem|avem|plecăm|plecam|vedem|spunem|știm|stim|fim)(?![\p{L}])/iu, message: 'nepotrivire de persoană după „pot să”' },
        { pattern: /(?<![\p{L}])ar\s+trebui(?:\s+măcar)?\s+(?:le|îi|mi|ne|vă|te|mă)\s+\p{L}+/iu, message: 'posibil „să” lipsă în construcția „ar trebui ...”' },
        { pattern: /(?<![\p{L}])nu\s+ești\s+(?:nici\s+)?părere\s+de\s+rău(?![\p{L}])/iu, message: 'expresie idiomatică agramaticală „nu ești părere de rău”' }
    ];
    for (const guard of highConfidenceRomanianQualityGuards) {
        if (guard.pattern.test(clean)) reasons.push(guard.message);
    }

    // Repetiție imediată de cuvânt: nu o corectăm automat, deoarece poate fi
    // o bâlbâială/replică intenționată; o lăsăm Grammar Review să decidă.
    // Limitele sunt Unicode-aware pentru a nu confunda prefixe precum
    // „de” din „deștept” sau „cu” din „cuțitul” cu duplicate reale.
    const duplicate = clean.match(/(?<![\p{L}])([\p{L}]{2,})\s+\1(?![\p{L}-])/iu);
    const intentionalRepeatWords = new Set(['nu', 'da', 'mă', 'te', 'eu', 'tu', 'ha', 'haha', 'hei']);
    if (duplicate && !intentionalRepeatWords.has(String(duplicate[1]).toLowerCase())) {
        reasons.push(`cuvânt repetat: „${duplicate[0]}”`);
    }

    // Construcții de clitic evident suspecte, pe care Grammar Review deja știe
    // să le analizeze, dar care merită o verificare punctuală atunci când apar.
    if (/\baș-o\b/i.test(clean)) reasons.push('clitic suspect „aș-o”');
    if (/\bnu\s+ți-pasă\b/i.test(clean)) reasons.push('clitic suspect „nu ți-pasă”');
    if (/\buită-ce-mi\b/i.test(clean)) reasons.push('clitic suspect „uită-ce-mi”');
    if (/(?:^|\s)(?:să|sa)\s+mi\s+facă\b/i.test(clean)) reasons.push('clitic suspect „să mi facă”');

    // Calcuri/construcții observate în QA manual. Sunt DOAR semnale: nu sunt
    // modificate automat fără comparație cu originalul și contextul.
    if (/(?:^|[^\p{L}])(?:însuși|insusi|insuşi)\s+semnalele(?:$|[^\p{L}])/iu.test(clean)) reasons.push('acord suspect „însuși semnalele”');
    if (/\bnici\s+mai\s+mult\s+decât\s+este\s+el\b/i.test(clean)) reasons.push('construcție comparativă suspectă');

    // Detectare țintită pentru cuvinte englezești de conținut care pot rămâne
    // integrate într-o propoziție românească și pot scăpa detectorului global.
    // Lista este intenționat scurtă și conservatoare pentru a evita nume proprii
    // sau împrumuturi uzuale din română.
    const highConfidenceEnglish = new Set([
        'upheaval', 'innate', 'indictment', 'disregard', 'however', 'although',
        'meanwhile', 'witness', 'threat', 'helpless', 'sudden', 'footage',
        'outcome', 'warning', 'breach', 'device', 'evidence', 'outnumbered'
    ]);
    const englishIntegrated = clean.match(/[A-Za-z]+/g) || [];
    const englishHits = englishIntegrated.filter(word => highConfidenceEnglish.has(word.toLowerCase()));
    for (const word of [...new Set(englishHits.map(w => w.toLowerCase()))]) {
        reasons.push(`cuvânt englezesc integrat „${word}”`);
    }

    return reasons;
}

function detectSourceAwareQualityReviewReasons(item, translation, contextItems, translatedById) {
    const source = String(item?.text || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const target = String(translation || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (!source || !target || isJunkOrInterjection(item?.text)) return [];

    const reasons = [];
    // Sursă „response” + traducere lexical greșită; corecția deterministă ar trebui
    // s-o repare înainte de review, iar acest semnal protejează cazul dacă reapare.
    if (/\bresponse\b/i.test(source) && /(?<![\p{L}])retras(?:ul|ului)?(?![\p{L}])/iu.test(target)) {
        reasons.push('cuvânt incompatibil cu sursa: „response” tradus ca „retrasul”');
    }

    if (/\b(?:but\s+)?you(?:'re|\s+are)\s+not\s+sorry\b/i.test(source) &&
        /(?<![\p{L}])nu\s+ești\s+(?:nici\s+)?părere\s+de\s+rău(?![\p{L}])/iu.test(target)) {
        reasons.push('expresia idiomatică „you are not sorry” este tradusă agramatical');
    }

    if (/\bcould\s+i\s+have\s+a\s+word\b/i.test(source) &&
        /(?<![\p{L}])pot\s+să\s+vorbim(?![\p{L}])/iu.test(target)) {
        reasons.push('nepotrivire de persoană: „Could I…” nu corespunde lui „Pot să vorbim”');
    }

    if (/\bshould\s+at\s+least\s+tell\b/i.test(source) &&
        /(?<![\p{L}])ar\s+trebui\s+măcar\s+(?:le|îi|mi|ne|vă|te|mă)\s+\p{L}+/iu.test(target) &&
        !/(?<![\p{L}])ar\s+trebui\s+măcar\s+să\s+(?:le|îi|mi|ne|vă|te|mă)(?![\p{L}])/iu.test(target)) {
        reasons.push('lipsește „să” într-o construcție cu „ar trebui ... să”');
    }

    if (/\boutnumbered\b/i.test(source) && /\boutnumbered\b/i.test(target)) {
        reasons.push('a rămas un cuvânt englezesc netradus („outnumbered”)');
    }

    // Validare contextuală a continuității: dacă blocul englezesc anterior se termină
    // cu „was/were”, blocul curent începe cu un gerunziu, iar traducerea începe cu
    // o formă clară de persoana I prezent, persoana/timpul s-au schimbat.
    const allItems = Array.isArray(contextItems) ? contextItems : [item];
    const index = allItems.findIndex(entry => String(entry.id) === String(item.id));
    if (index > 0) {
        const previous = allItems[index - 1];
        const previousSource = String(previous.text || '').replace(/<[^>]+>/g, ' ').trim();
        const currentSource = source;
        const previousTarget = String(translatedById[String(previous.id)] || '').replace(/<[^>]+>/g, ' ').trim();
        const beginsEnglishProgressive = /^[a-z]+ing\b/i.test(currentSource);
        const hasPastProgressiveAuxiliary = /\b(?:was|were)\s*$/i.test(previousSource);
        const firstTargetToken = (target.match(/^[“„"'«»(\s-]*([\p{L}-]+)/u) || [])[1] || '';
        const likelyFirstPersonPresent = /(?:ez|esc|iesc)$/iu.test(firstTargetToken);
        const previousTargetContinues = previousTarget && !/[.!?…]["”')\]]*$/u.test(previousTarget);
        const currentSourceNotFirstPerson = !/^(?:I|we)\b/i.test(currentSource);
        if (beginsEnglishProgressive && hasPastProgressiveAuxiliary && previousTargetContinues &&
            currentSourceNotFirstPerson && likelyFirstPersonPresent) {
            reasons.push('nepotrivire de persoană/timp: continuarea „was/were + -ing” a devenit persoana I, prezent');
        }
    }

    return reasons;
}

function collectQualityReviewReasons(item, translation, contextItems, translatedById) {
    return [
        ...detectLocalGrammarReviewReasons(translation),
        ...detectSourceAwareQualityReviewReasons(item, translation, contextItems, translatedById)
    ];
}

function findRepeatedBoundaryConnectorIssues(items, translatedById) {
    const issues = [];
    const seen = new Set();
    const connectorPattern = /(?:^|\s)(dar|însă|totuși)\s*[,;:!?…]*$/iu;
    const leadingConnectorPattern = /^\s*(?:[-–—]\s*)?(dar|însă|totuși)(?![\p{L}])/iu;
    const sourceTailPattern = /(?:^|\s)(but|however|yet|still|nevertheless)\s*[,;:!?…]*$/iu;
    const sourceHeadPattern = /^\s*(?:[-–—]\s*)?(but|however|yet|still|nevertheless)\b/iu;

    const sourceConnectorSupportsRomanian = (englishConnector, romanianConnector) => {
        const en = String(englishConnector || '').toLocaleLowerCase('en-US');
        const ro = String(romanianConnector || '').toLocaleLowerCase('ro-RO');
        const supported = {
            but: ['dar', 'însă'],
            however: ['dar', 'însă', 'totuși'],
            yet: ['dar', 'însă', 'totuși'],
            still: ['dar', 'însă', 'totuși'],
            nevertheless: ['dar', 'însă', 'totuși']
        };
        return Boolean(supported[en]?.includes(ro));
    };

    for (let i = 0; i < items.length - 1; i++) {
        const currentItem = items[i];
        const nextItem = items[i + 1];
        if (isJunkOrInterjection(currentItem.text) || isJunkOrInterjection(nextItem.text)) continue;

        const currentText = String(translatedById[String(currentItem.id)] || '')
            .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        const nextText = String(translatedById[String(nextItem.id)] || '')
            .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        const tail = currentText.match(connectorPattern);
        const head = nextText.match(leadingConnectorPattern);
        if (!tail || !head || tail[1].toLocaleLowerCase('ro-RO') !== head[1].toLocaleLowerCase('ro-RO')) continue;

        // Folosim ambele originale pentru a afla ce fragment justifică de fapt
        // conectorul. Astfel, nu raportăm o dublare mecanic doar din română.
        const sourceCurrent = String(currentItem.text || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        const sourceNext = String(nextItem.text || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        const sourceTail = sourceCurrent.match(sourceTailPattern);
        const sourceHead = sourceNext.match(sourceHeadPattern);
        const tailSupportedBySource = sourceTail && sourceConnectorSupportsRomanian(sourceTail[1], tail[1]);
        const headSupportedBySource = sourceHead && sourceConnectorSupportsRomanian(sourceHead[1], head[1]);

        // Dacă ambele surse au același conector în aceeași poziție, păstrăm
        // traducerea lor: nu presupunem că repetiția vine dintr-o eroare AI.
        if (tailSupportedBySource && headSupportedBySource) continue;

        // Când conectorul de la final este susținut de originalul precedent,
        // semnalăm blocul următor (al cărui original nu începe cu acel conector).
        // În celelalte cazuri, semnalăm conectorul introdus la finalul blocului
        // curent; de ex. ID 669 adăuga „dar”, deși originalul continuă abia la 670
        // cu „but”.
        const issueItem = tailSupportedBySource && !headSupportedBySource ? nextItem : currentItem;
        const issueId = String(issueItem.id);
        if (seen.has(issueId)) continue;
        seen.add(issueId);

        const reason = `conector repetat între două fragmente consecutive: „${tail[1]}”; originalele EN indică plasarea conectorului ${tailSupportedBySource ? `la ID ${currentItem.id}` : headSupportedBySource ? `la ID ${nextItem.id}` : 'doar după compararea contextului'}; verifică dacă traducerea a adăugat conectorul în blocul greșit`;
        issues.push({ item: issueItem, reason, pairedItem: issueItem === currentItem ? nextItem : currentItem });
    }
    return issues;
}

function applyDeterministicBoundaryConnectorFixes(items, translatedById) {
    let fixed = 0;
    const sourceSupports = (englishConnector, romanianConnector) => {
        const en = String(englishConnector || '').toLocaleLowerCase('en-US');
        const ro = String(romanianConnector || '').toLocaleLowerCase('ro-RO');
        const supported = {
            but: ['dar', 'însă'],
            however: ['dar', 'însă', 'totuși'],
            yet: ['dar', 'însă', 'totuși'],
            still: ['dar', 'însă', 'totuși'],
            nevertheless: ['dar', 'însă', 'totuși']
        };
        return Boolean(supported[en]?.includes(ro));
    };
    const roTail = /(?:^|\s)(dar|însă|totuși)\s*[,;:!?…]*$/iu;
    const roHead = /^\s*(?:[-–—]\s*)?(dar|însă|totuși)(?![\p{L}])/iu;
    const enTail = /(?:^|\s)(but|however|yet|still|nevertheless)\s*[,;:!?…]*$/iu;
    const enHead = /^\s*(?:[-–—]\s*)?(but|however|yet|still|nevertheless)\b/iu;

    for (let i = 0; i < items.length - 1; i++) {
        const current = items[i];
        const next = items[i + 1];
        if (isJunkOrInterjection(current.text) || isJunkOrInterjection(next.text)) continue;
        const currentId = String(current.id);
        const nextId = String(next.id);
        const currentRo = String(translatedById[currentId] || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        const nextRo = String(translatedById[nextId] || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        const roCurrentTail = currentRo.match(roTail);
        const roNextHead = nextRo.match(roHead);
        if (!roCurrentTail || !roNextHead || roCurrentTail[1].toLocaleLowerCase('ro-RO') !== roNextHead[1].toLocaleLowerCase('ro-RO')) continue;

        const currentEn = String(current.text || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        const nextEn = String(next.text || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        const enCurrentTail = currentEn.match(enTail);
        const enNextHead = nextEn.match(enHead);
        const currentSupported = enCurrentTail && sourceSupports(enCurrentTail[1], roCurrentTail[1]);
        const nextSupported = enNextHead && sourceSupports(enNextHead[1], roNextHead[1]);

        // Corectăm numai când originalul următor justifică conectorul, iar
        // originalul curent nu îl justifică la sfârșit. Exemplul sigur este
        // „... EF1”, dar” + „dar n-a fost ea” / EN: „EF1,” + „but it wasn't her”.
        if (!currentSupported && nextSupported) {
            const before = String(translatedById[currentId] || '');
            const after = before.replace(/\s+(?:dar|însă|totuși)\s*[,;:!?…]*\s*$/iu, '').trimEnd();
            if (after && after !== before.trimEnd()) {
                translatedById[currentId] = formatSubtitleLine(after);
                fixed++;
                console.log(`${c.green}✔ [Boundary Connector Fix] ID ${currentId}: conectorul de la final eliminat; originalul ID ${nextId} începe cu „${enNextHead[1]}”.${c.reset}`);
            }
        }
    }
    return fixed;
}

async function runLocalGrammarQualityPass(items, translatedById) {
    let autoFixed = 0;
    const flagged = [];

    for (const item of items) {
        const id = String(item.id);
        const current = String(translatedById[id] || '');
        if (!current.trim()) continue;
        if (isJunkOrInterjection(item.text)) continue;

        // Aplicăm întâi numai corecțiile ancorate clar în sursă și typo-fix-urile
        // cu risc mic; astfel AI primește o versiune curățată, nu duplică munca locală.
        const sourceFixed = applySourceGroundedSemanticFixes(item.text, current);
        const fixed = applyLocalGrammarDeterministicFixes(sourceFixed);
        if (fixed !== current) {
            translatedById[id] = formatSubtitleLine(fixed);
            autoFixed++;
        }

        const effective = String(translatedById[id] || '');
        const reasons = collectQualityReviewReasons(item, effective, items, translatedById);
        const missingExplicitTerms = getMissingExplicitAnatomicalTerms(item.text, effective);
        if (missingExplicitTerms.length) {
            reasons.push(`detaliu anatomic explicit pierdut din original: ${missingExplicitTerms.join(', ')}`);
        }
        if (reasons.length) {
            flagged.push({ item, reasons: [...new Set(reasons)] });
        }
    }

    // Verifică relația dintre două blocuri: un „dar” la sfârșitul primului
    // bloc urmat imediat de „dar” la începutul celui de-al doilea poate dubla
    // aceeași legătură logică. Ambele fragmente sunt trimise împreună la review.
    for (const boundaryIssue of findRepeatedBoundaryConnectorIssues(items, translatedById)) {
        const id = String(boundaryIssue.item.id);
        const existing = flagged.find(entry => String(entry.item.id) === id);
        if (existing) {
            if (!existing.reasons.includes(boundaryIssue.reason)) existing.reasons.push(boundaryIssue.reason);
        } else {
            flagged.push({ item: boundaryIssue.item, reasons: [boundaryIssue.reason] });
        }
    }
    flagged.sort((a, b) => items.findIndex(item => String(item.id) === String(a.item.id)) - items.findIndex(item => String(item.id) === String(b.item.id)));

    console.log(`${c.green}[GRAMATICĂ] Verificare locală încheiată; ${autoFixed} corecții directe aplicate.${c.reset}`);

    return {
        autoFixed,
        flaggedItems: flagged.map(entry => entry.item),
        reasonsById: Object.fromEntries(flagged.map(entry => [String(entry.item.id), entry.reasons.join('; ')]))
    };
}

// ============================================================
// SEMANTIC SPOT CHECK — SEMNALE PUTERNICE DE TRADUCERE CORUPTĂ
// Nu încearcă să evalueze stilul. Marchează doar construcții care sunt
// suficient de suspecte încât merită o singură verificare AI punctuală.
// Se combină cu Micro-Grammar în același request pentru a nu adăuga
// o trecere Gemini separată.
// ============================================================

function detectSemanticSpotCheckReasons(text) {
    const clean = String(text || '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    if (!clean) return [];

    const reasons = [];

    // Construcție clar suspectă: româna standard cere „în fața cui/câtor...”,
    // nu „în fața a cine/câți...”. Verificăm doar formele cu risc foarte mare.
    if (/(?<![\p{L}])în\s+fața\s+a\s+(?:cine|câți|câte)(?=$|[^\p{L}])/iu.test(clean)) {
        reasons.push('construcție foarte suspectă „în fața a cine/câți...”');
    }

    // „De câți oameni a fost nevoie” este construcția firească. Dacă lipsește
    // prepoziția „de”, trimitem replica la verificare punctuală.
    if (/\b(?:câți|câte)\s+(?:\p{L}+\s+){0,5}a\s+fost\s+nevoie\b/iu.test(clean) &&
        !/\bde\s+(?:câți|câte)\s+(?:\p{L}+\s+){0,5}a\s+fost\s+nevoie\b/iu.test(clean)) {
        reasons.push('posibilă lipsă a prepoziției „de” în construcția „a fost nevoie”');
    }

    // Concatenări fără spațiu observate în QA. Sunt foarte specifice și
    // nu modifică automat textul; doar declanșează verificarea punctuală.
    if (/\b(?:unimpact|unregizor|unregizoare|unactor|oameniiși)\b/iu.test(clean)) {
        reasons.push('posibilă concatenare accidentală de cuvinte');
    }

    // „am învățat-o Biblia” / „ai învățat-o cartea” sunt semnale foarte puternice
    // de structură coruptă; nu marcăm construcții cu „pe” (care pot fi valide).
    if (/\b(?:am|ai|a|au|ați|aveam|aveai|avea)\s+învățat-o\s+(?!pe\b)\p{L}{2,}\b/iu.test(clean)) {
        reasons.push('structură suspectă după „învățat-o”');
    }

    // Cazul observat în QA: „ce și tu și eu avem nevoie să...”
    // Este suficient de specific pentru a evita false positive-uri.
    if (/\b(?:ce|ceea\s+ce)\s+și\s+tu\s+și\s+eu\s+avem\s+nevoie\s+să\b/iu.test(clean)) {
        reasons.push('construcție semantică suspectă „și tu și eu avem nevoie...”');
    }

    return reasons;
}

function runSemanticSpotCheck(items, translatedById) {
    const flagged = [];

    for (const item of items) {
        const current = String(translatedById[String(item.id)] || '');
        if (!current.trim()) continue;
        if (isJunkOrInterjection(item.text)) continue;

        const reasons = detectSemanticSpotCheckReasons(current);
        if (reasons.length) flagged.push({ item, reasons });
    }

    console.log(`${c.green}[Semantic Spot Check] Verificare punctuală încheiată.${c.reset}`);
    return flagged.map(entry => entry.item);
}

// ============================================================
// RECUPERARE FINALĂ — TRADUCERI DEVENITE GOALE
// ============================================================

// Întoarce un motiv explicit când o traducere de recuperare nu este acceptată.
function assessEmptyRecoveryCandidate(item, candidateRaw) {
    if (candidateRaw === undefined || candidateRaw === null) {
        return { ok: false, reason: 'ID absent din răspunsul Gemini' };
    }

    const candidate = formatSubtitleLine(String(candidateRaw || ''));
    if (!candidate || !candidate.replace(/<[^>]+>/g, '').trim()) {
        return { ok: false, reason: 'Gemini a returnat text gol' };
    }
    if (hasUntranslatedEnglish(item.text, candidate)) {
        return { ok: false, reason: 'textul conține engleză netradusă' };
    }
    if (hasCorruptedSubtitleText(candidate, item.text)) {
        return { ok: false, reason: 'textul a fost respins de verificarea de corupere' };
    }
    if (hasLostExplicitSourceTerm(item.text, candidate)) {
        return { ok: false, reason: 'traducerea pierde un termen explicit din original' };
    }
    return { ok: true, candidate };
}

// Recuperare locală, fără apel API: refolosește traducerea deja validată a unei
// replici cu text-sursă identic. Nu ghicește și nu folosește potriviri aproximative.
function normalizeLocalRecoverySource(text) {
    return String(text || '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .normalize('NFC')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeLocalRecoveryTranslation(text) {
    return String(text || '')
        .replace(/<[^>]+>/g, ' ')
        .normalize('NFC')
        .replace(/\s+/g, ' ')
        .trim();
}

function recoverEmptyTranslationsLocally(allItems, emptyItems, translatedById, stageLabel) {
    const bySource = new Map();

    for (const sourceItem of allItems) {
        const sourceKey = normalizeLocalRecoverySource(sourceItem.text);
        if (!sourceKey || isEffectivelyEmptySubtitleText(sourceItem.text) || isJunkOrInterjection(sourceItem.text)) continue;

        const current = String(translatedById[String(sourceItem.id)] || '');
        if (!current.replace(/<[^>]+>/g, '').trim()) continue;

        const assessment = assessEmptyRecoveryCandidate(sourceItem, current);
        if (!assessment.ok) continue;

        const translationKey = normalizeLocalRecoveryTranslation(assessment.candidate);
        if (!translationKey) continue;

        if (!bySource.has(sourceKey)) bySource.set(sourceKey, new Map());
        const translations = bySource.get(sourceKey);
        if (!translations.has(translationKey)) {
            translations.set(translationKey, { candidate: assessment.candidate, sourceId: String(sourceItem.id) });
        }
    }

    const recoveredIds = [];
    const remaining = [];
    for (const item of emptyItems) {
        const id = String(item.id);
        const sourceKey = normalizeLocalRecoverySource(item.text);
        const matches = bySource.get(sourceKey);

        // Dacă aceeași sursă are mai multe traduceri distincte deja existente,
        // considerăm cazul ambiguu și nu alegem una arbitrar.
        if (!sourceKey || !matches || matches.size !== 1) {
            remaining.push(item);
            continue;
        }

        const match = [...matches.values()][0];
        const assessment = assessEmptyRecoveryCandidate(item, match.candidate);
        if (!assessment.ok) {
            console.log(`${c.yellow}⚠ [${stageLabel} Local] ID ${id}: potrivirea cu ID ${match.sourceId} a fost respinsă: ${assessment.reason}.${c.reset}`);
            remaining.push(item);
            continue;
        }

        translatedById[id] = assessment.candidate;
        recoveredIds.push(id);
        console.log(`${c.green}✔ [${stageLabel} Local] ID ${id} recuperat din traducerea existentă a ID-ului ${match.sourceId}; fără apel Gemini.${c.reset}`);
    }

    if (recoveredIds.length) {
        console.log(`${c.green}✔ [${stageLabel} Local] Recuperate local: ${recoveredIds.length}/${emptyItems.length}.${c.reset}`);
    }
    return { recoveredIds, remaining };
}

function markEmptyRecoveryQuotaBlock(keyStates, error) {
    const message = String(error?.message || error || '');
    const quotaError = error?.isRateLimit429 === true || /\b429\b/i.test(message) || /resource has been exhausted|quota exceeded/i.test(message);
    if (!quotaError) return false;

    // O eroare de cotă pentru un singur proiect nu blochează recuperarea prin
    // celelalte proiecte. Oprim numai dacă toate proiectele rămase sunt marcate
    // cu cotă zilnică epuizată (sau au fost dezactivate ca invalide).
    if (error?.isPermanentQuotaBlock === true) {
        keyStates._emptyRecoveryQuotaBlocked = true;
        return true;
    }
    const now = Date.now();
    const nonDisabled = keyStates.filter(state => {
        const lane = getLaneForKeyState(state);
        return !state.disabled && !lane.disabled;
    });
    const allDailyBlocked = nonDisabled.length > 0 && nonDisabled.every(state => {
        const lane = getLaneForKeyState(state);
        return Math.max(Number(state.dailyQuotaUntil || 0), Number(lane.dailyQuotaUntil || 0)) > now;
    });
    if (allDailyBlocked || nonDisabled.length === 0) {
        keyStates._emptyRecoveryQuotaBlocked = true;
        return true;
    }
    return false;
}

async function retryEmptyTranslationIndividually(item, translatedById, keyStates, stageLabel = 'Empty Recovery') {
    const id = String(item.id);
    if (keyStates._emptyRecoveryQuotaBlocked) return false;

    if (!(keyStates._emptyRecoveryAttemptedIds instanceof Set)) {
        keyStates._emptyRecoveryAttemptedIds = new Set();
    }
    // Marcăm ID-ul înaintea apelului: Final Empty Recovery nu repetă aceleași cereri.
    keyStates._emptyRecoveryAttemptedIds.add(id);

    const jsonPrompt = `
${MASTER_TRANSLATION_PROMPT}

RECUPERARE INDIVIDUALĂ PENTRU O SINGURĂ TRADUCERE GOALĂ.
Tradu replica de mai jos în română naturală. Păstrează sensul, tonul și formatul de subtitrare.
Nu omite ID-ul și nu returna text gol. Returnează doar un array JSON cu exact un obiect.

${JSON.stringify([{ id: item.id, text: item.text }], null, 2)}

Format obligatoriu:
[
  {"id": ${Number.parseInt(id, 10)}, "text": "traducerea română"}
]
`;
    const plainPrompt = `Tradu în română naturală replica de subtitrare de mai jos. Păstrează sensul exact, tonul și numele proprii. Nu explica, nu pune ghilimele și nu returna JSON. Returnează numai textul românesc al replicii. Nu lăsa răspunsul gol.

ORIGINAL: ${String(item.text || '').trim()}`;

    // Empty Recovery trebuie să rotească prin pool, nu să se oprească după 3
    // încercări. După un 429 extindem retry-ul pentru a avea timp să folosim
    // proiectele disponibile, exact cum se întâmplă la traducerea calupului.
    const maxKeyAttempts = Math.max(8, keyStates.length);
    const maxRateLimitAttempts = Math.max(maxKeyAttempts, keyStates.length * 3);
    let sawRateLimit429 = false;
    let plainTextFallbackNext = false;
    let lastReason = 'nu a fost obținută o traducere validă';
    for (let attempt = 1; attempt <= (sawRateLimit429 ? maxRateLimitAttempts : maxKeyAttempts); attempt++) {
        if (keyStates._emptyRecoveryQuotaBlocked) return false;
        const plainTextMode = plainTextFallbackNext;
        plainTextFallbackNext = false;
        try {
            const retryKey = await getAvailableKey(keyStates);
            const retryRaw = await callGemini(
                plainTextMode ? plainPrompt : jsonPrompt,
                retryKey,
                { timeout: 30000, ...(plainTextMode ? { plainText: true } : {}) }
            );
            let candidateRaw = '';
            if (plainTextMode) {
                candidateRaw = cleanPlainTextReviewResponse(retryRaw);
            } else {
                const retryJson = safeJsonParse(retryRaw);
                const retryDict = normalizeTranslationPayload(retryJson);
                candidateRaw = retryDict[id];
            }

            const assessment = assessEmptyRecoveryCandidate(item, candidateRaw);
            if (assessment.ok) {
                translatedById[id] = assessment.candidate;
                return true;
            }
            lastReason = assessment.reason;
            // Trecem la răspuns simplu numai după un răspuns JSON inutilizabil,
            // nu după 429/503; o eroare de cotă trebuie să schimbe proiectul.
            plainTextFallbackNext = !plainTextMode;
        } catch (error) {
            const message = String(error?.message || error || lastReason);
            const is429 = error?.isRateLimit429 === true || /\b429\b/i.test(message);
            const is503 = /(?:status code\s*)?\b503\b/i.test(message);
            if (is429) {
                sawRateLimit429 = true;
                register429(
                    keyStates,
                    Number(error.retryAfterMs) || 15000,
                    error.isProjectQuota429 === true
                );
                console.log(`${c.yellow}⚠ [429 Retry] ${stageLabel} ID ${id}: proiect limitat; încerc alt proiect (${attempt}/${maxRateLimitAttempts}).${c.reset}`);
            } else if (is503) {
                console.log(`${c.yellow}⚠ [503 Retry] ${stageLabel} ID ${id}: serviciu temporar indisponibil; reîncerc (${attempt}/${sawRateLimit429 ? maxRateLimitAttempts : maxKeyAttempts}).${c.reset}`);
            }
            const quotaBlocked = markEmptyRecoveryQuotaBlock(keyStates, error);
            lastReason = message.slice(0, 180);
            if (quotaBlocked || error?.isPermanentQuotaBlock) return false;
            // 429 e înregistrat în callGemini pe proiectul exact care l-a primit;
            // următoarea iterație apelează selectorul, care ocolește cheia în pauză.
        }
    }
    const attemptsUsed = sawRateLimit429 ? maxRateLimitAttempts : maxKeyAttempts;
    console.log(`${c.yellow}⚠ [${stageLabel} Retry] ID ${id} nerecuperat după limita de ${attemptsUsed} încercări (${lastReason}).${c.reset}`);
    return false;
}

async function recoverEmptyTranslationsFinal(items, translatedById, keyStates) {
    const detectedEmptyTranslations = items.filter(item => {
        const originalClean = isEffectivelyEmptySubtitleText(item.text) ? '' : String(item.text || '').replace(/<[^>]+>/g, '').trim();
        if (!originalClean) return false;
        // Interjecțiile/vocalizările izolate sunt eliminate intenționat din subtitrarea română.
        if (isJunkOrInterjection(item.text)) return false;
        const translated = translatedById[String(item.id)];
        return !String(translated || '').replace(/<[^>]+>/g, '').trim();
    });

    if (!detectedEmptyTranslations.length) return { detected: 0, recovered: 0 };

    // Încercăm recuperarea locală ÎNAINTE de verificarea cotei: reutilizarea unei
    // traduceri existente nu consumă Gemini și rămâne permisă chiar după un 429.
    const localRecovery = recoverEmptyTranslationsLocally(
        items, detectedEmptyTranslations, translatedById, 'Final Empty Recovery'
    );
    let recoveredCount = localRecovery.recoveredIds.length;
    const recoveredIds = [...localRecovery.recoveredIds];
    const unresolvedAfterLocal = detectedEmptyTranslations.filter(item =>
        !String(translatedById[String(item.id)] || '').replace(/<[^>]+>/g, '').trim()
    );

    if (!unresolvedAfterLocal.length) {
        console.log(`${c.green}✔ [Final Empty Recovery] Toate cele ${detectedEmptyTranslations.length} traduceri goale au fost recuperate local.${c.reset}`);
        return { detected: detectedEmptyTranslations.length, recovered: recoveredCount };
    }

    // Abia acum oprim apelurile AI după eroare de cotă; etapa locală a rulat deja.
    if (keyStates._emptyRecoveryQuotaBlocked) {
        console.log(`${c.yellow}⚠ [Final Empty Recovery] Fără cereri Gemini din cauza erorii 429/cotă; rămase goale: ${unresolvedAfterLocal.map(item => item.id).join(', ')}.${c.reset}`);
        return { detected: detectedEmptyTranslations.length, recovered: recoveredCount };
    }

    const attemptedIds = keyStates._emptyRecoveryAttemptedIds instanceof Set
        ? keyStates._emptyRecoveryAttemptedIds
        : new Set();
    const previouslyRetried = unresolvedAfterLocal.filter(item => attemptedIds.has(String(item.id)));
    if (previouslyRetried.length) {
        console.log(`${c.yellow}ℹ [Final Empty Recovery] Nu repet retry-ul individual deja efectuat pentru ID-urile: ${previouslyRetried.map(item => item.id).join(', ')}.${c.reset}`);
    }
    const emptyTranslations = unresolvedAfterLocal.filter(item => !attemptedIds.has(String(item.id)));
    if (!emptyTranslations.length) {
        console.log(`${c.yellow}⚠ [Final Empty Recovery] Rămase goale după încercările anterioare: ${unresolvedAfterLocal.map(item => item.id).join(', ')}.${c.reset}`);
        return { detected: detectedEmptyTranslations.length, recovered: recoveredCount };
    }

    console.log(`${c.yellow}⚠ [Final Empty Recovery] ${emptyTranslations.length} traduceri încă goale; încerc recuperarea AI doar după cea locală.${c.reset}`);
    const recoveryPrompt = `
${MASTER_TRANSLATION_PROMPT}

RECUPERARE FINALĂ PENTRU TRADUCERI GOALE.
Următoarele replici au text original, dar traducerea existentă este goală.
Tradu TOATE liniile de mai jos în română naturală. Nu omite niciun ID.
Nu returna text gol.

${JSON.stringify(emptyTranslations.map(item => ({ id: item.id, text: item.text })), null, 2)}

Returnează DOAR un ARRAY JSON valid în forma:
[
  {"id": 123, "text": "traducerea română"}
]
`;

    const failedIds = [];
    try {
        const recoveryKey = await getAvailableKey(keyStates);
        const recoveryRaw = await callGemini(recoveryPrompt, recoveryKey, { timeout: 20000 });
        const recoveryJson = safeJsonParse(recoveryRaw);
        const recoveryDict = normalizeTranslationPayload(recoveryJson);

        for (const item of emptyTranslations) {
            const id = String(item.id);
            const assessment = assessEmptyRecoveryCandidate(item, recoveryDict[id]);
            if (assessment.ok) {
                translatedById[id] = assessment.candidate;
                recoveredCount++;
                recoveredIds.push(id);
            } else {
                failedIds.push(id);
                console.log(`${c.yellow}⚠ [Final Empty Recovery] ID ${id} respins: ${assessment.reason}.${c.reset}`);
            }
        }
    } catch (error) {
        const quotaBlocked = markEmptyRecoveryQuotaBlock(keyStates, error);
        console.log(`${c.yellow}⚠ [Final Empty Recovery] Cererea de recuperare a eșuat: ${error.message}${quotaBlocked ? ' Nu vor mai fi pornite alte cereri de recuperare în această procesare.' : ''}${c.reset}`);
        for (const item of emptyTranslations) {
            const id = String(item.id);
            if (!String(translatedById[id] || '').replace(/<[^>]+>/g, '').trim() && !failedIds.includes(id)) failedIds.push(id);
        }
    }

    const remainingEmpty = detectedEmptyTranslations.filter(item =>
        !String(translatedById[String(item.id)] || '').replace(/<[^>]+>/g, '').trim()
    );
    const recoveredSuffix = recoveredIds.length ? ` (ID: ${recoveredIds.join(', ')})` : '';
    const failedSuffix = remainingEmpty.length ? `; nereparate: ${remainingEmpty.map(item => item.id).join(', ')}` : '';
    console.log(`${remainingEmpty.length === 0 ? c.green : c.yellow}✔ [Final Empty Recovery] Recuperate: ${recoveredCount}/${detectedEmptyTranslations.length}${recoveredSuffix}${failedSuffix}${c.reset}`);
    return { detected: detectedEmptyTranslations.length, recovered: recoveredCount };
}

// ============================================================
// MAJUSCULE LA FRAGMENTELE CONTINUATE
// Dacă blocul englez continuă propoziția anterioară (începe cu literă mică, iar
// blocul precedent nu s-a încheiat cu punct), cuvintele funcționale de la începutul
// traducerii (Și, Iar, Dar, Să, Mai, De...) trec la literă mică. Folosește o listă
// închisă de cuvinte, ca să nu atingă niciodată nume proprii.
// ============================================================

const CONTINUATION_FUNCTION_WORDS = new Set([
    'și', 'iar', 'dar', 'sau', 'să', 'că', 'care', 'ce', 'cine', 'cum', 'când', 'unde', 'cât',
    'dacă', 'ca', 'de', 'pe', 'la', 'în', 'din', 'cu', 'pentru', 'prin', 'fără', 'despre',
    'după', 'înainte', 'către', 'între', 'mai', 'apoi', 'atunci', 'doar', 'chiar', 'tot',
    'totul', 'toți', 'toate', 'ceva', 'așa', 'nu', 'un', 'cea', 'cel', 'cei', 'cele', 'mă', 'te',
    'se', 'ne', 'vă', 'îmi', 'îți', 'își'
]);

function isContinuationBlock(prevEnglish, currentEnglish) {
    const cur = String(currentEnglish || '').replace(/<[^>]+>/g, '').trim();
    const prev = String(prevEnglish || '').replace(/<[^>]+>/g, '').trim();
    if (!cur || !prev) return false;
    if (/^[-–—]/.test(cur)) return false;
    const body = cur.replace(/^[.…\s"'“‘(\[]+/, '');
    if (!/^[a-z]/.test(body)) return false;
    if (/(?<!\.)[.!?]["”')\]]*$/.test(prev)) return false;
    return true;
}

function applyContinuationCase(items, translatedById) {
    let changed = 0;
    for (let i = 1; i < items.length; i++) {
        if (!isContinuationBlock(items[i - 1].text, items[i].text)) continue;

        const id = String(items[i].id);
        const current = String(translatedById[id] || '');
        const previousRo = String(translatedById[String(items[i - 1].id)] || '').trim();
        if (!current.trim() || !previousRo) continue;
        if (/(?<!\.)[.!?]["”]?$/.test(previousRo)) continue;
        if (/^\s*[-–—]/.test(current)) continue;

        const match = current.match(/^(\s*[.…"„“]*\s*)([A-ZĂÂÎȘȚ])([a-zăâîșț]*)/);
        if (!match) continue;
        const word = match[2] + match[3];
        const previousEnglish = String(items[i - 1].text || '').replace(/<[^>]+>/g, ' ').trim();
        const currentEnglish = String(items[i].text || '').replace(/<[^>]+>/g, ' ').trim();
        const progressiveContinuation = /\b(?:was|were|is|are)\s*$/i.test(previousEnglish) && /^[a-z]+ing\b/i.test(currentEnglish);
        if (!CONTINUATION_FUNCTION_WORDS.has(word.toLowerCase()) && !progressiveContinuation) continue;

        translatedById[id] = match[1] + match[2].toLowerCase() + match[3] + current.slice(match[0].length);
        changed++;
    }
    console.log(`${c.green}✔ [Continuări] ${changed} fragmente continuate au primit literă mică la început.${c.reset}`);
    return changed;
}


// ============================================================
// MOTORUL PRINCIPAL DE TRADUCERE SRT
// ============================================================

async function translateSrtWithGemini(srtText, apiKeys) {
    const sourceBlockCount = (String(srtText || '').match(/-->/g) || []).length;
    const parseStats = { fillerBlocksFiltered: 0, otherBlocksFiltered: 0, invalidBlocksSkipped: 0 };
    const items = parseSrt(srtText, parseStats);
    if (!items.length) throw new Error('Nu s-au găsit subtitrări valide.');

    const accountingDelta = sourceBlockCount - items.length - parseStats.fillerBlocksFiltered - parseStats.otherBlocksFiltered - parseStats.invalidBlocksSkipped;
    console.log(`${c.cyan}[SRT] Sursă: ${sourceBlockCount} blocuri | către Gemini: ${items.length} | interjecții eliminate înainte: ${parseStats.fillerBlocksFiltered}${parseStats.otherBlocksFiltered ? ` | alte blocuri goale/curățate: ${parseStats.otherBlocksFiltered}` : ''}${parseStats.invalidBlocksSkipped ? ` | blocuri SRT invalide ignorate: ${parseStats.invalidBlocksSkipped}` : ''}${accountingDelta ? ` | diferență de numărătoare: ${accountingDelta}` : ''}.${c.reset}`);

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

            if (localIndex > 0) await sleep(1500 * localIndex);

            const result = await processChunkWithRetry(chunk, items, start, end, previousTranslatedContext, keyStates, globalIndex, chunks.length);
            return { globalIndex, result };
        });

        const results = await Promise.all(promises);
        results.sort((a, b) => a.globalIndex - b.globalIndex);

        for (const batchResult of results) {
            const sourceChunk = chunks[batchResult.globalIndex];
            let chunkResult = batchResult.result;
            const blankCount = chunkResult.filter(item => !String(item.text || '').trim()).length;
            const isMostlyBlank = chunkResult.length > 0 && blankCount >= Math.ceil(chunkResult.length * 0.8);
            const alignmentIssue = isMostlyBlank ? null : detectTranslationAlignmentShift(sourceChunk, chunkResult);
            if (alignmentIssue) {
                const suspectStart = Math.max(0, alignmentIssue.start - 2);
                const suspectEnd = Math.min(sourceChunk.length - 1, alignmentIssue.end + 2);
                const startId = sourceChunk[suspectStart]?.id ?? sourceChunk[alignmentIssue.start]?.id;
                const endId = sourceChunk[suspectEnd]?.id ?? sourceChunk[alignmentIssue.end]?.id;
                console.log(`${c.yellow}⚠ [Aliniere] Posibilă decalare ${alignmentIssue.shift > 0 ? '+' : ''}${alignmentIssue.shift} replică detectată în zona ID ${startId}–${endId} (corelație ${alignmentIssue.score.toFixed(2)}, bază ${alignmentIssue.baseline.toFixed(2)}, ${alignmentIssue.windows} ferestre). Retraduc zona în segmente mai mici; nu mut automat textele între ID-uri.${c.reset}`);
                chunkResult = await repairTranslationAlignmentRange(
                    sourceChunk,
                    chunkResult,
                    alignmentIssue,
                    items,
                    batchResult.globalIndex * CHUNK_SIZE,
                    keyStates,
                    batchResult.globalIndex,
                    chunks.length
                );
                const residualIssue = detectTranslationAlignmentShift(sourceChunk, chunkResult);
                if (residualIssue) {
                    const residualStart = sourceChunk[Math.max(0, residualIssue.start - 2)]?.id ?? sourceChunk[residualIssue.start]?.id;
                    const residualEnd = sourceChunk[Math.min(sourceChunk.length - 1, residualIssue.end + 2)]?.id ?? sourceChunk[residualIssue.end]?.id;
                    console.log(`${c.yellow}⚠ [Aliniere] După retraducere persistă un semnal statistic de posibilă decalare în zona ID ${residualStart}–${residualEnd}. Textele nu au fost mutate automat; zona merită verificată.${c.reset}`);
                } else {
                    console.log(`${c.green}✔ [Aliniere] Verificarea după retraducere nu mai detectează decalarea inițială.${c.reset}`);
                }
                batchResult.result = chunkResult;
            }
            for (const item of batchResult.result) {
                translatedById[String(item.id)] = item.text;
            }
        }

        const lastResult = results[results.length - 1];
        if (lastResult && lastResult.result) {
            previousTranslatedContext = lastResult.result.slice(-PREVIOUS_TRANSLATION_CONTEXT);
        }
    }

    console.log(`${c.green}[Gemini] Calupuri inițiale finalizate: ${chunks.length}/${chunks.length}.${c.reset}`);

    let sourceGroundedCorrections = 0;
    for (const item of items) {
        const id = String(item.id);
        const before = String(translatedById[id] || '');
        const after = applyBecauseOfWhatISaidCorrection(item.text, before);
        if (after !== before) {
            translatedById[id] = formatSubtitleLine(after);
            sourceGroundedCorrections++;
        }
    }
    if (sourceGroundedCorrections) {
        console.log(`${c.green}[Corecturi locale] ${sourceGroundedCorrections} corecții ancorate în originalul EN aplicate înainte de retry.${c.reset}`);
    }

    const emptyTranslations = items.filter(item => {
        const originalClean = isEffectivelyEmptySubtitleText(item.text) ? '' : String(item.text || '').replace(/<[^>]+>/g, '').trim();
        if (!originalClean || isJunkOrInterjection(item.text)) return false;
        const translated = translatedById[String(item.id)];
        return !String(translated || '').replace(/<[^>]+>/g, '').trim();
    });

    if (emptyTranslations.length > 0) {
        console.log(`${c.yellow}⚠ [Empty Recovery] ${emptyTranslations.length} traduceri goale detectate. Încerc mai întâi recuperarea locală...${c.reset}`);
        const localRecovery = recoverEmptyTranslationsLocally(
            items, emptyTranslations, translatedById, 'Empty Recovery'
        );
        let recoveredCount = localRecovery.recoveredIds.length;
        const recoveredIds = [...localRecovery.recoveredIds];
        const failedIds = [];
        const failedItems = [];
        let parsedInitialResponse = false;
        const pendingEmptyTranslations = localRecovery.remaining;

        if (pendingEmptyTranslations.length && !keyStates._emptyRecoveryQuotaBlocked) {
            console.log(`${c.yellow}⚠ [Empty Recovery] ${pendingEmptyTranslations.length} replici nu au potrivire locală sigură; solicit Gemini doar pentru acestea.${c.reset}`);
            const recoveryPrompt = `
${MASTER_TRANSLATION_PROMPT}

RECOVERY PENTRU TRADUCERI GOALE.
Următoarele replici au text original, dar traducerea anterioară a fost goală.
Tradu TOATE liniile de mai jos în română naturală. Nu omite niciun ID.

${JSON.stringify(pendingEmptyTranslations.map(item => ({ id: item.id, text: item.text })), null, 2)}

Returnează DOAR un ARRAY JSON valid în forma:
[
  {"id": 123, "text": "traducerea română"}
]
`;

            try {
                const recoveryKey = await getAvailableKey(keyStates);
                const recoveryRaw = await callGemini(recoveryPrompt, recoveryKey);
                const recoveryJson = safeJsonParse(recoveryRaw);
                const recoveryDict = normalizeTranslationPayload(recoveryJson);
                parsedInitialResponse = true;

                for (const item of pendingEmptyTranslations) {
                    const id = String(item.id);
                    const assessment = assessEmptyRecoveryCandidate(item, recoveryDict[id]);
                    if (assessment.ok) {
                        translatedById[id] = assessment.candidate;
                        recoveredCount++;
                        recoveredIds.push(id);
                    } else {
                        failedIds.push(id);
                        failedItems.push(item);
                        console.log(`${c.yellow}⚠ [Empty Recovery] ID ${id} respins: ${assessment.reason}.${c.reset}`);
                    }
                }
            } catch (error) {
                const quotaBlocked = markEmptyRecoveryQuotaBlock(keyStates, error);
                console.log(`${c.yellow}⚠ [Empty Recovery] Cererea de recuperare a eșuat: ${error.message}${quotaBlocked ? ' Nu vor mai fi pornite alte cereri de recuperare în această procesare.' : ''}${c.reset}`);
            }

            // Doar ID-urile respinse de un răspuns utilizabil primesc un retry AI individual.
            if (parsedInitialResponse && !keyStates._emptyRecoveryQuotaBlocked) {
                for (const item of failedItems) {
                    if (keyStates._emptyRecoveryQuotaBlocked) break;
                    const id = String(item.id);
                    const retriedSuccessfully = await retryEmptyTranslationIndividually(
                        item, translatedById, keyStates, 'Empty Recovery'
                    );
                    if (retriedSuccessfully) {
                        recoveredCount++;
                        recoveredIds.push(id);
                        const failedIndex = failedIds.indexOf(id);
                        if (failedIndex >= 0) failedIds.splice(failedIndex, 1);
                    }
                }
            }
        } else if (pendingEmptyTranslations.length && keyStates._emptyRecoveryQuotaBlocked) {
            console.log(`${c.yellow}⚠ [Empty Recovery] Gemini omis: cota a fost deja depășită; încercarea locală a fost efectuată.${c.reset}`);
        }

        // Raportăm ID-urile încă goale după toate încercările, inclusiv fallback-ul local.
        const stillEmpty = emptyTranslations.filter(item =>
            !String(translatedById[String(item.id)] || '').replace(/<[^>]+>/g, '').trim()
        );
        for (const item of stillEmpty) {
            const id = String(item.id);
            if (!failedIds.includes(id)) failedIds.push(id);
        }
        const recoveredSuffix = recoveredIds.length ? ` (ID: ${recoveredIds.join(', ')})` : '';
        const failedSuffix = stillEmpty.length ? `; nereparate: ${stillEmpty.map(item => item.id).join(', ')}` : '';
        console.log(`${stillEmpty.length === 0 ? c.green : c.yellow}✔ [Empty Recovery] Recuperate: ${recoveredCount}/${emptyTranslations.length}${recoveredSuffix}${failedSuffix}${c.reset}`);
    }

    const targetedRetry = await globalPostCheck(items, translatedById, keyStates, 2);
    console.log(`${c.green}[RETRY FINAL] ${targetedRetry.fixed} replici reparate.${c.reset}`);

    // Reparăm determinist doar connectorii repetați când cele două originale
    // stabilesc fără ambiguitate că primul bloc a adăugat conectorul prea devreme.
    // Astfel, cazul de limită nu mai consumă o cerere Grammar Review/JSON.
    applyDeterministicBoundaryConnectorFixes(items, translatedById);

    // Verificare AI punctuală și limitată: numai replicile pe care semnalele
    // locale le marchează ca potențial corupte/agramaticale. Nu revizuim toate
    // subtitrările și nu schimbăm modelul, calupurile sau mecanismul cheilor.
    const localQuality = await runLocalGrammarQualityPass(items, translatedById);
    const semanticQualityItems = runSemanticSpotCheck(items, translatedById);
    const targetedReasonById = { ...localQuality.reasonsById };
    for (const item of semanticQualityItems) {
        const id = String(item.id);
        const reasons = detectSemanticSpotCheckReasons(translatedById[id] || '');
        if (reasons.length) {
            targetedReasonById[id] = [targetedReasonById[id], reasons.join('; ')].filter(Boolean).join('; ');
        }
    }

    const targetedQualityIds = new Set([
        ...localQuality.flaggedItems.map(item => String(item.id)),
        ...semanticQualityItems.map(item => String(item.id))
    ]);
    const targetedQualityCandidates = items.filter(item => targetedQualityIds.has(String(item.id)));
    const MAX_TARGETED_QUALITY_REVIEW_ITEMS = 30;
    let firstQualityReview = { checked: 0, fixed: 0, rejectedQualityReasonsById: Object.create(null) };
    if (targetedQualityCandidates.length) {
        const reviewItems = targetedQualityCandidates.slice(0, MAX_TARGETED_QUALITY_REVIEW_ITEMS);
        console.log(`${c.cyan}🎯 [Quality Retry] Verificare AI punctuală pentru ${reviewItems.length} replici.${c.reset}`);
        firstQualityReview = await grammarTranslationReview(reviewItems, translatedById, keyStates, {
            mode: 'targeted',
            contextItems: items,
            reasonById: targetedReasonById
        });
        console.log(`${c.green}✔ [Quality Retry] ${firstQualityReview.checked} verificate punctual, ${firstQualityReview.fixed} corectate.${c.reset}`);
    } else {
        console.log(`${c.green}✔ [Quality Retry] Nicio replică nu a declanșat verificarea AI punctuală; nu s-a adăugat o cerere Gemini.${c.reset}`);
    }

    // Verificare după corectare: reevaluăm numai replicile care încă au semnale
    // cunoscute. Un singur al doilea tur, limitat la 15 replici, evită atât acceptarea
    // oarbă a unei corecturi greșite, cât și o Grammar Review costisitoare pentru tot filmul.
    const unresolvedQualityMap = new Map();
    for (const item of items) {
        if (isJunkOrInterjection(item.text)) continue;
        const id = String(item.id);
        const text = String(translatedById[id] || '');
        if (!text.trim()) continue;
        const reasons = collectQualityReviewReasons(item, text, items, translatedById);
        if (reasons.length) unresolvedQualityMap.set(id, { item, reasons: [...new Set(reasons)] });
    }
    for (const issue of findRepeatedBoundaryConnectorIssues(items, translatedById)) {
        const id = String(issue.item.id);
        const existing = unresolvedQualityMap.get(id);
        if (existing) existing.reasons.push(issue.reason);
        else unresolvedQualityMap.set(id, { item: issue.item, reasons: [issue.reason] });
    }

    if (unresolvedQualityMap.size && targetedQualityCandidates.length) {
        const retryCandidates = items.filter(item => unresolvedQualityMap.has(String(item.id))).slice(0, 15);
        const retryReasonById = Object.fromEntries(retryCandidates.map(item => {
            const id = String(item.id);
            const unresolvedReasons = unresolvedQualityMap.get(id).reasons;
            const rejectedReasons = firstQualityReview.rejectedQualityReasonsById?.[id] || [];
            return [id, [...new Set([
                ...unresolvedReasons,
                ...rejectedReasons.map(reason => `propunere anterioară respinsă: ${reason}`)
            ])].join('; ')];
        }));
        console.log(`${c.cyan}🔁 [Quality Recheck] Reverificare punctuală pentru ${retryCandidates.length} replici.${c.reset}`);
        const recheck = await grammarTranslationReview(retryCandidates, translatedById, keyStates, {
            mode: 'targeted',
            contextItems: items,
            reasonById: retryReasonById
        });
        console.log(`${c.cyan}🔁 [Quality Recheck] ${recheck.checked} reverificate, ${recheck.fixed} corectate la a doua verificare.${c.reset}`);
    }

    // Recuperare finală independentă de Grammar Review pentru eventuale traduceri goale.
    await recoverEmptyTranslationsFinal(items, translatedById, keyStates);

    // Ultima protecție: corecțiile mecanice certe se reaplică înainte de export.
    // formatSubtitleLine() este idempotent pentru aceste corecții și reaplică
    // dicționarul determinist la final.
    for (const item of items) {
        const id = String(item.id);
        const current = translatedById[id];
        if (current == null || String(current).trim() === '') continue;

        // Protecție suplimentară: formatterul final nu are voie să șteargă
        // accidental o traducere care exista deja. Dacă după curățare toate
        // caracterele dispar, păstrăm ultima traducere nenulă disponibilă.
        const currentText = String(current);
        let finalText = applyDeterministicSemanticFix(
            item.text,
            formatSubtitleLine(currentText)
        );
        finalText = applySourceGroundedSemanticFixes(item.text, finalText);
        finalText = applyLocalGrammarDeterministicFixes(finalText);
        const formattedFinalText = formatSubtitleLine(finalText);

        if (String(formattedFinalText).trim()) {
            translatedById[id] = formattedFinalText;
        } else {
            translatedById[id] = currentText;
            console.log(`${c.yellow}⚠ [Protecție finală] ID ${id}: formatterul ar fi golit traducerea; am păstrat ultima variantă nenulă.${c.reset}`);
        }
    }

    applyContinuationCase(items, translatedById);
    // Ultima apărare contra conectorilor reintroduși de Grammar Review.
    applyDeterministicBoundaryConnectorFixes(items, translatedById);

    // Reparare finală pe baza verificărilor efectuate după formatare.
    // Astfel, semnalele care au supraviețuit verificărilor anterioare revin la
    // corectare contextuală înainte de export, nu doar în raportul final.
    const finalRepairReasonById = Object.create(null);
    const finalRepairCandidates = [];
    for (const item of items) {
        const id = String(item.id);
        const originalClean = isEffectivelyEmptySubtitleText(item.text)
            ? ''
            : String(item.text || '').replace(/<[^>]+>/g, '').trim();
        if (!originalClean || isJunkOrInterjection(item.text)) continue;

        const current = String(translatedById[id] || '');
        const reasons = [];
        if (!current.trim()) reasons.push('traducere goală; trebuie completată în română');
        if (hasUntranslatedEnglish(item.text, current)) reasons.push('posibil fragment englezesc netradus; repară fragmentul în română');
        if (hasCorruptedSubtitleText(current, item.text)) reasons.push('posibil text corupt; reconstruiește formularea din original și context');
        reasons.push(...getSourceFidelityIssues(item.text, current));
        reasons.push(...collectQualityReviewReasons(item, current, items, translatedById));
        const uniqueReasons = [...new Set(reasons)];
        if (uniqueReasons.length) {
            finalRepairCandidates.push(item);
            finalRepairReasonById[id] = uniqueReasons.join('; ');
        }
    }
    for (const issue of findRepeatedBoundaryConnectorIssues(items, translatedById)) {
        const id = String(issue.item.id);
        if (!finalRepairCandidates.some(item => String(item.id) === id)) {
            finalRepairCandidates.push(issue.item);
        }
        finalRepairReasonById[id] = [finalRepairReasonById[id], issue.reason].filter(Boolean).join('; ');
    }

    if (finalRepairCandidates.length) {
        const beforeFinalRepair = new Map(finalRepairCandidates.map(item => [
            String(item.id), String(translatedById[String(item.id)] || '')
        ]));
        console.log(`${c.cyan}[Final Repair] Corectare contextuală finală pentru ${finalRepairCandidates.length} replici candidate...${c.reset}`);
        const finalReview = await grammarTranslationReview(
            finalRepairCandidates,
            translatedById,
            keyStates,
            { mode: 'targeted', contextItems: items, reasonById: finalRepairReasonById }
        );

        // Reaplicăm numai formatarea sigură pe replicile corectate în ultimul pas.
        for (const item of finalRepairCandidates) {
            const id = String(item.id);
            const current = String(translatedById[id] || '');
            if (!current.trim() || current === beforeFinalRepair.get(id)) continue;
            let finalText = applyDeterministicSemanticFix(item.text, formatSubtitleLine(current));
            finalText = applySourceGroundedSemanticFixes(item.text, finalText);
            finalText = applyLocalGrammarDeterministicFixes(finalText);
            const formatted = formatSubtitleLine(finalText);
            if (formatted.trim()) translatedById[id] = formatted;
        }
        applyContinuationCase(items, translatedById);
        applyDeterministicBoundaryConnectorFixes(items, translatedById);
        console.log(`${c.green}[Final Repair] Verificare finală încheiată; ${Number(finalReview?.fixed || 0)} corectări aplicate.${c.reset}`);
    }

    // Interjecțiile generate ca traducere izolată sunt eliminate din ieșire și
    // scoase din numitorul QA; nu trebuie raportate ca eroare de fidelitate.
    // Ultima curățare înainte de export, după toate etapele care pot modifica textul.
    // Dacă replica a rămas numai o interjecție/umplutură, o golim; altfel păstrăm restul.
    for (const item of items) {
        const id = String(item.id);
        const current = String(translatedById[id] || '');
        if (!current.trim()) continue;
        const cleaned = formatSubtitleLine(current);
        if (cleaned.trim()) {
            translatedById[id] = cleaned;
        } else if (isOnlyStandaloneFillerSequence(current) || isOnlyStandaloneOutputInterjection(current)) {
            translatedById[id] = '';
        }
    }

    const suppressedFillerIds = items
        .filter(item => {
            const id = String(item.id);
            const translated = String(translatedById[id] || '').trim();
            // A source-only reaction/marker must not leak into the output, even if Gemini
            // returned an empty or non-empty paraphrase for it. Also suppress reaction-only translations.
            return isJunkOrInterjection(item.text) || isOnlyStandaloneFillerSequence(translated) || isOnlyStandaloneOutputInterjection(translated);
        })
        .map(item => String(item.id));
    const suppressedFillerIdSet = new Set(suppressedFillerIds);

    const finalQualityFlags = [];
    for (const item of items) {
        const id = String(item.id);
        if (isJunkOrInterjection(item.text) || suppressedFillerIdSet.has(id)) continue;
        const text = String(translatedById[id] || '');
        const reasons = collectQualityReviewReasons(item, text, items, translatedById);
        if (reasons.length) finalQualityFlags.push({ item, reasons: [...new Set(reasons)] });
    }
    for (const issue of findRepeatedBoundaryConnectorIssues(items, translatedById)) {
        const id = String(issue.item.id);
        if (suppressedFillerIdSet.has(id)) continue;
        const existing = finalQualityFlags.find(entry => String(entry.item.id) === id);
        if (existing) {
            if (!existing.reasons.includes(issue.reason)) existing.reasons.push(issue.reason);
        } else {
            finalQualityFlags.push({ item: issue.item, reasons: [issue.reason] });
        }
    }

    const finalSuspicious = items.filter(item => {
        const id = String(item.id);
        if (suppressedFillerIdSet.has(id)) return false;
        const originalClean = isEffectivelyEmptySubtitleText(item.text) ? '' : String(item.text || '').replace(/<[^>]+>/g, '').trim();
        if (!originalClean) return false;

        const translated = translatedById[id];
        const transClean = String(translated || '').replace(/<[^>]+>/g, '').trim();
        if (!transClean) return true;
        if (isJunkOrInterjection(item.text)) return false;

        return hasUntranslatedEnglish(item.text, translated) ||
            hasCorruptedSubtitleText(translated, item.text) ||
            hasLostExplicitSourceTerm(item.text, translated);
    });

    // Numitorul QA include doar replicile-sursă care chiar trebuie să aibă text:
    // exclude interjecțiile suprimate intenționat și blocurile-sursă goale/tehnice.
    const qaEligibleItems = items.filter(item => {
        const id = String(item.id);
        const originalClean = isEffectivelyEmptySubtitleText(item.text)
            ? '' : String(item.text || '').replace(/<[^>]+>/g, '').trim();
        return Boolean(originalClean) &&
            !suppressedFillerIdSet.has(id) &&
            !isJunkOrInterjection(item.text);
    });
    const qaEligibleIds = new Set(qaEligibleItems.map(item => String(item.id)));
    const unresolvedEmpty = qaEligibleItems.filter(item =>
        !String(translatedById[String(item.id)] || '').replace(/<[^>]+>/g, '').trim()
    );
    const remainingNonEmptySuspicious = finalSuspicious.filter(item => {
        const id = String(item.id);
        return !unresolvedEmpty.some(missing => String(missing.id) === id);
    });
    const emittedCount = qaEligibleItems.filter(item =>
        String(translatedById[String(item.id)] ?? '').replace(/<[^>]+>/g, '').trim().length > 0
    ).length;
    const finalStatus = {
        inputCount: items.length,
        eligibleCount: qaEligibleItems.length,
        emittedCount,
        unresolvedEmptyCount: unresolvedEmpty.length,
        unresolvedEmptyIds: unresolvedEmpty.map(item => String(item.id)),
        remainingSuspiciousCount: remainingNonEmptySuspicious.length,
        suppressedFillerCount: suppressedFillerIds.length
    };
    const logContext = translationLogContext.getStore();
    if (logContext) logContext.finalStatus = finalStatus;

    const routineMetrics = logContext?.routineMetrics || { automatedInterventions: 0 };
    const qaSummary = `[QA FINAL] Text: ${emittedCount}/${qaEligibleItems.length} | Goale: ${unresolvedEmpty.length} | Suspecte: ${remainingNonEmptySuspicious.length} | Suprimate: ${suppressedFillerIds.length} | Intervenții automate: ${routineMetrics.automatedInterventions}`;
    if (unresolvedEmpty.length) {
        console.log(`${c.yellow}${qaSummary}${c.reset}`);
        console.log(`${c.yellow}[QA FINAL] ID-uri fără traducere: ${unresolvedEmpty.map(item => String(item.id)).join(', ')}${c.reset}`);
    } else if (remainingNonEmptySuspicious.length) {
        console.log(`${c.yellow}${qaSummary}${c.reset}`);
    } else {
        console.log(`${c.green}${qaSummary}${c.reset}`);
    }

    const output = items
        .filter(item => {
            const id = String(item.id);
            return qaEligibleIds.has(id) && String(translatedById[id] ?? '').replace(/<[^>]+>/g, '').trim().length > 0;
        })
        .map(item => {
            const translated = String(translatedById[String(item.id)]);
            return `${item.id}\n${item.start} --> ${item.end}\n${translated}\n`;
        }).join('\n');

    return output.trim() ? output.trim() + '\n' : '';
}

// ============================================================
// TARGET URL VALIDATION / SSRF PROTECTION
// ============================================================

function isPrivateOrReservedIp(address) {
    const family = net.isIP(address);

    if (family === 4) {
        const parts = address.split('.').map(Number);
        if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) {
            return true;
        }

        const value = ((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3];
        const inRange = (start, end) => value >= start && value <= end;

        return (
            inRange(0x00000000, 0x00FFFFFF) || // 0.0.0.0/8
            inRange(0x0A000000, 0x0AFFFFFF) || // 10.0.0.0/8
            inRange(0x64400000, 0x647FFFFF) || // 100.64.0.0/10
            inRange(0x7F000000, 0x7FFFFFFF) || // 127.0.0.0/8
            inRange(0xA9FE0000, 0xA9FEFFFF) || // 169.254.0.0/16
            inRange(0xAC100000, 0xAC1FFFFF) || // 172.16.0.0/12
            inRange(0xC0000000, 0xC00000FF) || // 192.0.0.0/24
            inRange(0xC0000200, 0xC00002FF) || // 192.0.2.0/24
            inRange(0xC0A80000, 0xC0A8FFFF) || // 192.168.0.0/16
            inRange(0xC6120000, 0xC613FFFF) || // 198.18.0.0/15
            inRange(0xC6336400, 0xC63364FF) || // 198.51.100.0/24
            inRange(0xCB007100, 0xCB0071FF) || // 203.0.113.0/24
            inRange(0xE0000000, 0xFFFFFFFF)    // multicast/reserved
        );
    }

    if (family === 6) {
        const normalized = address.toLowerCase().replace(/%.+$/, '');

        if (
            normalized === '::' ||
            normalized === '::1' ||
            normalized.startsWith('fc') ||
            normalized.startsWith('fd') ||
            /^(fe[89ab])/.test(normalized) ||
            normalized.startsWith('ff') ||
            normalized.startsWith('2001:db8:')
        ) {
            return true;
        }

        const mappedMatch = normalized.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
        if (mappedMatch) {
            return isPrivateOrReservedIp(mappedMatch[1]);
        }

        return false;
    }

    return true;
}

async function validateTargetUrl(rawUrl) {
    let parsed;

    try {
        parsed = new URL(String(rawUrl || '').trim());
    } catch (error) {
        throw new Error('URL sursă invalid.');
    }

    if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error('Sunt permise doar URL-uri HTTP sau HTTPS.');
    }

    if (parsed.username || parsed.password) {
        throw new Error('URL-urile cu autentificare inclusă nu sunt permise.');
    }

    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');

    if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname.endsWith('.internal') || hostname.endsWith('.home.arpa')) {
        throw new Error('Destinația URL nu este permisă.');
    }

    let addresses;

    if (net.isIP(hostname)) {
        addresses = [{ address: hostname, family: net.isIP(hostname) }];
    } else {
        try {
            addresses = await dns.lookup(hostname, { all: true, verbatim: true });
        } catch (error) {
            throw new Error('Nu s-a putut rezolva gazda URL-ului.');
        }
    }

    if (!addresses.length || addresses.some(entry => isPrivateOrReservedIp(entry.address))) {
        throw new Error('Destinația URL nu este permisă.');
    }

    return {
        url: parsed.toString(),
        address: addresses[0].address,
        family: addresses[0].family
    };
}

async function fetchValidatedSubtitleUrl(initialUrl) {
    let currentUrl = initialUrl;
    const maxRedirects = 5;

    for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount++) {
        const validation = await validateTargetUrl(currentUrl);

        const response = await axios.get(validation.url, {
            headers: { 'User-Agent': BROWSER_USER_AGENT },
            timeout: 30000,
            responseType: 'text',
            maxRedirects: 0,
            validateStatus: status => status >= 200 && status < 400,
            lookup: (hostname, options, callback) => {
                callback(null, validation.address, validation.family);
            }
        });

        if (response.status >= 300) {
            const location = response.headers.location;
            if (!location) {
                throw new Error('Redirecționare URL fără destinație validă.');
            }
            currentUrl = new URL(location, validation.url).toString();
            continue;
        }

        return response;
    }

    throw new Error('Prea multe redirecționări pentru URL-ul sursă.');
}

// ============================================================
// TRANSLATION ROUTE
// ============================================================

app.get('/:configData/translate', async (req, res) => {
    const imdbId = req.query.id;
    const targetUrl = req.query.targetUrl || req.query.url;
    const configData = req.params.configData;


    if (!targetUrl) {
        console.log(`${c.red}✖ EROARE: Lipsă URL sursă.${c.reset}`);
        return res.status(400).send('Lipsă URL sursă.');
    }

    let validatedTarget;
    try {
        validatedTarget = await validateTargetUrl(targetUrl);
    } catch (error) {
        console.log(`${c.red}✖ EROARE: URL sursă respins: ${error.message}${c.reset}`);
        return res.status(400).send(error.message);
    }

    let userKeys = [];
    try {
        const decoded = Buffer.from(configData, 'base64').toString('utf8');
        let parsed;
        try {
            parsed = JSON.parse(decoded);
        } catch(err) {
            parsed = decoded;
        }

        if (Array.isArray(parsed)) {
            userKeys = parsed;
        } else if (parsed && typeof parsed === 'object') {
            userKeys = parsed.key ? [parsed.key] : Object.values(parsed);
        } else if (typeof parsed === 'string') {
            userKeys = [parsed];
        }
    } catch(e) {
        console.log(`${c.red}✖ EROARE: Configurare invalidă.${c.reset}`);
        return res.status(400).send('Configurare invalidă. Instalează addon-ul din nou.');
    }

    userKeys = userKeys.map(k => String(k).trim()).filter(Boolean);

    if (!userKeys.length) {
        console.log(`${c.red}✖ EROARE: Nu s-au putut extrage chei API valide.${c.reset}`);
        return res.status(400).send('Nu există chei Gemini configurate.');
    }

    const cacheKey = validatedTarget.url;

    const cachedEntry = getMemoryCacheEntry(cacheKey);
    if (typeof cachedEntry === 'string') {
        res.setHeader('Content-Type', 'application/x-subrip; charset=utf-8');
        return res.send(cachedEntry);
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

        if (cachedEntry && typeof cachedEntry !== 'string') {
            processPromise = cachedEntry;
        } else {
            const startTime = Date.now();
            
            const logContext = { mediaId: imdbId, finalStatus: null, routineMetrics: { automatedInterventions: 0 } };
            processPromise = translationLogContext.run(logContext, async () => {
                const [srtRes, mediaTitle] = await Promise.all([
                    fetchValidatedSubtitleUrl(validatedTarget.url),
                    fetchMediaTitle(imdbId)
                ]);
                rememberOriginalSource(cacheKey, String(srtRes.data || ''));

                logTranslationStart(imdbId, mediaTitle);

                return await translateSrtWithGemini(String(srtRes.data || ''), userKeys);
            });
            
            memoryCache.set(cacheKey, processPromise);
            cleanMemoryCache(cacheKey);
            
            processPromise.then(translatedSrtString => {
                // Înlocuiește numai intrarea pentru această promisiune; nu suprascrie
                // accidental o intrare mai nouă dacă logica cache-ului se schimbă ulterior.
                if (memoryCache.get(cacheKey) === processPromise) {
                    memoryCache.delete(cacheKey);
                    memoryCache.set(cacheKey, translatedSrtString);
                }
                cleanMemoryCache(cacheKey); 
                
                const durationSeconds = Math.floor((Date.now() - startTime) / 1000);
                const timeFormatted = durationSeconds < 60 ? `${durationSeconds} sec` : `${Math.floor(durationSeconds / 60)} min și ${durationSeconds % 60} sec`;
                
                const status = logContext.finalStatus;
                const qaSuffix = status?.unresolvedEmptyCount
                    ? ` | QA cu ${status.unresolvedEmptyCount} lipsuri`
                    : status?.remainingSuspiciousCount
                        ? ` | QA cu ${status.remainingSuspiciousCount} avertismente`
                        : ' | QA OK';
                console.log(`\x1b[96m[${imdbId}] [DONE] | 🕒 ${timeFormatted}${qaSuffix}\x1b[0m\n`);
                
            }).catch((err) => {
                console.log(`${c.red}✖ EROARE PROCESARE PENTRU: ${imdbId} - ${err.message}${c.reset}`);
                if (memoryCache.get(cacheKey) === processPromise) {
                    memoryCache.delete(cacheKey);
                }
            });
        }

        const finalSrt = await processPromise;
        
        if (finalSrt && finalSrt.trim().length > 0) {
            const now = new Date();
            const timeStr = now.toLocaleTimeString('ro-RO') + ' ' + now.toLocaleDateString('ro-RO');
            
            const existingIndex = secretArchive.findIndex(item => item.id === imdbId);
            const previousOriginal = existingIndex !== -1 ? secretArchive[existingIndex].original : '';
            if (existingIndex !== -1) {
                secretArchive.splice(existingIndex, 1);
            }

            secretArchive.unshift({ id: imdbId, time: timeStr, content: finalSrt, original: originalSources[cacheKey] || previousOriginal || '' });
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
// SRT PARSER NATIV 
// ============================================================

function parseSrt(srt, stats = null) {
    const normalized = String(srt || '').replace(/\r/g, '').replace(/^\uFEFF/, '');
    const blocks = normalized.split(/\n{2,}/);
    const result = [];
    if (stats) {
        stats.fillerBlocksFiltered = 0;
        stats.otherBlocksFiltered = 0;
        stats.invalidBlocksSkipped = 0;
    }

    for (const block of blocks) {
        const lines = block.split('\n').map(l => l.trimEnd());
        if (lines.length < 3) {
            if (stats && /-->/.test(block)) stats.invalidBlocksSkipped++;
            continue;
        }

        const id = Number(lines[0].trim());
        if (!Number.isInteger(id)) {
            if (stats && /-->/.test(block)) stats.invalidBlocksSkipped++;
            continue;
        }

        const timing = lines[1].trim();
        const match = timing.match(/^(\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2},\d{3})(?:.*)?$/);
        if (!match) {
            if (stats && /-->/.test(block)) stats.invalidBlocksSkipped++;
            continue;
        }

        let rawText = lines.slice(2).join('\n');

        // Detectăm interjecțiile izolate pe sursa originală, înainte de orice normalizare.
        // Curățăm pentru clasificare doar marcajele sonore uzuale, etichetele și parantezele,
        // astfel încât „♪ Woo-hoo ♪” să fie tratat ca vocalizare, nu ca replică.
        const sourceFillerProbe = rawText
            .replace(/[♪♫♬♩#]/g, '')
            .replace(/\{[^}]+\}/g, ' ')
            .replace(/\[[^\]]*?\]/g, ' ')
            .replace(/<[^>]+>/g, ' ');
        const sourceIsFillerOnly = isOnlyStandaloneFillerSequence(sourceFillerProbe);
        if (sourceIsFillerOnly) {
            if (stats) stats.fillerBlocksFiltered++;
            continue;
        }

        // Verificăm textul ORIGINAL înainte de cleanTextForJson(). Unele surse folosesc
        // entități HTML pentru spații/caractere invizibile, iar etapa de curățare poate
        // transforma aceste entități într-un fragment aparent nenul. Un astfel de bloc
        // este totuși gol și nu trebuie să intre în pipeline-ul de traducere.
        if (isEffectivelyEmptySubtitleText(rawText)) {
            if (stats) stats.otherBlocksFiltered++;
            continue;
        }

        const text = cleanTextForJson(rawText);

        if (!text || text === ' ' || isEffectivelyEmptySubtitleText(text)) {
            if (stats) {
                if (sourceIsFillerOnly) stats.fillerBlocksFiltered++;
                else stats.otherBlocksFiltered++;
            }
            continue;
        }

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
    console.log(`${c.green}🚀 RO Sub Translator v${manifest.version} pornit${c.reset}`);
    console.log(`${c.cyan}🧠 Model Gemini activ: ${MODEL_NAME}${c.reset}`);
});
