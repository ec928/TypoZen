// Part of the keyboard editing cases (keyboard-editing-cases.mjs): the source part, so the gate
// runs the three parts in parallel.
process.argv[2] = 'source';
await import('./keyboard-editing-cases.mjs');
