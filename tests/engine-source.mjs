/**
 * Shared access to the shipping editor engine sources.
 *
 * The engine lives as ordered classic scripts under js/modules/. Production loads them
 * one tag at a time; tests that need a single string (extractFunction, parse-check,
 * direct file reads) concat in load order here so they never pin to a stale monolith.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const appDir = path.join(__dirname, '..');
const modulesDir = path.join(appDir, 'js', 'modules');
const orderPath = path.join(modulesDir, 'load-order.json');

export function engineModuleNames() {
    const order = JSON.parse(fs.readFileSync(orderPath, 'utf8'));
    if (!order.modules || !order.modules.length) {
        throw new Error('js/modules/load-order.json has no modules list');
    }
    return order.modules.slice();
}

export function engineModulePaths() {
    return engineModuleNames().map(n => path.join(modulesDir, n));
}

/** Full engine source, modules concatenated in load order. */
export function readEngineSource() {
    const parts = [];
    for (const p of engineModulePaths()) {
        if (!fs.existsSync(p)) throw new Error('missing engine module: ' + p);
        parts.push(fs.readFileSync(p, 'utf8'));
    }
    return parts.join('\n');
}

/** Script tags to inject into TypoZen_Template.html (production). */
export function engineScriptTags() {
    return engineModuleNames()
        .map(n => '<script src="js/modules/' + n + '"></script>')
        .join('\n    ');
}

/** Marker pair used by the template and by build-test-template.mjs. */
export const ENGINE_BEGIN = '<!-- TYPOZEN_ENGINE_BEGIN -->';
export const ENGINE_END = '<!-- TYPOZEN_ENGINE_END -->';
