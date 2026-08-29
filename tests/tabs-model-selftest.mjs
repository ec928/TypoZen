/**
 * Pure model tests for multi-document tab logic (mirrors TypoZen_App.cs DocTab ops).
 * No WPF — exercises switch/new/close/open algorithms that must not lose buffers.
 *
 * node tests/tabs-model-selftest.mjs
 */

let passed = 0, failed = 0;
function assert(c, m) {
    if (c) { passed++; console.log('  OK  ', m); }
    else { failed++; console.error('  FAIL', m); }
}

// assert is defined above before use

class DocTab {
    constructor(id, filePath, content, isDirty) {
        this.Id = id;
        this.FilePath = filePath ?? null;
        this.Content = content ?? '';
        this.IsDirty = !!isDirty;
    }
    get Title() {
        const name = this.FilePath ? this.FilePath.split(/[/\\]/).pop() : 'Untitled.md';
        return this.IsDirty ? name + ' *' : name;
    }
}

/** Mirror of host tab state machine */
class TabModel {
    constructor() {
        this.tabs = [];
        this.active = -1;
        this.nextId = 1;
        this.currentFilePath = null;
        this.isDirty = false;
        this.editorContent = ''; // stand-in for WebView buffer
    }

    ensure() {
        if (this.tabs.length === 0) {
            this.tabs.push(new DocTab(this.nextId++, null, '', false));
            this.active = 0;
        }
        if (this.active < 0 || this.active >= this.tabs.length) this.active = 0;
    }

    syncFromEditor() {
        if (this.active < 0 || this.active >= this.tabs.length) return;
        const t = this.tabs[this.active];
        t.Content = this.editorContent;
        t.FilePath = this.currentFilePath;
        t.IsDirty = this.isDirty;
    }

    apply(tab) {
        this.currentFilePath = tab.FilePath;
        this.isDirty = tab.IsDirty;
        this.editorContent = tab.Content || '';
    }

    switchTo(index) {
        if (index < 0 || index >= this.tabs.length) return false;
        if (index === this.active) return true;
        this.syncFromEditor();
        this.active = index;
        this.apply(this.tabs[this.active]);
        return true;
    }

    newTab() {
        this.ensure();
        this.syncFromEditor();
        const tab = new DocTab(this.nextId++, null, '', false);
        this.tabs.push(tab);
        this.active = this.tabs.length - 1;
        this.apply(tab);
    }

    closeAt(index, discardDirty = true) {
        if (index < 0 || index >= this.tabs.length) return false;
        if (index === this.active) this.syncFromEditor();
        const tab = this.tabs[index];
        if (tab.IsDirty && !discardDirty) return false; // cancel
        const closedActive = index === this.active;
        this.tabs.splice(index, 1);
        if (this.tabs.length === 0) {
            this.tabs.push(new DocTab(this.nextId++, null, '', false));
            this.active = 0;
            this.apply(this.tabs[0]);
            return true;
        }
        if (index < this.active) this.active--;
        else if (this.active >= this.tabs.length) this.active = this.tabs.length - 1;
        if (closedActive) this.apply(this.tabs[this.active]);
        return true;
    }

