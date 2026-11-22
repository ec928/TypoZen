/**
 * Live WPF menu + Windows clipboard E2E test against the real TypoZen.exe.
 *
 * Drives the actual WPF right-click ContextMenu and top MenuBar (Edit / Format) via
 * Windows UI Automation and asserts directly against the Windows clipboard and live
 * document across Preview (single-line, multi-line, plain & rich paste-over-selection),
 * Source, Reader, and the Find bar.
 *
 *   RUN_APP_E2E=1 node tests/menu-clipboard-app.mjs
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { launchApp, sleep } from './app-harness.mjs';

const deadline = setTimeout(() => { console.error('  FAIL over budget (180 s)'); process.exit(1); }, 180000);
const tmpMd = path.join(os.tmpdir(), 'tz-menu-clipboard-' + process.pid + '.md');
const DOC = 'Three ways to see single word here\n\nAlpha line\nBeta line\nGamma line';
fs.writeFileSync(tmpMd, DOC);

const getClip = () => execFileSync('powershell', ['-NoProfile', '-STA', '-Command',
    'Add-Type -AssemblyName PresentationCore; for ($t=0; $t -lt 10; $t++) { try { $v = [System.Windows.Clipboard]::GetText(); [Console]::Out.Write($v); break } catch { if ($t -eq 9) { throw }; Start-Sleep -Milliseconds 60 } }'
], { encoding: 'utf8' });
const setClip = (s) => execFileSync('powershell', ['-NoProfile', '-STA', '-Command',
    `for ($t=0; $t -lt 10; $t++) { try { Set-Clipboard -Value '${String(s).replace(/'/g, "''")}'; break } catch { if ($t -eq 9) { throw }; Start-Sleep -Milliseconds 60 } }`]);
const setRichClip = (plain, html) => {
    const ps = [
        'Add-Type -AssemblyName PresentationCore',
        '$d = New-Object System.Windows.DataObject',
        `$d.SetText('${String(plain).replace(/'/g, "''")}', [System.Windows.TextDataFormat]::UnicodeText)`,
        `$h = '${String(html).replace(/'/g, "''")}'`,
        "$pre = '<html><body><!--StartFragment-->'; $post = '<!--EndFragment--></body></html>'",
        '$fmt = "Version:0.9`r`nStartHTML:{0:0000000000}`r`nEndHTML:{1:0000000000}`r`nStartFragment:{2:0000000000}`r`nEndFragment:{3:0000000000}`r`n"',
        '$sh = [Text.Encoding]::UTF8.GetByteCount(($fmt -f 0,0,0,0)); $sf = $sh + [Text.Encoding]::UTF8.GetByteCount($pre); $ef = $sf + [Text.Encoding]::UTF8.GetByteCount($h); $eh = $ef + [Text.Encoding]::UTF8.GetByteCount($post)',
        '$cf = ($fmt -f $sh,$eh,$sf,$ef) + $pre + $h + $post',
        '$d.SetText($cf, [System.Windows.TextDataFormat]::Html)',
        'for ($t=0; $t -lt 10; $t++) { try { [System.Windows.Clipboard]::SetDataObject($d, $true); break } catch { if ($t -eq 9) { throw }; Start-Sleep -Milliseconds 60 } }'
    ].join('; ');
    execFileSync('powershell', ['-NoProfile', '-STA', '-Command', ps]);
};

function invokeMenuPath(pathParts) {
    const partsLiteral = pathParts.map(p => `'${p.replace(/'/g, "''")}'`).join(',');
    const ps = `
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type -Name Win -Namespace Native -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);'
$p = Get-Process TypoZen | Select-Object -First 1
if (-not $p) { throw "TypoZen not running" }
$AE = [System.Windows.Automation.AutomationElement]; $TS = [System.Windows.Automation.TreeScope]
$parts = @(${partsLiteral})
function FindVisible($name) {
  $cond = New-Object System.Windows.Automation.AndCondition(
    (New-Object System.Windows.Automation.PropertyCondition($AE::ProcessIdProperty, $p.Id)),
    (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::MenuItem)))
  $items = $AE::RootElement.FindAll($TS::Descendants, $cond)
  $found = @()
  foreach ($i in $items) {
    $r = $i.Current.BoundingRectangle
    if ($i.Current.Name -eq $name -and -not $i.Current.IsOffscreen -and $r.Width -gt 0 -and $r.Height -gt 0) { $found += $i }
  }
  if ($found.Count -gt 0) { return $found[$found.Count - 1] }
  return $null
}
for ($idx = 0; $idx -lt $parts.Count; $idx++) {
  $nm = $parts[$idx]
  $hit = $null
  # Bring the window forward only for a top menu that is not showing yet. Activating the
  # main window closes an open right-click menu, so doing it first threw away the menu the
  # test had just opened: "Visible MenuItem not found: Copy" (2026-11-22).
  $hit = FindVisible $nm
  if (-not $hit -and $idx -eq 0 -and $p.MainWindowHandle -ne 0) { [Native.Win]::SetForegroundWindow($p.MainWindowHandle) | Out-Null }
  for ($try = 0; $try -lt 25 -and -not $hit; $try++) {
    Start-Sleep -Milliseconds 120
    $hit = FindVisible $nm
  }
  if (-not $hit) { throw "Visible MenuItem not found: $nm" }
  if ($idx -lt $parts.Count - 1) {
    $ec = $null
    if ($hit.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$ec)) {
      if ($ec.Current.ExpandCollapseState -ne [System.Windows.Automation.ExpandCollapseState]::Collapsed) { $ec.Collapse(); Start-Sleep -Milliseconds 100 }
      $ec.Expand()
    }
    Start-Sleep -Milliseconds 250
  } else {
    $inv = $null
    if ($hit.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$inv)) { $inv.Invoke() }
    else { throw "No InvokePattern on $nm" }
  }
}
`;
    execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' });
}

let prevClip = '';
try { prevClip = getClip(); } catch { prevClip = ''; }

let passed = 0, failed = 0;
function check(label, ok, detail) {
    if (ok) { passed++; console.log('  OK   ' + label); return; }
    failed++;
    console.error('  FAIL ' + label + (detail ? ' :: ' + detail : ''));
}

const app = await launchApp({ file: tmpMd, settleMs: 4000, visible: true });
try {
    async function resetDoc(md, mode = 'wysiwyg') {
        await app.eval((m, mo) => {
            loadMarkdownContent(m);
            if (state.mode !== mo) handleCommand('view_set:mode:' + mo);
            HistoryManager.resetToCurrent();
        }, md, mode);
        await sleep(300);
    }
    const getDoc = () => app.eval(() => (state.mode === 'source' ? sourceEditor.value : getMarkdownContent(false)));
    const selectWord = (bi, word) => app.eval((i, w) => {
        const b = document.querySelector('#editor .block[data-model-index="' + i + '"]');
        const t = document.createTreeWalker(b, NodeFilter.SHOW_TEXT).nextNode();
        const pos = t.nodeValue.indexOf(w);
        const r = document.createRange(); r.setStart(t, pos); r.setEnd(t, pos + w.length);
        const s = getSelection(); s.removeAllRanges(); s.addRange(r);
        if (editor.isContentEditable) focusEditorNoScroll();
        snapshotFormatSelectionFromEditor();
        rememberEditorCaret();
        const box = r.getBoundingClientRect();
        return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    }, bi, word);
    const selectLines = (i0, i1) => app.eval((a, z) => {
        const b0 = document.querySelector('#editor .block[data-model-index="' + a + '"]');
        const b1 = document.querySelector('#editor .block[data-model-index="' + z + '"]');
        const t0 = document.createTreeWalker(b0, NodeFilter.SHOW_TEXT).nextNode();
        const t1 = document.createTreeWalker(b1, NodeFilter.SHOW_TEXT).nextNode();
        const r = document.createRange(); r.setStart(t0, 0); r.setEnd(t1, t1.nodeValue.length);
        const s = getSelection(); s.removeAllRanges(); s.addRange(r);
        focusEditorNoScroll();
        snapshotFormatSelectionFromEditor();
        rememberEditorCaret();
        if (typeof snapshotMultiBlockSelectionFromLive === 'function') snapshotMultiBlockSelectionFromLive();
        const box = b0.getBoundingClientRect();
        return { x: box.left + 20, y: box.top + box.height / 2 };
    }, i0, i1);

    console.log('\n=== Preview right-click Copy / Cut / Paste / Format ===');
    await resetDoc(DOC);
    setClip('S1');
    let pt = await selectWord(0, 'single');
    await app.page.mouse.click(pt.x, pt.y, { button: 'right' }); await sleep(300);
    invokeMenuPath(['Copy']); await sleep(400);
    check('RC Copy single word', getClip() === 'single', 'clip=' + JSON.stringify(getClip()));

    await resetDoc(DOC);
    setClip('S2');
    pt = await selectLines(2, 3);
    await app.page.mouse.click(pt.x, pt.y, { button: 'right' }); await sleep(300);
    invokeMenuPath(['Copy']); await sleep(400);
    check('RC Copy multi-line', getClip().replace(/\r\n/g, '\n') === 'Alpha line\nBeta line', 'clip=' + JSON.stringify(getClip()));

    await resetDoc(DOC);
    setClip('S3');
    pt = await selectWord(0, 'single');
    await app.page.mouse.click(pt.x, pt.y, { button: 'right' }); await sleep(300);
    invokeMenuPath(['Cut']); await sleep(400);
    check('RC Cut single word', getClip() === 'single' && (await getDoc()).startsWith('Three ways to see  word here'),
        'clip=' + JSON.stringify(getClip()) + ' line0=' + JSON.stringify((await getDoc()).split('\n')[0]));

    await resetDoc(DOC);
    setClip('S4');
    pt = await selectLines(2, 3);
    await app.page.mouse.click(pt.x, pt.y, { button: 'right' }); await sleep(300);
    invokeMenuPath(['Cut']); await sleep(400);
    check('RC Cut multi-line', getClip().replace(/\r\n/g, '\n') === 'Alpha line\nBeta line' && (await getDoc()) === 'Three ways to see single word here\n\n\nGamma line',
        'clip=' + JSON.stringify(getClip()) + ' doc=' + JSON.stringify(await getDoc()));

    await resetDoc(DOC);
    setClip('REPLACED');
    pt = await selectWord(0, 'single');
    await app.page.mouse.click(pt.x, pt.y, { button: 'right' }); await sleep(300);
    invokeMenuPath(['Paste']); await sleep(400);
    check('RC Paste replaces selected word and keeps space', (await getDoc()).startsWith('Three ways to see REPLACED word here'),
        'line0=' + JSON.stringify((await getDoc()).split('\n')[0]));

    await resetDoc(DOC);
    setRichClip('boldword', '<b>boldword</b>');
    pt = await selectWord(0, 'single');
    await app.page.mouse.click(pt.x, pt.y, { button: 'right' }); await sleep(300);
    invokeMenuPath(['Paste']); await sleep(400);
    check('RC Paste rich HTML converts to **bold** without keeping old word', (await getDoc()).startsWith('Three ways to see **boldword** word here'),
        'line0=' + JSON.stringify((await getDoc()).split('\n')[0]));

    await resetDoc(DOC);
    setRichClip('boldword', '<b>boldword</b>');
    pt = await selectWord(0, 'single');
    await app.page.mouse.click(pt.x, pt.y, { button: 'right' }); await sleep(300);
    invokeMenuPath(['Paste as Plain Text']); await sleep(400);
    check('RC Paste as Plain Text strips HTML and keeps space', (await getDoc()).startsWith('Three ways to see boldword word here'),
        'line0=' + JSON.stringify((await getDoc()).split('\n')[0]));

    await resetDoc(DOC);
    setClip('TWO_GONE');
    pt = await selectLines(2, 3);
    await app.page.mouse.click(pt.x, pt.y, { button: 'right' }); await sleep(300);
    invokeMenuPath(['Paste']); await sleep(400);
    check('RC Paste replaces multi-line selection', (await getDoc()) === 'Three ways to see single word here\n\nTWO_GONE\nGamma line',
        'doc=' + JSON.stringify(await getDoc()));

    await resetDoc(DOC);
    setClip('S5');
    pt = await selectWord(0, 'single');
    await app.page.mouse.click(pt.x, pt.y, { button: 'right' }); await sleep(300);
    invokeMenuPath(['Select All']); await sleep(350);
    await app.page.mouse.click(pt.x, pt.y, { button: 'right' }); await sleep(300);
    invokeMenuPath(['Copy']); await sleep(400);
    check('RC Select All -> RC Copy', getClip().replace(/\r\n/g, '\n') === DOC, 'clip=' + JSON.stringify(getClip()));

    await resetDoc(DOC);
    pt = await selectWord(0, 'single');
    await app.page.mouse.click(pt.x, pt.y, { button: 'right' }); await sleep(300);
    invokeMenuPath(['Bold']); await sleep(350);
    check('RC Bold', (await getDoc()).startsWith('Three ways to see **single** word here'));

    await resetDoc(DOC);
    pt = await selectWord(0, 'single');
    await app.page.mouse.click(pt.x, pt.y, { button: 'right' }); await sleep(300);
    invokeMenuPath(['Heading', 'Heading 2']); await sleep(350);
    check('RC Heading > Heading 2', (await getDoc()).startsWith('## Three ways to see single word here'));

    await resetDoc(DOC);
    pt = await selectWord(0, 'single');
    await app.page.mouse.click(pt.x, pt.y, { button: 'right' }); await sleep(300);
    invokeMenuPath(['Callout', 'Note']); await sleep(350);
    check('RC Callout > Note', (await getDoc()).startsWith('> [!NOTE]\n> Three ways to see single word here'));

    console.log('\n=== Reader Edit > Copy & Find bar Edit > Copy ===');
    await resetDoc(DOC, 'reader');
    setClip('S_READER');
    await selectWord(0, 'single');
    invokeMenuPath(['Edit', 'Copy']); await sleep(450);
    check('Reader Edit > Copy', getClip() === 'single', 'clip=' + JSON.stringify(getClip()));

    await resetDoc(DOC, 'wysiwyg');
    setClip('S_FIND');
    await app.eval(() => { openFindBar(); const i = document.getElementById('findInput'); i.focus(); i.value = 'needle'; i.setSelectionRange(0, 6); });
    await sleep(150);
    invokeMenuPath(['Edit', 'Copy']); await sleep(450);
    check('Find bar Edit > Copy', getClip() === 'needle', 'clip=' + JSON.stringify(getClip()));

    setRichClip('REPL', '<b>REPL</b>');
    await app.eval(() => { const i = document.getElementById('findInput'); i.focus(); i.value = 'aXc'; i.setSelectionRange(1, 2); });
    await sleep(150);
    invokeMenuPath(['Edit', 'Paste']); await sleep(450);
    const findAfterPaste = await app.eval(() => ({ val: document.getElementById('findInput').value, doc: getMarkdownContent(false) }));
    check('Find bar Edit > Paste puts plain text in Find input without touching doc',
        findAfterPaste.val === 'aREPLc' && findAfterPaste.doc === DOC, JSON.stringify(findAfterPaste));

    setClip('S_FIND_ALL');
    await app.eval(() => { const i = document.getElementById('findInput'); i.focus(); i.value = 'wholefind'; i.setSelectionRange(2, 2); });
    await sleep(150);
    invokeMenuPath(['Edit', 'Select All']); await sleep(300);
    invokeMenuPath(['Edit', 'Copy']); await sleep(450);
    check('Find bar Edit > Select All -> Edit > Copy', getClip() === 'wholefind', 'clip=' + JSON.stringify(getClip()));
    await app.eval(() => { if (typeof closeFindBar === 'function') closeFindBar(); });

    console.log('\n=== Source right-click Copy / Cut / Paste ===');
    await resetDoc(DOC, 'source');
    setClip('S_SRC1');
    const srcPt = await app.eval(() => {
        const idx = sourceEditor.value.indexOf('Alpha');
        sourceEditor.focus();
        sourceEditor.setSelectionRange(idx, idx + 5);
        rememberEditorCaret();
        const lines = document.querySelectorAll('.cm-line');
        const box = lines[2] ? lines[2].getBoundingClientRect() : document.querySelector('.cm-content').getBoundingClientRect();
        return { x: box.left + 15, y: box.top + box.height / 2 };
    });
    await app.page.mouse.click(srcPt.x, srcPt.y, { button: 'right' }); await sleep(300);
    invokeMenuPath(['Copy']); await sleep(400);
    check('Source RC Copy', getClip() === 'Alpha', 'clip=' + JSON.stringify(getClip()));

    setClip('S_SRC2');
    await app.eval(() => {
        const idx = sourceEditor.value.indexOf('Alpha');
        sourceEditor.focus();
        sourceEditor.setSelectionRange(idx, idx + 5);
        rememberEditorCaret();
    });
    await app.page.mouse.click(srcPt.x, srcPt.y, { button: 'right' }); await sleep(300);
    invokeMenuPath(['Cut']); await sleep(400);
    check('Source RC Cut', getClip() === 'Alpha' && (await getDoc()).includes('\n\n line\nBeta line'),
        'clip=' + JSON.stringify(getClip()) + ' doc=' + JSON.stringify(await getDoc()));

    setClip('RESTORED');
    const srcPastePt = await app.eval(() => {
        const lines = document.querySelectorAll('.cm-line');
        const box = lines[1] ? lines[1].getBoundingClientRect() : document.querySelector('.cm-content').getBoundingClientRect();
        return { x: box.left + 10, y: box.top + box.height / 2 };
    });
    await app.page.mouse.click(srcPastePt.x, srcPastePt.y); await sleep(120);
    await app.page.mouse.click(srcPastePt.x, srcPastePt.y, { button: 'right' }); await sleep(300);
    invokeMenuPath(['Paste']); await sleep(400);
    check('Source RC Paste', (await getDoc()) === 'Three ways to see single word here\nRESTORED\n line\nBeta line\nGamma line', 'doc=' + JSON.stringify(await getDoc()));
} finally {
    try { if (prevClip) setClip(prevClip); } catch {}
    await app.close();
    try { fs.unlinkSync(tmpMd); } catch {}
    clearTimeout(deadline);
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
