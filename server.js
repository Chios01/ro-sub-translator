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
    id: 'ro.sub.translator',
    version: '12.8.0',
    name: 'RO Sub Translator',
    description:
        'Traducere cinematică automată English → Romanian cu Gemini',
    resources: [
        'subtitles'
    ],
    types: [
        'movie',
        'series'
    ],
    catalogs: [],
    idPrefixes: [
        'tt'
    ]
};

// ============================================================
// ROOT
// ============================================================

app.get('/', (req, res) => {
    const indexPath = path.join(
        __dirname,
        'index.html'
    );

    if (fs.existsSync(indexPath)) {
        return res.sendFile(indexPath);
    }

    res.send(
        'RO Sub Translator is running.'
    );
});

// ============================================================
// PING
// ============================================================

app.get('/ping', (req, res) => {
    res.send('OK');
});

// ============================================================
// VALIDATE GEMINI KEY
// ============================================================

app.get('/validate-key', async (req, res) => {
    const key =
        String(req.query.key || '').trim();

    if (!key) {
        return res.status(400).json({
            valid: false,
            error: 'Missing API key'
        });
    }

    try {
        const response = await axios.get(
            'https://generativelanguage.googleapis.com/v1beta/models',
            {
                params: {
                    key
                },
                timeout: 20000
            }
        );

        return res.json({
            valid: true,
            models:
                response.data?.models || []
        });

    } catch (error) {
        return res.status(
            error.response?.status || 500
        ).json({
            valid: false,
            error:
                error.response?.data ||
                error.message
        });
    }
});

// ============================================================
// CONFIGURE
// ============================================================

app.get('/:configData/configure', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="ro">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>RO Sub Translator</title>
<style>
body {
    font-family: Arial, sans-serif;
    background: #111;
    color: #eee;
    padding: 30px;
}
.container {
    max-width: 800px;
    margin: auto;
}
textarea {
    width: 100%;
    min-height: 180px;
    background: #222;
    color: #fff;
    border: 1px solid #444;
    padding: 12px;
    box-sizing: border-box;
}
button {
    margin-top: 15px;
    padding: 12px 20px;
    cursor: pointer;
}
</style>
</head>
<body>
<div class="container">
<h1>RO Sub Translator</h1>
<p>
Introdu cheile Gemini, câte una pe linie.
</p>
<textarea id="keys"></textarea>
<br>
<button onclick="save()">Salvează</button>
<script>
function save() {
    const keys =
        document.getElementById('keys')
            .value
            .split(/\\n+/)
            .map(x => x.trim())
            .filter(Boolean);

    if (!keys.length) {
        alert('Introdu cel puțin o cheie.');
        return;
    }

    const encoded =
        btoa(JSON.stringify(keys));

    const url =
        location.origin +
        '/' +
        encoded +
        '/manifest.json';

    window.location.href = url;
}
</script>
</div>
</body>
</html>
    `);
});

// ============================================================
// MANIFEST ROUTE
// ============================================================

app.get('/:configData/manifest.json', (req, res) => {
    res.json(manifest);
});

// ============================================================
// ARCHIVE
// ============================================================

app.get('/archive', (req, res) => {
    res.json(secretArchive);
});

app.get('/archive/:index', (req, res) => {
    const index =
        Number(req.params.index);

    if (
        !Number.isInteger(index) ||
        index < 0 ||
        index >= secretArchive.length
    ) {
        return res.status(404).send(
            'Archive item not found'
        );
    }

    res.type('text/plain').send(
        secretArchive[index].content
    );
});

// ============================================================
// SUBTITLE FETCHING
// ============================================================

async function handleSubtitles(req, res) {
    const type =
        req.params.type;

    const id =
        req.params.id;

    const extra =
        req.params.extra || '';

    const params =
        new URLSearchParams(extra);

    let targetUrl =
        params.get('url') ||
        req.query.url ||
        req.query.targetUrl;

    if (!targetUrl) {
        return res.json({
            subtitles: []
        });
    }

    targetUrl =
        decodeURIComponent(targetUrl);

    try {
        const response =
            await axios.get(
                targetUrl,
                {
                    headers: {
                        'User-Agent':
                            BROWSER_USER_AGENT
                    },
                    timeout: 30000,
                    responseType: 'text'
                }
            );

        const subtitles =
            parseSrt(
                String(response.data || '')
            );

        const result =
            subtitles.map(item => ({
                id:
                    `${id}-${item.id}`,
                url:
                    `${req.protocol}://${req.get('host')}` +
                    `/${req.params.configData || ''}/translate` +
                    `?id=${encodeURIComponent(id)}` +
                    `&targetUrl=${encodeURIComponent(targetUrl)}`,
                lang: 'ron',
                name: 'Română',
                format: 'srt'
            }));

        if (!result.length) {
            return res.json({
                subtitles: []
            });
        }

        res.json({
            subtitles: [
                {
                    id:
                        `${id}-translated`,
                    url:
                        `${req.protocol}://${req.get('host')}` +
                        `/${req.params.configData}/translate` +
                        `?id=${encodeURIComponent(id)}` +
                        `&targetUrl=${encodeURIComponent(targetUrl)}`,
                    lang: 'ron',
                    name: 'Română',
                    format: 'srt'
                }
            ]
        });

    } catch (error) {
        console.error(
            `${c.red}Subtitle fetch error:${c.reset}`,
            error.message
        );

        if (!res.headersSent) {
            res.json({
                subtitles: []
            });
        }
    }
}

