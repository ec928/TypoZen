// Part of the keyboard editing cases (keyboard-editing-cases.mjs): the preview part, so the gate
// runs the three parts in parallel.
process.argv[2] = 'preview';
await import('./keyboard-editing-cases.mjs');
