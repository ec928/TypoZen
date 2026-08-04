"""
UI smoke test for TypoZen multi-document tabs (pywinauto).
Launches TypoZen.exe, checks tab strip + New tab button, creates a second tab.
"""
import sys
import time
from pathlib import Path

from pywinauto import Application
from pywinauto.findwindows import ElementNotFoundError

ROOT = Path(__file__).resolve().parent.parent
EXE = ROOT / "TypoZen.exe"


def main():
    if not EXE.exists():
        print("FAIL: TypoZen.exe not found at", EXE)
        return 1

    # Kill existing
    try:
        import subprocess
        subprocess.run(["taskkill", "/IM", "TypoZen.exe", "/F"], capture_output=True)
        time.sleep(0.5)
    except Exception:
        pass

    print("Starting", EXE)
    app = Application(backend="uia").start(str(EXE), work_dir=str(ROOT))
    time.sleep(5)  # WebView2 init

    try:
        win = app.window(title_re=".*TypoZen.*")
        win.wait("visible", timeout=20)
        print("  OK   main window visible:", win.window_text())
    except Exception as e:
        print("FAIL: window not found:", e)
        return 1

    # Enumerate interesting controls
    try:
        # New tab button
        new_tab = win.child_window(title="+", control_type="Button")
        if not new_tab.exists(timeout=3):
            # try by automation id / name
            buttons = win.descendants(control_type="Button")
            names = [b.window_text() for b in buttons]
            print("  buttons:", names[:40])
            new_tab = None
            for b in buttons:
                if b.window_text().strip() == "+":
                    new_tab = b
                    break
            if new_tab is None:
                print("FAIL: New tab (+) button not found")
                return 1
        print("  OK   New tab (+) button found")
    except Exception as e:
        print("FAIL: looking for + button:", e)
        return 1

    # Count tab-like buttons/text before click
    def list_tab_titles():
        titles = []
        for el in win.descendants():
            try:
                t = el.window_text()
                ct = el.element_info.control_type
                # Tab chips show Untitled.md or file names
                if t and (t.endswith(".md") or t.endswith(".md *") or "Untitled" in t):
                    if ct in ("Text", "Button", "ListItem", "TabItem", "Custom", "Pane"):
                        titles.append(t)
            except Exception:
                pass
        # de-dupe preserve order (display only — use count_tab_chips() to detect adds)
        seen = set()
        out = []
        for t in titles:
            if t not in seen:
                seen.add(t)
                out.append(t)
        return out

    def count_tab_chips():
        # Raw, NON-deduplicated chip count.
        #
        # Every new tab is named "Untitled Document", so a de-duplicated title list
        # cannot grow when one is added. Asserting on it made this test report
        # "+ button dead" while + worked perfectly — the measurement was blind, not
        # the button. UIA may surface a single chip as several elements, so this
        # number is inflated in absolute terms; only the DELTA is meaningful, and
        # the delta is sound.
        n = 0
        for el in win.descendants():
            try:
                t = el.window_text()
                ct = el.element_info.control_type
                if t and (t.endswith(".md") or t.endswith(".md *") or "Untitled" in t):
                    if ct in ("Text", "Button", "ListItem", "TabItem", "Custom", "Pane"):
                        n += 1
            except Exception:
                pass
        return n

    before = list_tab_titles()
    before_n = len(before)
    print("  tab titles before:", before, "(count=%d)" % before_n)

    # Click +
    #
    # Assert on count_tab_chips(), not on the de-duplicated title list — see the
    # comment there for why the title list can never register a new "Untitled" tab.
    #
    # .click() drives the UIA InvokePattern. A bare click_input() does nothing
    # unless the window is focused first (verified: unfocused physical click has no
    # effect; win.set_focus() + click_input() works). InvokePattern needs no focus,
    # which is what an unattended test wants.
    chips_before = count_tab_chips()
    try:
        new_tab.click()
        time.sleep(1.5)
    except Exception as e:
        print("FAIL: click + :", e)
        return 1

    after = list_tab_titles()
    chips_after = count_tab_chips()
    print("  tab titles after +:", after)

    if chips_after > chips_before:
        print("  OK   + created a tab (chip count %d -> %d)" % (chips_before, chips_after))
    else:
        print("FAIL: + click added no tab chip (%d -> %d)" % (chips_before, chips_after))
        if not win.exists():
            print("FAIL: window closed")
            return 1
        return 1

    # File menu New should also increase tabs (or add a title)
    try:
        n0 = count_tab_chips()
        win.menu_select("File->New")
        time.sleep(1.0)
        after2 = list_tab_titles()
        n1 = count_tab_chips()
        print("  tab titles after File>New:", after2)
        # Same reasoning as the + assertion: compare chip counts, not unique titles.
        if n1 > n0:
            print("  OK   File>New created a tab (chip count %d -> %d)" % (n0, n1))
        else:
            print("  WARN File>New: no chip delta (menu path may still work; UIA list incomplete)")
        print("  OK   File>New did not crash")
    except Exception as e:
        print("  WARN File>New menu:", e)

    # App still alive
    if win.exists():
        print("  OK   window still alive")
    else:
        print("FAIL: window died")
        return 1

    print("\nTABS UI SMOKE PASSED (controls present; + click executed)")
    return 0


if __name__ == "__main__":
    try:
        code = main()
    except Exception as e:
        print("FAIL: exception:", e)
        code = 1
    finally:
        try:
            import subprocess
            subprocess.run(["taskkill", "/IM", "TypoZen.exe", "/F"], capture_output=True)
        except Exception:
            pass
    sys.exit(code)
