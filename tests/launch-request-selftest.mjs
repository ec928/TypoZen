/**
 * Phase 6 launch surface: CLI / pipe protocol shape and page handlers.
 *
 *   node tests/launch-request-selftest.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { readEngineSource, appDir } from './engine-source.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let passed = 0, failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  OK   ' + msg); }
    else { failed++; console.error('  FAIL ' + msg); }
}

const cs = fs.readFileSync(path.join(appDir, 'TypoZen_App.cs'), 'utf8')
    + '\n' + fs.readFileSync(path.join(appDir, 'TypoZen_Launch.cs'), 'utf8');
const js = readEngineSource();

console.log('=== host: LaunchRequest ===');
{
    assert(cs.indexOf('class LaunchRequest') >= 0, 'LaunchRequest type exists');
    assert(cs.indexOf('ParseArgs') >= 0, 'ParseArgs parses CLI');
    assert(cs.indexOf('ToPipeLine') >= 0 && cs.indexOf('FromPipeLine') >= 0, 'pipe round-trip helpers');
    assert(cs.indexOf('--reader') >= 0, 'CLI --reader');
    assert(cs.indexOf('--search') >= 0, 'CLI --search');
    assert(cs.indexOf('--match-index') >= 0, 'CLI --match-index');
    assert(cs.indexOf('#tz1') >= 0, 'pipe marker #tz1');
    assert(cs.indexOf('external_find:') >= 0, 'host sends external_find');
    assert(cs.indexOf('external_goto_line:') >= 0, 'host sends external_goto_line');
    assert(cs.indexOf('ApplyPendingLaunchHints') >= 0, 'apply after load');
    assert(cs.indexOf('OpenWithLaunchRequest') >= 0, 'open + hints path');
}

console.log('=== page: external find / goto ===');
{
    assert(js.indexOf('function applyExternalFind') >= 0, 'applyExternalFind present');
    assert(js.indexOf('function applyExternalGotoLine') >= 0, 'applyExternalGotoLine present');
    assert(js.indexOf("external_find:") >= 0, 'message handler for external_find');
    assert(js.indexOf("external_goto_line:") >= 0, 'message handler for external_goto_line');
    assert(js.indexOf('findJumpTo') >= 0, 'uses findJumpTo for match index');
    assert(js.indexOf('openFindBar') >= 0, 'opens find bar for highlight');
}

console.log('=== ZenSeek calls TypoZen ===');
{
    const bat = fs.readFileSync(path.join(appDir, '..', 'ZenSeek', 'ZenSeek.bat'), 'utf8');
    assert(bat.indexOf('Open-InTypoZen') >= 0, 'Open-InTypoZen helper');
    assert(bat.indexOf('Resolve-TypoZenExe') >= 0, 'resolves TypoZen.exe');
    assert(bat.indexOf('--reader') >= 0, 'passes --reader');
    assert(bat.indexOf('--search') >= 0, 'passes --search');
    assert(bat.indexOf('--match-index') >= 0, 'passes --match-index');
    assert(/Open-InTypoZen[\s\S]{0,200}return/.test(bat)
        || bat.indexOf('if (Global:Open-InTypoZen') >= 0
        || bat.indexOf('if (Open-InTypoZen') >= 0
        || bat.indexOf('Global:Open-InTypoZen') >= 0,
        'Show-Reader prefers TypoZen');
}

console.log('\npassed=' + passed + ' failed=' + failed);
if (failed) {
    console.error('\nLAUNCH REQUEST SELFTEST FAILED');
    process.exit(1);
}
console.log('\nLAUNCH REQUEST SELFTEST PASSED');
process.exit(0);
