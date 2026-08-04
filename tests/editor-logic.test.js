/**
 * Legacy entry point. Production logic lives in TypoZen_Template.html (not
 * js/markdown-core.js). Prefer the regression suite:
 *
 *   node tests/regression-selftest.mjs
 *
 * This file re-runs that suite so old docs / run-tests.ps1 still work.
 */
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const suite = path.join(__dirname, 'regression-selftest.mjs');

console.log('editor-logic.test.js → delegates to regression-selftest.mjs');
const r = spawnSync(process.execPath, [suite], {
    encoding: 'utf8',
    cwd: root,
    stdio: 'inherit'
});
process.exit(r.status == null ? 1 : r.status);