    isReusableEmptyUntitled(tab) {
        if (!tab || tab.FilePath || tab.IsDirty) return false;
        const c = (tab.Content || '').trim();
        if (!c) return true;
            if (/start typing here/i.test(c)) return true;
        if (/start typing\.\.\./i.test(c) && /F1/i.test(c)) return true;
        if (/^# Untitled Document/i.test(c) && c.length < 80) return true;
        // First-run welcome document from the template — generated, not authored.
        if (/^# Welcome to TypoZen/i.test(c)) return true;
        return false;
    }

    openFile(path, content) {
        this.ensure();
        // already open?
        for (let i = 0; i < this.tabs.length; i++) {
            if (this.tabs[i].FilePath === path) {
                this.switchTo(i);
                this.tabs[i].Content = content;
                this.tabs[i].IsDirty = false;
                if (i === this.active) {
                    this.currentFilePath = path;
                    this.isDirty = false;
                    this.editorContent = content;
                }
                return 'switched';
            }
        }
        this.syncFromEditor();
        let tab;
        if (this.active >= 0 && this.isReusableEmptyUntitled(this.tabs[this.active])) {
            tab = this.tabs[this.active];
        } else {
            tab = new DocTab(this.nextId++);
            this.tabs.push(tab);
            this.active = this.tabs.length - 1;
        }
        tab.FilePath = path;
        tab.Content = content;
        tab.IsDirty = false;
        this.apply(tab);
        return 'opened';
    }
}

console.log('\n=== Tabs: new / switch preserves buffers ===');
{
    const m = new TabModel();
    m.ensure();
    m.editorContent = 'doc A line 1';
    m.isDirty = true;
    m.newTab();
    assert(m.tabs.length === 2, 'two tabs after New');
    assert(m.active === 1, 'active is new tab');
    assert(m.editorContent === '', 'new tab empty editor');
    assert(m.tabs[0].Content === 'doc A line 1', 'tab0 kept content');
    assert(m.tabs[0].IsDirty === true, 'tab0 dirty flag kept');

    m.editorContent = 'doc B only';
    m.isDirty = true;
    m.switchTo(0);
    assert(m.editorContent === 'doc A line 1', 'switch back restores A');
    assert(m.tabs[1].Content === 'doc B only', 'tab1 stored B');
    m.switchTo(1);
    assert(m.editorContent === 'doc B only', 'switch to B restores B');
}

console.log('\n=== Tabs: close active keeps other buffer ===');
{
    const m = new TabModel();
    m.ensure();
    m.editorContent = 'keep me';
    m.isDirty = false;
    m.newTab();
    m.editorContent = 'close me';
    m.isDirty = false;
    m.closeAt(1, true);
    assert(m.tabs.length === 1, 'one tab left');
    assert(m.editorContent === 'keep me', 'remaining tab content');
}

console.log('\n=== Tabs: close last recreates untitled ===');
{
    const m = new TabModel();
    m.ensure();
    m.editorContent = 'gone';
    m.closeAt(0, true);
    assert(m.tabs.length === 1, 'always at least one tab');
    assert(m.editorContent === '', 'fresh untitled empty');
    assert(m.tabs[0].FilePath == null, 'untitled has no path');
}

console.log('\n=== Tabs: open same path switches, no duplicate ===');
{
    const m = new TabModel();
    m.ensure();
    m.openFile('C:\\docs\\a.md', '# A');
    assert(m.tabs.length === 1, 'reuse clean untitled for first open');
    assert(m.editorContent === '# A', 'loaded A');
    m.newTab();
    m.editorContent = 'other';
    const r = m.openFile('C:\\docs\\a.md', '# A refreshed');
    assert(r === 'switched', 'second open switches');
    assert(m.tabs.length === 2, 'still two tabs not three');
    assert(m.editorContent === '# A refreshed', 'content refreshed on switch-open');
}

console.log('\n=== Tabs: dirty title ===');
{
    const t = new DocTab(1, 'C:\\x\\note.md', 'hi', true);
    assert(t.Title === 'note.md *', 'dirty title has star');
    t.IsDirty = false;
    assert(t.Title === 'note.md', 'clean title');
}

console.log('\n=== Tabs: close index adjusts active ===');
{
    const m = new TabModel();
    m.ensure();
    m.editorContent = 't0';
    m.newTab();
    m.editorContent = 't1';
    m.newTab();
    m.editorContent = 't2';
    // tabs 0,1,2 active=2
    m.closeAt(0, true); // close first while on last
    assert(m.tabs.length === 2, 'two left');
    assert(m.active === 1, 'active adjusted after close before active');
    assert(m.tabs[0].Content === 't1' || m.editorContent === 't2', 'buffers sane after close');
}

console.log('\n=== Tabs: open reuses default Untitled placeholder ===');
{
    const m = new TabModel();
    m.ensure();
    m.editorContent = '# Untitled Document\n\nStart typing here...';
    m.isDirty = false;
    m.openFile('C:\\docs\\real.md', '# Real\n\nbody');
    assert(m.tabs.length === 1, 'reuse placeholder untitled instead of 2nd tab');
    assert(m.editorContent === '# Real\n\nbody', 'loaded real file into reused tab');
    assert(m.tabs[0].FilePath === 'C:\\docs\\real.md', 'path set on reused tab');
}

console.log('\n=== Tabs: open reuses the first-run welcome document ===');
{
    // Fresh profile shows the template welcome doc. Opening a file used to strand it
    // in its own tab, because only "Untitled Document" counted as a placeholder.
    const welcome = '# Welcome to TypoZen\n\nA modern, distraction-free **WYSIWYG** markdown and text editor.\n\n### Key Features\n- **True Live Preview**: lots more text here so it is well over the 80 character placeholder limit.';
    const m = new TabModel();
    m.ensure();
    m.editorContent = welcome;
    m.isDirty = false;
    m.openFile('C:\\docs\\real.md', '# Real\n\nbody');
    assert(m.tabs.length === 1, 'reuse welcome doc instead of 2nd tab');
    assert(m.editorContent === '# Real\n\nbody', 'loaded real file into reused tab');

    // ...but an EDITED welcome doc is the user's work and must be kept.
    const m2 = new TabModel();
    m2.ensure();
    m2.editorContent = welcome + '\n\nmy own notes';
    m2.isDirty = true;
    m2.openFile('C:\\docs\\real.md', '# Real\n\nbody');
    assert(m2.tabs.length === 2, 'edited welcome doc kept in its own tab');
}

console.log(`\npassed=${passed} failed=${failed}`);
if (failed) process.exit(1);
console.log('TABS MODEL SELFTEST PASSED');
process.exit(0);
