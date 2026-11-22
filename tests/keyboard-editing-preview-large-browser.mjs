// Part of the keyboard editing cases (keyboard-editing-cases.mjs): every case in the MIDDLE of a
// long file (preview-large), so the gate tests editing where Preview holds only a window of the file.
process.argv[2] = 'preview-large';
await import('./keyboard-editing-cases.mjs');
