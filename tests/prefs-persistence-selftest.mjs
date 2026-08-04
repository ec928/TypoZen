/**
 * Self-test: preference persistence must survive a full localStorage.
 *
 * Regression guarded: savePreferences used to call localStorage.setItem BEFORE
 * postMsg inside one shared try/catch. localStorage has a ~5 MB quota, so on a large
 * document setItem threw, the catch swallowed it, and the host never received
 * save_prefs again — theme, mode, margins and the unsaved-work scratchpad silently
 * stopped persisting, with no error anywhere.
 *
 * node tests/prefs-persistence-selftest.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(__dirname, '..', 'TypoZen_Template_Test.html'), 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
const mainScript = scripts.sort((a, b) => b.length - a.length)[0];
if (!mainScript || mainScript.length < 10000) {
    console.error('FAIL: could not extract main editor script from template');
    process.exit(1);
}

function extractFunction(name) {
    const startRe = new RegExp(`function\\s+${name}\\s*\\(`);
    const idx = mainScript.search(startRe);
    if (idx < 0) throw new Error('missing function ' + name);
    let i = mainScript.indexOf('{', idx);
    let depth = 0;
    for (; i < mainScript.length; i++) {
        const c = mainScript[i];
        if (c === '{') depth++;
        else if (c === '}' && --depth === 0) return mainScript.slice(idx, i + 1);
    }
    throw new Error('unclosed function ' + name);
}

const src = extractFunction('savePreferences');

/** Run the real savePreferences against stubbed globals. */
function run(opts) {
    const posted = [];
    const stored = {};
    const localStorage = {
        setItem(k, v) {
            if (opts.quotaBytes != null && v.length > opts.quotaBytes) {
                const err = new Error('QuotaExceededError');
                err.name = 'QuotaExceededError';
                throw err;
            }
            stored[k] = v;
        },
        getItem(k) { return Object.prototype.hasOwnProperty.call(stored, k) ? stored[k] : null; }
    };
    const factory = new Function(
        'isRestoring', 'scheduleSavePreferences', 'window', 'state', 'sidebar',
        'getMarkdownContent', 'localStorage', 'postMsg', '_contentCache',
        src + '\nreturn savePreferences;'
    );
    const savePreferences = factory(
        false,
        function () {},
        { allThemes: [{ Name: 'Modern Dark' }] },
        {
            themeIndex: 0, themeName: 'Modern Dark', mode: 'wysiwyg', margin: 'regular',
            lastFilePath: 'C:\\doc.md',
            // Privacy switch (File > Privacy). Off means no copy of the document goes into
            // settings.json or localStorage. Tests opt in explicitly where they need it.
            persistContent: opts.persistContent !== false
        },
        { classList: { contains: function () { return false; } } },
        function () { return opts.content; },
        localStorage,
        function (m) { posted.push(m); },
        // Cache of the last serialize. null forces savePreferences to serialize itself,
        // which is the path we want under test; the cached path is covered separately.
        opts.contentCache === undefined ? null : opts.contentCache
    );
    savePreferences(true); // fromScheduler
    return { posted, stored, localStorage };
}

let passed = 0;
let failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}

function prefsFrom(posted) {
    const msg = posted.find(m => m.startsWith('save_prefs:'));
    return msg ? JSON.parse(msg.substring('save_prefs:'.length)) : null;
}

console.log('--- normal document ---');
{
    const small = '# Doc\n\nhello world';
    const r = run({ content: small, quotaBytes: null });
    const p = prefsFrom(r.posted);
    assert(p !== null, 'host received save_prefs');
    assert(p && p.lastContent === small, 'host prefs carry the document');
    assert(p && p.themeName === 'Modern Dark', 'host prefs carry the theme');
    assert(r.stored['typozen_prefs'] != null, 'localStorage backup written');
    const backup = JSON.parse(r.stored['typozen_prefs']);
    assert(backup.lastContent === small, 'localStorage backup carries the document');
}

console.log('--- document larger than the localStorage quota ---');
{
    const big = 'x'.repeat(6 * 1024 * 1024);
    const r = run({ content: big, quotaBytes: 5 * 1024 * 1024 });
    const p = prefsFrom(r.posted);
    assert(p !== null, 'host STILL received save_prefs past the quota');
    assert(p && p.lastContent === big, 'host prefs still carry the full document');
    assert(p && p.margin === 'regular', 'host prefs still carry the settings');

    const raw = r.stored['typozen_prefs'];
    assert(raw != null, 'localStorage fell back to a lite backup');
    if (raw) {
        const backup = JSON.parse(raw);
        assert(backup.lastContent === '', 'lite backup drops the document body');
        assert(backup.themeName === 'Modern Dark', 'lite backup keeps the settings');
    }
}

console.log('--- reuses the cached serialize when one is available ---');
{
    // updateStatsNow caches its serialize; savePreferences must reuse it rather than
    // walking the whole document a second time 800ms later.
    const r = run({ content: 'SHOULD NOT BE CALLED', contentCache: '# cached\n\nbody' });
    const p = prefsFrom(r.posted);
    assert(p && p.lastContent === '# cached\n\nbody', 'cached content used instead of re-serializing');
}

console.log('--- localStorage entirely unavailable ---');
{
    const r = run({ content: 'hello', quotaBytes: -1 }); // every setItem throws
    const p = prefsFrom(r.posted);
    assert(p !== null, 'host received save_prefs with localStorage dead');
    assert(p && p.lastContent === 'hello', 'host prefs intact with localStorage dead');
    assert(r.stored['typozen_prefs'] == null, 'no backup written, and no throw escaped');
}

console.log('--- content persistence switched off (the default) ---');
{
    // With File > Privacy > "Remember unsaved documents" off, no copy of the document
    // may reach settings.json or localStorage — while every other setting still must.
    const secret = '# Private notes\n\nsomething personal';
    const r = run({ content: secret, quotaBytes: null, persistContent: false });
    const p = prefsFrom(r.posted);
    assert(p !== null, 'host still receives save_prefs with persistence off');
    assert(p && p.lastContent === '', 'no document text is sent to the host');
    assert(p && p.themeName === 'Modern Dark', 'settings still persist with persistence off');
    assert(p && p.margin === 'regular', 'margins still persist with persistence off');

    const raw = r.stored['typozen_prefs'];
    assert(raw != null, 'localStorage backup still written');
    if (raw) {
        const backup = JSON.parse(raw);
        assert(backup.lastContent === '', 'no document text reaches localStorage either');
        assert(JSON.stringify(backup).indexOf('something personal') < 0,
            'no fragment of the document survives anywhere in the payload');
    }

    // The cached serialize must not sneak past the switch.
    const r2 = run({ content: 'x', contentCache: secret, persistContent: false });
    const p2 = prefsFrom(r2.posted);
    assert(p2 && p2.lastContent === '', 'the serialize cache does not bypass the switch');
}

console.log('\npassed=' + passed + ' failed=' + failed);
if (failed) {
    console.error('\nPREFS PERSISTENCE SELFTEST FAILED');
    process.exit(1);
}
console.log('\nPREFS PERSISTENCE SELFTEST PASSED');
