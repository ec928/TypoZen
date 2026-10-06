// Part of the keyboard editing cases (keyboard-editing-cases.mjs): the large part, so the gate
// runs the three parts in parallel.
process.argv[2] = 'large';
await import('./keyboard-editing-cases.mjs');
