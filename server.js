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
    version: '12.72.0',
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
        
        console.log(`${c.green}✔ S-au pregătit ${diverseSubs.length} subtitrări de tradus pentru: ${id}${c.reset}`);

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

function deepCleanSubtitleText(text) {
    if (!text) return text;
    
    let trimmed = text.trim();
    if (/^(-|\–|\—)(\s*(-|\–|\—))*$/g.test(trimmed)) return '';

    let cleaned = text.replace(/\b(ăă|îhî|mhm|ah|oh|uh|agh|aâ|aoleu)\b[,!]*/gmi, ' ').trim();
    cleaned = cleaned.replace(/\s+/g, ' ');
    
    if (/^(ah|oh|uh|agh|aâ|aoleu|ăă)[!.]*$/gmi.test(cleaned)) return '';
    if (!cleaned) return '';

    cleaned = cleaned.replace(/\bman-ar\b/gi, 'mi-ar');
    cleaned = cleaned.replace(/\bman-a\b/gi, 'mi-a');
    cleaned = cleaned.replace(/\b[Dd]e ce man pas[aă]\b/gi, 'De ce mi-ar păsa');
    cleaned = cleaned.replace(/\b[Dd]e ce man-ar pasa\b/gi, 'De ce mi-ar păsa');
    
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
        [/\b(să îți recuperezi banii)\b/gi, 'să îți recuperezi fondurile'],
        [/\b(să-și vadă banii înapoi)\b/gi, 'să-și recupereze banii']
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

16. NO ENGLISH LEFT BEHIND — MANDATORY FINAL CHECK
Translate EVERY actual English dialogue line into Romanian.

After translating, compare EVERY output value with its corresponding English input value.

NEVER return an English dialogue sentence or clause unchanged.
NEVER copy an English dialogue block from the input into the output.
If the output is still substantially English, translate it again before returning the JSON.

English may remain ONLY when it is:
- a character/proper name
- a brand or established name
- a place or official title that should remain unchanged
- a genuinely unavoidable technical term with no natural Romanian equivalent

A complete English sentence is NEVER acceptable as a translated subtitle.

17. NO ALTERNATIVES
Never provide multiple translations.
Never write alternatives such as: (varianta 1 / varianta 2) or "X" / "Y".
Choose the single most natural Romanian translation.

18. DO NOT IMPROVISE
If a phrase is ambiguous, use the surrounding context to determine the most likely intended meaning.

19. TARGETED GRANULAR RETRY ON UNTRANSLATED ENGLISH LINES
CRITICAL: If the English detection filter discovers that specific lines within a chunk have remained untranslated in English, DO NOT fail or re-translate the entire chunk of 165 lines. Instead, isolate ONLY the specific failing line indices, re-translate solely those specific lines in a targeted micro-request to Gemini, and merge them back seamlessly.

20. MULTI-SPEAKER DIALOGUE FORMATTING - CRITICAL
When a subtitle contains two different speakers, you MUST output them on TWO SEPARATE LINES using a line break (\\n). 
Do NOT output them on a single horizontal line.
CORRECT:
- Baker, ia coridorul.
- Am înțeles!

21. NEVER OUTPUT EMPTY DIALOGUE DASHES OR STANDALONE INTERJECTIONS
NEVER output a subtitle line containing ONLY hyphens, dashes, or empty markers such as "-", "–", or "—".
NEVER output standalone hesitation sounds or interjections such as "ăă", "îhî", "mhm", "Ah!", "Oh!", "Uh!", "Agh!", "Aâ!".
If a subtitle contains an empty dialogue dash or a standalone interjection with no actual spoken text after it, DELETE IT completely.

22. NO INVENTED OR CORRUPTED ROMANIAN WORDS
NEVER invent Romanian words. Words such as "molmoșește", "anghang", "tangou" (when misused as a corrupted word) and similar malformed forms sunt strict interzise.

23. ABSOLUTELY NO ENGLISH DIALOGUE LEFT
After translation, inspect EVERY individual subtitle line. If any line remains an English dialogue sentence or clause, translate it into natural Romanian.

24. STRICT GRAMMAR AND CLEAN PUNCTUATION
NEVER output malformed forms such as "Ț-am", "Eu acționez" (or incorrect agreement), or double hyphens ("--") where standard Romanian punctuation is required. Use correct clitics ("Ți-am", "să-i", "să-ți", "să-și") and proper grammar. 

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
- verify that no corrupted or invented Romanian word remains;
- verify that no word is accidentally distorted or misspelled;
- verify that the Romanian sentence sounds natural when read aloud.

If you find even ONE suspicious word or malformed phrase, rewrite that subtitle before returning the JSON.

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
                // Dacă primim limitare (Prea multe cereri), aruncăm cheia imediat
                keyState.pausedUntil = Date.now() + 65000;
                throw new Error(`Rate limit 429. Se schimbă cheia...`);
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
// CHUNK ENGINE CU RETRY, RE-SPLIT SI VERIFICARE ENGLEZA
// ============================================================

function chunkArray(array, size) {
    const chunks = [];
    for (let i = 0; i < array.length; i += size) {
        chunks.push(array.slice(i, i + size));
    }
    return chunks;
}

function hasUntranslatedEnglish(original, translated) {
    if (!original || !translated) return false;

    const normalize = value => String(value)
        .toLowerCase()
        .replace(/[“”„"’']/g, "'")
        .replace(/[–—]/g, '-')
        .replace(/\s+/g, ' ')
        .trim();

    const originalNorm = normalize(original);
    const translatedNorm = normalize(translated);

    const strongEnglish = new Set([
        'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'than',
        'they', 'them', 'their', 'we', 'us', 'our',
        'you', 'your', 'he', 'him', 'his', 'she', 'her', 'it', 'its',
        'this', 'that', 'these', 'those',
        'what', 'which', 'who', 'where', 'when', 'why', 'how',
        'with', 'from', 'into', 'onto', 'about', 'after', 'before',
        'without', 'against', 'between', 'through', 'because', 'while',
        'would', 'could', 'should', 'will', 'shall', 'can', 'cannot',
        'do', 'does', 'did', 'have', 'has', 'had',
        'not', "don't", "isn't", "won't", "can't", "didn't",
        'please', 'sorry', 'thanks', 'thank', 'yes', 'okay', 'ok'
    ]);

    const englishMarkers = new Set([
        ...strongEnglish,
        'need', 'needs', 'needed', 'want', 'wants', 'wanted',
        'know', 'knows', 'knew', 'think', 'thought', 'mean', 'means',
        'look', 'looks', 'looked', 'make', 'makes', 'made',
        'get', 'gets', 'got', 'go', 'goes', 'went', 'come', 'comes', 'came',
        'take', 'takes', 'took', 'give', 'gives', 'gave',
        'see', 'sees', 'saw', 'say', 'says', 'said',
        'tell', 'tells', 'told', 'find', 'finds', 'found',
        'leave', 'leaves', 'left', 'keep', 'keeps', 'kept',
        'disregard', 'forget', 'ignore', 'remember',
        'good', 'bad', 'right', 'wrong', 'now', 'here', 'there',
        'very', 'really', 'just', 'only', 'still', 'already',
        'first', 'last', 'next', 'back', 'again'
    ]);

    const tokenize = value => value.match(/[a-z]+(?:'[a-z]+)?/g) || [];
    const tw = tokenize(translatedNorm);
    const ow = tokenize(originalNorm);

    if (originalNorm === translatedNorm && tw.length > 0) {
        const strong = tw.filter(w => strongEnglish.has(w)).length;
        const markers = tw.filter(w => englishMarkers.has(w)).length;
        if (strong >= 1 || markers >= 2) return true;
    }

    if (tw.length <= 7) {
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

function hasCorruptedSubtitleText(text) {
    const s = String(text || '').trim();
    if (!s) return true;

    if (/^(?:[-–—]\s*)+[.!?,:;]?\s*$/.test(s)) return true;
    if (/^[-–—]\s*[.!?,:;]\s*/.test(s)) return true;

    return false;
}

async function processChunkWithRetry(chunk, allItems, chunkStart, chunkEnd, previousTranslatedContext, keyStates, globalChunkIndex, totalChunks, depth = 0) {
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

            const results = chunk.map(obj => {
                const val = dict[obj.id] !== undefined ? dict[obj.id] : (dict[String(obj.id)] !== undefined ? dict[String(obj.id)] : obj.text);
                return {
                    id: obj.id,
                    text: formatSubtitleLine(val)
                };
            });

            const untranslatedItems = results.filter(result => {
                const original = chunk.find(obj => obj.id === result.id)?.text || '';
                return hasUntranslatedEnglish(original, result.text);
            });

            if (untranslatedItems.length > 0 && depth < 2) {
                console.log(`${c.yellow}⚠ [Gemini] Detectate ${untranslatedItems.length} linii netraduse în calupul ${globalChunkIndex + 1}. Retraducere punctuală...${c.reset}`);
                
                for (const badItem of untranslatedItems) {
                    await sleep(1500); // Pauză pentru a nu bloca API-ul
                    const originalObj = chunk.find(obj => obj.id === badItem.id);
                    if (!originalObj) continue;

                    const singlePrompt = `
${MASTER_TRANSLATION_PROMPT}

Tradu strict această singură linie de subtitrare în limba română naturală, păstrând exact cheia "${originalObj.id}":
{
  "${originalObj.id}": "${originalObj.text}"
}
`;
                    try {
                        const singleRaw = await callGemini(singlePrompt, keyState);
                        const sIdx = singleRaw.indexOf('{');
                        const eIdx = singleRaw.lastIndexOf('}');
                        const singleJson = JSON.parse(singleRaw.slice(sIdx, eIdx + 1));
                        const fixedVal = singleJson[originalObj.id] || singleJson[String(originalObj.id)];
                        if (fixedVal) {
                            const targetRes = results.find(r => r.id === originalObj.id);
                            if (targetRes) {
                                const candidate = formatSubtitleLine(fixedVal);
                                if (
                                    candidate &&
                                    !hasUntranslatedEnglish(originalObj.text, candidate) &&
                                    !hasCorruptedSubtitleText(candidate)
                                ) {
                                    targetRes.text = candidate;
                                    console.log(`${c.green}  ✔ [Retry] ${originalObj.id} reparată și validată${c.reset}`);
                                } else {
                                    console.log(`${c.yellow}  ⚠ [Retry] ${originalObj.id} încă suspectă după retraducere${c.reset}`);
                                }
                            }
                        }
                    } catch (err) {}
                }
            }

            console.log(`${c.green}✔ [Gemini] Calup ${globalChunkIndex + 1}/${totalChunks} finalizat! (${chunk.length}/${chunk.length} linii)${c.reset}`);
            return results;
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

async function globalPostCheck(items, translatedById, keyStates, maxPasses = 2) {
    let totalFixed = 0;

    for (let pass = 1; pass <= maxPasses; pass++) {
        const suspicious = items.filter(item => {
            const translated = translatedById[String(item.id)];
            return !translated ||
                hasUntranslatedEnglish(item.text, translated) ||
                hasCorruptedSubtitleText(translated);
        });

        console.log(`\n${c.cyan}🔍 POST-CHECK GLOBAL — pass ${pass}/${maxPasses}${c.reset}`);
        console.log(`   Verificate: ${items.length} replici`);

        if (suspicious.length === 0) {
            console.log(`${c.green}✔ 0 replici suspecte${c.reset}`);
            return { fixed: totalFixed, remaining: [] };
        }

        console.log(`${c.yellow}⚠ Detectate ${suspicious.length} replici suspecte${c.reset}`);

        for (const item of suspicious) {
            await sleep(2000); // Pauză crucială de 2 secunde pentru a preveni 429
            let fixed = false;

            for (let retry = 1; retry <= 3; retry++) {
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
{
  "${item.id}": "traducerea română"
}
`;

                    const raw = await callGemini(singlePrompt, keyState);

                    let cleanText = raw.trim();
                    const sIdx = cleanText.indexOf('{');
                    const eIdx = cleanText.lastIndexOf('}');
                    if (sIdx < 0 || eIdx <= sIdx) {
                        throw new Error('Răspuns retry fără JSON valid');
                    }

                    const parsed = JSON.parse(cleanText.slice(sIdx, eIdx + 1));
                    const candidateRaw =
                        parsed[item.id] !== undefined
                            ? parsed[item.id]
                            : parsed[String(item.id)];

                    const candidate = formatSubtitleLine(String(candidateRaw || ''));

                    if (
                        candidate &&
                        !hasUntranslatedEnglish(item.text, candidate) &&
                        !hasCorruptedSubtitleText(candidate)
                    ) {
                        translatedById[String(item.id)] = candidate;
                        fixed = true;
                        totalFixed++;

                        console.log(`${c.green}  ✔ Global retry: ${item.id} reparată (${retry}/3)${c.reset}`);
                        break;
                    }

                    console.log(`${c.yellow}  ⚠ Global retry: ${item.id} încă suspectă (${retry}/3)${c.reset}`);
                } catch (err) {
                    console.log(`${c.yellow}  ⚠ Global retry eșuat pentru ${item.id} (${retry}/3): ${err.message}${c.reset}`);
                }
            }

            if (!fixed) {
                console.log(`${c.red}  ❌ Neremediată: ${item.id}${c.reset}`);
            }
        }

        const remaining = items.filter(item => {
            const translated = translatedById[String(item.id)];
            return !translated ||
                hasUntranslatedEnglish(item.text, translated) ||
                hasCorruptedSubtitleText(translated);
        });

        if (remaining.length === 0) {
            console.log(`${c.green}✔ Toate replicile suspecte au fost remediate${c.reset}`);
            return { fixed: totalFixed, remaining: [] };
        }

        console.log(`${c.yellow}⚠ ${remaining.length} suspecte rămase după pass ${pass}${c.reset}`);
    }

    const remaining = items.filter(item => {
        const translated = translatedById[String(item.id)];
        return !translated ||
            hasUntranslatedEnglish(item.text, translated) ||
            hasCorruptedSubtitleText(translated);
    });

    return { fixed: totalFixed, remaining };
}

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

    const globalCheck = await globalPostCheck(
        items,
        translatedById,
        keyStates,
        2
    );

    console.log(`\n${c.cyan}🔍 VERIFICARE FINALĂ...${c.reset}`);

    const finalSuspicious = items.filter(item => {
        const translated = translatedById[String(item.id)];
        return !translated ||
            hasUntranslatedEnglish(item.text, translated) ||
            hasCorruptedSubtitleText(translated);
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
    console.log(`${c.green}✔ Total remediate prin targeted retry: ${globalCheck.fixed}${c.reset}`);

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
