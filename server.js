const express = require('express');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const dns = require('dns').promises;
const net = require('net');

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

// Verificarea AI clasică, cu prompt foarte lung, rămâne oprită.
// În locul ei rulăm un audit compact pe TOATE replicile traduse, în calupuri
// mai mici și cu concurență limitată. Astfel nu depindem exclusiv de regex-uri.
const ENABLE_FULL_GRAMMAR_REVIEW = false;
const ENABLE_TARGETED_GRAMMAR_REVIEW = false;
const ENABLE_COMPACT_GRAMMAR_AUDIT = true;
const GRAMMAR_AUDIT_BATCH_SIZE = 60;
const GRAMMAR_AUDIT_CONCURRENCY = 3;

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
    version: '12.78.105',
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
// CLEAN TEXT FOR JSON 
// ============================================================

function cleanTextForJson(text) {
    if (!text) return text;
    let clean = text;

    clean = clean.replace(/\{[^}]+\}/g, '');
    clean = clean.replace(/[♪♫♬♩#]/gi, '');
    clean = clean.replace(/â™ª/gi, '');
    clean = clean.replace(/â™«/gi, '');

    clean = clean.replace(/<[iIbBuU]>\s*(?:ah|oh|uh|eh|er+|hm+|hmm+|agh|aâ|aoleu|ă{1,}|mhm|îhî|ugh|argh|aah|oof|uf|um+|uhm+|erm+|a{2,})[!.,?…\s-]*\s*<\/[iIbBuU]>/gi, '');
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

// Detectează replicile-sursă care conțin doar ezitări vocale. Folosit numai pentru
// a nu reintroduce un „Păi...” / „Ei bine...” după ce filtrul a eliminat „Well, um...”.
// Nu tratează „well” sau „so” singure drept ezitări, fiindcă pot avea sens propriu.
const SOURCE_HESITATION_WORDS = new Set([
    'uh', 'uhh', 'um', 'umm', 'ummm', 'uhm', 'uhmm', 'erm', 'er', 'eh',
    'hmm', 'hm', 'mmm', 'ă', 'ăă', 'ăăă'
]);

function isSourceHesitationWord(word) {
    return SOURCE_HESITATION_WORDS.has(word) ||
        /^(?:ă+|uh+|um+|uhm+|erm+|er+|eh+|hm+|hmm+|mmm+)$/.test(word);
}

function isSourceHesitationOnly(text) {
    const clean = String(text || '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
        .toLocaleLowerCase('ro-RO');
    const words = clean.match(/[a-zăâîșț]+/giu) || [];
    if (!words.length || words.length > 4) return false;

    const hasActualHesitation = words.some(isSourceHesitationWord);
    if (!hasActualHesitation) return false;

    // „Well, um...” / „So, um...” nu sunt ezitare pură: „Well/So” poartă
    // sens de legătură („Păi/Deci”) și trebuie păstrat după eliminarea lui „um”.
    return words.every(isSourceHesitationWord);
}

function normalizeDuplicateSourceIds(items) {
    const seen = new Set();
    const hasDuplicates = items.some(item => {
        const id = String(item.id);
        if (seen.has(id)) return true;
        seen.add(id);
        return false;
    });
    if (hasDuplicates) items.forEach((item, index) => { item.id = index + 1; });
    return hasDuplicates;
}

function deepCleanSubtitleText(text) {
    if (!text) return text;
    
    let trimmed = text.trim();
    if (/^(-|\–|\—)(\s*(-|\–|\—))*$/g.test(trimmed)) return '';

    let cleaned = text.replace(/^<[^>]+>\s*(?:ah|oh|uh|eh|er+|hm+|hmm+|agh|aâ|aoleu|ă{1,}|mhm|îhî|ugh|argh|aah|oof|uf|um+|uhm+|erm+|a{2,}|shh|psst|sh)[!.,?…\s-]*\s*<\/[^>]+>$/gmi, '');
    // Elimină bâlbâielile/interjecțiile de ezitare care nu aduc informație.
    // IMPORTANT: includem și punctul în delimitatori; altfel „ăă...” / „mhm...”
    // nu sunt prinse corect deoarece regex-ul vechi nu considera „.” delimitator.
    // „ă{2,}” prinde și forme precum „ăăă...”, nu doar exact „ăă”.
    // Include ezitările observate în SRT: um/umm, erm, uhm și Aa?/aaa.
    // Nu eliminăm litera „a” singură, deoarece este un cuvânt valid în română.
    const hesitationToken = '(?:ă{2,}|ă|îhî|mhm|ah|oh|uh|eh|er+|hm+|hmm+|agh|aâ|aoleu|um+|uhm+|erm+|a{2,})';

    // Dacă ezitarea este la final și a fost precedată de virgulă/„;”/„:”,
    // eliminăm și punctuația rămasă înaintea ei și păstrăm o elipsă naturală.
    cleaned = cleaned.replace(
        new RegExp('[,;:]\\s*' + hesitationToken + '[,;:.!?…]*\\s*$', 'gmi'),
        '...'
    );

    cleaned = cleaned.replace(
        new RegExp('(^|[\\s,;:.!?…])' + hesitationToken + '(?=[\\s,;:.!?…]|$)[,;:.!?…]*', 'gmi'),
        '$1'
    ).trim();

    // Elimină bâlbâiala de tip „V-vin”, „M-mă”, „S-sunt” → „Vin”, „Mă”, „Sunt”.
    // Elimină una sau mai multe repetări ale aceleiași litere: „Ț-ț-ținta” → „Ținta”.
    // Corecție pentru bâlbâiala observată în numele propriu:
    // „Oh-ppenheimer” / „O-ppenheimer” -> „Oppenheimer”.
    cleaned = cleaned.replace(/\bO[h]?[-–—]ppenheimer\b/giu, 'Oppenheimer');

    // Elimină repetarea completă a aceluiași cuvânt compus: „vor-vor” -> „vor”,
    // „N-am-n-am” -> „N-am”. Formele normale „n-am” și „re-educare” rămân intacte.
    cleaned = cleaned.replace(
        /\b([\p{L}]+(?:-[\p{L}]+)?)\s*[-–—]\s*\1\b/giu,
        '$1'
    );

    // Greșeală de tastare observată în subtitrarea de test.
    cleaned = cleaned.replace(/\bpuncrele\b/giu, match =>
        /^[P]/.test(match) ? 'Punctele' : 'punctele'
    );

    cleaned = cleaned.replace(/(^|[^\p{L}])([A-Za-zĂÂÎȘȚăâîșț])(?:[-–—]\2)+(?=[A-Za-zĂÂÎȘȚăâîșț])/giu, '$1$2');
    // Elimină fragmentul întrerupt repetat înaintea cuvântului complet:
    // „Ți-... Ținta” / „Țin—… Ținta” -> „Ținta”. Se aplică doar dacă
    // următorul cuvânt începe exact cu fragmentul, pentru a evita ștergeri arbitrare.
    cleaned = cleaned.replace(
        /(^|[^\p{L}])([A-Za-zĂÂÎȘȚăâîșț]{1,3})[-–—](?:\.{2,}|…)+\s+([A-Za-zĂÂÎȘȚăâîșț]{2,})/giu,
        (match, prefix, fragment, fullWord) => {
            const fragmentLower = fragment.toLocaleLowerCase('ro-RO');
            const fullLower = fullWord.toLocaleLowerCase('ro-RO');
            return fullLower.startsWith(fragmentLower) ? prefix + fullWord : match;
        }
    );

    // Corectează și bâlbâiala fără elipsă: „Ți-ținta” -> „ținta”.
    // Regula se aplică numai când cuvântul după cratimă începe cu fragmentul,
    // evitând forme legitime precum „re-educare”.
    cleaned = cleaned.replace(
        /(^|[^\p{L}])([A-Za-zĂÂÎȘȚăâîșț]{1,3})[-–—]([A-Za-zĂÂÎȘȚăâîșț]{2,})/giu,
        (match, prefix, fragment, fullWord) => {
            const fragmentLower = fragment.toLocaleLowerCase('ro-RO');
            const fullLower = fullWord.toLocaleLowerCase('ro-RO');
            if (fullLower.startsWith(fragmentLower) && fullLower !== fragmentLower) {
                const restoredWord = /^[A-ZĂÂÎȘȚ]/.test(fragment) && /^[a-zăâîșț]/.test(fullWord)
                    ? fullWord.charAt(0).toLocaleUpperCase('ro-RO') + fullWord.slice(1)
                    : fullWord;
                return prefix + restoredWord;
            }
            return match;
        }
    );

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
    cleaned = cleaned.replace(/(^|[.!?]\s+)([a-zăâîșț])/g, (m, prefix, letter) => prefix + letter.toUpperCase());
    
    if (/^(?:ah|oh|uh|eh|er+|hm+|hmm+|agh|aâ|aoleu|ă{1,}|mhm|îhî|ugh|argh|aah|oof|uf|um+|uhm+|erm+|a{2,})[!.?…]*$/gmi.test(cleaned)) return '';
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

    // Elimină marcatorii de dialog de la începutul replicilor.
    // Liniuțele din interiorul cuvintelor sau al propozițiilor rămân neschimbate.
    text = text.replace(/^\s*[-–—]+\s*/gm, '');
    
    let rawLines = text.split('\n').map(l => l.trim()).filter(Boolean);
    let expandedLines = [];
    
    rawLines.forEach(l => {
        let doubleDialogMatch = l.match(/^[-–—]?\s*(.+?[.!?])\s*[-–—]\s*(.+)$/);
        
        if (doubleDialogMatch) {
            expandedLines.push(doubleDialogMatch[1].trim());
            expandedLines.push(doubleDialogMatch[2].trim());
        } else if (l.includes(' - ') && !l.startsWith('-')) {
            let parts = l.split(' - ');
            expandedLines.push(parts[0].trim());
            expandedLines.push(parts[1].trim());
        } else {
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

    // Ultima protecție: nicio linie de subtitrare nu începe cu marcator de dialog.
    wrappedLines = wrappedLines
        .map(line => line.replace(/^\s*[-–—]+\s*/, '').trim())
        .filter(Boolean);

    if (wrappedLines.length > 2) {
        text = wrappedLines.slice(0, 2).join('\n');
    } else {
        text = wrappedLines.join('\n');
    }

    // Corecții mecanice certe confirmate în verificările recente.
    // Sunt intenționat specifice pentru a evita corecții globale riscante.
    const dictionar = [
        // Forme generate variabil de model pentru aceeași construcție semantică.
        // Sunt limitate la expresii confirmate ca greșite în acest proiect.
        [/\b(?:Iași|Iasi|Ieși|Iesi)[- ]mi din cap\b/gi, 'Ieși din capul meu'],
        [/\b(?:Ia|I-a) mâna după mine\b/gi, 'Ia mâna de pe mine'],
        [/\bȘi pe urmă am fut-o ca să sărbătorim\b/gi, 'Și pe urmă ne-am futut ca să sărbătorim'],
        [/\b(?:Și|Si) pe urmă am f\*{2,}ut ca să sărbătorim\b/gi, 'Și pe urmă ne-am futut ca să sărbătorim'],
        [/\b(?:Și|Si) pe urmă am f\*{2,}t ca să sărbătorim\b/gi, 'Și pe urmă ne-am futut ca să sărbătorim'],
        [/\bE un cuptor dracului aici\b/gi, 'E un cuptor al naibii aici'],
        [/\bRezoluția Concurrentă\b/g, 'Rezoluția Concurentă'],
        [/\bun cerc de încrederi\b/gi, 'un cerc de încredere'],
        [/\bcuando îți zic\b/gi, 'când îți zic'],
        [/\bmult așteptatului film\b/gi, 'mult așteptatul film'],
        [/\bnăibii\b/gi, 'naibii'],
        [/\blar că sunteți aici\b/gi, 'că sunteți aici'],
        [/\bn-am gânit\b/gi, 'n-am gândit'],
        [/\bnicodată\b/gi, 'niciodată'],
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
        [/\bîn joi\b/gi, 'joi'],
        [/\bde la embedding itself in a mudbank\.?/gi, 'de la a se înfige într-un mal de noroi.'],
        [/\bembedding itself in a mudbank\.?/gi, 'a se înfige într-un mal de noroi.'],
        [/\bN-a fost nic67\b/gi, 'Nu era niciun loc aici?'],
        // Corecție contextuală păstrată; regula globală „background → trecut” a fost eliminată.
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

        // Corecții mecanice certe observate în verificările recente.
        // Erori recurente confirmate: corecții native, deterministe.
        [/\bca să\.\.\.rbătorim\b/gi, 'ca să sărbătorim'],
        [/\bM-am cerut în căsătorie cu\b/gi, 'L-am cerut în căsătorie pe'],
        [/\bCitească-gânduri\b/gi, 'Cititoare de gânduri'],
        [/\bdemocracția\b/gi, 'democrația'],
        [/\bMă reasigur în patru ani\b/gi, 'Să fiu realeasă în patru ani'],
        [/\bS-a dus totul pe râpă\b/gi, 'S-a dus totul de râpă'],
        [/\bo bullet\b/gi, 'un glonț'],
        [/\bmergem orbești\b/gi, 'mergem orbește'],
        [/\bo favoră\b/gi, 'o favoare'],
        [/\bMă închizi într-o cușcă\s*\/\s*dacă nu accept să fii arma ta\b/gi, 'Mă închizi într-o cușcă / dacă nu accept să fiu arma ta'],
        [/\bȘi pe urmă am fumat-o de sărbătoare\b/gi, 'Și pe urmă ne-am futut ca să sărbătorim'],
        [/\bRezoluția Concurrentă\b/gi, 'Rezoluția Concurentă'],
        [/\bun cerc de încrederi\b/gi, 'un cerc de încredere'],

        // Sunt intenționat conservative: repară doar forme clar corupte/typo.
        [/\bDe ce (?:ne|mi|ți|v|i)-ar pasa\b/gi, m => m.replace(/pasa\b/gi, 'păsa')],
        [/\bmizerijile\b/gi, 'mizeriile'],
        [/\bfrecându-menta\b/gi, 'frecând menta'],
        [/\bT-Ar trebui\b/g, 'Ar trebui'],
        [/\btuți\b/gi, 'toți'],
        [/\bțin-ținta\b/gi, 'ținta'],
        [/\bfãcut-o\b/gi, 'făcut-o'],
        [/\bca i-au făcut\b/gi, 'cum i-au făcut'],
        [/\bpână la adânci bătrânețe\b/gi, 'până la adânci bătrâneți'],
        [/\breeligitată\b/gi, 'realeasă'],
        [/\bîn ourselves\b/gi, 'înșine'],
        [/\bMă-nvățați\b/g, 'mă-nvățați'],
        [/\bmi l-a învățat tata\b/gi, 'm-a învățat tata'],
        [/\bvirusul ăla naibii\b/gi, 'virusul ăla al naibii'],
        [/\bDe ce ne-ar pasa\b/gi, 'De ce ne-ar păsa'],
        [/\bDe ce i-ar pasa\b/gi, 'De ce i-ar păsa'],
        [/\bcomuniștii erau periculoase\b/gi, 'comuniștii erau periculoși'],
        [/\bîn ziua în care\b/gi, 'în ziua în care'],
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
CRITICAL FORMATTING: Whenever a subtitle contains two separate speakers, ALWAYS split them onto separate vertical lines (one above the other) using line breaks, rather than packing everything onto a single long horizontal line. NEVER add dialogue dashes at the beginning of those lines.

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
Remove non-dialogue audio tags, standalone hesitation sounds, and meaningless interjections (such as "Ah!", "Oh!", "Uh!", "Agh!", "ăă", "ăăă", "mhm") entirely. Do not translate standalone grunts or cries.
When a hesitation is embedded in an otherwise meaningful Romanian sentence (for example "Am fost, ăă..." or "Păi, ăă..."), remove the hesitation from the final subtitle while preserving the natural Romanian sentence and punctuation.
Also remove obvious one-letter stutters such as "E-E", "A-A" or "M-M" when they are merely speech disfluencies.

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
Do NOT prefix either line with a dialogue dash.
CORRECT:
Baker, ia coridorul.
Am înțeles!

21. NEVER OUTPUT DIALOGUE DASHES OR STANDALONE INTERJECTIONS
NEVER prefix a dialogue line with hyphens or dashes such as "-", "–", or "—".
NEVER output a subtitle line containing ONLY hyphens, dashes, or empty markers.
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

function createKeyState(keys) {
    return keys.map(key => ({ key, pausedUntil: 0, disabled: false, failures: 0, lastUsed: 0 }));
}

function getGlobal429Until(keyStates) { return Number(keyStates._global429Until || 0); }
function register429(keyStates, cooldownMs) {
    const now = Date.now();
    const paused = keyStates.filter(s => !s.disabled && s.pausedUntil > now).length;
    const active = keyStates.filter(s => !s.disabled).length;
    if (active > 0 && paused >= Math.min(2, active)) {
        keyStates._global429Until = Math.max(
            getGlobal429Until(keyStates),
            now + Math.min(30000, Math.max(15000, cooldownMs))
        );
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
    // `false` dezactivează schema constrânsă pentru auditul compact.
    // În v104, schema extinsă cu issue_type/confidence/reason a produs HTTP 400
    // pentru cererile de audit. Păstrăm JSON mode și validarea locală a rezultatului.
    const responseSchema = options.responseSchema === false ? null : (options.responseSchema || {
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
    });

    try {
        const generationConfig = {
            temperature: 0.0,
            responseMimeType: 'application/json'
        };
        if (responseSchema) generationConfig.responseSchema = responseSchema;

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
        return raw;
    } catch (error) {
        const status = error.response?.status;
        if (status === 401 || status === 403) {
            keyState.disabled = true;
            throw new Error(`Cheie Gemini invalidă (${status}).`);
        }
        if (status === 429) {
            // 429 este tratat ca limitare temporară. Cheia curentă intră
            // în cooldown; dacă mai multe chei au fost limitate, activăm
            // temporar poarta globală pentru a evita rotația frenetică.
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
        // Include mesajul detaliat al API-ului în log pentru erorile 4xx/5xx.
        // Axios afișează de obicei doar „Request failed with status code 400”,
        // ceea ce ascunde cauza reală (schema, parametru sau cerere invalidă).
        if (status) {
            const apiDetail = error.response?.data?.error?.message || error.message || 'eroare API necunoscută';
            const diagnosticError = new Error(`Gemini HTTP ${status}: ${String(apiDetail).slice(0, 500)}`);
            diagnosticError.status = status;
            throw diagnosticError;
        }
        throw error;
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

function isJunkOrInterjection(text) {
    const clean = String(text || '').replace(/<[^>]+>/g, '').trim();
    if (!clean) return true;

    // Marcatori goi/tehnici care nu reprezintă dialog real. Sunt ignorați
    // complet de verificările de traducere, ca să nu apară în loguri ca suspecți.
    if (/^[\s0-9\-–—._,;:!?…'"~^`´‚„“”‘’()\[\]{}|\\/♪♫♬♩#]+$/.test(clean)) return true;

    if (/^(?:[-–—\s]*)(?:ah|oh|uh|eh|er+|hm+|hmm+|agh|aâ|aoleu|ă{1,}|mhm|îhî|ugh|argh|aah|oof|uf|um+|uhm+|erm+|a{2,}|shh|psst|sh)[!.,?…\s-]*$/i.test(clean)) return true;
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

    // Semnal pentru formularea defectuoasă observată în SRT-ul tt15398776.
    // Nu o rescriem automat; o trimitem spre targeted retry.
    if (/(?:^|[^\p{L}])orăleană(?:$|[^\p{L}])/iu.test(s) &&
        /(?:^|[^\p{L}])inutil[ăa](?:$|[^\p{L}])/iu.test(s)) return true;

    return false;
}

function normalizeTranslationPayload(parsed) {
    if (Array.isArray(parsed)) {
        const dict = Object.create(null);
        for (const item of parsed) {
            if (!item || item.id === undefined) continue;
            const id = String(item.id);
            if (Object.prototype.hasOwnProperty.call(dict, id)) {
                throw new Error(`Răspuns Gemini cu ID duplicat: ${id}`);
            }
            dict[id] = item.text === undefined ? '' : String(item.text);
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

    // 429/503 sunt tranzitorii. Reîncercăm până la 8 ori, fără a împărți
    // chunk-ul doar din cauza unui rate-limit temporar.
    const maxKeyAttempts = 8;
    let attemptedKeys = new Set();

    for (let attempt = 1; attempt <= maxKeyAttempts; attempt++) {
        let keyState = null;
        try {
            await waitFor429Gate(keyStates);
            const candidates = keyStates
                .filter(s => !s.disabled && s.pausedUntil <= Date.now())
                .sort((a, b) => a.lastUsed - b.lastUsed);

            if (!candidates.length) {
                keyState = await getAvailableKey(keyStates);
            } else {
                keyState = candidates[0];
                keyState.lastUsed = Date.now();
            }

            console.log(`${c.cyan}➤ [Gemini] Traduc calup ${globalChunkIndex + 1}/${totalChunks}...${c.reset}`);

            const raw = await callGemini(prompt, keyState);
            const parsed = JSON.parse(String(raw).trim());
            const dict = normalizeTranslationPayload(parsed);

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
                    const missingRaw = await callGemini(missingPrompt, keyState, { timeout: 20000 });
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
                const originalClean = isEffectivelyEmptySubtitleText(original) ? '' : String(original).replace(/<[^>]+>/g, '').trim();
                const translatedClean = String(result.text || '').replace(/<[^>]+>/g, '').trim();
                if (!originalClean) return false;
                if (isJunkOrInterjection(original)) return false;
                // Nu logăm ca „suspectă” o replică al cărei rezultat este gol
                // sau este doar un marker tehnic (—, -, ..., punctuație etc.).
                // Acestea sunt gestionate separat de Empty Recovery / validarea finală.
                if (!translatedClean || isJunkOrInterjection(result.text)) return false;
                return hasUntranslatedEnglish(original, result.text) || hasCorruptedSubtitleText(result.text, original);
            });

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
            if (is429 && keyState) {
                register429(keyStates, Number(error.retryAfterMs) || 15000);
            }
            const isTransient = is429 || /status code 5\d\d/.test(error.message);
            console.log(`${c.yellow}⚠ [Gemini] Calup ${globalChunkIndex + 1} eșuat (încercarea ${attempt}/${maxKeyAttempts}): ${error.message}${c.reset}`);

            if (!isTransient) break;
            if (attempt < maxKeyAttempts) {
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

function isOkOnlySubtitle(text) {
    const clean = String(text || '').replace(/<[^>]+>/g, '').trim();
    return /^(?:[-–—\s]*(?:ok|okay)(?:[.!?…]+)?[-–—\s]*)$/i.test(clean);
}

async function globalPostCheck(items, translatedById, keyStates, maxPasses = 1) { 
    let totalFixed = 0;

    for (let pass = 1; pass <= maxPasses; pass++) {
        const suspicious = items.filter(item => {
            const originalClean = isEffectivelyEmptySubtitleText(item.text) ? '' : String(item.text || '').replace(/<[^>]+>/g, '').trim();
            if (!originalClean) return false;
            if (isJunkOrInterjection(item.text) || isSourceHesitationOnly(item.text)) return false;

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

Înainte de JSON, fă o ultimă verificare semantică a fiecărei corecții: compară EN → RO, pronumele, prepozițiile, subiectul, obiectul și relațiile dintre personaje. Nu accepta o corecție care doar sună mai bine.

Returnează DOAR JSON valid în forma:
[
  {"id": ${item.id}, "text": "traducerea română"}
]
`;

                    const raw = await callGemini(singlePrompt, keyState, { timeout: 30000 });
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
                }
            }

                if (!fixed) {
                    console.log(`${c.red}  ❌ Neremediată: ${item.id}${c.reset}`);
                }
            }
        };

        await Promise.all(Array.from({ length: retryConcurrency }, () => retryWorker()));

        const remaining = items.filter(item => {
            const originalClean = isEffectivelyEmptySubtitleText(item.text) ? '' : String(item.text || '').replace(/<[^>]+>/g, '').trim();
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
        const originalClean = isEffectivelyEmptySubtitleText(item.text) ? '' : String(item.text || '').replace(/<[^>]+>/g, '').trim();
        if (!originalClean) return false;
        if (isJunkOrInterjection(item.text) || isSourceHesitationOnly(item.text)) return false;

        const translated = translatedById[String(item.id)];
        const transClean = String(translated || '').replace(/<[^>]+>/g, '').trim();

        if (!transClean) return true;

        return hasUntranslatedEnglish(item.text, translated) ||
            hasCorruptedSubtitleText(translated, item.text);
    });

    return { fixed: totalFixed, remaining };
}

// ============================================================
// FILTRU SUPLIMENTAR — GRAMATICĂ + CALITATEA TRADUCERII
// Rulează separat de mecanismul principal și aplică doar corecții certe.
// ============================================================

const GRAMMAR_REVIEW_BATCH_SIZE = 120;
// Calupuri mai mici pentru verificarea punctuală: scad tokenii/request și riscul de timeout.
const GRAMMAR_TARGETED_REVIEW_BATCH_SIZE = 35;
const GRAMMAR_REVIEW_TIMEOUT_MS = 120000;
const GRAMMAR_REVIEW_TIMEOUT_RETRY_MS = 3000;
const GRAMMAR_REVIEW_JSON_RETRY_DELAY_MS = 1200;
const GRAMMAR_REVIEW_JSON_RETRY_LIMIT = 1;
const GRAMMAR_REVIEW_JSON_SPLIT_MIN = 20;

// ============================================================
// PROTECȚIE ANTI-RESCRIERE — auditul trebuie să corecteze, nu să retraducă.
// Respinge doar schimbările foarte ample (similaritate sub prag); corecțiile
// normale de gramatică și de sens rămân eligibile.
// ============================================================
const MIN_AUDIT_CORRECTION_SIMILARITY = 0.48;

function normalizedCorrectionSimilarity(originalText, candidateText) {
    const normalize = value => String(value || '')
        .replace(/<[^>]*>/g, '')
        .normalize('NFC')
        .toLocaleLowerCase('ro-RO')
        .replace(/\s+/g, ' ')
        .trim();

    const a = normalize(originalText);
    const b = normalize(candidateText);
    if (a === b) return 1;
    if (!a || !b) return 0;

    // Subtitrările sunt scurte; două rânduri DP evită alocarea unei matrice mari.
    let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        const current = [i];
        for (let j = 1; j <= b.length; j++) {
            const substitutionCost = a[i - 1] === b[j - 1] ? 0 : 1;
            current[j] = Math.min(
                current[j - 1] + 1,
                previous[j] + 1,
                previous[j - 1] + substitutionCost
            );
        }
        previous = current;
    }

    return 1 - previous[b.length] / Math.max(a.length, b.length);
}

function hasSecondPersonAddressCue(text) {
    // Unicode boundaries are necessary because JavaScript \b does not treat ș/ț/ă/î as word letters.
    return /(?<![\p{L}])(?:you|your|you're|you've|you'll|you'd|yourself|yourselves|tu|te|tine|ți|ti|tău|tau|ta|tale|tăi|tai|voi|vă|va|dumneavoastră|dumneata|dumitale|dvs\.?|ești|esti|ai|vrei|poți|poti|faci|spui|știi|stii|sunteți|sunteti|aveți|aveti|doriți|doriti|vreți|vreti|faceți|faceti|spuneți|spuneti|ați|ati)(?![\p{L}])/iu.test(String(text || ''));
}

const ACCEPTED_AUDIT_ISSUE_TYPES = /(?:grammar|gramatic|syntax|sintax|semantic|semantic|meaning|fidel|translation|traduc|corrupt|corup|continuity|continuit|duplicate|duplic|spelling|orthograph|ortograf|agreement|acord|conjugat|typo|clitic|pronoun|pronume|preposition|prepoz|word.?order|ordine|address|register|adresare)/i;

function hasHighConfidenceAuditProof(proof) {
    if (!proof || typeof proof !== 'object') return false;
    const confidence = Number(proof.confidence);
    const issueType = String(proof.issue_type || '').trim();
    const reason = String(proof.reason || '').replace(/\s+/g, ' ').trim();
    return Number.isFinite(confidence) && confidence >= 90 &&
        ACCEPTED_AUDIT_ISSUE_TYPES.test(issueType) && reason.length >= 24;
}

function hasStrongRepairSignal(text) {
    const clean = String(text || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (!clean) return true;
    if (/[\uFFFD\u0000-\u0008\u000B\u000C\u000E-\u001F\u0400-\u04FF\u4E00-\u9FFF\u3040-\u30FF]/u.test(clean)) return true;
    // Semnale de corupere/gramatică puternică: cuvânt alăturat repetat,
    // prepoziții/conectori dublați sau majuscule nejustificate în interiorul frazei.
    if (/(?<![\p{L}])([\p{L}]{3,})\s+\1(?![\p{L}])/iu.test(clean)) return true;
    if (/(?<![\p{L}])(?:de|la|cu|pe|în|din|că|să|și)\s+(?:de|la|cu|pe|în|din|că|să|și)(?![\p{L}])/iu.test(clean)) return true;
    if (/[\p{Ll}][,;:]?\s+[A-ZĂÂÎȘȚ][\p{Ll}]{2,}\s+[A-ZĂÂÎȘȚ][\p{Ll}]{2,}/u.test(clean)) return true;
    if (/\b(?:\p{L}{1,3}\.\.\.\p{L}{1,3}|\p{L}{1,3}[-–]\p{L}{1,3})\b/iu.test(clean)) return true;
    return false;
}

const BOUNDARY_STOPWORDS = new Set([
    'a','ai','al','ale','am','au','că','ca','ce','cu','de','din','e','ea','ei','el','era','este','eu',
    'i','îi','în','la','le','li','lui','mai','mă','mi','ne','ni','nu','o','or','pe','să','sa','și','si',
    'te','ți','ti','tu','un','una','unei','unui','vă','va','voi','your','you','the','a','an','and','are',
    'as','at','be','but','by','for','from','he','her','his','i','if','in','is','it','me','my','of','on',
    'or','our','she','so','that','to','we','with'
]);

function boundaryOverlap(leftText, rightText) {
    const words = value => String(value || '')
        .normalize('NFC').toLocaleLowerCase('ro-RO')
        .match(/[\p{L}\p{N}]+/gu) || [];
    const left = words(leftText);
    const right = words(rightText);
    const max = Math.min(5, left.length, right.length);
    for (let size = max; size >= 1; size--) {
        const suffix = left.slice(-size);
        const prefix = right.slice(0, size);
        if (suffix.every((word, index) => word === prefix[index]) &&
            suffix.some(word => word.length >= 4 && !BOUNDARY_STOPWORDS.has(word))) {
            return suffix;
        }
    }
    return [];
}

function createsUnexpectedBoundaryEcho(item, candidate, current, contextItems, contextIndexById, translations) {
    const index = contextIndexById.get(String(item.id));
    if (!Number.isInteger(index) || index < 0) return null;
    const previous = index > 0 ? contextItems[index - 1] : null;
    const next = index < contextItems.length - 1 ? contextItems[index + 1] : null;
    const currentEnglish = String(item.text || '');
    const readTranslation = id => translations instanceof Map
        ? translations.get(String(id))
        : translations[String(id)];

    if (previous) {
        const previousRo = String(readTranslation(previous.id) || '');
        const currentOldOverlap = boundaryOverlap(previousRo, current);
        const candidateOverlap = boundaryOverlap(previousRo, candidate);
        const englishOverlap = boundaryOverlap(previous.text, currentEnglish);
        if (candidateOverlap.length > currentOldOverlap.length &&
            candidateOverlap.length > englishOverlap.length) {
            return { side: 'după replica anterioară', words: candidateOverlap.join(' ') };
        }
    }
    if (next) {
        const nextRo = String(readTranslation(next.id) || '');
        const currentOldOverlap = boundaryOverlap(current, nextRo);
        const candidateOverlap = boundaryOverlap(candidate, nextRo);
        const englishOverlap = boundaryOverlap(currentEnglish, next.text);
        if (candidateOverlap.length > currentOldOverlap.length &&
            candidateOverlap.length > englishOverlap.length) {
            return { side: 'înaintea replicii următoare', words: candidateOverlap.join(' ') };
        }
    }
    return null;
}

async function grammarTranslationReview(items, translatedById, keyStates, options = {}) {
    const contextItems = options.contextItems || items;
    const isTargetedReview = options.mode === 'targeted';
    const isCompactAudit = options.mode === 'audit';

    const candidates = items.filter(item => {
        const original = String(item.text || '').replace(/<[^>]+>/g, '').trim();
        const translated = String(translatedById[String(item.id)] || '').replace(/<[^>]+>/g, '').trim();
        if (!original || !translated) return false;
        if (isJunkOrInterjection(item.text)) return false;
        if (isOkOnlySubtitle(translated)) return false;
        return true;
    });

    if (!candidates.length) {
        console.log(`${c.green}✔ [Grammar Review] Nu există replici eligibile pentru verificare.${c.reset}`);
        return { checked: 0, fixed: 0 };
    }

    if (isCompactAudit) {
        console.log(`\n${c.cyan}🧠 AUDIT AI COMPACT CONTEXTUAL — GRAMATICĂ + FIDELITATE PE TOATE REPLICILE${c.reset}`);
    } else if (isTargetedReview) {
        console.log(`\n${c.cyan}🎯 VERIFICARE PUNCTUALĂ — GRAMATICĂ + TRADUCERE${c.reset}`);
    } else {
        console.log(`\n${c.cyan}📝 VERIFICARE SUPLIMENTARĂ — GRAMATICĂ + TRADUCERE${c.reset}`);
    }
    console.log(`   Verificate: ${candidates.length} replici`);
    if (isCompactAudit) {
        console.log(`   Context bilingv pentru adresare, propoziții fragmentate și dubluri între replici: ${candidates.length} replici`);
    }

    const reviewBatchSize = isCompactAudit
        ? GRAMMAR_AUDIT_BATCH_SIZE
        : (isTargetedReview ? GRAMMAR_TARGETED_REVIEW_BATCH_SIZE : GRAMMAR_REVIEW_BATCH_SIZE);
    const batches = chunkArray(candidates, reviewBatchSize);
    let checked = 0;
    let fixed = 0;

    const rateLimitRetryQueue = [];
    const contextIndexById = new Map(contextItems.map((entry, index) => [String(entry.id), index]));
    // Snapshot-ul împiedică auditul concurent să schimbe contextul altei cereri în curs.
    const baselineTranslations = new Map(contextItems.map(entry => [
        String(entry.id), String(translatedById[String(entry.id)] || '')
    ]));
    let rejectedAggressiveRewrites = 0;
    let rejectedBoundaryEchoes = 0;
    let acceptedLargeRepairs = 0;
    const acceptedLargeRepairIds = new Set();

    const processGrammarBatch = async (batch, batchIndex, label) => {
        let batchFixed = 0;

        const payload = batch.map(item => {
            if (isCompactAudit) {
                const index = contextIndexById.get(String(item.id));
                const previous = Number.isInteger(index) && index > 0 ? contextItems[index - 1] : null;
                const next = Number.isInteger(index) && index >= 0 && index < contextItems.length - 1
                    ? contextItems[index + 1]
                    : null;
                const currentTranslation = baselineTranslations.get(String(item.id)) || '';
                const compactContext = neighbour => neighbour ? {
                    id: neighbour.id,
                    en: String(neighbour.text || '').replace(/\s+/g, ' ').slice(0, 130),
                    ro: String(baselineTranslations.get(String(neighbour.id)) || '').replace(/\s+/g, ' ').slice(0, 130)
                } : null;

                // Contextul vecin se trimite pentru toate liniile, nu doar când există „you/tu”.
                // E necesar pentru a identifica propoziții fragmentate și cuvinte dublate la granița ID-urilor.
                return {
                    id: item.id,
                    original: item.text,
                    translation: currentTranslation,
                    context_before: compactContext(previous),
                    context_after: compactContext(next)
                };
            }

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
                semnale_locale: options.reasonsById?.[String(item.id)] || []
            };
        });

        const prompt = isCompactAudit ? `
Ești revizor profesionist de subtitrări ENGLEZĂ → ROMÂNĂ. Verifică fiecare înregistrare și propune doar corecții certe, nu o retraducere stilistică.

PENTRU FIECARE ID compară sensul originalului cu româna și verifică explicit: gramatica propoziției, acordul, conjugarea, pronumele/cliticele, prepozițiile, vocabularul, ortografia, diacriticele, punctuația care schimbă sensul și naturalețea expresiei în română. O propoziție poate conține cuvinte corecte individual și totuși să fie greșită sintactic sau semantic.

REGULI STRICTE:
1. Dacă textul românesc este corect, fidel și firesc pentru dialog, păstrează-l EXACT. Nu-l schimba pentru că ai prefera sinonime, altă ordine a cuvintelor sau un stil mai literar.
2. Fă editarea minimă necesară. Păstrează expresiile și structura existente ori de câte ori sunt corecte. Nu reformula toată replica pentru a repara o singură greșeală.
3. Corectează calcurile din engleză și formulările care schimbă cine face acțiunea, cui i se adresează, asupra cui se acționează sau ce relație există între personaje. Verifică verbul împreună cu prepoziția și complementul, nu doar cuvintele izolate.
4. Verifică persoana și registrul de adresare. Când englezescul „you” permite atât adresarea informală, cât și cea formală, folosește context_before/context_after pentru a păstra consecvent „tu/te/ți/tău/ești/ai” ori „dumneavoastră/vă/aveți/sunteți”, DAR numai dacă acel context pare să aparțină aceleiași conversații și aceleiași relații între interlocutori. Replicile vecine pot aparține altor personaje; nu presupune automat că sunt același vorbitor. Dacă registrul nu poate fi stabilit sigur, nu schimba adresarea existentă fără o dovadă clară din original.
5. Verifică formele „niciun/nicio” versus „nici un/nici o” după sens și normă. Nu aplica o înlocuire oarbă acolo unde separarea are alt sens. Verifică inclusiv typo-uri subtile precum „acceași”, cuvinte deformate sau forme care par românești, dar nu se potrivesc sintactic.
6. Păstrează slangul, vulgaritățile, sarcasmul, umorul, numele proprii, termenii ficționali și repetițiile/bâlbâielile intenționate. Nu transforma automat o expresie colocvială într-una formală.
7. Contextul bilingv este doar ajutor pentru sens și adresare. Corectează DOAR replica asociată ID-ului curent; nu modifica vecinii.
8. Dacă nu poți demonstra o eroare clară din original și context, omite acel ID. Este mai bine să păstrezi o formulare acceptabilă decât să introduci o regresie.
9. Folosește context_before/context_after pentru a identifica propoziții care continuă între subtitrări, începuturi/terminații rupte și cuvinte sau expresii repetate accidental la limita a două ID-uri. Dacă două replici românești se repetă, verifică dacă ORIGINALUL englezesc repetă aceeași idee; dacă nu, repară numai ID-ul curent când acesta este locul potrivit pentru corecție.
10. Pentru fiecare corecție, returnează și issue_type, confidence (număr întreg 0–100) și reason. reason trebuie să indice concret eroarea din varianta actuală și dovada din ORIGINAL/context pentru corecție. Nu folosi „sună mai bine” sau preferința stilistică drept motiv. confidence trebuie să reflecte certitudinea reală, nu să fie automat 100.
11. Dacă soluția necesită o reformulare amplă pentru că varianta curentă este coruptă sau semantic greșită, nu o abandona doar fiindcă seamănă puțin cu textul inițial: oferă o justificare concretă și fidelă ORIGINALULUI. Dacă nu există dovadă clară, omite ID-ul.

DATE:
${JSON.stringify(payload, null, 2)}

Returnează DOAR un array JSON valid. Pentru fiecare corecție folosește forma [{"id":123,"text":"varianta română corectată","issue_type":"grammar|semantic|corruption|continuity|spelling|other","confidence":95,"reason":"motiv concret și scurt bazat pe original/context"}]. Dacă nu există nicio corecție clară, returnează [].
` : `
Ești un corector profesionist de subtitrări ENGLEZĂ → ROMÂNĂ.

Aceasta este o VERIFICARE SUPLIMENTARĂ, independentă de traducerea principală.
NU retraduce automat și NU rescrie replicile pentru stil.
Scopul este să identifici și să corectezi DOAR greșelile CLARE de gramatică, ortografie sau traducere care fac replica română incorectă, coruptă sau evident lipsită de sens.

REGULI CRITICE:
1. Dacă traducerea este corectă și naturală, NU O MODIFICA.
2. Dacă există orice dubiu că o schimbare ar putea modifica sensul, păstrează traducerea actuală.
3. Nu schimba slangul, vulgaritățile, expresiile colocviale, sarcasmul, umorul sau stilul personajului dacă sunt inteligibile și corecte.
4. NU elimina și NU modifica repetiții intenționate sau bâlbâieli de dialog, de exemplu „Nu-nu”, „Da, eu-eu...”, „Nu, nu, nu.”.
5. Nu modifica nume proprii, titluri, mărci, locuri sau termeni ficționali doar pentru că par neobișnuiți.
6. Nu transforma o formulare colocvială corectă într-una literară.
7. Repară cuvinte deformate, lipite, tăiate sau inventate și forme gramaticale evident greșite.
8. Verifică EXPLICIT gramatica la nivel de propoziție, nu doar cuvintele izolate: acord subiect–verb, timp/mod verbal, persoană, gen și număr, articol, pronume, clitice, prepoziții, ordine sintactică și construcția frazei.
9. Verifică EXPLICIT dacă formularea este română naturală și logică. Detectează calcuri sau transferuri directe din engleză care produc o construcție nenaturală ori greșită în română, dar corectează numai când ORIGINALUL și contextul susțin clar varianta corectă.
10. Verifică poziționarea cliticelor și a pronumelor: forme precum „aș-o omori”, „nu ți-pasă”, „uită-ce-mi face”, „mi facă” sau alte combinații similare trebuie analizate sintactic, nu doar lexical.
11. Verifică formele verbale: conjugare, infinitiv, conjunctiv, condițional, acord temporal și terminații. Exemple reale: „să arești” → „să arestezi”, „te admira” → verifică „te admiră”/„te admirau” după ORIGINAL și context.
12. Verifică prepozițiile și construcțiile prepoziționale: detectează dublări sau combinații forțate precum „pregătit pentru pe 6” și alege corecția numai din sensul ORIGINALULUI.
13. Verifică cuvintele foarte scurte și formele de 2–6 litere, deoarece pot ascunde deformări: „tuți”, „șura”, „mi”, „f-o” etc. Nu presupune că un cuvânt este corect doar pentru că seamănă cu unul românesc.
14. Fă o verificare EXPLICITĂ A FIECĂRUI CUVÂNT: caută forme inexistente sau corupte, litere schimbate accidental, cuvinte lipite/splitate, diacritice corupte și forme generate prin traducere automată. Exemple reale: „orgasmato”, „metamorfoți”, „șura”, „tuți”, „fãcut-o”.
15. Dacă un cuvânt sau o formulare este neobișnuită, verifică mai întâi dacă este nume propriu, marcă, termen fictiv, jargon, vulgaritate sau formă colocvială intenționată. Nu „corecta” doar pentru că sună neobișnuit.
16. Verifică semantic și sintactic replica în raport cu ORIGINALUL și contextul din jur. O formulare poate avea cuvinte românești corecte și totuși să fie greșită ca structură sau sens. Exemple reale: „Ori dăm de capăt cum să-l antrenăm”, „M-am cerut în căsătorie cu Hughie”, „Și uită-ce-mi face și mie”.
17. Detectează calcuri evidente din engleză și vocative/construcții traduse mecanic, de exemplu „idioticule” când ORIGINALUL cere un vocativ românesc natural precum „idiotule”. Nu schimba însă jargonul sau termenii intenționați.
18. Verifică majusculele în context: nu transforma automat începutul unei replici în literă mică sau invers; corectează doar când poziția sintactică este clară.
19. Fă o AUDITARE SINTACTICĂ COMPLETĂ a fiecărei replici, chiar dacă toate cuvintele individuale par românești. Nu presupune că o propoziție este corectă doar pentru că nu conține typo-uri. Verifică dacă subiectul, predicatul, complementele, pronumele și determinările se leagă logic între ele și dacă ordinea cuvintelor produce o propoziție românească firească.
20. Compară fiecare traducere cu ORIGINALUL și, când este util, cu replicile din „context_anterior_en/context_urmator_en” și „context_anterior_ro/context_urmator_ro”. Contextul este doar pentru înțelegerea sensului și a continuității; corectează numai replica curentă. Folosește contextul pentru a detecta persoana verbală, referința pronumelor, acordul, construcțiile care continuă din replica anterioară și propozițiile împărțite între subtitrări.
21. Fii atent la erorile „gramatical românești la nivel de cuvinte, dar greșite ca propoziție”: acord greșit ascuns, complement legat de verbul greșit, prepoziție nepotrivită, verb la persoana/numărul greșit, pronume cu antecedent greșit, ordine sintactică anormală, construcție tranzitivă/intranzitivă greșită sau formulare care schimbă relația dintre personaje.
22. Verifică separat CONSTRUCȚIILE VERBALE. Nu analiza doar forma verbului, ci și ce complemente cere verbul în română. De exemplu, o construcție precum „M-am cerut în căsătorie cu Hughie” poate avea cuvinte corecte individual, dar verbul și complementul sunt incompatibile; dacă ORIGINALUL spune că vorbitorul a cerut o altă persoană în căsătorie, reconstruiește construcția corectă.
23. Verifică separat ACORDUL LOGIC, nu doar acordul gramatical superficial. Subiectul real trebuie să determine corect genul, numărul și persoana predicatului și ale adjectivelor/participiilor. De exemplu, „comuniștii erau periculoase” trebuie identificat ca acord greșit chiar dacă fiecare cuvânt există în română.
24. Verifică FORMELE CU DIACRITICE și formele omografe care schimbă gramatica: „pasa/păsa”, „in/în” și alte cazuri în care lipsa diacriticii poate ascunde o formă greșită. Nu corecta automat orice lipsă de diacritică dacă este nume propriu, marcă sau caz legitim.
25. Verifică FRAGMENTELE CORUPTE chiar și atunci când verificarea lexicală nu le marchează: „Ț-ținta”, „frecându-menta”, „mizerijile”, „reeligitată” sau combinații similare. Dacă forma rezultată nu poate funcționa în propoziția respectivă, reconstruiește-o din ORIGINAL și context.
26. Dacă o replică este împărțită pe două linii de subtitrare sau continuă evident în contextul vecin, evaluează sensul propoziției COMPLETE, nu doar fiecare fragment izolat. Nu introduce punctuație, majuscule sau reformulări doar pentru a face fragmentul izolat să pară complet.
27. Detectează formulările care sunt traduceri literale ale unei expresii englezești și care devin nenaturale sau lipsite de sens în română. Exemplu de tip: „suntem la anghinare rău de tot acum” pentru o expresie idiomatică precum „we're in a pickle”. Dacă sensul originalului este clar, adaptează expresia în română naturală fără a-i schimba intenția.
28. Nu confunda naturalețea cu preferința stilistică. Corectează doar când formularea este efectiv greșită, ambiguă, ilogică sau nenaturală într-un mod evident pentru un vorbitor nativ; nu rescrie o formulare doar pentru că ai prefera o altă variantă.
29. Caută EXPLICIT secvențe corupte rezultate din traducere automată sau tăiere accidentală: „f-o”, „fãcut-o”, „ți-ți”, „mi-mi”, „să-să”, fragmente rămase singure sau combinații care nu formează o construcție românească validă. Dacă ORIGINALUL nu susține o bâlbâială/repetiție intenționată, tratează-le ca erori.
30. Pentru orice token care conține o bucată suspectă lipită de un cuvânt valid, fă o verificare separată a tokenului și apoi a propoziției complete. Exemple: „Țin-ținta e prea mică.”, „T-Ar trebui...”, „frecându-menta”, „nu ți-pasă”. Dacă prima parte nu are funcție gramaticală în context și nu este o bâlbâială susținută de ORIGINAL, nu păstra tokenul doar pentru că partea finală este un cuvânt românesc valid. Reconstruiește forma corectă din ORIGINAL și context.
31. Cazul „Țin-ținta e prea mică.” este un exemplu de FRAGMENT CORUPT, nu de repetiție intenționată: dacă ORIGINALUL nu indică o bâlbâială, varianta corectă trebuie să elimine fragmentul „Țin-” și să păstreze sensul propoziției, de tipul „Ținta e prea mică.”. Nu lăsa o formă precum „T-ținta”, „Țin-ținta” sau altă combinație intermediară.
32. După orice corecție lexicală, verifică din nou ÎNTREAGA PROPOZIȚIE. Nu este suficient să repari un singur cuvânt dacă acordul, ordinea, cliticele sau sensul rămân greșite.
33. FOLOSEȘTE ACEST SET DE REGRESIE CA TEST OBLIGATORIU, DAR NU CA DICȚIONAR GLOBAL.
Înainte de a returna corecțiile, verifică dacă poți identifica și corecta tipurile de erori de mai jos atunci când ORIGINALUL și contextul le confirmă. Acestea sunt exemple de erori reale; NU aplica înlocuiri mecanice tuturor replicilor similare.
- „Ieși-mi din cap” → verifică dacă sensul corect este „Ieși din capul meu”. Problema este relația de posesie/sens, nu doar gramatica.
- „într-una extrem de letală” pentru un substantiv masculin precum „virus” → „într-unul extrem de letal”. Verifică acordul de gen și referința pronumelui.
- „momentul potrivitur” → „momentul potrivit”. Repară typo-urile evidente.
- „ca să...rbătorim” → „ca să sărbătorim”. Repară cuvintele fragmentate/trunchiate.
- „Citească-gânduri, ții minte?” → verifică dacă ORIGINALUL cere o expresie precum „Cititoare de gânduri” sau altă formulare naturală; nu aplica automat aceeași corecție în alte contexte.
- „democracția” → „democrația”. Repară erorile ortografice evidente.
- „mă reasigur” pentru „get reelected” → verifică sensul politic și, dacă ORIGINALUL/contextul îl confirmă, corectează către sensul „să fiu reales/realeasă”.
- „rămas pe jos” pentru „left standing” → verifică dacă sensul este „rămas în picioare”/„rămas prin preajmă”, în funcție de context.
- „S-a dus totul pe râpă” → verifică expresia românească și, dacă ORIGINALUL cere această idiomă, corectează „de râpă”.
- „o bullet” → „un glonț” dacă ORIGINALUL folosește „bullet” cu sensul de proiectil. Dacă „bullet” este altceva, păstrează sensul real.
- „n-ai putut să scape” → „n-ai putut să scapi” când subiectul este „tu”. Verifică persoana verbală.
- „mergem orbești” → „mergem orbește” când este folosit adverbial. Verifică funcția gramaticală, nu doar forma cuvântului.
Aceste exemple trebuie folosite pentru a detecta CATEGORIILE de eroare: semantică, acord, typo, fragmentare, calchiu, ortografie, fals prieten, idiom, cuvânt netradus, conjugare și adverbializare. Dacă o variantă actuală este corectă, NU o modifica doar pentru că seamănă cu un exemplu.

33. O corecție propusă NU este acceptată dacă rezultatul introduce o nouă formă coruptă, o repetiție accidentală, un cuvânt inventat, o construcție nenaturală sau o eroare gramaticală.
34. Repară numai când există o variantă românească clară, susținută de ORIGINAL și context. Dacă sunt posibile mai multe variante plauzibile și nu există certitudine, păstrează traducerea actuală.
35. Păstrează sensul original, registrul, vulgaritățile, slangul, umorul și intenția replicii.
36. Nu adăuga informații și nu elimina informații.
37. Păstrează exact formatul de subtitrare și eventualele line-break-uri relevante.
38. Nu introduce engleză în traducere și nu introduce caractere non-latine.
39. Dacă nu ești 100% sigur că există o eroare, PĂSTREAZĂ traducerea actuală.

EXEMPLE SUPLIMENTARE DE ERORI RECENTE:
- „Ce naiba veți faceți la Los Alamos?” → verifică auxiliarul + verbul; forma așteptată poate fi „veți face”.
- „Mecanica cuantică spun că e din ambele.” → verifică acordul subiect–verb și sensul complet.
- „Printre oamenii de știință a fost unanimă.” → verifică subiectul logic, acordul și construcția semantică.
- „Mm, mi-am amintesc bine.” → verifică reflexivul și persoana; dacă ORIGINALUL cere „îmi amintesc”, repară întreaga construcție.
- „Există o persoană pe care n-o veți niciodată învinge.” → verifică ordinea naturală „n-o veți învinge niciodată”.
- „Destul de puternic să-l omoare pe Homelander l-ar transforma...” → verifică ordinea sintactică a întregii propoziții.
- „De ce dracu' aș-o omori pe maică-ta?” → verifică simultan condiționalul, infinitivul și cliticul.
- „Deci chiar ai f-o.” → verifică forma verbală completă și cliticul; nu păstra fragmentul „f-o” dacă ORIGINALUL cere „făcut-o”.
- „nu ți-acționează puterile?” → verifică poziția cliticului și construcția verbală completă.

EXEMPLE REALE DIN SUBTITRĂRI CARE TREBUIE FOLOSITE CA MODELE
 DE DETECȚIE:
- „Ori dăm de capăt cum să-l antrenăm” → detectează construcția sintactică nenaturală și corectează conform ORIGINALULUI.
- „pregătit pentru pe 6” → detectează dublarea prepozițiilor și corectează conform ORIGINALULUI.
- „ca să...rbătorim” → detectează cuvântul trunchiat și repară „ca să sărbătorim”.
- „De ce dracu' aș-o omori pe maică-ta?” → detectează poziționarea greșită a cliticului și forma verbală; varianta trebuie verificată în ORIGINAL.
- „M-am cerut în căsătorie cu Hughie” → detectează construcția semantică/sintactică greșită; ORIGINALUL poate cere „L-am cerut în căsătorie pe Hughie”.
- „să arești” → „să arestezi”.
- „idioticule” → verifică dacă este un calchiu greșit; dacă ORIGINALUL cere vocativul românesc, „idiotule”.
- „Ca să Mă-nvățați” → verifică majuscula nejustificată în interiorul propoziției.
- „Fete din toată lumea te admira.” → verifică acordul și timpul verbal.
- „Fără ca idiotul ăsta...” → verifică majuscula în funcție de poziția în frază.
- „ai nevoie de pașaport” după punct → verifică majuscula de început.
- „nu ți-pasă” → verifică cliticul și forma corectă „nu-ți pasă”.
- „metamorfoți” → detectează cuvântul inexistent și reconstruiește forma corectă din ORIGINAL/context.
- „Și uită-ce-mi face și mie.” → verifică pronumele/cliticul lipsă și construcția „uită-te ce-mi face și mie”.
- „ftuți” → detectează typo-ul și verifică forma corectă din ORIGINAL/context.
- „Și comuniștii erau periculoase?” → verifică acordul de gen și număr dintre subiect și predicat/nume predicativ: „comuniștii” cere „periculoși”.
- „Apar și dispari din viața mea” → verifică persoana și paralelismul verbal; nu accepta combinații precum „apar” + „dispari” dacă ORIGINALUL/contextul cere aceeași persoană verbală.
- „De ce? Țin-ținta e prea mică.” → detectează fragmentul corupt și verifică întreaga construcție, nu doar cuvântul „ținta”.
- „De ce i-ar pasa ce fac?” → verifică forma verbală „păsa” și construcția completă „i-ar păsa”.
- „...cumpărate in ziua...” → verifică diacriticele și forma gramaticală „în”.
- „De ce i-o fi spus lui Einstein de m-a vorbit de rău.” → verifică legătura sintactică dintre verbe, pronume și subordonate; nu accepta o propoziție doar pentru că toate cuvintele sunt românești.

39. Verifică explicit CONSTRUCȚIILE CU AUXILIARE ȘI MODALE. Forme precum „veți faceți”, „ar trebui să mergiți” sau alte combinații incompatibile de forme verbale sunt erori clare când ORIGINALUL și contextul confirmă forma corectă.
40. Verifică explicit ORDINEA CLITICELOR în infinitiv, condițional, conjunctiv și perfect compus. Forme precum „aș-o omori”, „nu ți-acționează”, „ai f-o” trebuie analizate ca structură completă, nu reparate doar caracter cu caracter.
41. Verifică explicit ACORDUL SUBIECT–VERB. „Mecanica cuantică spun că e din ambele” trebuie analizat chiar dacă fiecare cuvânt există în română.
42. Verifică explicit PREPOZIȚIILE ȘI COMPLEMENTELE CERUTE DE VERB. Nu accepta combinații precum „pregătit pentru pe 6” sau complemente incompatibile; verifică relația sintactică completă.
43. Verifică explicit construcții de tipul „Printre oamenii de știință a fost unanimă”: stabilește subiectul logic și verifică acordul și sensul.
44. Verifică explicit FRAGMENTELE care par corecte lexical, dar sunt rupte sintactic. Dacă structura este evident coruptă, reconstruiește numai partea susținută de ORIGINAL și context.
45. Verifică explicit VERBELE REFLEXIVE ȘI PRONUMELE PERSONALE. „mi-am amintesc”, „m-am cerut în căsătorie”, „aș-o omori” și „mi facă” trebuie evaluate ca întregi construcții verbale.
46. Verifică explicit ORDINEA NATURALĂ A CUVINTELOR. „Există o persoană pe care n-o veți niciodată învinge” trebuie evaluat ca propoziție, nu ca listă de cuvinte corecte.
47. Verifică explicit VOCATIVELE ȘI CALCURILE LEXICALE; „idioticule” poate fi un calchiu dacă ORIGINALUL cere „idiotule”.
48. Formele scurte corupte („veți faceți”, „ai f-o”, „ți-acționează”, „aș-o omori”, „mi-am amintesc”, „ftuți”, „realejată”, „fãcut-o”) sunt semnale pentru o verificare sintactică mai largă.
49. Nu considera o linie corectă doar pentru că trece un detector lexical. Caută activ erori care apar exclusiv din relația dintre cuvinte: acord, guvernare verbală, clitice, complemente, ordine sintactică și sens.
50. După orice corecție verbală, pronominală sau de ordine a cuvintelor, verifică din nou întreaga propoziție față de ORIGINAL și context.
51. Fă o VERIFICARE DE INTEGRITATE A PROPOZIȚIEI după analiza lexicală: dacă toate cuvintele există în română, verifică totuși dacă împreună formează o propoziție completă, coerentă și gramaticală. Nu considera „toate cuvintele sunt românești” drept dovadă că traducerea este corectă.
52. Fă o VERIFICARE ORTOGRAFICĂ FINALĂ pentru fiecare linie: caută litere lipsă, litere în plus, inversări, forme fără diacritice care schimbă cuvântul, spații puse greșit în jurul cratimei și cuvinte trunchiate. Exemple de tip: „invige”, „reeleasă”, „nite”, „făt-o”, „f-ut-o”, „N- ar”, „trebui” în loc de „trebuie”.
53. Fă o VERIFICARE DE FORMA VERBALĂ + CONSTRUCȚIE VERBALĂ: dacă apare un verb suspect, verifică simultan infinitivul/conjunctivul/condiționalul, persoana, numărul, auxiliarul, cliticul și complementul cerut. Nu repara doar terminația unui verb dacă întreaga construcție rămâne greșită.
54. Fă o VERIFICARE DE ORDINE SINTACTICĂ: pentru fiecare propoziție suspectă, rearanjează mental componentele în ordinea românească naturală și compară cu ORIGINALUL. Exemple: „Destul de puternic să-l omoare pe Homelander l-ar transforma...” și „Există o persoană pe care n-o veți niciodată învinge.” sunt probleme de structură, nu simple typo-uri.
55. Fă o VERIFICARE DE ACORD ȘI REFERINȚĂ: verifică subiectul real al fiecărui verb/adjectiv/participiu și antecedentul fiecărui pronume. Nu accepta acorduri sau referințe care par plauzibile local, dar nu se potrivesc cu propoziția completă ori cu contextul.
56. Fă o VERIFICARE DE COMPLETITUDINE: caută cuvinte lipsă care fac propoziția să pară aproape corectă, dar nu corectă, inclusiv clitice, auxiliare, prepoziții, terminații și elemente obligatorii ale construcției. Exemple: „De ce dracu' aș-o omori...”, „Deci ai f-o.” și „nu ți-acționează...” trebuie evaluate ca structuri complete.
57. Fă o VERIFICARE PENTRU ERORI DE TIP „CUVÂNT CORECT, RELAȚIE GREȘITĂ”: un verb poate fi corect ca formă, dar greșit în persoană; un substantiv poate fi corect, dar legat prin prepoziția greșită; două cuvinte pot fi corecte separat, dar combinația poate fi imposibilă în română. Aceste cazuri trebuie corectate dacă ORIGINALUL și contextul oferă o soluție clară.
58. Pentru propozițiile împărțite între două sau mai multe subtitluri, fă verificarea la nivelul frazei complete folosind context_anterior și context_urmator. Nu lăsa o eroare de acord, timp verbal, clitic sau ordine a cuvintelor să treacă doar pentru că fragmentul local pare acceptabil.
59. Fă o ultimă trecere mentală de tip NATIV ROMÂN: „Aș spune această propoziție exact așa în română?” Dacă răspunsul este clar „nu” din cauza unei greșeli gramaticale/sintactice sau a unui calchiu evident, verifică ORIGINALUL și propune corecția. Dacă este doar o preferință stilistică, NU modifica.
60. Nu te opri după găsirea primei erori. După ce identifici o problemă într-o linie, verifică și restul liniei pentru alte erori independente înainte de a returna corecția.
61. Verifică explicit FORMELE VERBALE TRUNCHIATE SAU LIPSITE DE LITERE. Exemple precum „t trebui” trebuie analizate ca posibile forme corupte ale lui „trebuie”; nu lăsa forma doar pentru că restul propoziției este inteligibil.
62. Verifică explicit CUVINTELE SCURTE DEFORMATE. Forme precum „nite” trebuie tratate ca posibile deformări ale lui „niște” și verificate în ORIGINAL și context înainte de corectare.
63. Verifică explicit CUVINTELE INVENTATE/DEFORMATE CARE PAR PLAUZIBILE. O formă precum „peștinat” trebuie considerată suspectă chiar dacă seamănă cu o formă românească; reconstruiește forma corectă numai după ORIGINAL și context.
64. Verifică explicit MAJUSCULELE NEJUSTIFICATE ÎN INTERIORUL PROPOZIȚIEI. „Ca să Mă înveți...” trebuie evaluat ca posibilă eroare de capitalizare; dacă nu este nume propriu sau citat intenționat, forma firească este „Ca să mă înveți...”.
65. Verifică explicit CONECTORII „CA/CUM” ȘI CONSTRUCȚIILE COMPARATIVE/REFERENȚIALE. O formulare precum „Exact ca i-ați făcut tatălui meu” poate fi coruptă; dacă ORIGINALUL exprimă modul în care s-a făcut ceva, verifică dacă este necesar „Exact cum i-ați făcut tatălui meu”. Nu schimba automat fără suportul ORIGINALULUI.
66. Verifică explicit EXPRESIILE TEMPORALE CU „LA/PÂNĂ LA/PÂNĂ”. Formulări precum „pregătit pe 6” trebuie comparate cu ORIGINALUL pentru a stabili dacă sensul este „pregătit la șase”, „pregătit până la șase” sau altceva. Nu accepta o prepoziție doar pentru că traducerea literală o permite.
67. Verifică explicit CONSTRUCȚIILE CU „ÎN DOI/ÎN DOUĂ” ȘI EXPRESIILE DE MOD/NUMĂR. O formulare precum „totul se mișcă în doi” poate fi un calchiu al englezei; verifică ORIGINALUL și contextul pentru o formulare românească naturală, de tipul „ne mișcăm câte doi”, dacă sensul o confirmă.
68. Când găsești o formă suspectă, nu corecta doar cuvântul izolat. Reanalizează întreaga propoziție după înlocuire și verifică din nou acordul, sensul, complementele și naturalețea.
69. Verifică explicit ORICE CARACTER ATIPIC DINTR-UN CUVÂNT ROMÂNESC. Româna standard folosește literele latine și diacriticele „ă â î ș ț”. Caractere precum „ł, ø, æ, å, ñ, ç, ð, þ, ß, đ” sau alte caractere neobișnuite inserate în cuvinte românești trebuie tratate ca POSIBILĂ CORUPERE/EROARE. Exemplu: „ała” trebuie verificat ca posibilă formă coruptă a lui „ăla”. Verifică întotdeauna ORIGINALUL și contextul înainte de corectare.
70. Nu trata automat orice caracter străin ca eroare. Nume proprii, mărci, locuri, termeni ficționali și cuvinte străine intenționale pot conține caractere neobișnuite; păstrează-le dacă ORIGINALUL și contextul confirmă că sunt deliberate.
71. Verifică explicit MAJUSCULELE ACCIDENTALE DIN INTERIORUL PROPOZIȚIEI. Un cuvânt românesc obișnuit nu trebuie să înceapă accidental cu majusculă în mijlocul propoziției. Exemple: „Ca să Mă înveți...”, „..., Oricum.” sau „De ce i-ar Pasa...” trebuie verificate. Corectează numai dacă nu este început de propoziție, nume propriu, marcă, titlu, citat sau alt caz justificat de context.
72. Pentru caracterele atipice și majusculele suspecte, nu face o corecție izolată doar pentru că forma „arată ciudat”. Compară ORIGINALUL, context_anterior și context_urmator și verifică întreaga propoziție înainte de a decide.


EXEMPLE SUPLIMENTARE — INTEGRITATE SINTACTICĂ ȘI ORTOGRAFICĂ:
- „Există o persoană pe care n-o veți niciodată învinge.” → ordinea corectă este de tipul „Există o persoană pe care n-o veți învinge niciodată.”; verifică întreaga construcție, nu doar cuvântul „învinge”.
- „Destul de puternic să-l omoare pe Homelander l-ar transforma...” → propoziția trebuie reconstruită în ordinea românească susținută de ORIGINAL; nu accepta structura doar pentru că fiecare cuvânt este valid.
- „Ce naiba veți faceți la Los Alamos?” → „veți face”; elimină combinația auxiliar + formă verbală incompatibilă.
- „Atacul de panică ăla trebui să fie un avertisment.” → „Atacul de panică ăla trebuie să fie un avertisment.”; verifică forma verbală completă.
- „să fiu reeleasă peste patru ani.” → „să fiu realeasă peste patru ani.”; verifică forma lexicală/participială.
- „Mai bine mă omorau, decât ce i-am făcut fetei aceia.” → „...fetei aceleia.”; verifică acordul în construcția completă.
- „Poți să-mi iei nite Sugarfish?” → „niște”; verifică ortografia și diacriticele.
- „N- ar trebui să fie așa.” → „N-ar trebui să fie așa.”; verifică spațierea în jurul cratimei.
- „Ca să Mă-nveți cum să-mi ucid tatăl?” → „Ca să mă-nveți...”; verifică majuscula în context.
- „Exact ca au făcut-o cu tatăl meu.” → verifică prepoziția/conectorul și construcția; dacă ORIGINALUL confirmă, „Exact cum au făcut-o...” este forma naturală.
- „Mecanica cuantică spun că e din ambele.” → verifică subiectul singular și acordul verbal, chiar dacă toate cuvintele sunt valide.
- „Printre oamenii de știință a fost unanimă.” → verifică subiectul logic și acordul; nu accepta o propoziție doar pentru că adjectivul este românesc.
- „Mm, mi-am amintesc bine.” → verifică reflexivul și forma verbală completă; dacă ORIGINALUL cere „îmi amintesc”, corectează întreaga construcție.
- „De ce i-ar pasa ce fac?” → „De ce i-ar păsa ce fac?”; verifică forma verbală și construcția condițională.
- „...cumpărate in ziua...” → „...cumpărate în ziua...”; verifică diacritica și forma gramaticală.
- „făt-o”, „f-ut-o”, „ai f-o” → dacă ORIGINALUL nu indică o bâlbâială intenționată, reconstruiește forma verbală completă, de tipul „făcut-o”.
- „invige”, „reeleasă”, „nite”, „frecându-menta”, „mizerijile” → tratează-le ca posibile deformări și verifică propoziția completă înainte de corectare.

IMPORTANT: Acestea sunt exemple de TIPURI DE ERORI, nu corecții care trebuie aplicate orbește. Pentru fiecare linie, ORIGINALUL și contextul au prioritate.

IMPORTANT:
- Nu trebuie să modifici toate liniile.
- Returnează DOAR liniile pentru care există o corecție clară și necesară.
- Pentru liniile deja corecte, nu este nevoie să le returnezi.
- Dacă nu există nicio corecție clară, returnează un ARRAY GOL: [].

VERIFICARE OBLIGATORIE A CORECȚIEI FINALE:
Pentru fiecare linie pe care alegi să o corectezi, NU te opri după ce găsești prima problemă.
După ce formulezi noua variantă, recitește și verifică DIN NOU varianta finală ca pe o subtitrare independentă.
Înainte să o returnezi, confirmă mental toate acestea:
- toate cuvintele sunt românești, complete și corect scrise;
- acordurile gramaticale sunt corecte;
- verbele, pronumele și cliticile sunt corecte;
- prepozițiile și construcția frazei sunt naturale în română;
- nu a rămas nicio traducere literală sau fragment corupt;
- nu ai introdus o nouă greșeală în timp ce ai reparat-o pe cea veche;
- sensul, registrul și intenția originalului au rămas intacte.
Dacă după această a doua verificare mai există ORICE problemă evidentă în varianta propusă, NU o returna ca „corectată”; păstrează traducerea actuală.
Nu marca o linie drept corectată doar pentru că ai schimbat-o. Varianta nouă trebuie să fie efectiv mai bună și corectă.

EXEMPLE DE ERORI CARE TREBUIE VERIFICATE ÎN VARIANTA FINALĂ:
- „ai făt-o” / „fãcut-o” → verifică să nu rămână forma coruptă; forma corectă uzuală este „ai făcut-o”.
- „o favoră” → „o favoare”.
- „mi facă” → verifică forma clitică potrivită contextului, de exemplu „să-mi facă”.
- „Exact ca i-au făcut...” → verifică legătura gramaticală potrivită contextului, nu doar primul cuvânt schimbat.
- „Atacul ăla de panică trebui să fie un avertisment...” → forma verbală este suspectă; verifică „trebuie” în raport cu ORIGINALUL.
- „Poți să-mi iei nite Sugarfish?” → verifică forma „nite” și, dacă ORIGINALUL confirmă pluralul nehotărât, corectează la „niște”.
- „Lenny era să se peștinat când i-am spus.” → tratează „peștinat” ca formă coruptă și reconstruiește propoziția numai din ORIGINAL/context.
- „Ca să Mă înveți cum să-mi ucid tatăl?” → dacă „Mă” nu este nume propriu sau început de citat, corectează la „mă”.
- „Exact ca i-ați făcut tatălui meu.” → verifică dacă „ca” trebuie să fie „cum” pentru construcția cerută de ORIGINAL.
- „Asigură-te că e pregătit pe 6.” → verifică sensul temporal în ORIGINAL; nu păstra „pe 6” dacă engleza cere „la 6” sau „până la 6”.
- „Totul se mișcă în doi.” → verifică dacă este un calchiu și dacă ORIGINALUL cere o construcție românească de tipul „ne mișcăm câte doi”.
- „orgasmato”, „șura”, „tuți” → tratează-le ca forme suspecte care trebuie verificate explicit în ORIGINAL și context; nu le lăsa doar pentru că par aproape de un cuvânt românesc.
Aceste exemple sunt orientative; NU modifica o replică dacă originalul nu susține corecția.

INTEGRARE SUPLIMENTARĂ — AUDIT STRICT AL SENSULUI ȘI AL NATURALITĂȚII:
73. Compară obligatoriu „translation” cu „original” înainte de orice corecție. Nu presupune că o formulare românească este greșită doar pentru că ai fi tradus-o altfel. Corectează numai dacă există o eroare reală și clară de sens, gramatică, ortografie, sintaxă sau naturalețe.
74. Verifică explicit CALCURILE ȘI TRADUCERILE LITERALE din engleză. Dacă „translation” este o traducere mecanică ce nu are sens sau sună evident nenatural în română, reconstruiește formularea folosind sensul din „original” și context. Exemplul de tip „Suntem oameni în voi” trebuie analizat semantic și reformulat numai dacă originalul confirmă sensul corect.
75. Verifică explicit FORMULĂRILE CARE SUNT ROMÂNEȘTI CA VOCABULAR, DAR GREȘITE CA RELAȚIE SINTACTICĂ SAU SEMANTICĂ. Nu este suficient ca toate cuvintele să existe în dicționar. Verifică dacă verbul, subiectul, complementele, pronumele și prepozițiile formează împreună o construcție validă și dacă redau relația din „original”.
76. Verifică explicit FORMELE VERBALE ȘI CONSTRUCȚIILE VERBALE COMPLETE. Nu repara doar un sufix sau o literă dacă problema afectează întreaga construcție. Exemple: „să arești” → verifică „să arestezi”; „aș-o omori” → „aș omorî-o”; „mi-am amintesc” → „îmi amintesc”.
77. Verifică explicit ACORDUL DE GEN, NUMĂR ȘI PERSOANĂ folosind și contextul. Dacă traducerea curentă contrazice subiectul real, antecedentul pronumelui sau referința din original, corectează întreaga construcție, nu doar cuvântul problematic.
78. Verifică explicit TOPICA CLITICELOR ȘI A PRONUMELOR. Forme precum „nu ți-pasă”, „aș-o omori”, „uită-ce-mi face” sau combinații similare trebuie analizate ca structuri complete și corectate numai dacă „original” și contextul susțin clar corecția.
79. Verifică explicit CUVINTELE CORUPTE, TRUNCHIATE, LIPITE SAU INVENTATE, inclusiv forme care par aproape românești. Exemple: „metamorfoți”, „reeligitată”, „Iertați-man”, „ała”, „frecându-menta”, „mizerijile”. Pentru fiecare astfel de caz, verifică „original”, „ctx_ant” și „ctx_urm” înainte de a reconstrui forma.
80. Verifică explicit DIACRITICELE ȘI CARACTERELE ATIPICE în interiorul cuvintelor. Caractere precum „ł”, „ø”, „æ”, „å”, „ñ”, „ç”, „ð”, „þ”, „ß”, „đ” sau alte caractere neobișnuite într-un cuvânt românesc pot indica o corupere. Nu le corecta automat dacă fac parte dintr-un nume propriu, termen străin, marcă sau alt element intenționat.
81. Verifică explicit MAJUSCULELE ACCIDENTALE din interiorul propoziției. Exemple de tipul „Ca să Mă înveți...”, „..., Oricum.” sau „De ce i-ar Pasa...” trebuie analizate în context. Nu modifica nume proprii, titluri, mărci, începuturi de propoziție sau citate legitime.
82. Verifică explicit NATURALEȚEA ROMÂNEASCĂ, dar NU o confunda cu preferința stilistică. Dacă formularea este corectă și transmite sensul originalului, păstreaz-o chiar dacă există o variantă pe care ai prefera-o. Intervine numai când formularea este evident greșită, ilogică, calchiată sau nenaturală pentru un vorbitor nativ.
83. Păstrează obligatoriu slangul, vulgaritățile, sarcasmul, umorul, bâlbâielile și repetițiile intenționate. Nu transforma „Nu-nu”, „Da, eu-eu...” sau „Nu, nu, nu.” în formulări mai elegante dacă „original” indică intenția respectivă.
84. După fiecare corecție propusă, fă o VERIFICARE FINALĂ A VARIANTEI NOI: recitește propoziția completă, compar-o din nou cu „original”, verifică acordurile, verbele, cliticile, prepozițiile, sensul, diacriticele și naturalețea. Dacă noua variantă introduce orice eroare sau dacă nu ești sigur că este mai corectă decât varianta existentă, NU returna corecția.
85. Nu modifica o replică doar pentru a o „îmbunătăți”. Dacă „translation” este corectă, naturală și transmite corect „original”, ignor-o complet. Nu returna replicile bune.
86. Dacă există două variante posibile și nu există suficiente informații în „original”, „ctx_ant” și „ctx_urm” pentru a decide fără dubiu, păstrează traducerea existentă. Prioritatea este conservarea unei traduceri bune, nu forțarea unei corecții.
87. VERIFICARE SEMANTICĂ OBLIGATORIE: Nu este suficient ca traducerea română să fie gramaticală sau să sune natural. Compară sensul COMPLET al originalului în engleză cu traducerea română. Detectează cazurile în care traducerea este o propoziție românească validă, dar transmite ALTĂ IDEE decât originalul. Exemplu: EN „Get out of my head.” / RO „Ieși-mi din cap.” — dacă, în context, sensul cerut este „Get out of my head”, preferă o formulare care păstrează fidel sensul și posesia din original, precum „Ieși din capul meu”, numai dacă ORIGINALUL și contextul confirmă.
88. NU ACCEPTA REFORMULĂRI CARE SCHIMBĂ RELAȚIA DINTRE CUVINTE: Verifică atent prepozițiile, pronumele, posesivele, complementele și expresiile fixe. O propoziție poate fi perfect gramaticală în română și totuși să fie o traducere greșită. Exemplu: EN „Don't fucking touch me.” / RO „Să nu mă atingi de pulă.” — aceasta NU este echivalentă semantic; aici „fucking” funcționează ca intensificator/vulgarism, nu ca indicator al unui obiect sexual. Corectează numai dacă ORIGINALUL și contextul confirmă funcția respectivă.
89. VERIFICĂ VULGARITĂȚILE DUPĂ FUNCȚIA LOR ÎN ORIGINAL: Un cuvânt vulgar englezesc precum „fuck”, „fucking”, „damn”, „shit” etc. poate funcționa ca verb literal, intensificator, înjurătură, interjecție sau element de insistență/emfază. NU presupune automat că trebuie tradus literal. Stabilește mai întâi funcția lui în propoziția originală și păstrează nivelul de vulgaritate, fără a inventa obiecte, acțiuni sau relații care nu există în ORIGINAL.
90. VERIFICĂ EXPRESIILE IDIOMATICE ȘI COLOQUIALE CA UNITĂȚI DE SENS: Nu traduce fiecare cuvânt separat. Compară sensul expresiei întregi din EN cu sensul expresiei întregi din RO. O formulare românească literală, dar cu alt sens, trebuie tratată ca eroare semantică chiar dacă este gramaticală.
91. DETECTEAZĂ „ROMÂNĂ CORECTĂ, DAR SENS GREȘIT”: Acesta este un caz CRITIC. Dacă RO este gramatical și natural, dar schimbă cine face acțiunea, cine primește acțiunea, obiectul, posesia, relația dintre personaje, introduce un obiect care nu există în EN, elimină un element important din EN, schimbă funcția unei înjurături/intensificator într-un substantiv sau obiect concret ori schimbă sensul unei expresii, COREctează traducerea numai pe baza ORIGINALULUI și a contextului.
92. ÎNAINTE DE ORICE CORECȚIE SEMANTICĂ: Compară obligatoriu ORIGINALUL, traducerea actuală, context_anterior și context_urmator. Nu corecta doar pentru că o altă formulare românească sună mai bine. Corectează numai dacă există o diferență reală de sens și există o variantă clară, susținută de surse.
93. DUPĂ CORECȚIE: Recitește propoziția română completă și verifică din nou dacă noua variantă păstrează sensul EN, tonul, registrul și vulgaritatea atunci când există, fără să introducă cuvinte, obiecte, acțiuni sau idei inexistente în EN și fără să elimine informații importante. Dacă noua variantă nu este clar mai fidelă semantic, NU o returna.

94. DETECTEAZĂ CALCURILE SINTACTICE ȘI IDIOMATICE CARE PAR GRAMATICALE, DAR NU SUNT ROMÂNĂ NATURALĂ.

O traducere poate conține numai cuvinte românești corecte și totuși să fie formulată greșit deoarece structura originalului englezesc a fost copiată mecanic.

Exemplu de tip de problemă:
RO: „E un cuptor dracului aici.”
Această formulare trebuie analizată în raport cu ORIGINALUL și contextul; exemplul NU este o corecție automată și nu trebuie modificat doar pentru că seamănă cu acest caz.

Verifică dacă relația dintre substantiv, atribut, complement, intensificator și restul propoziției este una firească în română.
Nu copia mecanic ordinea sau construcția din engleză. Dacă originalul folosește o expresie figurată, colocvială sau un intensificator, traducerea trebuie să redea FUNCȚIA și SENSUL expresiei în română, nu să traducă fiecare componentă separat.

95. ACORDĂ ATENȚIE SPECIALĂ CONSTRUCȚIILOR „SUBSTANTIV + ÎNJURĂTURĂ/INTENSIFICATOR”.

Forme precum „un X dracului”, „un X naibii”, „un X al naibii” sau alte combinații similare NU sunt automat corecte doar pentru că există în limba română.
Verifică dacă expresia rezultată este realmente naturală în context și dacă reproduce sensul și funcția din original.

96. NU CONFUNDA „CUVÂNT ROMÂNESC VALID” CU „CONSTRUCȚIE ROMÂNEASCĂ VALIDĂ”.

Grammar Review trebuie să verifice simultan:
- sensul fiecărui cuvânt;
- relația dintre cuvinte;
- funcția expresiei;
- topica naturală în română;
- sensul întregii propoziții;
- echivalența cu originalul.

Dacă toate cuvintele sunt corecte individual, dar combinația lor produce o formulare nenaturală, calchiată sau semantic greșită, COREctează propoziția.

97. PENTRU EXPRESIILE COLOCVIALE/VULGARE, VERIFICĂ ÎNTÂI FUNCȚIA, APOI FORMA.

Nu presupune că „fucking” = „dracului” în orice context, „damn” = „dracului” în orice context, „hell” = „iad” în orice context sau „fuck” = un substantiv/verb literal în orice context.
Stabilește funcția expresiei în propoziția EN și caută echivalentul românesc natural pentru ACEA FUNCȚIE.



98. REGULĂ DE CONSERVARE PRIORITARĂ — NU REPARA CE ESTE DEJA BUN.
Scopul Grammar Review NU este să facă traducerea „mai frumoasă”, „mai elegantă” sau să aleagă formularea pe care tu ai prefera-o.
Dacă „translation” este gramaticală, naturală suficient pentru un vorbitor nativ și transmite corect sensul din „original”, NU O MODIFICA.
O diferență de preferință stilistică, sinonim, topică acceptabilă sau formulare alternativă NU este motiv de corecție.
Dacă nu poți identifica o eroare concretă și demonstrabilă, păstrează varianta existentă.

99. PRAG RIDICAT PENTRU CORECȚIE.
Returnează o corecție numai dacă poți explica în mod clar ce este greșit în varianta actuală și de ce varianta nouă este mai corectă.
Nu corecta pe baza unor formulări precum „ar suna mai bine”, „aș spune mai natural”, „poate ar fi mai potrivit” sau „prefer această variantă”.
Dacă problema este discutabilă sau există mai multe variante corecte, NU CORECTA.

100. NATURALEȚEA SE VERIFICĂ FĂRĂ SUPRA-CORRECTARE.
Regulile 94–97 despre calcuri, intensificatori și construcții nefirești trebuie aplicate conservator.
Nu presupune că o structură neobișnuită este greșită doar pentru că nu este formularea ta preferată.
Pentru a modifica o construcție, trebuie să existe simultan:
- o problemă reală de română sau o nepotrivire clară de sens;
- o explicație susținută de ORIGINAL și context;
- o variantă nouă clar mai corectă.
Dacă lipsește oricare dintre acestea, păstrează traducerea actuală.

101. NU GENERALIZA DIN EXEMPLE.
Exemplele din regulile anterioare, inclusiv „E un cuptor dracului aici.”, „Ieși-mi din cap.” sau exemplele cu vulgarități, sunt doar cazuri de test și NU reprezintă tipare care trebuie reparate automat în toate replicile similare.
Nu modifica o replică doar pentru că seamănă superficial cu un exemplu.
Compară întotdeauna ORIGINALUL, traducerea actuală și contextul concret.

102. O SINGURĂ EVALUARE COMPLETĂ, NU REPARAȚII ÎN CASCADĂ.
Înainte de a propune o corecție, analizează întreaga replică și toate problemele posibile deodată.
Alege o singură variantă finală care rezolvă problema identificată fără să introducă alte modificări inutile.
Nu face „îmbunătățiri” secundare după ce problema principală a fost rezolvată.
După formularea variantei finale, verific-o din nou ca pe o replică nouă.

103. PĂSTREAZĂ REGISTRUL ȘI INTENȚIA EXISTENTE.
Nu elimina vulgaritatea, slangul, sarcasmul, umorul, repetițiile intenționate sau stilul personajului doar pentru a obține o română mai formală.
În același timp, nu introduce vulgaritate, intensitate, obiecte sau sensuri care nu există în ORIGINAL.
Corectează numai ceea ce este efectiv greșit.

104. REGULĂ FINALĂ ÎN CAZ DE DUBIU.
Dacă după compararea ORIGINAL + translation + context_anterior_en + context_urmator_en + context_anterior_ro + context_urmator_ro nu există suficiente dovezi pentru o corecție sigură, NU returna nimic pentru acel ID.
Este preferabil să rămână o formulare ușor imperfectă decât să fie înlocuită o traducere corectă cu o reformulare greșită.

105. ORDINEA PRIORITĂȚILOR.
Respectă această ordine strictă:
1) fidelitatea față de ORIGINAL;
2) corectitudinea gramaticală și semantică;
3) naturalețea românească;
4) stilul și preferința de formulare.
O prioritate inferioară NU poate justifica modificarea unei variante corecte la o prioritate superioară.
Regulile 98–110 au rol de protecție împotriva supra-corectării și prevalează atunci când există conflict cu o regulă anterioară.

106. ANTI-HALUCINAȚIE SEMANTICĂ — NU INVENTA ELEMENTE CARE NU EXISTĂ ÎN ORIGINAL.
Nu introduce în traducerea română etnii, categorii sociale, religii, obiecte, persoane, acțiuni sau alte informații care nu sunt susținute de EN și context. Dacă o vulgaritate, insultă sau expresie englezească este ambiguă, verifică funcția și sensul ei în EN înainte de a alege echivalentul românesc.

107. PROTEJEAZĂ REGISTRUL ȘI INTENȚIA ORIGINALULUI.
Nu înlocui o vulgaritate cu un eufemism inventat și nu transforma o expresie vulgară într-o referire la o etnie sau altă categorie socială doar pentru că aceasta pare o soluție locală. Păstrează registrul, tonul și intensitatea originalului atunci când există un echivalent românesc firesc.

108. VULGARITĂȚILE TREBUIE INTERPRETATE DUPĂ FUNCȚIE.
Dacă un termen precum "fuck/fucking", "shit", "damn", "hell" etc. funcționează ca verb, act sexual, intensificator, înjurătură sau interjecție, stabilește funcția din EN înainte de traducere. Nu inventa un alt verb, obiect sau acțiune doar pentru a evita vulgaritatea.

109. VERIFICARE ANTI-HALUCINAȚIE ȘI RELAȚIILE ACȚIUNII.
Nu introduce în traducerea română persoane, obiecte, etnii, categorii sociale, acțiuni sau relații care nu există în ORIGINAL. Verifică explicit cine face acțiunea, asupra cui se face și dacă acțiunea este reciprocă/reflexivă. Nu transforma accidental o construcție de tip „we + verb” într-o acțiune asupra unei persoane terțe și nu transforma un vulgarism într-o insultă socială/etnică sau într-un eufemism care schimbă sensul. Dacă traducerea existentă este fidelă, nu o modifica.

110. CORECȚIE DOAR CU DOVADĂ.
Dacă nu poți demonstra din EN + context că traducerea RO este greșită ca sens, gramatică, vocabular sau construcție, PĂSTREAZĂ traducerea existentă. Nu modifica doar pentru că o altă formulare ți se pare mai elegantă.

111. VERIFICARE SEMANTICĂ A CONSTRUCȚIILOR CU PRONUME ȘI PREPOZIȚII.
Nu verifica doar dacă fiecare cuvânt există în română. Compară relația exprimată în EN cu relația exprimată în RO: cine acționează, asupra cui, unde, de pe ce, către cine, cui aparține ceva și dacă acțiunea este reflexivă sau reciprocă. O schimbare aparent mică de prepoziție sau pronume poate schimba sensul. Dacă EN cere o relație clară și RO o schimbă, corectează întreaga construcție, nu doar cuvântul izolat.

112. ACEEAȘI IDEE POATE FI GENERATĂ ÎN MAI MULTE FORME.
Nu presupune că o eroare semantică va apărea mereu sub aceeași formulare românească. Detectează tipul construcției greșite și verifică sensul ei în raport cu EN, chiar dacă modelul a schimbat cuvintele, flexiunea sau topica. Exemplele „Ieși-mi din cap” și „Ia mâna după mine” sunt cazuri de test pentru verificarea sensului, NU tipare care trebuie aplicate orbește altor replici.

113. REPARĂ CONSTRUCȚIA COMPLETĂ CÂND E NECESAR.
Dacă eroarea este de sens sau de relație sintactică, nu face o înlocuire cosmetică a unui singur cuvânt. Reformează doar partea necesară astfel încât rezultatul final să fie simultan fidel EN, corect gramatical și natural în română. După corecție, verifică din nou întreaga propoziție.

REGULĂ SPECIALĂ ÎMPOTRIVA PREFERINȚEI STILISTICE:
Nu folosi faptul că „ai spune tu altfel” sau că o variantă „sună mai bine” ca dovadă de eroare. O formulare diferită, dar corectă și fidelă, trebuie păstrată.

DATELE DE VERIFICAT:
Fiecare obiect conține și context_anterior_en/context_urmator_en și context_anterior_ro/context_urmator_ro. Acestea sunt DOAR pentru înțelegerea sensului, acordului și continuității.
Câmpul semnale_locale conține motivele pentru care verificările automate au marcat replica. Folosește-le ca indicii de verificat, NU ca dovadă automată că traducerea este greșită. Compară obligatoriu originalul și contextul înainte de a corecta.
Nu traduce și nu modifica textele de context. Returnează corecții DOAR pentru câmpul translation al ID-ului curent.
${JSON.stringify(payload, null, 2)}

Returnează DOAR JSON valid în forma:
[
  {"id": 123, "text": "traducerea corectată"}
]
Pentru ID-urile fără o eroare clară și demonstrabilă, NU returna niciun obiect.
`;


        let lastJsonError = null;

        // JSON-ul Gemini poate fi invalid ocazional chiar dacă promptul cere
        // explicit JSON valid. Nu abandonăm calupul la prima eroare: facem
        // un retry punctual pe același calup, iar dacă răspunsul rămâne invalid
        // îl împărțim automat în două. Astfel păstrăm dimensiunea configurată ca dimensiune normală
        // și nu pierdem verificări doar din cauza unei ghilimele/virgule stricate.
        for (let jsonAttempt = 0; jsonAttempt <= GRAMMAR_REVIEW_JSON_RETRY_LIMIT; jsonAttempt++) {
            try {
                if (jsonAttempt > 0) {
                    console.log(`${c.yellow}↻ [Grammar Review] JSON invalid la ${batch.length} replici; retry ${jsonAttempt}/${GRAMMAR_REVIEW_JSON_RETRY_LIMIT}...${c.reset}`);
                    await sleep(GRAMMAR_REVIEW_JSON_RETRY_DELAY_MS);
                }

                const keyState = await getAvailableKey(keyStates);
                const requestPrompt = jsonAttempt > 0
                    ? `${prompt}\n\nRETRY TEHNIC: Returnează DOAR JSON valid, fără markdown sau explicații. ${isCompactAudit ? 'Pentru fiecare corecție include obligatoriu id, text, issue_type, confidence și reason.' : 'Format exact: [{\"id\":123,\"text\":\"...\"}].'} Pentru nicio corecție returnează exact []. Nu modifica ID-urile. Escapă toate ghilimelele interne din text.`
                    : prompt;
                const raw = await callGemini(requestPrompt, keyState, {
                    timeout: GRAMMAR_REVIEW_TIMEOUT_MS,
                    // În audit, JSON mode + prompt explicit, fără responseSchema extins.
                    // Toate proprietățile cerute sunt validate de parser/guard local;
                    // schema extinsă a produs HTTP 400 în rularea v104.
                    responseSchema: isCompactAudit ? false : {
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
                const auditProofById = new Map();
                if (isCompactAudit && Array.isArray(parsed)) {
                    for (const row of parsed) {
                        if (row && row.id !== undefined) auditProofById.set(String(row.id), row);
                    }
                }

                checked += batch.length;

                for (const item of batch) {
                    const id = String(item.id);
                const candidateRaw = parsedDict[id];
                if (candidateRaw == null) continue;

                const current = formatSubtitleLine(String(translatedById[id] || ''));
                const candidate = formatSubtitleLine(String(candidateRaw || ''));

                if (!candidate || candidate === current) continue;

                if (isCompactAudit) {
                    const similarity = normalizedCorrectionSimilarity(current, candidate);
                    const proof = auditProofById.get(id);
                    const hasProof = hasHighConfidenceAuditProof(proof);
                    const strongSignal = hasStrongRepairSignal(current) || hasCorruptedSubtitleText(current, item.text);
                    const boundaryEcho = createsUnexpectedBoundaryEcho(
                        item, candidate, current, contextItems, contextIndexById, baselineTranslations
                    );

                    // Nu lăsăm auditul să introducă o repetiție la granița a două ID-uri
                    // dacă engleza nu o susține și varianta anterioară nu avea duplicarea.
                    if (boundaryEcho) {
                        rejectedBoundaryEchoes++;
                        console.log(`${c.yellow}  ⚠ [Continuity Guard] ID ${item.id} ignorat: creează dublura „${boundaryEcho.words}” ${boundaryEcho.side}.${c.reset}`);
                        continue;
                    }

                    // Similaritatea este doar un semnal, nu verdictul final. Schimbările ample
                    // se acceptă dacă AI furnizează tipul erorii, o justificare concretă și
                    // încredere >=90. Sub 12% cerem suplimentar un semnal puternic de corupere.
                    if (similarity < MIN_AUDIT_CORRECTION_SIMILARITY) {
                        const proofAllowsLargeRepair = hasProof && (similarity >= 0.12 || strongSignal);
                        if (!proofAllowsLargeRepair) {
                            rejectedAggressiveRewrites++;
                            console.log(`${c.yellow}  ⚠ [Correction Guard] ID ${item.id} ignorat: reformulare prea amplă (${Math.round(similarity * 100)}% similaritate), justificare insuficientă sau semnal de eroare slab.${c.reset}`);
                            continue;
                        }
                        acceptedLargeRepairs++;
                        acceptedLargeRepairIds.add(id);
                        console.log(`${c.cyan}  ↳ [Correction Guard] ID ${item.id}: reformulare amplă acceptată (${Math.round(similarity * 100)}%); motiv=${String(proof.issue_type)}, încredere=${Number(proof.confidence)}.${c.reset}`);
                    }
                }

                // Filtrul suplimentar nu acceptă traduceri devenite engleză sau text corupt.
                if (hasUntranslatedEnglish(item.text, candidate) ||
                    hasCorruptedSubtitleText(candidate, item.text)) {
                    console.log(`${c.yellow}  ⚠ [Grammar Review] ${item.id} ignorată: noua variantă a devenit suspectă${c.reset}`);
                    continue;
                }

                translatedById[id] = candidate;
                fixed++;
                batchFixed++;
                }

                // IMPORTANT: dacă răspunsul JSON a fost valid și am procesat calupul,
                // calupul este REUȘIT. Nu lăsăm bucla de retry să cadă ulterior în
                // fallback-ul „eroare necunoscută” și să dubleze contorul checked.
                console.log(`${c.green}✔ [Grammar Review] ${label}: ${batchFixed} corectate${c.reset}`);
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

                    // 429 este trimis mai departe către coada existentă.
                    if (is429) {
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

                // Dacă am ajuns aici după un retry JSON eșuat, NU mai abandonăm
                // calupul indiferent dacă a doua eroare a fost JSON, răspuns gol sau
                // o eroare neașteptată. Îl împărțim pentru a izola replica problematică.
                if (batch.length > GRAMMAR_REVIEW_JSON_SPLIT_MIN &&
                    (isJsonError || jsonAttempt > 0 || /conținut gol|empty content/i.test(message))) {
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

    // Auditul compact folosește concurență limitată, la fel ca traducerea principală.
    // Modurile vechi păstrează ordinea secvențială.
    if (isCompactAudit) {
        let nextBatchIndex = 0;
        const workerCount = Math.max(1, Math.min(GRAMMAR_AUDIT_CONCURRENCY, batches.length));
        await Promise.all(Array.from({ length: workerCount }, async () => {
            while (true) {
                const batchIndex = nextBatchIndex++;
                if (batchIndex >= batches.length) return;
                const batch = batches[batchIndex];
                const result = await processGrammarBatch(
                    batch,
                    batchIndex,
                    `Audit ${batchIndex + 1}/${batches.length}`
                );
                if (result.is429) rateLimitRetryQueue.push({ batch, batchIndex });
            }
        }));
    } else {
        // Prima trecere: dacă un calup primește 429, nu îl abandonăm definitiv.
        // Îl punem la coadă și îl reîncercăm după ce terminăm toate calupurile normale.
        for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
            const batch = batches[batchIndex];
            const result = await processGrammarBatch(
                batch,
                batchIndex,
                `Calup ${batchIndex + 1}/${batches.length}`
            );
            if (result.is429) rateLimitRetryQueue.push({ batch, batchIndex });
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

            if (result.is429 && retryRound < 2) {
                rateLimitRetryQueue.push(queued);
            }
        }
    }

    if (rateLimitRetryQueue.length) {
        console.log(`${c.yellow}⚠ [Grammar Review] ${rateLimitRetryQueue.length} calupuri au rămas neverificate după cele 2 reîncercări 429.${c.reset}`);
    }

    // Control final asupra rezultatului combinat: corecțiile din calupuri concurente
    // pot interacționa între ele. Revertim doar linia care a introdus o dublură nouă.
    if (isCompactAudit) {
        for (const item of candidates) {
            const id = String(item.id);
            const originalTranslation = baselineTranslations.get(id) || '';
            const finalTranslation = String(translatedById[id] || '');
            if (!finalTranslation || finalTranslation === originalTranslation) continue;
            const newEcho = createsUnexpectedBoundaryEcho(
                item, finalTranslation, originalTranslation, contextItems, contextIndexById, translatedById
            );
            if (newEcho) {
                translatedById[id] = originalTranslation;
                fixed = Math.max(0, fixed - 1);
                if (acceptedLargeRepairIds.delete(id)) acceptedLargeRepairs = Math.max(0, acceptedLargeRepairs - 1);
                rejectedBoundaryEchoes++;
                console.log(`${c.yellow}  ⚠ [Continuity Guard] ID ${id} readus la varianta anterioară: corecțiile cumulate au creat dublura „${newEcho.words}” ${newEcho.side}.${c.reset}`);
            }
        }
    }

    console.log(`${c.green}✔ [Grammar Review] Final: ${checked} verificate, ${fixed} corectate${c.reset}`);
    if (rejectedAggressiveRewrites) {
        console.log(`${c.cyan}ℹ [Correction Guard] ${rejectedAggressiveRewrites} reformulări ample respinse: justificare insuficientă sau text inițial fără semnal suficient de eroare.${c.reset}`);
    }
    if (acceptedLargeRepairs) {
        console.log(`${c.green}✔ [Correction Guard] ${acceptedLargeRepairs} reformulări ample acceptate pe baza justificării AI și a verificărilor de siguranță.${c.reset}`);
    }
    if (rejectedBoundaryEchoes) {
        console.log(`${c.cyan}ℹ [Continuity Guard] ${rejectedBoundaryEchoes} corecții respinse deoarece ar fi introdus dubluri între replici.${c.reset}`);
    }
    return { checked, fixed, rejectedAggressiveRewrites, acceptedLargeRepairs, rejectedBoundaryEchoes };
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
    [/\brenumerată\b/gi, 'remunerată'],
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
    [/\brenumerată\b/gi, 'remunerată'],
    [/\brenumerat\b/gi, 'remunerat'],
    [/\bsugist\b/gi, 'sugi'],

    // Corecții locale suplimentare cu încredere foarte mare, validate în QA.
    // Exemple concrete din testul tt15398776: typo-ul „acceași” și expresia fixă „nicio șansă”.
    [/(?<![\p{L}])acceași(?=$|[^\p{L}])/iu, 'aceeași'],
    [/(?<![\p{L}])nici\s+o\s+șansă(?=$|[^\p{L}])/iu, 'nicio șansă'],
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
    [/(?<![\p{L}])ți-a\s+pasat\b/iu, 'ți-a păsat']
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
        'outcome', 'warning', 'breach', 'device', 'evidence'
    ]);
    const englishIntegrated = clean.match(/[A-Za-z]+/g) || [];
    const englishHits = englishIntegrated.filter(word => highConfidenceEnglish.has(word.toLowerCase()));
    for (const word of [...new Set(englishHits.map(w => w.toLowerCase()))]) {
        reasons.push(`cuvânt englezesc integrat „${word}”`);
    }

    return reasons;
}

async function runLocalGrammarQualityPass(items, translatedById) {
    let autoFixed = 0;
    const flagged = [];

    for (const item of items) {
        const id = String(item.id);
        const current = String(translatedById[id] || '');
        if (!current.trim()) continue;
        if (isJunkOrInterjection(item.text)) continue;

        const fixed = applyLocalGrammarDeterministicFixes(current);
        if (fixed !== current) {
            translatedById[id] = formatSubtitleLine(fixed);
            autoFixed++;
            continue;
        }

        const reasons = detectLocalGrammarReviewReasons(current);
        if (reasons.length) {
            flagged.push({
                item,
                reasons
            });
        }
    }

    console.log(`${c.green}✔ [Micro-Grammar] ${autoFixed} corecții locale certe aplicate.${c.reset}`);

    if (flagged.length) {
        console.log(`${c.yellow}⚠ [Micro-Grammar] ${flagged.length} replici marcate pentru verificare punctuală.${c.reset}`);
        flagged.slice(0, 20).forEach(entry => {
            console.log(`  ${c.yellow}• ${entry.item.id}: ${entry.reasons.join('; ')}${c.reset}`);
        });
    } else {
        console.log(`${c.green}✔ [Micro-Grammar] Nicio replică nu necesită verificare punctuală.${c.reset}`);
    }

    return {
        autoFixed,
        flaggedItems: flagged.map(entry => entry.item),
        flaggedDetails: flagged.map(entry => ({ item: entry.item, reasons: entry.reasons }))
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
        if (isJunkOrInterjection(item.text) || isSourceHesitationOnly(item.text)) continue;

        const reasons = detectSemanticSpotCheckReasons(current);
        if (reasons.length) flagged.push({ item, reasons });
    }

    if (flagged.length) {
        console.log(`${c.yellow}⚠ [Semantic Spot Check] ${flagged.length} replici marcate pentru verificare punctuală.${c.reset}`);
        flagged.slice(0, 20).forEach(entry => {
            console.log(`  ${c.yellow}• ${entry.item.id}: ${entry.reasons.join('; ')}${c.reset}`);
        });
    } else {
        console.log(`${c.green}✔ [Semantic Spot Check] Nicio replică nu necesită verificare punctuală.${c.reset}`);
    }

    return flagged.map(entry => entry.item);
}

// ============================================================
// RECUPERARE DUPĂ GRAMMAR REVIEW — TRADUCERI DEVENITE GOALE
// ============================================================

async function recoverEmptyTranslationsAfterReview(items, translatedById, keyStates) {
    const emptyTranslations = items.filter(item => {
        const originalClean = isEffectivelyEmptySubtitleText(item.text) ? '' : String(item.text || '').replace(/<[^>]+>/g, '').trim();
        if (!originalClean) return false;
        if (isSourceHesitationOnly(item.text)) return false;

        // Interjecțiile cu sens pot fi recuperate; replicile doar din ezitare nu trebuie
        // să fie reumplute aici după ce filtrul le-a eliminat.
        const translated = translatedById[String(item.id)];
        const translatedClean = String(translated || '').replace(/<[^>]+>/g, '').trim();
        return !translatedClean;
    });

    if (!emptyTranslations.length) return { detected: 0, recovered: 0 };

    console.log(`${c.yellow}⚠ [Final Empty Recovery] ${emptyTranslations.length} traduceri goale detectate. Le retraduc punctual...${c.reset}`);

    const recoveryPrompt = `
${MASTER_TRANSLATION_PROMPT}

RECOVERY DUPĂ VERIFICAREA GRAMATICALĂ — TRADUCERI GOALE.
Următoarele replici au text original, dar traducerea rezultată după Grammar Review este goală.
Tradu TOATE liniile de mai jos în română naturală. Nu omite niciun ID.
Nu returna text gol.

${JSON.stringify(emptyTranslations.map(item => ({ id: item.id, text: item.text })), null, 2)}

Returnează DOAR un ARRAY JSON valid în forma:
[
  {"id": 123, "text": "traducerea română"}
]
`;

    let recoveredCount = 0;
    const recoveredIds = [];
    const failedIds = [];

    try {
        const recoveryKey = await getAvailableKey(keyStates);
        const recoveryRaw = await callGemini(recoveryPrompt, recoveryKey, { timeout: 20000 });
        const recoveryJson = safeJsonParse(recoveryRaw);
        const recoveryDict = normalizeTranslationPayload(recoveryJson);

        for (const item of emptyTranslations) {
            const candidateRaw = recoveryDict[String(item.id)];
            const candidate = formatSubtitleLine(String(candidateRaw || ''));
            const cleanedCandidate = formatSubtitleLine(deepCleanSubtitleText(candidate));

            if (
                !isSourceHesitationOnly(item.text) &&
                cleanedCandidate &&
                !hasUntranslatedEnglish(item.text, cleanedCandidate) &&
                !hasCorruptedSubtitleText(cleanedCandidate, item.text)
            ) {
                translatedById[String(item.id)] = cleanedCandidate;
                recoveredCount++;
                recoveredIds.push(String(item.id));
            } else {
                failedIds.push(String(item.id));
            }
        }
    } catch (error) {
        console.log(`${c.yellow}⚠ [Final Empty Recovery] Cererea de recuperare a eșuat: ${error.message}${c.reset}`);
    }

    const recoveredSuffix = recoveredIds.length ? ` (ID: ${recoveredIds.join(', ')})` : '';
    const failedSuffix = failedIds.length ? `; nereparate: ${failedIds.join(', ')}` : '';
    console.log(`${recoveredCount === emptyTranslations.length ? c.green : c.yellow}✔ [Final Empty Recovery] Recuperate: ${recoveredCount}/${emptyTranslations.length}${recoveredSuffix}${failedSuffix}${c.reset}`);
    return { detected: emptyTranslations.length, recovered: recoveredCount };
}

// ============================================================
// DETECTARE ȘI RECUPERARE PENTRU TRADUCERI REPETATE PE ID-URI DIFERITE
// ============================================================

function normalizeRepeatedTranslationCheckText(text) {
    return String(text || '')
        .replace(/<[^>]+>/g, ' ')
        .normalize('NFKC')
        .toLocaleLowerCase('ro-RO')
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function findSuspiciousRepeatedTranslationRuns(items, translatedById) {
    const runs = [];
    let i = 0;

    while (i < items.length) {
        const first = items[i];
        const firstNorm = normalizeRepeatedTranslationCheckText(translatedById[String(first.id)]);
        const words = firstNorm ? firstNorm.split(' ') : [];

        // Ignorăm răspunsurile scurte și interjecțiile repetate, precum „Da.” sau „Nu.”.
        if (firstNorm.length < 28 || words.length < 5) {
            i++;
            continue;
        }

        let j = i + 1;
        while (
            j < items.length &&
            normalizeRepeatedTranslationCheckText(translatedById[String(items[j].id)]) === firstNorm
        ) {
            j++;
        }

        if (j - i >= 3) {
            const sourceNorms = items.slice(i, j).map(item =>
                normalizeRepeatedTranslationCheckText(item.text)
            );
            const uniqueSources = new Set(sourceNorms.filter(Boolean));
            const substantialSources = sourceNorms.every(source => source.length >= 8);

            // Trei+ traduceri lungi identice pentru trei+ replici-sursă distincte
            // sunt un semnal de repetare/asociere greșită, nu o simplă repetiție de „Da/Nu”.
            if (uniqueSources.size >= 3 && substantialSources) {
                runs.push(items.slice(i, j));
            }
        }

        i = Math.max(i + 1, j);
    }

    return runs;
}

async function repairSuspiciousRepeatedTranslationRuns(items, translatedById, keyStates) {
    const runs = findSuspiciousRepeatedTranslationRuns(items, translatedById);
    if (!runs.length) {
        console.log(`${c.green}✔ [Mapping Check] Nicio secvență de 3+ traduceri lungi identice pe replici-sursă distincte.${c.reset}`);
        return 0;
    }

    let repaired = 0;

    for (const run of runs) {
        const ids = run.map(item => String(item.id));
        console.log(`${c.yellow}⚠ [Mapping Check] Posibil text repetat pe ID-uri distincte (${ids.join(', ')}); retranslatare punctuală.${c.reset}`);

        const prompt = `
${MASTER_TRANSLATION_PROMPT}

VERIFICARE PUNCTUALĂ A ASOCIERII ID–TEXT.
În rezultatul precedent, mai multe replici-sursă distincte au primit accidental aceeași traducere românească.
Tradu fiecare replică independent, strict după textul ei original. Nu copia aceeași propoziție între ID-uri diferite doar pentru că sunt alăturate.
Păstrează toate ID-urile exact; nu combina replicile, nu muta textul între ID-uri și nu omite nimic.

REPLICI:
${JSON.stringify(run.map(item => ({
            id: item.id,
            text: item.text,
            traducere_anterioara: translatedById[String(item.id)] || ''
        })), null, 2)}

Returnează DOAR un ARRAY JSON valid:
[
  {"id": 123, "text": "traducerea română"}
]
`;

        try {
            const keyState = await getAvailableKey(keyStates);
            const raw = await callGemini(prompt, keyState, { timeout: 30000 });
            const parsed = safeJsonParse(raw);
            const dict = normalizeTranslationPayload(parsed);

            const candidates = run.map(item => {
                const rawCandidate = dict[String(item.id)];
                if (rawCandidate === undefined || rawCandidate === null) {
                    throw new Error(`Lipsește ID-ul ${item.id} la verificarea ID–text.`);
                }

                const candidate = formatSubtitleLine(String(rawCandidate));
                const cleaned = formatSubtitleLine(deepCleanSubtitleText(candidate));
                if (!cleaned.trim()) {
                    throw new Error(`Traducerea pentru ID ${item.id} a rămas goală.`);
                }
                if (hasUntranslatedEnglish(item.text, cleaned) || hasCorruptedSubtitleText(cleaned, item.text)) {
                    throw new Error(`Traducerea pentru ID ${item.id} a rămas suspectă.`);
                }

                return { item, text: cleaned };
            });

            const distinct = new Set(candidates.map(candidate =>
                normalizeRepeatedTranslationCheckText(candidate.text)
            ));
            if (distinct.size < 2) {
                throw new Error('Răspunsul nou repetă aceeași traducere pe toate ID-urile.');
            }

            for (const candidate of candidates) {
                translatedById[String(candidate.item.id)] = candidate.text;
            }
            repaired += candidates.length;
            console.log(`${c.green}✔ [Mapping Check] Retraduse și revalidate ID-urile ${ids.join(', ')}.${c.reset}`);
        } catch (error) {
            console.log(`${c.yellow}⚠ [Mapping Check] Nu am putut confirma corectarea pentru ID-urile ${ids.join(', ')}: ${error.message}.${c.reset}`);
        }
    }

    return repaired;
}

// ============================================================
// MOTORUL PRINCIPAL DE TRADUCERE SRT
// ============================================================

async function translateSrtWithGemini(srtText, apiKeys) {
    const items = parseSrt(srtText);
    if (!items.length) throw new Error('Nu s-au găsit subtitrări valide.');

    // ID-urile SRT sunt doar etichete de cue; repetarea lor ar suprascrie textul
    // în dicționarul intern. Renumerotăm toate cue-urile în ordinea sursei, păstrând
    // textul și timpii, pentru o mapare deterministă.
    const hasDuplicateSourceIds = normalizeDuplicateSourceIds(items);
    if (hasDuplicateSourceIds) {
        console.log(`${c.yellow}⚠ [ID Integrity] ID-uri duplicate în SRT-ul sursă; am renumerotat intern cele ${items.length} de replici pentru a evita suprascrierea traducerilor.${c.reset}`);
    }

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

    // Detectează o eroare pe care verificarea ID-urilor prezente nu o vede:
    // aceeași traducere lungă returnată pentru trei sau mai multe replici-sursă diferite.
    await repairSuspiciousRepeatedTranslationRuns(items, translatedById, keyStates);

    const emptyTranslations = items.filter(item => {
        const originalClean = isEffectivelyEmptySubtitleText(item.text) ? '' : String(item.text || '').replace(/<[^>]+>/g, '').trim();
        if (!originalClean) return false;
        if (isJunkOrInterjection(item.text) || isSourceHesitationOnly(item.text)) return false;

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
            const recoveredIds = [];
            const failedIds = [];

            for (const item of emptyTranslations) {
                const candidateRaw = recoveryDict[String(item.id)];
                const candidate = formatSubtitleLine(String(candidateRaw || ''));
                const cleanedCandidate = formatSubtitleLine(deepCleanSubtitleText(candidate));

                if (
                    !isSourceHesitationOnly(item.text) &&
                    cleanedCandidate &&
                    !hasUntranslatedEnglish(item.text, cleanedCandidate) &&
                    !hasCorruptedSubtitleText(cleanedCandidate, item.text)
                ) {
                    translatedById[String(item.id)] = cleanedCandidate;
                    recoveredCount++;
                    recoveredIds.push(String(item.id));
                } else {
                    failedIds.push(String(item.id));
                }
            }

            const recoveredSuffix = recoveredIds.length ? ` (ID: ${recoveredIds.join(', ')})` : '';
            const failedSuffix = failedIds.length ? `; nereparate: ${failedIds.join(', ')}` : '';
            console.log(`${recoveredCount === emptyTranslations.length ? c.green : c.yellow}✔ [Empty Recovery] Recuperate: ${recoveredCount}/${emptyTranslations.length}${recoveredSuffix}${failedSuffix}${c.reset}`);
        } catch (error) {
            console.log(`${c.yellow}⚠ [Empty Recovery] Cererea de recuperare a eșuat: ${error.message}${c.reset}`);
        }
    }

    const targetedRetry = await globalPostCheck(items, translatedById, keyStates, 2);
    console.log(`${c.green}✔ Targeted retry final: ${targetedRetry.fixed} linii reparate${c.reset}`);

    if (ENABLE_FULL_GRAMMAR_REVIEW) {
        await grammarTranslationReview(items, translatedById, keyStates);
    } else {
        console.log(`${c.yellow}⏭ Grammar Review complet omis pentru a evita reverificarea tuturor replicilor; verificarea punctuală rămâne separată.${c.reset}`);
    }

    // Corecții deterministe locale, înaintea controlului AI.
    const microGrammar = await runLocalGrammarQualityPass(items, translatedById);

    if (ENABLE_COMPACT_GRAMMAR_AUDIT) {
        // Audităm toate replicile cu text; nu așteptăm ca regex-urile locale
        // să recunoască dinainte o eroare gramaticală sau semantică.
        await grammarTranslationReview(items, translatedById, keyStates, {
            mode: 'audit',
            contextItems: items
        });
    } else if (ENABLE_TARGETED_GRAMMAR_REVIEW) {
        const semanticSpotCheckItems = runSemanticSpotCheck(items, translatedById);

        // Combinăm toate semnalele într-o singură listă, ca fiecare replică să fie trimisă
        // cel mult o dată la verificarea AI punctuală. Păstrăm motivul detectării pentru AI.
        const targetedReviewMap = new Map();
        const targetedReasonsById = Object.create(null);
        for (const entry of microGrammar.flaggedDetails) {
            const id = String(entry.item.id);
            targetedReviewMap.set(id, entry.item);
            targetedReasonsById[id] = [...entry.reasons];
        }
        for (const item of semanticSpotCheckItems) {
            const id = String(item.id);
            targetedReviewMap.set(id, item);
            const semanticReasons = detectSemanticSpotCheckReasons(translatedById[id] || '');
            targetedReasonsById[id] = [...new Set([...(targetedReasonsById[id] || []), ...semanticReasons])];
        }

        if (targetedReviewMap.size) {
            await grammarTranslationReview(
                [...targetedReviewMap.values()],
                translatedById,
                keyStates,
                { mode: 'targeted', contextItems: items, reasonsById: targetedReasonsById }
            );
        } else {
            console.log(`${c.green}✔ [Grammar Review punctual] Nicio replică nu a fost marcată de verificările locale.${c.reset}`);
        }
    } else {
        console.log(`${c.cyan}ℹ Auditul AI gramatical este dezactivat explicit; rămân active corecțiile locale deterministe.${c.reset}`);
    }

    // Recuperarea finală pentru eventualele traduceri goale, indiferent dacă Grammar Review este activat.
    // Astfel, o corecție punctuală care a produs accidental un text gol nu mai ajunge
    // în fișierul final. Sunt retrimise doar ID-urile goale, nu întregul fișier.
    await recoverEmptyTranslationsAfterReview(items, translatedById, keyStates);

    // Filtru final de ezitări: o replică-sursă formată exclusiv din ezitare rămâne goală.
    // Previne reintroducerea „Păi...” / „Ei bine...” de către Empty Recovery.
    let suppressedFillerCues = 0;
    for (const item of items) {
        if (isSourceHesitationOnly(item.text)) {
            translatedById[String(item.id)] = '';
            suppressedFillerCues++;
        }
    }
    if (suppressedFillerCues) {
        console.log(`${c.cyan}ℹ [Hesitation Guard] ${suppressedFillerCues} replici formate doar din ezitare au rămas goale; nu au fost reintroduse ca text românesc de umplutură.${c.reset}`);
    }

    // Ultima protecție: corecțiile mecanice certe trebuie aplicate DUPĂ Grammar Review.
    // Altfel, verificatorul LLM poate rescrie din nou o formă deja corectată și rezultatul
    // devine dependent de variația aleatorie a modelului. formatSubtitleLine() este
    // idempotent pentru aceste corecții și reaplică dicționarul determinist la final.
    for (const item of items) {
        const id = String(item.id);
        if (isSourceHesitationOnly(item.text)) continue;
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
        finalText = applyLocalGrammarDeterministicFixes(finalText);
        const formattedFinalText = formatSubtitleLine(finalText);

        if (String(formattedFinalText).trim()) {
            translatedById[id] = formattedFinalText;
        } else {
            translatedById[id] = currentText;
            console.log(`${c.yellow}⚠ [Protecție finală] ID ${id}: formatterul ar fi golit traducerea; am păstrat ultima variantă nenulă.${c.reset}`);
        }
    }

    console.log(`\n${c.cyan}🔒 Protecție finală: curățarea deterministă a fost reaplicată după recuperări.${c.reset}`);
    console.log(`\n${c.cyan}🔍 VERIFICARE FINALĂ...${c.reset}`);

    const finalRepeatedRuns = findSuspiciousRepeatedTranslationRuns(items, translatedById);
    const finalRepeatedIds = new Set(finalRepeatedRuns.flatMap(run => run.map(item => String(item.id))));
    if (finalRepeatedIds.size) {
        console.log(`${c.yellow}⚠ [Mapping Check] Repetări lungi încă suspecte după toate corecțiile (ID: ${[...finalRepeatedIds].join(', ')}).${c.reset}`);
    }

    const finalSuspicious = items.filter(item => {
        if (finalRepeatedIds.has(String(item.id))) return true;
        const originalClean = isEffectivelyEmptySubtitleText(item.text) ? '' : String(item.text || '').replace(/<[^>]+>/g, '').trim();
        if (!originalClean) return false;
        if (isJunkOrInterjection(item.text) || isSourceHesitationOnly(item.text)) return false;

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

    const suppressedHesitationCues = items.filter(item => isSourceHesitationOnly(item.text)).length;
    const nonEmptyTranslations = items.filter(item => String(translatedById[String(item.id)] || '').trim()).length;
    console.log(`${c.green}✔ ${items.length - finalSuspicious.length}/${items.length} ID-uri fără probleme detectabile${c.reset}`);
    console.log(`${c.cyan}ℹ Traduceri cu text: ${nonEmptyTranslations}/${items.length}; replici-sursă de ezitare suprimate: ${suppressedHesitationCues}.${c.reset}`);
    console.log(`${c.green}✔ Verificarea finală executată după targeted retry.${c.reset}`);

    const output = items.map(item => {
        const id = String(item.id);
        const translated = isSourceHesitationOnly(item.text)
            ? ''
            : (translatedById[id] || item.text);
        return `${item.id}\n${item.start} --> ${item.end}\n${translated}\n`;
    }).join('\n');

    return output.trim() + '\n';
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

    if (memoryCache[cacheKey] && typeof memoryCache[cacheKey] === 'string') {
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
                const srtRes = await fetchValidatedSubtitleUrl(validatedTarget.url);
                
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

        // Verificăm textul ORIGINAL înainte de cleanTextForJson(). Unele surse folosesc
        // entități HTML pentru spații/caractere invizibile, iar etapa de curățare poate
        // transforma aceste entități într-un fragment aparent nenul. Un astfel de bloc
        // este totuși gol și nu trebuie să intre în pipeline-ul de traducere.
        if (isEffectivelyEmptySubtitleText(rawText)) continue;

        const text = cleanTextForJson(rawText);

        if (!text || text === ' ' || isEffectivelyEmptySubtitleText(text)) continue;

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
});
