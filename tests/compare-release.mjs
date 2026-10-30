/**
 * What changed in editing since the last release: the same keys on both builds, side by side.
 *
 * Run before a release, and read every difference. 0.19.2 changed how quotes behave under Enter
 * and Backspace and nothing said so; this says so. A difference is not a failure, some are the
 * point of the release, but each one has to be something you meant.
 *
 *   node tests/compare-release.mjs              against the latest GitHub release
 *   node tests/compare-release.mjs v0.19.0      against that tag
 *
 * About two and a half minutes. Exit 1 only for a broken invariant that the release did not have.
 */
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..');
const git = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' });

let tag = process.argv[2];
if (!tag) {
    const r = spawnSync('gh', ['release', 'list', '--limit', '1', '--json', 'tagName', '-q', '.[0].tagName'], { cwd: repo, encoding: 'utf8' });
    tag = (r.stdout || '').trim();
    if (!tag) { console.error('Could not ask GitHub for the latest release; name a tag.'); process.exit(2); }
}
if (git('rev-parse', '-q', '--verify', 'refs/tags/' + tag).status !== 0) git('fetch', '-q', 'origin', 'refs/tags/' + tag + ':refs/tags/' + tag);
if (git('rev-parse', '-q', '--verify', 'refs/tags/' + tag).status !== 0) { console.error('No tag ' + tag + ' here or on origin.'); process.exit(2); }

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'typozen-compare-'));
const oldDir = path.join(work, 'old');
fs.mkdirSync(oldDir);
const zip = path.join(work, 'old.zip');
const arch = git('archive', '--format=zip', '-o', zip, tag, '--', 'js', 'css', 'TypoZen_Template.html');
if (arch.status !== 0) { console.error(arch.stderr); process.exit(2); }
const unzip = process.platform === 'win32'
    ? spawnSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${oldDir}' -Force`], { encoding: 'utf8' })
    : spawnSync('unzip', ['-q', zip, '-d', oldDir], { encoding: 'utf8' });
if (unzip.status !== 0) { console.error(unzip.stderr); process.exit(2); }

const run = (dir, out) => new Promise(res => {
    const p = spawn(process.execPath, [path.join(here, 'key-fuzz.mjs'), dir, out, '200'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let text = ''; p.stdout.on('data', d => { text += d; });
    p.on('exit', () => res(text.trim().split('\n').pop()));
});
const newFile = path.join(work, 'new.json'), oldFile = path.join(work, 'old.json');
console.log('Comparing this tree with ' + tag + '...');
const [newLine, oldLine] = await Promise.all([run(repo, newFile), run(oldDir, oldFile)]);
console.log('  this tree: ' + newLine);
console.log('  ' + tag + ': ' + oldLine);

const now = JSON.parse(fs.readFileSync(newFile, 'utf8'));
const was = JSON.parse(fs.readFileSync(oldFile, 'utf8'));
const key = r => r.tok + ' ' + r.pos + ' ' + r.name;
const wasBy = new Map(was.map(r => [key(r), r]));
const broken = r => r && r.issues && r.issues.length;

const newlyBroken = now.filter(r => broken(r) && wasBy.has(key(r)) && !broken(wasBy.get(key(r))));
console.log('\n=== invariants broken here and not in ' + tag + ': ' + newlyBroken.length);
newlyBroken.forEach(r => console.log('  ' + key(r) + ': ' + r.issues.join('; ').slice(0, 170)));
console.log('=== broken in both (older bugs): ' + now.filter(r => broken(r) && broken(wasBy.get(key(r)))).length);
now.filter(r => broken(r) && broken(wasBy.get(key(r)))).slice(0, 20).forEach(r => console.log('  ' + key(r) + ': ' + r.issues.join('; ').slice(0, 170)));

const differ = now.filter(r => { const o = wasBy.get(key(r)); return o && !r.skip && !o.skip && r.after !== o.after; });
console.log('\n=== saved text differs in ' + differ.length + ' of ' + now.length + ' cases. Read each one:');
for (const r of differ) {
    const a = r.after.split('\n'), b = wasBy.get(key(r)).after.split('\n');
    let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++;
    console.log('  ' + key(r));
    console.log('    now  ' + JSON.stringify(a.slice(i, i + 3).join('\n')));
    console.log('    was  ' + JSON.stringify(b.slice(i, i + 3).join('\n')));
}
fs.rmSync(work, { recursive: true, force: true });
process.exit(newlyBroken.length ? 1 : 0);
