"""
End-to-end multi-tab content isolation test.
Launches TypoZen with --debug and TYPOZEN_TAB_E2E set; the app loads two files, switches
tabs, verifies editor content, writes tab-e2e-result.txt, and exits.
"""
import os
import sys
import time
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EXE = ROOT / "TypoZen.exe"
OUT = ROOT / "tests" / "_tab_e2e_out"


def kill_own(proc):
    """End only the process tree this script started."""
    subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True)


def main():
    if not EXE.exists():
        print("FAIL: TypoZen.exe not found at", EXE)
        return 1

    if OUT.exists():
        shutil.rmtree(OUT, ignore_errors=True)
    OUT.mkdir(parents=True, exist_ok=True)

    # Never kill a TypoZen this script did not start: `taskkill /IM TypoZen.exe /F` here
    # closed the user's own editor without saving. TYPOZEN_TAB_E2E turns off the
    # single-instance server, so this run can sit beside an open one; its own profile
    # folder keeps it out of that one's settings and session.
    env = os.environ.copy()
    env["TYPOZEN_TAB_E2E"] = str(OUT)
    env["TYPOZEN_PROFILE_DIR"] = str(OUT / "profile")

    print("Starting TypoZen tab content E2E...")
    print("  OUT=", OUT)
    proc = subprocess.Popen(
        [str(EXE), "--debug"],
        cwd=str(ROOT),
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    result_path = OUT / "tab-e2e-result.txt"
    deadline = time.time() + 45
    while time.time() < deadline:
        if result_path.exists() and result_path.stat().st_size > 0:
            # give app a moment to finish Close()
            time.sleep(0.5)
            break
        if proc.poll() is not None and not result_path.exists():
            time.sleep(0.5)
            if result_path.exists():
                break
            print("FAIL: process exited before writing result (code=%s)" % proc.returncode)
            return 1
        time.sleep(0.25)
    else:
        print("FAIL: timed out waiting for tab-e2e-result.txt")
        kill_own(proc)
        return 1

    # Ensure the process this script started is gone (and its WebView2 children).
    try:
        proc.wait(timeout=5)
    except Exception:
        kill_own(proc)

    text = result_path.read_text(encoding="utf-8", errors="replace")
    print(text)
    if text.startswith("PASS"):
        print("TABS CONTENT E2E PASSED")
        return 0
    print("TABS CONTENT E2E FAILED")
    return 1


if __name__ == "__main__":
    sys.exit(main())
