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
    version: '12.78.44',
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
    
    console.log(`\n${c.magenta}🔍 [Stremio] Caut subtitrări pentru: ${id} (${type})${c.reset}`);

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
        const videoTokens = fNameLower.split(/[^a-z0-9]+/i).filter(t => t.length > 2 && !/^(mkv|mp4|avi)$/.test(t));

        // Ranking: prioritizează varianta de subtitrare care corespunde cel mai bine
        // fișierului video ales. Nu schimbăm sursele; schimbăm doar ordinea.
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

        const getMetaText = (obj) => {
            const d = obj?.sourceData || {};
            const values = [
                d.movieReleaseName, d.releaseName, d.releaseGroup, d.releaseFormat,
                d.movieRelease, d.release, d.name, d.title, d.filename, d.fileName,
                d.source, d.sourceName, d.provider, d.group, d.format, d.tags,
                obj?.realName
            ];
            return values.filter(v => v !== undefined && v !== null && String(v).trim())
                .map(v => String(v)).join(' ');
        };

        const extractSeasonEpisode = (name) => (normalizeReleaseName(name).match(/\bs\d{1,2}e\d{1,2}\b/) || [])[0] || '';
        const extractReleaseGroup = (name) => {
            const n = normalizeReleaseName(name);
            const m = n.match(/(?:^|\s)(?:by|from)\s+([a-z0-9][a-z0-9-]{2,})\b/i);
            if (m) return m[1];
            const known = n.match(/\b(yts|yify|rarbg|tgx|qxr|psa|web|amzn|nf|dsnp|hulu|max|evo|sparks|ntb|dimension|fleet|ctrlhd)\b/);
            return known ? known[1] : '';
        };
        const detectFamily = (name) => {
            const n = normalizeReleaseName(name);
            if (/\bbluray\b/.test(n)) return 'bluray';
            if (/\bweb\b|\bamzn\b|\bnf\b|\bdsnp\b|\bhulu\b|\bmax\b/.test(n)) return 'web';
            if (/\bdvdrip\b|\bdvd\b/.test(n)) return 'dvd';
            if (/\bhdcam\b|\bhdts\b|\bcamrip\b|\btelesync\b|\btelecine\b/.test(n)) return 'cam';
            return '';
        };
        const detectProviders = (name) => {
            const n = normalizeReleaseName(name);
            return new Set((n.match(/\b(amzn|nf|dsnp|hulu|max|itunes|atvp|crunchyroll|paramount|peacock|appletv)\b/g) || []));
        };
        const detectFlags = (name) => {
            const n = normalizeReleaseName(name);
            return {
                hdr: /\bhdr\b/.test(n),
                hdr10: /\bhdr10\b/.test(n),
                dv: /\b(dv|dolby vision)\b/.test(n),
                bit10: /\b10bit\b|\b10 bit\b/.test(n),
                fps: /\b(23\.976|24|25|29\.97|30|50|59\.94|60)fps\b/.test(n),
                proper: /\bproper\b/.test(n),
                imax: /\bimax\b/.test(n),
                extended: /\bextended(?:\s+(?:cut|edition|version))?\b/.test(n),
                director: /\bdirector(?:s|['’]s)?(?:\s+cut)?\b|\bdc\b/.test(n),
                direct: /\bdirect\s+cut\b/.test(n),
                unrated: /\bunrated\b|\buncut\b|\buncensored\b/.test(n),
                theatrical: /\btheatrical(?:\s+cut)?\b/.test(n),
                recut: /\brecut\b/.test(n),
                special: /\bspecial\s+(?:edition|cut)\b/.test(n),
                ultimate: /\bultimate(?:\s+(?:cut|edition|version))?\b/.test(n),
                redux: /\bredux\b/.test(n),
                finalCut: /\bfinal\s+cut\b/.test(n),
                roadshow: /\broadshow(?:\s+version)?\b/.test(n),
                assembly: /\bassembly(?:\s+cut)?\b/.test(n),
                openMatte: /\bopen\s+matte\b/.test(n),
                tvCut: /\btv\s+cut\b|\btelevision\s+cut\b/.test(n),
                international: /\binternational\b/.test(n),
                european: /\beuropean\b/.test(n),
                us: /\b(?:us|usa|u s)\b/.test(n),
                uk: /\b(?:uk|u k)\b/.test(n),
                cannes: /\bcannes\b/.test(n),
                alternative: /\balternative(?:\s+(?:cut|version))?\b/.test(n),
                remastered: /\bremastered(?:\s+edition)?\b/.test(n),
                anniversary: /\banniversary(?:\s+edition|\s+version)?\b/.test(n),
                collector: /\bcollector(?:['’]s)?\s+edition\b/.test(n),
                criterion: /\bcriterion(?:\s+collection)?\b/.test(n),
                definitive: /\bdefinitive(?:\s+(?:cut|edition|version))?\b/.test(n),
                limited: /\blimited(?:\s+(?:edition|version))?\b/.test(n),
                workprint: /\bworkprint\b/.test(n),
                repack: /\brepack\b/.test(n),
                rerip: /\brerip\b/.test(n)
            };
        };
        const countMeaningfulOverlap = (a, b) => {
            const stop = new Set(['the','a','an','and','of','to','in','for','with','from','movie','film','episode','season','subtitle','subtitles']);
            const aa = new Set(normalizeReleaseName(a).split(/\s+/).filter(t => t.length > 2 && !stop.has(t)));
            const bb = new Set(normalizeReleaseName(b).split(/\s+/).filter(t => t.length > 2 && !stop.has(t)));
            let n = 0; aa.forEach(t => { if (bb.has(t)) n++; }); return n;
        };

        const videoMeta = getMetaText({ realName: fNameLower, sourceData: {} });
        const videoName = normalizeReleaseName(videoMeta);
        const videoFamily = detectFamily(videoName);
        const videoProviders = detectProviders(videoName);
        const videoResolution = (videoName.match(/\b(2160p|1080p|720p|sd)\b/) || [])[1] || '';
        const videoSeasonEpisode = extractSeasonEpisode(videoName);
        const videoGroup = extractReleaseGroup(videoName);
        const videoFlags = detectFlags(videoName);

        diverseSubs.forEach(s => {
            s.score = 0;
            const subMeta = getMetaText(s);
            const subName = normalizeReleaseName(subMeta);
            const subFamily = detectFamily(subName);
            const subProviders = detectProviders(subName);
            const subGroup = extractReleaseGroup(subName);
            const subFlags = detectFlags(subName);

            // 1. Exact title/release overlap.
            const overlap = countMeaningfulOverlap(videoName, subName);
            s.score += Math.min(600, overlap * 80);
            if (videoTokens.length > 0) {
                const matches = videoTokens.filter(t => t.length > 2 && subName.includes(t)).length;
                if (matches >= Math.ceil(videoTokens.length * 0.5)) s.score += 300;
                if (matches === videoTokens.length) s.score += 500;
            }

            // 2. Season/episode and release group are among the strongest signals.
            if (videoSeasonEpisode && subName.includes(videoSeasonEpisode)) s.score += 700;
            if (videoGroup && subGroup && videoGroup === subGroup) s.score += 500;
            if (videoGroup && subName.includes(videoGroup)) s.score += 250;

            // 3. Match the actual release family; do not universally prefer WEB-DL or BluRay.
            if (videoFamily && subFamily === videoFamily) s.score += 350;
            if (videoFamily && subFamily && subFamily !== videoFamily) s.score -= 250;

            // 4. Provider/platform match.
            videoProviders.forEach(p => { if (subProviders.has(p)) s.score += 220; });
            if (videoProviders.size && !subProviders.size) s.score -= 20;

            // 5. Technical match. For 4K/2160p videos, resolution is a strong
            // signal: prefer an explicitly 2160p subtitle and push 1080p below it.
            // This does not require the subtitle to be 4K in every case; it only
            // makes an explicit resolution match win when such a candidate exists.
            const subResolution = (() => {
                const d = s.sourceData || {};
                const explicit = [d.subtitleFileName, d.filename, d.fileName, d.movieReleaseName, d.releaseName, s.realName]
                    .filter(v => v !== undefined && v !== null && String(v).trim())
                    .map(v => normalizeReleaseName(String(v)));
                for (const value of explicit) {
                    const m = value.match(/\b(2160p|1080p|720p|sd)\b/);
                    if (m) return m[1];
                }
                return '';
            })();
            if (videoResolution && subResolution === videoResolution) s.score += 400;
            if (videoResolution === '2160p' && subResolution === '1080p') s.score -= 300;
            if (videoResolution === '2160p' && subResolution === '720p') s.score -= 450;
            if (videoResolution === '1080p' && subResolution === '2160p') s.score -= 250;
            if (videoFlags.hdr && subFlags.hdr) s.score += 120;
            if (videoFlags.hdr10 && subFlags.hdr10) s.score += 100;
            if (videoFlags.dv && subFlags.dv) s.score += 100;
            if (videoFlags.bit10 && subFlags.bit10) s.score += 70;
            if (videoFlags.fps && subFlags.fps) s.score += 35;
            if (videoFlags.proper && subFlags.proper) s.score += 220;
            if (videoFlags.imax && subFlags.imax) s.score += 220;

            // 6. Cut/edition matching: only bonus when the selected video actually has the tag.
            const editionFlags = ['extended','director','direct','unrated','theatrical','recut','special','ultimate','redux','finalCut','roadshow','assembly','openMatte','tvCut','international','european','us','uk','cannes','alternative','remastered','anniversary','collector','criterion','definitive','limited','workprint'];
            for (const flag of editionFlags) if (videoFlags[flag] && subFlags[flag]) s.score += 220;

            // Repack/Rerip are packaging tags, not different cuts: never penalize a candidate for them.
            // They receive only a small tie-break bonus when both sides match.
            if (videoFlags.repack && subFlags.repack) s.score += 35;
            if (videoFlags.rerip && subFlags.rerip) s.score += 35;

            // 7. Known subtitle quality penalties.
            if (/\bsdh\b|\bhi\b|hearing impaired/i.test(subName)) s.score -= 30;
            if (/\bforced\b|\bforeign parts\b/.test(subName)) s.score -= 20;
            if (/sync|corregido|resync|translated|auto|machine/.test(subName)) s.score -= 120;
            if (/yts|yify|rarbg|tgx|qxr|psa/.test(subName)) s.score += 20;
        });

        diverseSubs.sort((a, b) => b.score - a.score);

        // Compact ranking diagnostics: never dump full subtitle names or source metadata.
        console.log(`${c.cyan}🔎 [Ranking] Video: ${userFilename || id}${c.reset}`);
        console.log(`${c.cyan}   ${diverseSubs.slice(0, 5).map((s, i) => `#${i + 1} ${s.score} | ID ${s.id || s.sourceData?.id || '?'}`).join(' || ')}${c.reset}`);

        diverseSubs = diverseSubs.slice(0, 15);
        
        console.log(`${c.green}✔ S-au pregătit ${diverseSubs.length} subtitrări de tradus pentru: ${id}${c.reset}`);

        const generatedSubs = diverseSubs.map((s, index) => {
            const encodedUrl = encodeURIComponent(s.originalUrl);
            
            // Pentru afișare, folosim numele real al fișierului de subtitrare când există.
            // Unele surse au movieReleaseName corupt (ex. 1080p) deși subtitleFileName este 2160p.
            const displaySourceName = [
                s.sourceData?.subtitleFileName,
                s.sourceData?.filename,
                s.sourceData?.fileName,
                s.sourceData?.releaseName,
                s.realName,
                s.sourceData?.movieReleaseName
            ].find(v => v !== undefined && v !== null && String(v).trim()) || '';
            let vizualName = String(displaySourceName).replace(/[^a-zA-Z0-9.-]/g, ' ');
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

    clean = clean.replace(/<[iIbBuU]>\s*(?:ah|oh|uh|agh|aâ|aoleu|ăă|mhm|îhî|ugh|argh|aah|oof|uf)[!.,?\s-]*\s*<\/[iIbBuU]>/gi, '');
    clean = clean.replace(/<[iIbBuU]>\s*<\/[iIbBuU]>/gi, '');

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

function deepCleanSubtitleText(text) {
    if (!text) return text;
    
    let trimmed = text.trim();
    if (/^(-|\–|\—)(\s*(-|\–|\—))*$/g.test(trimmed)) return '';

    let cleaned = text.replace(/^<[^>]+>\s*(?:ah|oh|uh|agh|aâ|aoleu|ăă|mhm|îhî|ugh|argh|aah|oof|uf|shh|psst|sh)[!.,?\s-]*\s*<\/[^>]+>$/gmi, '');
    cleaned = cleaned.replace(/\b(ăă|îhî|mhm|ah|oh|uh|agh|aâ|aoleu)\b[,!]*/gmi, ' ').trim();
    cleaned = cleaned.replace(/\s+/g, ' ');
    
    if (/^(ah|oh|uh|agh|aâ|aoleu|ăă|ugh|argh|aah|oof|uf)[!.]*$/gmi.test(cleaned)) return '';
    if (/^[-–—\s.?!,;:'"]+$/.test(cleaned)) return '';

    cleaned = cleaned.replace(/\\+/g, ' ');
    cleaned = cleaned.replace(/\b(nu|de|ce|pe|la)1\b/gi, '$1');

    cleaned = cleaned.replace(/[^\u0000-\u024F\u1E00-\u1EFF\s.,!?:;\-–—'"()\[\]<>\/]/g, '');
    cleaned = cleaned.replace(/\s*\([^)]+\)$/g, '');

    if (!cleaned.trim()) return '';

    cleaned = cleaned.replace(/\bman-ar\b/gi, 'mi-ar');
    cleaned = cleaned.replace(/\bman-a\b/gi, 'mi-a');
    cleaned = cleaned.replace(/\b[Dd]e ce man pas[aă]\b/gi, 'De ce mi-ar păsa');
    cleaned = cleaned.replace(/\b[Dd]e ce man-ar pasa\b/gi, 'De ce mi-ar păsa');
    cleaned = cleaned.replace(/\bDe ce man spui\b/gi, 'De ce îmi spui');
    cleaned = cleaned.replace(/\bLasă-man\b/gi, 'Lasă-mă');
    
    cleaned = cleaned.replace(/\bșă-i\b/g, 'să-i');
    cleaned = cleaned.replace(/\bȘă-i\b/g, 'Să-i');
    cleaned = cleaned.replace(/\bșă-ți\b/g, 'să-ți');
    cleaned = cleaned.replace(/\bȘă-ți\b/g, 'Să-ți');
    cleaned = cleaned.replace(/\bșă-și\b/g, 'să-și');
    cleaned = cleaned.replace(/\bȘă-și\b/g, 'Să-și');

    cleaned = cleaned.replace(/^[aA]?[,\s]*mi s-a plătit\.?/gi, 'Mi-am primit banii.');
    cleaned = cleaned.replace(/^[aA]?[,\s]*am fost plătit[aă]?\.?/gi, 'Mi-am primit banii.');
    cleaned = cleaned.replace(/\bdistraggă\b/gi, 'distragă');

    return cleaned;
}

function formatSubtitleLine(text) {
    if (!text) return ' ';
    
    text = deepCleanSubtitleText(text);
    if (!text.trim()) return ' ';

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
    
    let rawLines = text.split('\n').map(l => l.trim()).filter(Boolean);
    let expandedLines = [];
    
    rawLines.forEach(l => {
        let doubleDialogMatch = l.match(/^[-–—]?\s*(.+?[.!?])\s*[-–—]\s*(.+)$/);
        
        if (doubleDialogMatch) {
            expandedLines.push('- ' + doubleDialogMatch[1].trim());
            expandedLines.push('- ' + doubleDialogMatch[2].trim());
        } else if (l.includes(' - ') && !l.startsWith('-')) {
            let parts = l.split(' - ');
            expandedLines.push('- ' + parts[0].trim());
            expandedLines.push('- ' + parts[1].trim());
        } else {
            if (/^[-–—][^\s]/.test(l)) {
                l = l.replace(/^[-–—]/, '- ');
            }
            expandedLines.push(l);
        }
    });

    let wrappedLines = [];
    for (let line of expandedLines) {
        if (line.length > 50) {
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
        [/\bjhonson\b/gi, 'Johnson'],
        [/\bsuch a detailed indictment\b/gi, 'un rechizitoriu atât de detaliat'],
        [/\bHowever,\b/gi, 'Cu toate acestea,'],
        [/\bdilettante\b/gi, 'diletant'],
        [/\babroach\b/gi, 'abordare'],
        [/\bfrom project\b/gi, 'din proiect'],
        [/\bfrom\b/gi, 'de la'],
        [/\bbackground\b/gi, 'trecut'],
        [/\bbanca acuzaților bancul acuzaților\b/gi, 'pe banca acuzaților'],
        [/\bîn joi\b/gi, 'joi'],
        [/\bde la embedding itself in a mudbank\.?/gi, 'de la a se înfige într-un mal de noroi.'],
        [/\bembedding itself in a mudbank\.?/gi, 'a se înfige într-un mal de noroi.'],
        [/\bN-a fost nic67\b/gi, 'Nu era niciun loc aici?'],
        [/\bbackground juridic\b/gi, 'trecut juridic'],
        [/\bCă\.E\.A\./gi, 'A.E.C.'],
        [/\bpro Jean Tatlock\b/gi, 'despre Jean Tatlock'],
        [/\bîn ș\s*\./gi, 'în șah.'],
        [/\bîn ș\b(?!\w)/gi, 'în șah'],
        [/\bpunerile\b/gi, 'vederile'],
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
        [/\bîmpotriva asta\b/gi, 'împotriva acestui lucru'],
        [/\bI tăiați capul\b/gi, 'Îi tăiați capul'],
        [/\bnam niciun fel\b/gi, 'n-am niciun fel'],
        [/\bnarțiune\b/gi, 'narațiune'],
        [/\binteriorul acestei cupe\b/gi, 'interiorul acestei cuști'],
        [/\bspuneți-i saluta\b/gi, 'spuneți-i salut'],
        [/\bcea mai izolatã\b/gi, 'cea mai izolată'],
        [/\brebuie să știm\b/gi, 'trebuie să știm'],
        [/\buficient de mult\b/gi, 'suficient de mult'],
        [/\bîi cureț\b/gi, 'îi curăț'],
        [/\bArată foarte atleți\b/gi, 'Arată foarte atletici'],
        [/\bîn toată regla\b/gi, 'în toată regula'],
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
        [/\bȚ-am cerut\b/gi, 'Ți-am cerut'],
        [/\bcearsăfuri\b/gi, 'cearșafuri'],
        [/\bșă ne ținem\b/gi, 'să ne ținem'],
        [/\boevacuare\b/gi, 'o evacuare'],
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
        [/s-l/gi, 'să-l'],
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
        [/\bțeață\b/gi, 'țeavă'],
        [/\bnite amenzi\b/gi, 'niște amenzi'],
        [/\bFlore la ureche\b/gi, 'Floare la ureche'],
        [/\blaptepentru\b/gi, 'lapte pentru'],
        [/\bc-total\b/gi, 'total'],
        [/\bÎntreabă--i\b/gi, 'Întreabă-i'],
        [/「/g, ''],
        [/\bdirectorenul\b/gi, 'directorul'],
        [/\bstorcești\b/gi, 'strivești'],
        [/\bcea mai albitură\b/gi, 'cea mai albă'],
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
        [/\bmarșă de manevră\b/gi, 'marjă de manevră'],
        [/\b(Ah|Oh|Uh|Agh|Aoleu)[!.]+$/gmi, ''],
        [/\bV Dumneata\b/gi, 'Dumneata'],
        [/\bnăscut Borden\b/gi, 'pe nume Borden'],
        [/\bca să o demonstr\b/gi, 'ca să o demonstrăm'],
        [/\bde ce n-a fost asocierile\b/gi, 'de ce n-au fost asocierile'],
        [/\bialaltăieri\b/gi, 'alaltăieri'],
        [/\bGăură\b/gi, 'Gaură'],
        [/\bOricum\b/gi, 'Oricum'],
        [/\beceam\b/gi, 'eram'],
        [/\bcei-o fi\b/gi, 'ce i-o fi'],
        [/\btoți leau\b/gi, 'șleau'],
        [/\bfeșciști\b/gi, 'fasciști'],
        [/\bÎ j cunosc\b/gi, 'Îi cunosc'],
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
        [/\bo raită\b/gi, 'un rateu'],
        [/\bdetonăm o raită\b/gi, 'declanșăm un eșec'],
        [/\bpe opt\b/gi, 'pe banca acuzaților'],
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
        [/\bpe opt așt[^\s]*,?\s*pe bănci\b/gi, 'pe banca acuzaților'],
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
        [/\bEu acționează\b/gi, 'Eu acționez'],
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
        [/\.icon\b/gi, '']
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
You are an expert professional English-to-Romanian cinematic subtitle translator.

Your ONLY task is to translate the provided English subtitle JSON into natural, fluent, grammatically correct Romanian that sounds like professionally localized movie or TV subtitles.

<translation_master_rules>

1. NATURAL ROMANIAN OVER LITERAL TRANSLATION
Translate the MEANING and INTENTION of the dialogue, not the individual English words.
Never follow English word order when doing so creates unnatural Romanian.
The final Romanian must sound like something a real Romanian speaker would naturally say.

2. STRICT GRAMMAR, REAL WORDS & TYPO CHECK
Use ONLY real Romanian words and correct Romanian forms.
NEVER output invented, malformed, truncated, merged, split, or misspelled words.
Before returning the JSON, silently check every Romanian word for:
- missing or extra letters
- words accidentally joined together
- words accidentally split apart
- incorrect Romanian diacritics
- malformed contractions
- invented Romanian words
- incorrect verb conjugations
- incorrect noun/adjective agreement
If a word looks malformed, reconstruct it from the English meaning and the surrounding Romanian context before returning the answer.

3. CONTEXT IS MANDATORY
Use the surrounding subtitle lines to determine the actual meaning.
Do not translate an isolated line by guessing its meaning.
Pay attention to who is speaking, who is being addressed, what happened immediately before, and what happens immediately after.

4. SENTENCES SPLIT ACROSS SUBTITLE LINES & VERTICAL WRAPPING
Subtitle lines may contain only part of a sentence.
Treat consecutive lines as parts of the same spoken sentence when appropriate.
CRITICAL FORMATTING: Whenever a subtitle contains two separate speakers, ALWAYS split them onto separate vertical lines (one above the other) using line breaks, rather than packing everything onto a single long horizontal line. Use standard dialogue dashes (- ) for multi-speaker lines where appropriate.

5. DO NOT TRANSLATE WORD-BY-WORD
English words frequently have several meanings.
Choose the Romanian meaning that fits the scene and dialogue.
Never automatically translate a word according to its most common dictionary meaning if the context clearly indicates another meaning.

6. PRESERVE MEANING
Do not add information that is not present in the original.
Do not remove meaningful information.
Do not invent explanations.
Do not change the speaker's intention.

7. CINEMATIC NATURALNESS
The result should sound like professional Romanian dubbing/subtitling.
Prefer concise, natural Romanian expressions over awkward literal constructions.

8. SLANG, PROFANITY AND REGISTER
Preserve the original level of vulgarity, slang, informality, hostility, affection, sarcasm, or formality.
Do not censor profanity.
Do not make normal dialogue unnecessarily vulgar.

9. SARCASM, IRONY AND HUMOR
Preserve sarcasm, irony, jokes and comedic intent.
Translate the intended meaning rather than mechanically translating the words.

10. GENDER AND SPEAKER
Pay close attention to the speaker and grammatical gender.
Use correct feminine and masculine forms whenever the context establishes the speaker's gender.

11. PRONOUNS AND VERB FORMS
Be especially careful with Romanian forms such as:
să-mi, să-ți, să-l, să-i, să-ne, să-vă,
mi-ai, ți-ai, i-ai, ne-am, v-ați,
n-am, n-ai, n-are, n-avem, n-au.
Use the correct natural Romanian form instead of broken combinations.

12. WORD BOUNDARIES
Never accidentally cut, merge, corrupt, or partially translate a word.
Every word must be complete and correctly spelled.

13. ROMANIAN DIACRITICS
Use standard Romanian diacritics correctly: ă, â, î, ș, ț.

14. DO NOT OVER-TRANSLATE
Proper names, established names, brands, places, titles, character names and other elements that should remain unchanged must remain unchanged unless there is an established Romanian equivalent clearly required by context.

15. AUDIO TAGS & INTERJECTIONS REMOVAL
Remove non-dialogue audio tags, standalone hesitation sounds, and meaningless interjections (such as "Ah!", "Oh!", "Uh!", "Agh!", "ăă", "mhm") entirely. Do not translate standalone grunts or cries.

16. NO ENGLISH LEFT BEHIND & TRANSLATE ALL SPEAKER LABELS
Translate EVERY actual English dialogue line into Romanian.
NEVER leave untranslated English sentence fragments (such as "from project", "embedding itself", "cowboys").
If a line starts with an English speaker label (such as 'DRIVER:', 'GUARD:', 'COP:', 'NARAȚIUNE:'), ALWAYS translate it into natural Romanian ('ȘOFER:', 'GARDĂ:', 'POLIȚIST:', 'NARAȚIUNE:') or keep the character's proper name cleanly.
NEVER return an English dialogue sentence or clause unchanged.

17. STRICTLY LATIN ALPHABET ONLY
NEVER output Devanagari, Hindi, Burmese, Asian, Cyrillic, or any other non-Latin characters under any circumstance. Output strictly standard Romanian Latin characters with proper diacritics.

18. NO ALTERNATIVES
Never provide multiple translations.
Never write alternatives such as: (varianta 1 / varianta 2) or "X" / "Y".
Choose the single most natural Romanian translation.

19. TARGET LINE FOCUS & FOREIGN WORDS
Verifică DOAR replica din mijloc. Dacă există un cuvânt străin intenționat, păstrează-l. Dacă este o scăpare din limba sursă, traduce-l. Nu modifica replicile vecine.

20. MULTI-SPEAKER DIALOGUE FORMATTING - CRITICAL
When a subtitle contains two different speakers, you MUST output them on TWO SEPARATE LINES using a line break (\\n). 
Do NOT output them on a single horizontal line.
CORRECT:
- Baker, ia coridorul.
- Am înțeles!

21. NEVER OUTPUT EMPTY DIALOGUE DASHES OR STANDALONE INTERJECTIONS
NEVER output a subtitle line containing ONLY hyphens, dashes, or empty markers such as "-", "–", or "—".
NEVER output standalone hesitation sounds or interjections such as "ăă", "îhî", "mhm", "Ah!", "Oh!", "Uh!", "Agh!", "Aâ!".

22. NO INVENTED OR CORRUPTED ROMANIAN WORDS
NEVER invent Romanian words. Words such as "molmoșește", "anghang", "tangou" (when misused) and similar malformed forms sunt strict interzise.

23. STRICT GRAMMAR AND CLEAN PUNCTUATION
NEVER output malformed forms such as "Ț-am", "Eu acționez" (or incorrect agreement), or double hyphens ("--") where standard Romanian punctuation is required. Use correct clitics ("Ți-am", "să-i", "să-ți", "să-și") and proper grammar. 

24. NO UNESCAPED DOUBLE QUOTES INSIDE TEXT
NEVER use unescaped double quotes (") inside the translated text values. If dialogue requires quotation marks or direct quotes, always use single quotes (') instead to ensure valid JSON formatting.

CRITICAL ERRORS TO AVOID:
- "De ce man pasă?" → "De ce mi-ar păsa?"
- "Mi s-a plătit" / "Am fost plătit" → "Mi-am primit banii."
- "șă-i", "șă-ți", "șă-și" → NEVER output "șă"; use "să-i", "să-ți", "să-și".

FINAL MANDATORY PROOFREAD — DO NOT SKIP

Before returning the JSON, perform one final line-by-line proofreading pass.
For EVERY translated subtitle:
- verify that every word is a valid Romanian word;
- verify grammar, agreement and diacritics;
- verify that no English dialogue remains;
- verify that no Cyrillic, Asian, Hindi or other non-Latin characters are used.

Do NOT return the JSON until this final proofreading pass is complete.
</translation_master_rules>

<few_shot_examples>
- Idiom: "Give me a break." -> "Hai, lasă-mă."
- Natural conversational: "Are you coming with us?" -> "Vii cu noi?"
- Slang: "What the hell, man?" -> "Ce naiba, frate?"
- Sarcasm: "Great. Just great." -> "Minunat. Pur și simplu minunat."
- Natural contraction: "I don't know." -> "Nu știu."
- Natural conversational: "We don't have anything in common." -> "N-avem nimic în comun."
- Natural conversational: "You have to tell me." -> "Trebuie să-mi spui."
</few_shot_examples>

IMPORTANT:
Quality is more important than literal word correspondence.
Never sacrifice Romanian grammar or naturalness just to stay close to the English word order.
Return ONLY JSON.
`;

// ============================================================
// PROMPT BUILDER CU CONTEXT
// ============================================================

function buildTranslationPrompt(chunk, allItems, chunkStart, chunkEnd, previousTranslatedContext) {
    const contextBefore = allItems.slice(Math.max(0, chunkStart - CONTEXT_LINES_BEFORE), chunkStart);
    const contextAfter = allItems.slice(chunkEnd, Math.min(allItems.length, chunkEnd + CONTEXT_LINES_AFTER));

    const keysToTranslate = chunk.map(obj => ({ id: obj.id, text: obj.text }));

    return `
${MASTER_TRANSLATION_PROMPT}

Context inainte (pentru referinta):
${contextBefore.map(i => `[${i.id}]${i.text}`).join('\n') || '(niciunul)'}

Context anterior tradus in Romana (pentru continuitate):
${previousTranslatedContext.map(i => `[${i.id}]${i.text}`).join('\n') || '(niciunul)'}

Tradu STRICT următoarele replici și returnează un ARRAY JSON cu exact câte un obiect pentru fiecare ID:
[
  {"id": 123, "text": "traducerea în română"}
]
Nu modifica ID-urile și nu omite nicio replică.

REPLICILE DE TRADUS:
${JSON.stringify(keysToTranslate, null, 2)}
`;
}

// ============================================================
// API KEY STATE & MANAGEMENT
// ============================================================

function createKeyState(keys) {
    return keys.map(key => ({ key, pausedUntil: 0, disabled: false, failures: 0, lastUsed: 0 }));
}

function getGlobal429Until(keyStates) { return Number(keyStates._global429Until || 0); }
function register429(keyStates, cooldownMs) {
    const now = Date.now();
    const paused = keyStates.filter(s => !s.disabled && s.pausedUntil > now).length;
    const active = keyStates.filter(s => !s.disabled).length;
    if (active > 0 && paused >= Math.min(2, active)) {
        keyStates._global429Until = Math.max(getGlobal429Until(keyStates), now + Math.min(30000, Math.max(15000, cooldownMs)));
    }
}
async function waitFor429Gate(keyStates) {
    while (true) {
        const waitMs = getGlobal429Until(keyStates) - Date.now();
        if (waitMs <= 0) return;
        console.log(`${c.yellow}⏳ [429 Gate] Prea multe chei limitate. Aștept ${Math.ceil(waitMs / 1000)}s înainte de următoarea încercare.${c.reset}`);
        await sleep(waitMs);
    }
}

async function getAvailableKey(keyStates) {
    while (true) {
        await waitFor429Gate(keyStates);
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

async function callGemini(prompt, keyState, options = {}) {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME}:generateContent`;
    const timeout = Number.isInteger(options.timeout) ? options.timeout : 120000;

    try {
        const response = await axios.post(
            endpoint,
            {
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: {
                    temperature: 0.0,
                    responseMimeType: 'application/json',
                    responseSchema: {
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
                    }
                },
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
        return raw;
    } catch (error) {
        const status = error.response?.status;
        if (status === 401 || status === 403) {
            keyState.disabled = true;
            throw new Error(`Cheie Gemini invalidă (${status}).`);
        }
        if (status === 429) {
            // 429 este tratat ca limitare temporară. Nu schimbăm frenetic cheia:
            // cheile standard aparțin proiectului și pot împărți aceeași cotă.
            const retryAfterHeader = error.response?.headers?.['retry-after'];
            const retryAfterSec = Number(retryAfterHeader);
            const cooldownMs = Number.isFinite(retryAfterSec) && retryAfterSec > 0
                ? Math.min(120000, Math.max(10000, retryAfterSec * 1000))
                : 15000;
            keyState.pausedUntil = Date.now() + cooldownMs;
            const retryError = new Error(`Rate limit 429. Aștept ${Math.ceil(cooldownMs / 1000)}s și reîncerc.`);
            retryError.isRateLimit429 = true;
            retryError.retryAfterMs = cooldownMs;
            throw retryError;
        }
        throw error;
    }
}

// ============================================================
// SAFE JSON PARSER (SANITIZER)
// ============================================================

function safeJsonParse(rawText) {
    let clean = String(rawText || '').replace(/^\uFEFF/, '').trim();

    // Elimină eventualele code fences Markdown fără a atinge textul traducerii.
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
                // Păstrează escape-urile JSON valide; pentru cele invalide păstrează
                // caracterul literal, astfel încât JSON-ul să poată fi reparat.
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
        // Chei simple fără ghilimele.
        x = x.replace(/([{,]\s*)([A-Za-z0-9_-]+)(\s*:)/g, '$1"$2"$3');
        // Virgule trailing.
        x = x.replace(/,\s*([}\]])/g, '$1');
        // Virgula lipsă între proprietăți: "..."\n"123": / }\n"123":
        x = x.replace(/([}\]"\d])\s*\n\s*("[^"\n]+"\s*:)/g, '$1,\n$2');
        // Două proprietăți lipite după un string.
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

    // Ultimul fallback: caractere de control rămase în afara stringurilor.
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

function isJunkOrInterjection(text) {
    const clean = String(text || '').replace(/<[^>]+>/g, '').trim();
    if (!clean) return true;
    if (/^[0-9\s\-–—.,?!:;\'"♪♫♬♩#]+$/.test(clean)) return true;
    if (/^(?:[-–—\s]*)(ah|oh|uh|agh|aâ|aoleu|ăă|mhm|îhî|ugh|argh|aah|oof|uf|shh|psst|sh)[!.,?\s-]*$/i.test(clean)) return true;
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
        'itself','himself','herself','themselves','myself','yourself','such','indictment','however','although','though','perhaps','rather','still'
    ]);

    const tokenize = value => value.match(/[a-zăâîșț]+(?:'[a-zăâîșț]+)?/g) || [];
    const tw = tokenize(translatedNorm);
    const ow = tokenize(originalNorm);

    // Numele proprii/titlurile pot rămâne intenționat în engleză.
    // Dacă textul este în mare parte identic, nu marcăm o expresie capitalizată scurtă.
    const namedTitle = /\b(?:The\s+[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,5}|Nobody\s+Beats\s+the\s+Wiz)\b/.test(transClean);
    const romanianSignals = /\b(?:și|să|se|este|sunt|era|erau|nu|da|că|ca|cu|de|din|în|pe|la|un|o|eu|tu|el|ea|noi|voi|ei|ele|mai|foarte|pentru|dar|sau|care|ce|cine|cum|unde|când|aici|acolo|trebuie|poate|fost|avea|am|ai|are|au|mă|te|îl|îi|mi|ți|lor|lui|mea|ta|tău|meu)\b/i;

    if (originalNorm === translatedNorm) {
        // Titlu/nume propriu scurt sau replică formată din nume propriu: acceptă.
        if (namedTitle && !romanianSignals.test(transClean) && tw.length <= 8) return false;
        const strong = tw.filter(w => strongEnglish.has(w)).length;
        const markers = tw.filter(w => englishMarkers.has(w)).length;
        if (strong >= 1 || markers >= 2) return true;
        if (tw.length >= 5 && markers >= 2) return true;
        return false;
    }

    // Fragmente englezești distinctive rămase într-o propoziție românească.
    const distinctive = new Set(['the','from','however','although','because','without','between','maybe','please','sorry','thanks','thank','your','would','could','should','cannot','itself','such','indictment']);
    const distinctiveHits = tw.filter(w => distinctive.has(w));
    if (distinctiveHits.length) {
        // "The Wall Street Journal", "The Lollipop Club", etc. pot fi nume/titluri.
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

async function processChunkWithRetry(chunk, allItems, chunkStart, chunkEnd, previousTranslatedContext, keyStates, globalChunkIndex, totalChunks, depth = 0) {
    const prompt = buildTranslationPrompt(chunk, allItems, chunkStart, chunkEnd, previousTranslatedContext);
    let lastError = null;

    // Erorile de JSON/schema nu repetă întregul chunk inutil.
    // 429/503 sunt însă tranzitorii și trebuie retrimise cu backoff exponențial.
    // Nu împărțim chunk-ul doar pentru că API-ul a limitat temporar cererea.
    const maxKeyAttempts = 8;
    let attemptedKeys = new Set();

    for (let attempt = 1; attempt <= maxKeyAttempts; attempt++) {
        let keyState = null;
        try {
            await waitFor429Gate(keyStates);
            // Alegem o cheie nefolosită în această încercare.
            const candidates = keyStates
                .filter(s => !s.disabled && s.pausedUntil <= Date.now())
                .sort((a, b) => a.lastUsed - b.lastUsed);

            if (!candidates.length) {
                keyState = await getAvailableKey(keyStates);
            } else {
                keyState = candidates[0];
                keyState.lastUsed = Date.now();
            }

            const keyMask = '...' + keyState.key.slice(-4);
            console.log(`${c.cyan}➤ [Gemini] Traduc calup ${globalChunkIndex + 1}/${totalChunks} (Model: ${MODEL_NAME} | Cheie: ${keyMask})...${c.reset}`);

            const raw = await callGemini(prompt, keyState);
            const parsed = JSON.parse(String(raw).trim());
            const dict = normalizeTranslationPayload(parsed);

            // Dacă lipsesc foarte puține ID-uri, le recuperăm punctual.
            // Dacă lipsesc multe, răspunsul Gemini este probabil trunchiat: împărțim
            // chunk-ul, NU trimitem zeci de linii într-o cerere secundară care poate bloca slotul.
            const missingItems = chunk.filter(obj => dict[String(obj.id)] === undefined);
            if (missingItems.length > 12) {
                throw new Error(`Răspuns Gemini sever incomplet: lipsesc ${missingItems.length} ID-uri.`);
            }
            if (missingItems.length) {
                console.log(`${c.yellow}⚠ [Gemini] Calupul ${globalChunkIndex + 1}: lipsesc ${missingItems.length} ID-uri. Cerere punctuală...${c.reset}`);
                const missingPrompt = `
${MASTER_TRANSLATION_PROMPT}

Returnează STRICT un ARRAY JSON valid pentru TOATE liniile de mai jos. Nu omite niciun ID și nu modifica ID-urile:
[
  {"id": 123, "text": "traducerea română"}
]

LINIILE LIPSĂ:
${JSON.stringify(missingItems, null, 2)}
`;
                try {
                    const missingRaw = await callGemini(missingPrompt, keyState, { timeout: 20000, maxAttempts: 1, retry429: false });
                    const missingJson = JSON.parse(String(missingRaw).trim());
                    const missingDict = normalizeTranslationPayload(missingJson);
                    for (const obj of missingItems) {
                        const value = missingDict[String(obj.id)];
                        if (value !== undefined) dict[String(obj.id)] = value;
                    }
                } catch (missingError) {
                    console.log(`${c.yellow}  ⚠ [Gemini] Cererea punctuală a eșuat: ${missingError.message}${c.reset}`);
                }
            }

            const stillMissing = chunk.filter(obj => dict[String(obj.id)] === undefined);
            if (stillMissing.length) {
                throw new Error(`JSON incomplet: lipsesc ${stillMissing.length} ID-uri după completarea punctuală.`);
            }

            const results = chunk.map(obj => ({
                id: obj.id,
                text: formatSubtitleLine(dict[String(obj.id)])
            }));

            const untranslatedItems = results.filter(result => {
                const original = chunk.find(obj => obj.id === result.id)?.text || '';
                const originalClean = String(original).replace(/<[^>]+>/g, '').trim();
                if (!originalClean) return false;
                if (isJunkOrInterjection(original)) return false;
                return hasUntranslatedEnglish(original, result.text) || hasCorruptedSubtitleText(result.text, original);
            });

            // Verificare LOCALĂ: nu mai facem apel Gemini suplimentar pentru fiecare
            // linie suspectă. Astfel păstrăm paralelismul 3 și timpul de ~2 minute.
            if (untranslatedItems.length > 0) {
                console.log(`${c.yellow}⚠ [Local Check] Calupul ${globalChunkIndex + 1}: ${untranslatedItems.length} replici suspecte de engleză/corupere.${c.reset}`);
                untranslatedItems.slice(0, 10).forEach(item => {
                    console.log(`  ${c.yellow}⚠ ${item.id}: ${String(item.text || '').slice(0, 120)}${c.reset}`);
                });
            }

            console.log(`${c.green}✔ [Gemini] Calup ${globalChunkIndex + 1}/${totalChunks} finalizat! (${chunk.length}/${chunk.length} linii)${c.reset}`);
            return results;
        } catch (error) {
            lastError = error;
            const is429 = error.isRateLimit429 === true || error.message.includes('429');
            if (is429 && keyState) register429(keyStates, Number(error.retryAfterMs) || 15000);
            const isTransient = is429 || /status code 5\d\d/.test(error.message);
            console.log(`${c.yellow}⚠ [Gemini] Calup ${globalChunkIndex + 1} eșuat (încercarea ${attempt}/${maxKeyAttempts}): ${error.message}${c.reset}`);

            // JSON invalid/incomplet => split/targeted completion, fără a repeta întregul chunk.
            // 429/5xx => backoff exponențial + jitter, fără split.
            if (!isTransient) break;
            if (attempt < maxKeyAttempts) {
                // 429: cheia este în cooldown; dacă mai multe chei au primit 429,
                // poarta globală oprește rotația frenetică până când cota are timp să revină.
                if (is429) {
                    continue;
                }

                const baseMs = 5000;
                const backoffMs = Math.min(120000, baseMs * Math.pow(2, attempt - 1));
                const jitterMs = Math.floor(Math.random() * 1500);
                await sleep(backoffMs + jitterMs);
                continue;
            }
        }
    }

    if (chunk.length > 20 && depth < 2) {
        console.log(`${c.yellow}⚠ [Gemini] Împart calupul ${globalChunkIndex + 1} în două părți imediat după eșec...${c.reset}`);

        const middle = Math.floor(chunk.length / 2);
        const first = chunk.slice(0, middle);
        const second = chunk.slice(middle);

        const firstResult = await processChunkWithRetry(first, allItems, chunkStart, chunkStart + middle, previousTranslatedContext, keyStates, globalChunkIndex, totalChunks, depth + 1);
        const secondContext = firstResult.slice(-PREVIOUS_TRANSLATION_CONTEXT);
        const secondResult = await processChunkWithRetry(second, allItems, chunkStart + middle, chunkEnd, secondContext, keyStates, globalChunkIndex, totalChunks, depth + 1);

        return [...firstResult, ...secondResult];
    }

    console.log(`${c.red}✖ [Gemini] Calupul ${globalChunkIndex + 1} a eșuat definitiv.${c.reset}`);
    throw lastError || new Error('Chunk translation failed.');
}

// ============================================================
// GLOBAL POST-CHECK + TARGETED RETRY
// ============================================================

// Nu retrimitem replici formate doar din OK/Okay; utilizatorul dorește
// ca aceste răspunsuri scurte să rămână exact așa cum au fost produse.
function isOkOnlySubtitle(text) {
    const clean = String(text || '').replace(/<[^>]+>/g, '').trim();
    return /^(?:[-–—\s]*(?:ok|okay)(?:[.!?…]+)?[-–—\s]*)$/i.test(clean);
}

async function globalPostCheck(items, translatedById, keyStates, maxPasses = 1) { 
    let totalFixed = 0;

    for (let pass = 1; pass <= maxPasses; pass++) {
        const suspicious = items.filter(item => {
            const originalClean = String(item.text || '').replace(/<[^>]+>/g, '').trim();
            if (!originalClean) return false;
            if (isJunkOrInterjection(item.text)) return false;

            const translated = translatedById[String(item.id)];
            if (isOkOnlySubtitle(translated)) return false;
            const transClean = String(translated || '').replace(/<[^>]+>/g, '').trim();

            if (!transClean) return true;

            return hasUntranslatedEnglish(item.text, translated) ||
                hasCorruptedSubtitleText(translated, item.text);
        });

        console.log(`\n${c.cyan}🔍 POST-CHECK GLOBAL — pass ${pass}/${maxPasses}${c.reset}`);
        console.log(`   Verificate: ${items.length} replici`);

        if (suspicious.length === 0) {
            console.log(`${c.green}✔ 0 replici suspecte${c.reset}`);
            return { fixed: totalFixed, remaining: [] };
        }

        console.log(`${c.yellow}⚠ Detectate ${suspicious.length} replici suspecte${c.reset}`);

        const retryConcurrency = Math.max(1, Math.min(CONCURRENCY_LIMIT, suspicious.length));
        let retryIndex = 0;
        const retryWorker = async () => {
            while (true) {
                const item = suspicious[retryIndex++];
                if (!item) return;
                let fixed = false;

                for (let retry = 1; retry <= 1; retry++) {
                try {
                    const keyState = await getAvailableKey(keyStates);
                    const current = translatedById[String(item.id)] || '';

                    const singlePrompt = `
${MASTER_TRANSLATION_PROMPT}

ACESTA ESTE UN RETRY FINAL, PUNCTUAL.
Linia a fost detectată ca netradusă sau coruptă. Ignoră traducerea anterioară dacă este greșită și produce o traducere română completă.

ID:
"${item.id}"

ORIGINAL:
${JSON.stringify(item.text)}

TRADUCEREA ACTUALĂ (poate fi greșită):
${JSON.stringify(current)}

Returnează DOAR JSON valid în forma:
[
  {"id": ${item.id}, "text": "traducerea română"}
]
`;

                    const raw = await callGemini(singlePrompt, keyState, { maxAttempts: 1, retry429: false, timeout: 30000 });
                    const parsed = safeJsonParse(raw);
                    const parsedDict = normalizeTranslationPayload(parsed);
                    const candidateRaw = parsedDict[String(item.id)];

                    const candidate = formatSubtitleLine(String(candidateRaw || ''));

                    if (
                        candidate &&
                        !hasUntranslatedEnglish(item.text, candidate) &&
                        !hasCorruptedSubtitleText(candidate, item.text)
                    ) {
                        translatedById[String(item.id)] = candidate;
                        fixed = true;
                        totalFixed++;

                        console.log(`${c.green}  ✔ Global retry: ${item.id} reparată (${retry}/2)${c.reset}`);
                        break;
                    }

                    console.log(`${c.yellow}  ⚠ Global retry: ${item.id} încă suspectă (${retry}/2)${c.reset}`);
                } catch (err) {
                    console.log(`${c.yellow}  ⚠ Global retry eșuat pentru ${item.id} (${retry}/2): ${err.message}${c.reset}`);
                    // Fără retry suplimentar: validatorul global este ultimul filtru.
                }
            }

                if (!fixed) {
                    console.log(`${c.red}  ❌ Neremediată: ${item.id}${c.reset}`);
                }
            }
        };

        await Promise.all(Array.from({ length: retryConcurrency }, () => retryWorker()));

        const remaining = items.filter(item => {
            const originalClean = String(item.text || '').replace(/<[^>]+>/g, '').trim();
            if (!originalClean) return false;
            if (isJunkOrInterjection(item.text)) return false;

            const translated = translatedById[String(item.id)];
            if (isOkOnlySubtitle(translated)) return false;
            const transClean = String(translated || '').replace(/<[^>]+>/g, '').trim();

            if (!transClean) return true;

            return hasUntranslatedEnglish(item.text, translated) ||
                hasCorruptedSubtitleText(translated, item.text);
        });

        if (remaining.length === 0) {
            console.log(`${c.green}✔ Toate replicile suspecte au fost remediate${c.reset}`);
            return { fixed: totalFixed, remaining: [] };
        }

        console.log(`${c.yellow}⚠ ${remaining.length} suspecte rămase după pass ${pass}${c.reset}`);
    }

    const remaining = items.filter(item => {
        const originalClean = String(item.text || '').replace(/<[^>]+>/g, '').trim();
        if (!originalClean) return false;
        if (isJunkOrInterjection(item.text)) return false;

        const translated = translatedById[String(item.id)];
        const transClean = String(translated || '').replace(/<[^>]+>/g, '').trim();

        if (!transClean) return true;

        return hasUntranslatedEnglish(item.text, translated) ||
            hasCorruptedSubtitleText(translated, item.text);
    });

    return { fixed: totalFixed, remaining };
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
    keyStates._global429Until = 0;
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
            for (const item of batchResult.result) {
                translatedById[String(item.id)] = item.text;
            }
        }

        const lastResult = results[results.length - 1];
        if (lastResult && lastResult.result) {
            previousTranslatedContext = lastResult.result.slice(-PREVIOUS_TRANSLATION_CONTEXT);
        }
    }

    console.log(`\n${c.green}✔ Toate cele ${chunks.length} de calupuri finalizate!${c.reset}`);

    // ========================================================
    // RECOVERY DOAR PENTRU TRADUCERI GOALE
    // ========================================================
    // Dacă Gemini a returnat o valoare goală pentru o replică ce
    // are text original, o cerem din nou punctual. Nu retraducem
    // chunk-ul și nu pornim recovery pentru alte tipuri de suspiciuni.
    const emptyTranslations = items.filter(item => {
        const originalClean = String(item.text || '').replace(/<[^>]+>/g, '').trim();
        if (!originalClean) return false;
        if (isJunkOrInterjection(item.text)) return false;

        const translated = translatedById[String(item.id)];
        const translatedClean = String(translated || '').replace(/<[^>]+>/g, '').trim();
        return !translatedClean;
    });

    if (emptyTranslations.length > 0) {
        console.log(`${c.yellow}⚠ [Empty Recovery] ${emptyTranslations.length} traduceri goale detectate. Le retraduc punctual...${c.reset}`);

        const recoveryPrompt = `
${MASTER_TRANSLATION_PROMPT}

RECOVERY PENTRU TRADUCERI GOALE.
Următoarele replici au text original, dar traducerea anterioară a fost goală.
Tradu TOATE liniile de mai jos în română naturală. Nu omite niciun ID.

${JSON.stringify(emptyTranslations.map(item => ({ id: item.id, text: item.text })), null, 2)}

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
            let recoveredCount = 0;

            for (const item of emptyTranslations) {
                const candidateRaw = recoveryDict[String(item.id)];
                const candidate = formatSubtitleLine(String(candidateRaw || ''));

                if (
                    candidate &&
                    !hasUntranslatedEnglish(item.text, candidate) &&
                    !hasCorruptedSubtitleText(candidate, item.text)
                ) {
                    translatedById[String(item.id)] = candidate;
                    recoveredCount++;
                    console.log(`${c.green}  ✔ [Empty Recovery] ${item.id} reparată${c.reset}`);
                } else {
                    console.log(`${c.red}  ❌ [Empty Recovery] ${item.id} nu a primit o traducere validă${c.reset}`);
                }
            }

            console.log(`${c.green}✔ [Empty Recovery] Recuperate: ${recoveredCount}/${emptyTranslations.length}${c.reset}`);
        } catch (error) {
            console.log(`${c.yellow}⚠ [Empty Recovery] Cererea de recuperare a eșuat: ${error.message}${c.reset}`);
        }
    }

    // Retry punctual doar pentru liniile rămase suspecte după traducerea normală.
    // Nu retraducem calupuri întregi și nu schimbăm paralelismul de 3.
    const targetedRetry = await globalPostCheck(items, translatedById, keyStates, 1);
    console.log(`${c.green}✔ Targeted retry final: ${targetedRetry.fixed} linii reparate${c.reset}`);

    console.log(`\n${c.cyan}🔍 VERIFICARE FINALĂ...${c.reset}`);

    const finalSuspicious = items.filter(item => {
        const originalClean = String(item.text || '').replace(/<[^>]+>/g, '').trim();
        if (!originalClean) return false;
        if (isJunkOrInterjection(item.text)) return false;

        const translated = translatedById[String(item.id)];
        const transClean = String(translated || '').replace(/<[^>]+>/g, '').trim();

        if (!transClean) return true;

        return hasUntranslatedEnglish(item.text, translated) ||
            hasCorruptedSubtitleText(translated, item.text);
    });

    if (finalSuspicious.length > 0) {
        console.log(`${c.yellow}⚠ ${finalSuspicious.length} replici suspecte rămân după Global Post-Check${c.reset}`);
        finalSuspicious.slice(0, 20).forEach(item => {
            console.log(`  ${c.red}❌ ${item.id}: ${String(translatedById[String(item.id)] || '').slice(0, 120)}${c.reset}`);
        });
    } else {
        console.log(`${c.green}✔ 0 replici suspecte${c.reset}`);
    }

    console.log(`${c.green}✔ ${items.length - finalSuspicious.length}/${items.length} replici valide${c.reset}`);
    console.log(`${c.green}✔ Verificarea finală executată după targeted retry.${c.reset}`);

    const output = items.map(item => {
        const translated = translatedById[String(item.id)] || item.text;
        return `${item.id}\n${item.start} --> ${item.end}\n${translated}\n`;
    }).join('\n');

    return output.trim() + '\n';
}

// ============================================================
// TRANSLATION ROUTE
// ============================================================

app.get('/:configData/translate', async (req, res) => {
    const imdbId = req.query.id;
    const targetUrl = req.query.targetUrl || req.query.url;
    const configData = req.params.configData;

    console.log(`\n${c.cyan}➤ [Stremio] S-a cerut traducerea pentru ID: ${imdbId}${c.reset}`);

    if (!targetUrl) {
        console.log(`${c.red}✖ EROARE: Lipsă URL sursă.${c.reset}`);
        return res.status(400).send('Lipsă URL sursă.');
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
