# Start-OnHiddenDesktop.ps1
#
# Launch a process on a separate Windows desktop, so its window never appears on the
# desktop the user is looking at and can never steal focus from what they are doing.
#
# Why this exists: the *-app.mjs suites drive the real TypoZen.exe. A full app-tier run
# makes 60 launchApp calls, every one of which pops a WPF window to the foreground, and
# app-harness press() calls bringToFront() before every keystroke because WebView2 drops
# keys to an unfocused window. The result was a window stealing focus roughly every
# thirty seconds for half an hour while the machine was in use.
#
# The automation itself never needed the screen: it drives the app over the DevTools
# protocol on a TCP port, which is desktop-independent. Only the window needed somewhere
# to live. A second desktop within the same window station gives it one -- the process
# renders normally (so WebView2 is not throttled the way a minimised window is), it just
# renders somewhere nobody is looking.
#
# Prints the new process id on stdout, and nothing else, so a caller can parse it.
#
#   powershell -File tools\Start-OnHiddenDesktop.ps1 -Exe "C:\...\TypoZen.exe" -Arguments "--debug"
#
# ASCII only. Windows PowerShell 5.1 reads a BOM-less file as ANSI, and one smart quote
# or em dash anywhere in here makes the whole script fail to parse.

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string] $Exe,
    [string] $ArgsBase64 = '',
    [string] $WorkingDirectory = '',
    [string] $DesktopName = 'typozen-e2e',
    [string] $EnvBase64 = ''
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $Exe)) { throw "Executable not found: $Exe" }
$Exe = (Resolve-Path -LiteralPath $Exe).Path
if ([string]::IsNullOrWhiteSpace($WorkingDirectory)) { $WorkingDirectory = Split-Path -Parent $Exe }
if (-not (Test-Path -LiteralPath $WorkingDirectory)) { throw "Working directory not found: $WorkingDirectory" }

$signature = @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class HiddenDesktop {
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr CreateDesktop(string desktop, IntPtr device, IntPtr devmode,
        int flags, uint access, IntPtr sa);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct STARTUPINFO {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_INFORMATION {
        public IntPtr hProcess, hThread;
        public int dwProcessId, dwThreadId;
    }

    // lpApplicationName is passed as IntPtr.Zero and the whole command line goes in
    // lpCommandLine as a mutable buffer: CreateProcess may write to that argument, and a
    // marshalled immutable string is not a legal target for it.
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CreateProcess(IntPtr applicationName, StringBuilder commandLine,
        IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint creationFlags,
        IntPtr environment, string currentDirectory, ref STARTUPINFO si, out PROCESS_INFORMATION pi);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint WaitForInputIdle(IntPtr process, uint milliseconds);
}
'@

if (-not ('HiddenDesktop' -as [type])) { Add-Type -TypeDefinition $signature }

# GENERIC_ALL. CreateDesktop returns the existing desktop's handle if the name is already
# taken, so repeated runs reuse one desktop rather than accumulating them.
$handle = [HiddenDesktop]::CreateDesktop($DesktopName, [IntPtr]::Zero, [IntPtr]::Zero, 0, 0x10000000, [IntPtr]::Zero)
if ($handle -eq [IntPtr]::Zero) {
    $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    throw "CreateDesktop('$DesktopName') failed: $((New-Object ComponentModel.Win32Exception $code).Message)"
}

# The child inherits this process's environment block, so setting the variables here is
# how they reach it -- CreateProcess is called with a null environment on purpose.
# Passed base64-encoded because powershell -File marshals every parameter as a string:
# a hashtable literal does not survive, and JSON on a Windows command line needs quoting
# that cmd.exe, PowerShell and JSON all disagree about. Base64 has none of those problems.
if (-not [string]::IsNullOrWhiteSpace($EnvBase64)) {
    $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($EnvBase64))
    $vars = $json | ConvertFrom-Json
    foreach ($prop in $vars.PSObject.Properties) {
        Set-Item -Path ("Env:" + $prop.Name) -Value ([string]$prop.Value) -Force
    }
}

$si = New-Object HiddenDesktop+STARTUPINFO
$si.cb = [Runtime.InteropServices.Marshal]::SizeOf($si)
$si.lpDesktop = "WinSta0\" + $DesktopName

$pi = New-Object HiddenDesktop+PROCESS_INFORMATION

# Arguments arrive base64-encoded as a JSON array for the same reason the environment
# does: a path like "7-Dune - Frank Herbert.epub" has to survive cmd.exe, PowerShell
# parameter binding and CreateProcess, and each of the three quotes differently. A token
# starting with "--" is also read as a parameter name by PowerShell if passed plainly.
$commandLine = New-Object System.Text.StringBuilder 32768
[void]$commandLine.Append('"').Append($Exe).Append('"')
if (-not [string]::IsNullOrWhiteSpace($ArgsBase64)) {
    $argJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($ArgsBase64))
    # NOT @($argJson | ConvertFrom-Json): in Windows PowerShell 5.1 ConvertFrom-Json emits
    # an array as a single object rather than enumerating it, so @(...) wraps the whole
    # array as ONE element and [string] on it joins the members with a space. That handed
    # TypoZen a single argument, '--debug <path>', which is neither the flag nor a file --
    # so the debug port never opened and the book never loaded. Assign, then foreach.
    $argList = ConvertFrom-Json -InputObject $argJson
    foreach ($a in $argList) {
        $t = [string]$a
        if ($t -match '\s|"') { [void]$commandLine.Append(' "').Append($t.Replace('"', '\"')).Append('"') }
        else { [void]$commandLine.Append(' ').Append($t) }
    }
}

$started = [HiddenDesktop]::CreateProcess([IntPtr]::Zero, $commandLine, [IntPtr]::Zero, [IntPtr]::Zero,
    $false, 0, [IntPtr]::Zero, $WorkingDirectory, [ref]$si, [ref]$pi)

if (-not $started) {
    $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    throw "CreateProcess failed: $((New-Object ComponentModel.Win32Exception $code).Message)"
}

# Hold the desktop open until the child has attached to it.
#
# This script's handle is the only thing keeping the desktop alive until the child's
# first thread connects to it, and exiting closes that handle. A child that has not
# connected yet -- a cold start straight after a build or install -- then fails user32
# initialisation and dies at once with 0x8007045A (ERROR_DLL_INIT_FAILED), before it
# writes anything or opens the DevTools port. That was the "intermittent" smoke failure.
# Measured 2026-09-17: closing the handle straight after CreateProcess killed 12 of 12
# launches; waiting for input idle first, 0 of 12. The wait returns in about a second,
# or at once if the child has already exited.
[void][HiddenDesktop]::WaitForInputIdle($pi.hProcess, 15000)

# stdout carries the pid and nothing else.
Write-Output $pi.dwProcessId