// ============================================================
// SUBTITLE METADATA
// ============================================================

function subtitleScore(item) {
    const name =
        String(
            item?.name ||
            item?.label ||
            ''
        ).toLowerCase();

    let score = 0;

    if (
        name.includes('english') ||
        name.includes('eng')
    ) {
        score += 50;
    }

    if (
        name.includes('forced')
    ) {
        score -= 10;
    }

    if (
        name.includes('sdh') ||
        name.includes('hearing')
    ) {
        score -= 5;
    }

    return score;
}

// ============================================================
// SUBTITLE ROUTES
// ============================================================

app.get(
    '/:configData/subtitles/:type/:id/:extra?.json',
    handleSubtitles
);

app.get(
    '/:configData/subtitles/:type/:id.json',
    handleSubtitles
);

// ============================================================
// TRANSLATION ROUTE
// ============================================================

app.get(
    '/:configData/translate',
    async (req, res) => {

        const imdbId =
            req.query.id;

        const targetUrl =
            req.query.targetUrl;

        const configData =
            req.params.configData;

        if (!targetUrl) {
            return res.status(400).send(
                'Lipsă URL sursă.'
            );
        }

        let userKeys = [];

        try {
            const decoded =
                Buffer
                    .from(
                        configData,
                        'base64'
                    )
                    .toString('utf8');

            userKeys =
                JSON.parse(decoded);

        } catch (e) {
            return res.status(400).send(
                'Configurare invalidă. Instalează addon-ul din nou.'
            );
        }

        if (!Array.isArray(userKeys)) {
            userKeys = [];
        }

        userKeys =
            userKeys
                .map(k =>
                    String(k).trim()
                )
                .filter(Boolean);

        if (!userKeys.length) {
            return res.status(400).send(
                'Nu există chei Gemini configurate.'
            );
        }

        const cacheKey =
            targetUrl;

        if (
            memoryCache[cacheKey] &&
            typeof memoryCache[cacheKey] === 'string'
        ) {
            res.setHeader(
                'Content-Type',
                'application/x-subrip; charset=utf-8'
            );

            return res.send(
                memoryCache[cacheKey]
            );
        }

        try {

            let processPromise;

            if (
                memoryCache[cacheKey] &&
                typeof memoryCache[cacheKey] !== 'string'
            ) {
                processPromise =
                    memoryCache[cacheKey];

            } else {

                const startTime =
                    Date.now();

                processPromise =
                    (async () => {

                        const srtRes =
                            await axios.get(
                                targetUrl,
                                {
                                    headers: {
                                        'User-Agent':
                                            BROWSER_USER_AGENT
                                    },
                                    timeout: 30000,
                                    responseType: 'text'
                                }
                            );

                        const totalLinesCount =
                            (
                                String(
                                    srtRes.data || ''
                                )
                                    .match(/-->/g) ||
                                []
                            ).length;

                        console.log(
                            `${c.cyan}\n==================================================${c.reset}`
                        );

                        console.log(
                            `${c.magenta}▶ ÎNCEPE PROCESAREA PENTRU: ${imdbId}${c.reset}`
                        );

                        console.log(
                            `${c.magenta}📑 Total linii de tradus: ${totalLinesCount}${c.reset}`
                        );

                        console.log(
                            `${c.cyan}==================================================\n${c.reset}`
                        );

                        return await translateSrtWithGemini(
                            String(
                                srtRes.data || ''
                            ),
                            userKeys
                        );
                    })();

                memoryCache[cacheKey] =
                    processPromise;

                cleanMemoryCache();

                processPromise
                    .then(
                        translatedSrtString => {

                            memoryCache[cacheKey] =
                                translatedSrtString;

                            cleanMemoryCache();

                            const durationSeconds =
                                Math.floor(
                                    (
                                        Date.now() -
                                        startTime
                                    ) / 1000
                                );

                            const timeFormatted =
                                durationSeconds < 60
                                    ? `${durationSeconds} sec`
                                    : `${Math.floor(
                                        durationSeconds / 60
                                    )} min și ${
                                        durationSeconds % 60
                                    } sec`;

                            console.log(
                                `${c.green}\n✔ PROCESARE FINALIZATĂ CU SUCCES PENTRU: ${imdbId}${c.reset}`
                            );

                            console.log(
                                `${c.green}⏱ Timp total de traducere: ${timeFormatted}${c.reset}`
                            );

                            console.log(
                                `${c.cyan}==================================================\n${c.reset}`
                            );
                        }
                    )
                    .catch(
                        err => {

                            console.log(
                                `${c.red}✖ EROARE PROCESARE PENTRU: ${imdbId} - ${err.message}${c.reset}`
                            );

                            delete memoryCache[
                                cacheKey
                            ];
                        }
                    );
            }

            const finalSrt =
                await processPromise;

            if (
                finalSrt &&
                finalSrt.trim().length > 0
            ) {

                const now =
                    new Date();

                const timeStr =
                    now.toLocaleTimeString(
                        'ro-RO'
                    ) +
                    ' ' +
                    now.toLocaleDateString(
                        'ro-RO'
                    );

                secretArchive.unshift({
                    id: imdbId,
                    time: timeStr,
                    content: finalSrt
                });

                if (
                    secretArchive.length > 10
                ) {
                    secretArchive.pop();
                }
            }

            res.setHeader(
                'Content-Type',
                'application/x-subrip; charset=utf-8'
            );

            res.setHeader(
                'Content-Disposition',
                'inline; filename="romanian.srt"'
            );

            return res.send(
                finalSrt
            );

        } catch (error) {

            console.error(
                'Translation error:',
                error.message
            );

            if (!res.headersSent) {
                return res
                    .status(500)
                    .send(
                        'Translation failed: ' +
                        error.message
                    );
            }

            return res.end();
        }
    }
);

