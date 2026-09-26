/**
 * Self-test: numbers become words before the Qwen narrator hears them (speakNumbers,
 * js/modules/09-speech.js).
 *
 * The narrator misreads digits -- "£86,000 - £117,800" came out as "...nine hundred seventeen
 * thousand eight hundred" in one voice and "...minus ... eight hundred twenty" in another
 * (2026-09-26). This runs the function straight from the module source, so it guards the code
 * the app runs, and checks both what must change and what must be left as it is.
 *
 *   node tests/speak-numbers-selftest.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '..', 'js', 'modules', '09-speech.js'), 'utf8');
const at = src.search(/function\s+speakNumbers\s*\(/);
if (at < 0) throw new Error('speakNumbers not found');
let i = src.indexOf('{', at), depth = 0;
for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) break; }
const speakNumbers = new Function(src.slice(at, i + 1) + '\nreturn speakNumbers;')();

let passed = 0, failed = 0;
const eq = (input, want) => {
    const got = speakNumbers(input);
    if (got === want) { passed++; console.log('  OK   ' + JSON.stringify(input) + ' -> ' + JSON.stringify(got)); }
    else { failed++; console.log('  FAIL ' + JSON.stringify(input) + '\n         got  ' + JSON.stringify(got) + '\n         want ' + JSON.stringify(want)); }
};

console.log('--- what Ed heard wrong');
eq('Pay Range: £86,000 - £117,800', 'Pay Range: eighty-six thousand pounds to one hundred and seventeen thousand eight hundred pounds');
eq('Apply by: 7th September 2026', 'Apply by: the seventh of September, twenty twenty-six');

console.log('--- amounts');
eq('£2m budget', 'two million pounds budget');
eq('£3.5bn', 'three point five billion pounds');
eq('£40k', 'forty thousand pounds');
eq('£1 each', 'one pound each');
eq('£1.50 each', 'one pound fifty each');
eq('$3.99', 'three dollars ninety-nine');
eq('€20', 'twenty euros');
eq('£2 million', 'two million pounds');
eq('£86,000 to £117,800', 'eighty-six thousand pounds to one hundred and seventeen thousand eight hundred pounds');

console.log('--- ranges, numbers, dates, times');
eq('10-12 people', 'ten to twelve people');
eq('10–12%', 'ten to twelve per cent');
eq('1,290 words', 'one thousand two hundred and ninety words');
eq('1,005 items', 'one thousand and five items');
eq('280 Colleagues', 'two hundred and eighty Colleagues');
eq('7 Locations across the UK', 'seven Locations across the UK');
eq('about 3.5 times', 'about three point five times');
eq('a 12% rise', 'a twelve per cent rise');
eq('the 21st century', 'the twenty-first century');
eq('the 3rd and 22nd', 'the third and twenty-second');
eq('on 24th August at 12pm', 'on the twenty-fourth of August at twelve p.m.');
eq('September 7, 2026', 'September the seventh, twenty twenty-six');
eq('at 9:30 am', 'at nine thirty a.m.');
eq('at 10:05', 'at ten oh five');
eq('in 1990', 'in nineteen ninety');
eq('from 1990-1995', 'from nineteen ninety to nineteen ninety-five');
eq('in 2005', 'in two thousand and five');
eq('(1905)', '(nineteen oh five)');
eq('in 1900', 'in nineteen hundred');

console.log('--- left as written');
eq('COVID-19', 'COVID-19');
eq('A4 paper', 'A4 paper');
eq('an mp3 file', 'an mp3 file');
eq('version 0.6.8', 'version 0.6.8');
eq('call 0800-123-456', 'call 0800-123-456');
eq('01 Welcome message', '01 Welcome message');
eq('No numbers here.', 'No numbers here.');

console.log(failed ? `SPEAK-NUMBERS FAILED (${failed} of ${passed + failed})` : `SPEAK-NUMBERS PASSED (${passed})`);
process.exitCode = failed ? 1 : 0;
