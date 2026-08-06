/**
 * Engine modules: load order, completeness, and production/template wiring.
 *
 *   node tests/modules-selftest.mjs
 */
import fs from 'fs';
import path from 'path';
import {
    appDir,
    engineModuleNames,
    engineModulePaths,
    readEngineSource,
    ENGINE_BEGIN,
    ENGINE_END,
} from './engine-source.mjs';

let passed = 0, failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}

console.log('=== engine modules ===');
{
    const names = engineModuleNames();
    assert(names.length >= 5, 'at least 5 modules listed (' + names.length + ')');
    assert(names[0] === '01-core.js', 'first module is 01-core.js');
    assert(names.indexOf('04-lists.js') >= 0, '04-lists.js listed');
    assert(names.indexOf('04b-format.js') >= 0, '04b-format.js listed');
    assert(names[names.length - 1] === '07-stats-host.js', 'last module is 07-stats-host.js');

    for (const p of engineModulePaths()) {
        assert(fs.existsSync(p), 'exists: ' + path.relative(appDir, p));
    }

    const src = readEngineSource();
    assert(src.length > 100000, 'concatenated engine is substantial (' + src.length + ' chars)');
    assert(src.indexOf('function htmlToMarkdown') >= 0, 'htmlToMarkdown present');
    assert(src.indexOf('const PageChunks') >= 0, 'PageChunks present');
    assert(src.indexOf('DocumentModel') >= 0, 'DocumentModel present');
    assert(src.indexOf('function bookGoToHref') >= 0, 'bookGoToHref present');
    assert(src.indexOf('const LARGE_DOC_CHARS') >= 0, 'LARGE_DOC_CHARS present');
    assert(src.indexOf('SOURCE_FIRST_CHARS') < 0, 'SOURCE_FIRST_CHARS alias removed');
    assert(src.indexOf('function resolveViewState') >= 0, 'resolveViewState present');
}

console.log('=== template wires every module ===');
{
    const template = fs.readFileSync(path.join(appDir, 'TypoZen_Template.html'), 'utf8');
    assert(template.indexOf(ENGINE_BEGIN) >= 0, 'ENGINE_BEGIN marker present');
    assert(template.indexOf(ENGINE_END) >= 0, 'ENGINE_END marker present');
    for (const name of engineModuleNames()) {
        assert(template.indexOf('js/modules/' + name) >= 0,
            'template loads ' + name);
    }
    // Must not load the deprecated stub as the engine.
    assert(!/<script\s+src=["']js\/typozen\.js["']/.test(template),
        'template does not load js/typozen.js');
}

console.log('=== deprecated stub is a hard fail ===');
{
    const stub = fs.readFileSync(path.join(appDir, 'js', 'typozen.js'), 'utf8');
    assert(/throw new Error/.test(stub), 'js/typozen.js throws if evaluated');
    assert(/no longer the engine/.test(stub), 'stub message names the module path');
}

console.log('\npassed=' + passed + ' failed=' + failed);
if (failed) {
    console.error('\nMODULES SELFTEST FAILED');
    process.exit(1);
}
console.log('\nMODULES SELFTEST PASSED');
process.exit(0);