// ============================================================
// MASTER CINEMATIC TRANSLATION PROMPT
// ============================================================

const MASTER_TRANSLATION_PROMPT = `
You are a professional cinematic subtitle translator.

Your task is to translate English subtitles into natural,
high-quality Romanian.

This is NOT a literal machine translation task.

The final Romanian subtitles must sound as if they were
originally written by a professional Romanian subtitler.

============================================================
1. ABSOLUTE PRIORITY
============================================================

Preserve:

- exact meaning
- context
- intention
- emotion
- character personality
- relationships
- register
- sarcasm
- irony
- humor
- subtext
- tension
- dramatic impact
- vulgarity level
- slang
- terminology
- names
- pronouns
- continuity

Do NOT invent information.

Do NOT add explanations.

Do NOT remove meaningful information.

Do NOT hallucinate.

If an expression is ambiguous, use the surrounding context
to determine the most plausible meaning.

Never invent a meaning simply because a word has several
possible dictionary translations.

============================================================
2. CINEMATIC ROMANIAN
============================================================

Romanian must sound natural when spoken by an actor.

Avoid:

- word-for-word English structures
- English syntax copied into Romanian
- awkward literal translations
- dictionary-like phrasing
- robotic language
- unnatural repetitions
- unnecessary formal language
- unnatural calques

Prefer:

- idiomatic Romanian
- conversational Romanian
- concise spoken phrasing
- natural rhythm
- natural word order
- appropriate Romanian punctuation

The translation should feel like dialogue,
not like a translated document.

============================================================
3. CONTEXT
============================================================

You receive contextual subtitle lines.

Use them.

The current subtitle may depend on:

- previous sentence
- following sentence
- speaker relationship
- previous terminology
- ongoing joke
- scene
- emotional state
- pronoun/register
- implied subject

Do not translate isolated words blindly.

If a sentence continues across subtitle boundaries,
maintain grammatical continuity.

============================================================
4. CHARACTER VOICE
============================================================

Different characters speak differently.

Preserve:

- educated vs uneducated speech
- formal vs informal speech
- aggressive speech
- polite speech
- sarcastic speech
- childish speech
- military speech
- scientific speech
- criminal slang
- street language
- aristocratic language
- professional terminology

Do not make every character sound identical.

============================================================
5. PRONOUNS AND REGISTER
============================================================

Respect:

- tu
- voi
- dumneavoastră

Do not change register randomly.

If the relationship indicates intimacy,
use natural informal Romanian.

If the relationship indicates distance,
authority, respect or hostility,
preserve that distinction.

============================================================
6. SARCASM / IRONY / HUMOR
============================================================

Translate the intended effect.

Do NOT translate sarcasm literally if that destroys
the joke or meaning.

Preserve:

- irony
- dry humor
- dark humor
- wordplay
- understatement
- exaggeration

The Romanian version should communicate the same intent.

============================================================
7. IDIOMS
============================================================

English idioms should normally be translated into
natural Romanian equivalents.

Do not blindly translate the individual words.

Example:

"Break a leg."

Do NOT translate literally.

Use a Romanian expression with the same function
when context allows it.

============================================================
8. SLANG / VULGARITY
============================================================

Preserve the original intensity.

Do not sanitize profanity unless required by context.

Do not make profanity stronger than the original.

Do not turn normal speech into vulgar speech.

Maintain the character's voice.

============================================================
9. NAMES / PLACES / TECHNICAL TERMS
============================================================

Never translate personal names.

Do not randomly modify:

- names
- surnames
- organizations
- brands
- locations
- scientific terms
- military terms
- technical terminology

Use established Romanian forms where clearly appropriate.

============================================================
10. NUMBERS / DATES / MEASUREMENTS
============================================================

Preserve factual values exactly.

Do not invent or alter:

- numbers
- dates
- percentages
- times
- measurements
- addresses
- coordinates

Localize formatting naturally when appropriate,
but never change the underlying value.

============================================================
11. SUBTITLE STYLE
============================================================

Keep subtitles concise.

Avoid unnecessary repetition.

Do not add explanations.

Do not add quotation marks unless required.

Do not add speaker names unless present in source.

Do not add stage directions that are not in source.

Maximum two lines per subtitle.

Use natural line breaks.

Never cut a word.

Never create malformed words.

============================================================
12. CRITICAL ANTI-CORRUPTION RULE
============================================================

Never output:

- truncated words
- isolated fragments
- accidental single letters
- corrupted Unicode
- replacement characters
- broken Romanian words
- random English fragments
- duplicated words caused by chunk boundaries

Examples of unacceptable corruption:

"v poate oferi mult mai multe."

"M puneți să fiu urmărit?"

"Alunec disear."

"țais."

"Adâncule."

These indicate translation corruption and must NEVER appear.

============================================================
13. JSON OUTPUT
============================================================

Return ONLY valid JSON.

No markdown.

No code fences.

No explanation.

No commentary.

Required structure:

{
  "translations": [
    {
      "id": 1,
      "text": "..."
    }
  ]
}

The number of translated items MUST exactly match
the number of input items.

Every input id MUST appear exactly once.

Do not change ids.

============================================================
14. FEW-SHOT EXAMPLES
============================================================

Example 1:

English:
"I don't know what you're talking about."

Natural Romanian:
"Nu știu despre ce vorbești."

NOT:
"Nu știu despre ce vorbești tu vorbind."

------------------------------------------------------------

Example 2:

English:
"Are you kidding me?"

Natural Romanian:
"Vorbești serios?"

Depending on context:
"Glumești?"

------------------------------------------------------------

Example 3:

English:
"Get the hell out of here."

Natural Romanian:
"Șterge-o de aici."

Depending on character:
"Dispari naibii de aici."

------------------------------------------------------------

Example 4:

English:
"You've got to be kidding."

Natural Romanian:
"Nu se poate."

or:

"Glumești."

depending on emotional context.

------------------------------------------------------------

Example 5:

English:
"That was a close call."

Natural Romanian:
"A fost cât pe ce."

------------------------------------------------------------

Example 6:

English:
"I thought you were dead."

Natural Romanian:
"Credeam că ești mort."

------------------------------------------------------------

Example 7:

English:
"Well, that's just great."

If sarcastic:

"Minunat."

NOT:

"Ei bine, asta este foarte grozav."

------------------------------------------------------------

Example 8:

English:
"Don't push your luck."

Natural Romanian:
"Nu-ți forța norocul."

------------------------------------------------------------

Example 9:

English:
"You really screwed this up."

Natural Romanian:
"Chiar ai dat-o în bară."

------------------------------------------------------------

Example 10:

English:
"What's your problem?"

Natural Romanian:
"Care-i problema ta?"

Depending on tone:

"Ce naiba ai?"

============================================================
15. FINAL SILENT QUALITY CHECK
============================================================

Before returning JSON, silently verify:

1. Every input subtitle has exactly one translation.
2. Every id is preserved.
3. No subtitle is missing.
4. No subtitle is duplicated.
5. No meaning was invented.
6. No important meaning was removed.
7. Romanian sounds natural.
8. Pronouns/register are consistent.
9. Character voice is preserved.
10. Sarcasm and irony are preserved.
11. Idioms are natural.
12. Slang/profanity intensity is preserved.
13. Names and terminology are preserved.
14. Numbers and factual data are unchanged.
15. No word is truncated.
16. No malformed Romanian appears.
17. No replacement character appears.
18. No commentary is included outside JSON.
19. JSON is valid.
20. The output count exactly matches the input count.

Return ONLY the JSON object.
`;

// ============================================================
// HELPERS
// ============================================================

function sleep(ms) {
    return new Promise(
        resolve => setTimeout(resolve, ms)
    );
}

function chunkArray(
    array,
    size
) {
    const chunks = [];

    for (
        let i = 0;
        i < array.length;
        i += size
    ) {
        chunks.push(
            array.slice(
                i,
                i + size
            )
        );
    }

    return chunks;
}

function cleanTextForJson(text) {
    return String(text || '')
        .replace(/\r/g, '')
        .trim();
}

function buildContextItems(
    items,
    start,
    end
) {
    return items.slice(
        Math.max(0, start),
        Math.min(
            items.length,
            end
        )
    );
}

// ============================================================
// TRANSLATION PROMPT BUILDER
// ============================================================

function buildTranslationPrompt(
    chunk,
    allItems,
    chunkStart,
    chunkEnd,
    previousTranslatedContext
) {

    const contextBefore =
        buildContextItems(
            allItems,
            chunkStart -
                CONTEXT_LINES_BEFORE,
            chunkStart
        );

    const contextAfter =
        buildContextItems(
            allItems,
            chunkEnd,
            chunkEnd +
                CONTEXT_LINES_AFTER
        );

    const contextBeforeText =
        contextBefore.length
            ? contextBefore
                .map(
                    item =>
                        `[${item.id}] ${item.text}`
                )
                .join('\n')
            : '(none)';

    const contextAfterText =
        contextAfter.length
            ? contextAfter
                .map(
                    item =>
                        `[${item.id}] ${item.text}`
                )
                .join('\n')
            : '(none)';

    const previousRomanian =
        previousTranslatedContext &&
        previousTranslatedContext.length
            ? previousTranslatedContext
                .map(
                    item =>
                        `[${item.id}] ${item.text}`
                )
                .join('\n')
            : '(none)';

    const subtitles =
        chunk
            .map(
                item =>
                    `[${item.id}] ${item.text}`
            )
            .join('\n');

    return `
${MASTER_TRANSLATION_PROMPT}

============================================================
CURRENT CHUNK
============================================================

Translate ONLY the following subtitle items:

${subtitles}

============================================================
SOURCE CONTEXT BEFORE CURRENT CHUNK
============================================================

${contextBeforeText}

============================================================
SOURCE CONTEXT AFTER CURRENT CHUNK
============================================================

${contextAfterText}

============================================================
PREVIOUS ROMANIAN TRANSLATION CONTEXT
============================================================

Use this only for continuity and terminology consistency.
Do NOT copy it blindly.

${previousRomanian}

============================================================
IMPORTANT
============================================================

Return exactly one translation for every subtitle id
in the CURRENT CHUNK.

Do not translate the context lines as additional items.

Return ONLY JSON.
`;
}

// ============================================================
// JSON PARSER
// ============================================================

function parseStrictTranslationResponse(
    raw
) {
    if (
        typeof raw !== 'string'
    ) {
        throw new Error(
            'Gemini response is not text'
        );
    }

    let text =
        raw.trim();

    text =
        text
            .replace(
                /^```json\s*/i,
                ''
            )
            .replace(
                /^```\s*/i,
                ''
            )
            .replace(
                /\s*```$/i,
                ''
            )
            .trim();

    let parsed;

    try {
        parsed =
            JSON.parse(text);
    } catch (firstError) {

        const start =
            text.indexOf('{');

        const end =
            text.lastIndexOf('}');

        if (
            start >= 0 &&
            end > start
        ) {
            parsed =
                JSON.parse(
                    text.slice(
                        start,
                        end + 1
                    )
                );
        } else {
            throw firstError;
        }
    }

    if (
        !parsed ||
        !Array.isArray(
            parsed.translations
        )
    ) {
        throw new Error(
            'JSON fără translations[]'
        );
    }

    return parsed.translations;
}

// ============================================================
// NORMALIZATION
// ============================================================

function normalizeSubtitleOutput(
    text
) {
    if (
        typeof text !== 'string'
    ) {
        return '';
    }

    return text
        .replace(/\r/g, '')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n')
        .trim();
}

// ============================================================
// SUBTITLE WRAPPING
// ============================================================

function wrapSubtitleText(
    text,
    maxChars = 45
) {
    const normalized =
        normalizeSubtitleOutput(text);

    if (!normalized) {
        return normalized;
    }

    const existing =
        normalized
            .split(/\n+/)
            .map(
                line =>
                    line.trim()
            )
            .filter(Boolean);

    // Never delete translated content.
    // Preserve good existing lines.
    if (
        existing.length <= 2 &&
        existing.every(
            line =>
                line.length <=
                maxChars
        )
    ) {
        return existing.join('\n');
    }

    const words =
        existing
            .join(' ')
            .split(/\s+/)
            .filter(Boolean);

    if (
        words.length < 2
    ) {
        return normalized;
    }

    // Reflow to two lines without
    // dropping any words.
    let best = 1;
    let bestScore =
        Infinity;

    for (
        let i = 1;
        i < words.length;
        i++
    ) {
        const left =
            words
                .slice(0, i)
                .join(' ');

        const right =
            words
                .slice(i)
                .join(' ');

        const overflow =
            Math.max(
                0,
                left.length -
                    maxChars
            ) +
            Math.max(
                0,
                right.length -
                    maxChars
            );

        const balance =
            Math.abs(
                left.length -
                right.length
            );

        const punctuationBonus =
            /[,:;!?]$/.test(
                left
            )
                ? -8
                : 0;

        const score =
            overflow * 1000 +
            balance +
            punctuationBonus;

        if (
            score < bestScore
        ) {
            bestScore =
                score;

            best = i;
        }
    }

    return (
        words
            .slice(0, best)
            .join(' ') +
        '\n' +
        words
            .slice(best)
            .join(' ')
    );
}

// ============================================================
// QUALITY GATE
// ============================================================

function findTranslationQualityIssue(
    text
) {
    if (
        typeof text !== 'string' ||
        !text.trim()
    ) {
        return 'traducere goală';
    }

    const value =
        text.trim();

    if (
        value.includes(' ')
    ) {
        return 'caracter Unicode corupt ( )';
    }

    // Common signs of truncation/corruption.
    if (
        /(^|\s)[mMvV](\s|$)/.test(
            value
        )
    ) {
        return 'fragment suspect de un singur caracter';
    }

    if (
        /\b(Adâncule|țais|disear)\b/i.test(
            value
        )
    ) {
        return 'fragment românesc suspect';
    }

    if (
        /\bglisare\b/i.test(
            value
        )
    ) {
        return 'traducere suspectă pentru dialog';
    }

    return null;
}

function validateTranslationQuality(
    sourceItems,
    translations
) {
    if (
        translations.length !==
        sourceItems.length
    ) {
        throw new Error(
            `Număr traduceri invalid: ${translations.length}/${sourceItems.length}`
        );
    }

    const expectedIds =
        new Set(
            sourceItems.map(
                item =>
                    String(item.id)
            )
        );

    const seen =
        new Set();

    for (
        const item of translations
    ) {
        if (
            !item ||
            item.id === undefined
        ) {
            throw new Error(
                'Traducere fără id'
            );
        }

        const id =
            String(item.id);

        if (
            !expectedIds.has(id)
        ) {
            throw new Error(
                `ID neașteptat: ${id}`
            );
        }

        if (
            seen.has(id)
        ) {
            throw new Error(
                `ID duplicat: ${id}`
            );
        }

        seen.add(id);

        const issue =
            findTranslationQualityIssue(
                item.text
            );

        if (issue) {
            throw new Error(
                `Calitate slabă la ID ${id}: ${issue}`
            );
        }
    }

    if (
        seen.size !==
        expectedIds.size
    ) {
        throw new Error(
            'Lipsesc traduceri'
        );
    }
}

// ============================================================
// API KEY STATE
// ============================================================

function createKeyState(
    keys
) {
    return keys.map(
        key => ({
            key,
            pausedUntil: 0,
            disabled: false,
            failures: 0,
            lastUsed: 0
        })
    );
}

async function getAvailableKey(
    keyStates
) {
    while (true) {

        const now =
            Date.now();

        const available =
            keyStates
                .filter(
                    state =>
                        !state.disabled &&
                        state.pausedUntil <=
                            now
                )
                .sort(
                    (a, b) =>
                        a.lastUsed -
                        b.lastUsed
                );

        if (available.length) {

            const state =
                available[0];

            state.lastUsed =
                Date.now();

            return state;
        }

        const waits =
            keyStates
                .filter(
                    state =>
                        !state.disabled &&
                        state.pausedUntil >
                            now
                )
                .map(
                    state =>
                        state.pausedUntil -
                        now
                );

        if (!waits.length) {
            throw new Error(
                'Toate cheile Gemini sunt dezactivate.'
            );
        }

        const waitMs =
            Math.max(
                250,
                Math.min(
                    ...waits
                )
            );

        console.log(
            `${c.yellow}⏳ Toate cheile sunt ocupate/în pauză. Aștept ${waitMs} ms.${c.reset}`
        );

        await sleep(
            waitMs
        );
    }
}

// ============================================================
// GEMINI CALL
// ============================================================

async function callGemini(
    prompt,
    keyState
) {

    const endpoint =
        `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME}:generateContent`;

    const maxAttempts = 8;

    let lastError =
        null;

    for (
        let attempt = 1;
        attempt <= maxAttempts;
        attempt++
    ) {

        try {

            const response =
                await axios.post(
                    endpoint,
                    {
                        contents: [
                            {
                                role: 'user',
                                parts: [
                                    {
                                        text: prompt
                                    }
                                ]
                            }
                        ],

                        generationConfig: {
                            temperature: 0.0,
                            responseMimeType:
                                'application/json'
                        },

                        safetySettings: [
                            {
                                category:
                                    'HARM_CATEGORY_HARASSMENT',
                                threshold:
                                    'BLOCK_NONE'
                            },
                            {
                                category:
                                    'HARM_CATEGORY_HATE_SPEECH',
                                threshold:
                                    'BLOCK_NONE'
                            },
                            {
                                category:
                                    'HARM_CATEGORY_SEXUALLY_EXPLICIT',
                                threshold:
                                    'BLOCK_NONE'
                            },
                            {
                                category:
                                    'HARM_CATEGORY_DANGEROUS_CONTENT',
                                threshold:
                                    'BLOCK_NONE'
                            }
                        ]
                    },
                    {
                        params: {
                            key:
                                keyState.key
                        },
                        timeout:
                            120000,
                        headers: {
                            'Content-Type':
                                'application/json'
                        }
                    }
                );

            const candidate =
                response.data
                    ?.candidates?.[0];

            const parts =
                candidate
                    ?.content?.parts ||
                [];

            const raw =
                parts
                    .map(
                        part =>
                            part.text ||
                            ''
                    )
                    .join('');

            if (
                !raw.trim()
            ) {
                throw new Error(
                    'Gemini a returnat conținut gol.'
                );
            }

            keyState.failures = 0;

            return raw;

        } catch (error) {

            lastError =
                error;

            const status =
                error.response?.status;

            const code =
                error.code;

            console.error(
                `${c.yellow}Gemini attempt ${attempt}/${maxAttempts} | status=${status || '-'} | code=${code || '-'} | key=...${keyState.key.slice(-4)}${c.reset}`
            );

            // Unauthorized / invalid key.
            if (
                status === 401 ||
                status === 403
            ) {
                keyState.disabled =
                    true;

                keyState.failures++;

                throw new Error(
                    `Cheie Gemini invalidă sau fără acces (${status}).`
                );
            }

            // Rate limit.
            if (
                status === 429
            ) {
                keyState.pausedUntil =
                    Date.now() +
                    61000;

                keyState.failures++;

                if (
                    attempt <
                    maxAttempts
                ) {
                    await sleep(
                        1500
                    );
                    continue;
                }
            }

            // Temporary server errors.
            if (
                status === 500 ||
                status === 502 ||
                status === 503 ||
                status === 504 ||
                code ===
                    'ECONNABORTED' ||
                code ===
                    'ETIMEDOUT'
            ) {
                keyState.failures++;

                if (
                    attempt <
                    maxAttempts
                ) {
                    const delay =
                        Math.min(
                            10000,
                            1000 *
                            Math.pow(
                                2,
                                attempt - 1
                            )
                        );

                    await sleep(
                        delay
                    );

                    continue;
                }
            }

            // Any other transient failure.
            if (
                attempt <
                maxAttempts
            ) {
                await sleep(
                    1200
                );

                continue;
            }
        }
    }

    throw (
        lastError ||
        new Error(
            'Gemini request failed.'
        )
    );
}

// ============================================================
// PROCESS CHUNK WITH RETRY
// ============================================================

async function processChunkWithRetry(
    chunk,
    allItems,
    chunkStart,
    chunkEnd,
    previousTranslatedContext,
    keyStates,
    depth = 0
) {

    const prompt =
        buildTranslationPrompt(
            chunk,
            allItems,
            chunkStart,
            chunkEnd,
            previousTranslatedContext
        );

    const maxLocalAttempts = 3;

    let lastError =
        null;

    for (
        let attempt = 1;
        attempt <=
            maxLocalAttempts;
        attempt++
    ) {

        let keyState = null;

        try {

            keyState =
                await getAvailableKey(
                    keyStates
                );

            const raw =
                await callGemini(
                    prompt,
                    keyState
                );

            const translations =
                parseStrictTranslationResponse(
                    raw
                );

            validateTranslationQuality(
                chunk,
                translations
            );

            const normalized =
                translations.map(
                    item => ({
                        id:
                            Number(
                                item.id
                            ),
                        text:
                            wrapSubtitleText(
                                normalizeSubtitleOutput(
                                    item.text
                                )
                            )
                    })
                );

            return normalized;

        } catch (error) {

            lastError =
                error;

            console.error(
                `${c.yellow}Chunk ${chunk[0]?.id}-${chunk[chunk.length - 1]?.id} attempt ${attempt}/${maxLocalAttempts}: ${error.message}${c.reset}`
            );

            if (
                keyState &&
                !keyState.disabled
            ) {
                keyState.failures++;
            }

            await sleep(
                700 *
                attempt
            );
        }
    }

    // If a large chunk repeatedly fails,
    // split it into two smaller chunks.
    if (
        chunk.length > 20 &&
        depth < 2
    ) {

        const middle =
            Math.floor(
                chunk.length / 2
            );

        const first =
            chunk.slice(
                0,
                middle
            );

        const second =
            chunk.slice(
                middle
            );

        const firstStart =
            chunkStart;

        const secondStart =
            chunkStart +
            middle;

        const firstEnd =
            secondStart;

        const secondEnd =
            chunkEnd;

        console.log(
            `${c.yellow}⚠️ Chunk mare eșuat. Îl împart în ${first.length} + ${second.length}.${c.reset}`
        );

        const firstResult =
            await processChunkWithRetry(
                first,
                allItems,
                firstStart,
                firstEnd,
                previousTranslatedContext,
                keyStates,
                depth + 1
            );

        const secondContext =
            firstResult.slice(
                -PREVIOUS_TRANSLATION_CONTEXT
            );

        const secondResult =
            await processChunkWithRetry(
                second,
                allItems,
                secondStart,
                secondEnd,
                secondContext,
                keyStates,
                depth + 1
            );

        return [
            ...firstResult,
            ...secondResult
        ];
    }

    throw (
        lastError ||
        new Error(
            'Chunk translation failed.'
        )
    );
}

// ============================================================
// MAIN TRANSLATION ENGINE
// ============================================================

async function translateSrtWithGemini(
    srtText,
    apiKeys
) {

    const items =
        parseSrt(srtText);

    if (!items.length) {
        throw new Error(
            'Nu s-au găsit subtitrări valide.'
        );
    }

    const cleanKeys =
        Array.from(
            new Set(
                apiKeys
                    .map(
                        key =>
                            String(key)
                                .trim()
                    )
                    .filter(Boolean)
            )
        );

    if (!cleanKeys.length) {
        throw new Error(
            'Nu există chei Gemini valide.'
        );
    }

    const keyStates =
        createKeyState(
            cleanKeys
        );

    const chunks =
        chunkArray(
            items,
            CHUNK_SIZE
        );

    console.log(
        `${c.cyan}📦 Total chunk-uri: ${chunks.length} | ${c.cyan}Chunk size: ${CHUNK_SIZE} | Paralel: ${CONCURRENCY_LIMIT}${c.reset}`
    );

    const translatedById =
        Object.create(null);

    let previousTranslatedContext =
        [];

    for (
        let batchStart = 0;
        batchStart <
            chunks.length;
        batchStart +=
            CONCURRENCY_LIMIT
    ) {

        const batch =
            chunks.slice(
                batchStart,
                batchStart +
                    CONCURRENCY_LIMIT
            );

        console.log(
            `${c.blue}⚡ Batch ${
                Math.floor(
                    batchStart /
                    CONCURRENCY_LIMIT
                ) + 1
            }/${Math.ceil(
                chunks.length /
                CONCURRENCY_LIMIT
            )} — ${batch.length} chunk-uri în paralel${c.reset}`
        );

        const promises =
            batch.map(
                async (
                    chunk,
                    localIndex
                ) => {

                    const globalIndex =
                        batchStart +
                        localIndex;

                    const start =
                        globalIndex *
                        CHUNK_SIZE;

                    const end =
                        start +
                        chunk.length;

                    // Small stagger prevents
                    // all keys from hitting
                    // Gemini at exactly the
                    // same millisecond.
                    if (
                        localIndex > 0
                    ) {
                        await sleep(
                            900 *
                            localIndex
                        );
                    }

                    console.log(
                        `${c.magenta}▶ Chunk ${globalIndex + 1}/${chunks.length}: IDs ${chunk[0].id}-${chunk[chunk.length - 1].id}${c.reset}`
                    );

                    const result =
                        await processChunkWithRetry(
                            chunk,
                            items,
                            start,
                            end,
                            previousTranslatedContext,
                            keyStates
                        );

                    console.log(
                        `${c.green}✔ Chunk ${globalIndex + 1}/${chunks.length} terminat${c.reset}`
                    );

                    return {
                        globalIndex,
                        result
                    };
                }
            );

        const results =
            await Promise.all(
                promises
            );

        results.sort(
            (a, b) =>
                a.globalIndex -
                b.globalIndex
        );

        for (
            const batchResult of
                results
        ) {

            for (
                const item of
                    batchResult.result
            ) {
                translatedById[
                    String(item.id)
                ] =
                    item.text;
            }
        }

        // Keep Romanian context from
        // the last completed chunk of
        // this batch for continuity
        // in the next batch.
        const lastResult =
            results[
                results.length - 1
            ];

        if (
            lastResult &&
            lastResult.result
        ) {
            previousTranslatedContext =
                lastResult.result.slice(
                    -PREVIOUS_TRANSLATION_CONTEXT
                );
        }
    }

    // ========================================================
    // FINAL INTEGRITY PASS
    // ========================================================

    for (
        const item of items
    ) {

        const translated =
            translatedById[
                String(item.id)
            ];

        if (
            translated === undefined
        ) {
            throw new Error(
                `Lipsește traducerea pentru ID ${item.id}`
            );
        }

        const issue =
            findTranslationQualityIssue(
                translated
            );

        if (issue) {
            throw new Error(
                `Integritate finală eșuată la ID ${item.id}: ${issue}`
            );
        }
    }

    // ========================================================
    // RECONSTRUCT SRT
    // ========================================================

    const output =
        items
            .map(
                item => {

                    const translated =
                        translatedById[
                            String(item.id)
                        ];

                    return (
                        `${item.id}\n` +
                        `${item.start} --> ${item.end}\n` +
                        `${translated}\n`
                    );
                }
            )
            .join('\n');

    return output.trim() + '\n';
}

// ============================================================
// SRT PARSER
// ============================================================

function parseSrt(
    srt
) {

    const normalized =
        String(srt || '')
            .replace(/\r/g, '')
            .replace(
                /^\uFEFF/,
                ''
            );

    const blocks =
        normalized
            .split(/\n{2,}/);

    const result = [];

    for (
        const block of blocks
    ) {

        const lines =
            block
                .split('\n')
                .map(
                    line =>
                        line.trimEnd()
                );

        if (
            lines.length < 3
        ) {
            continue;
        }

        const id =
            Number(
                lines[0].trim()
            );

        if (
            !Number.isInteger(id)
        ) {
            continue;
        }

        const timing =
            lines[1].trim();

        const match =
            timing.match(
                /^(\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2},\d{3})(?:.*)?$/
            );

        if (!match) {
            continue;
        }

        const text =
            lines
                .slice(2)
                .join('\n')
                .trim();

        if (!text) {
            continue;
        }

        result.push({
            id,
            start:
                match[1],
            end:
                match[2],
            text
        });
    }

    return result;
}

// ============================================================
// HEALTH
// ============================================================

app.get(
    '/health',
    (req, res) => {
        res.json({
            ok: true,
            service:
                'RO Sub Translator',
            model:
                MODEL_NAME,
            chunkSize:
                CHUNK_SIZE,
            concurrency:
                CONCURRENCY_LIMIT,
            timestamp:
                new Date().toISOString()
        });
    }
);

// ============================================================
// START SERVER
// ============================================================

const PORT =
    Number(
        process.env.PORT
    ) || 7000;

app.listen(
    PORT,
    '0.0.0.0',
    () => {

        console.log(
            `${c.green}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}`
        );

        console.log(
            `${c.green}🚀 RO Sub Translator pornit${c.reset}`
        );

        console.log(
            `${c.green}🌐 Port: ${PORT}${c.reset}`
        );

        console.log(
            `${c.green}🤖 Model: ${MODEL_NAME}${c.reset}`
        );

        console.log(
            `${c.green}📦 Chunk: ${CHUNK_SIZE} linii${c.reset}`
        );

        console.log(
            `${c.green}⚡ Paralelism: ${CONCURRENCY_LIMIT} chunk-uri${c.reset}`
        );

        console.log(
            `${c.green}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}`
        );
    }
);
