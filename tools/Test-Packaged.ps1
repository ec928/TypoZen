# Test-Packaged.ps1 - register the BUILT dist-msix\TypoZen.msix (not a re-stage of bin\) as a
# loose package and launch it by AUMID with --debug and a book, for packaged-smoke-app.mjs.
#
#   .\tools\Test-Packaged.ps1            # unpack, register, launch
#   node tests/packaged-smoke-app.mjs
#   .\tools\Test-Packaged.ps1 -Remove    # close the app first; removes the package and its profile
#
# Needs Developer Mode. Build-Msix.ps1 -Register registers a fresh stage of bin\, which can
# hold later work than the package about to be submitted; this registers the package itself.
# It unpacks inside dist-msix rather than under %LocalAppData%.
param([switch]$Remove)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dir  = Join-Path $root 'dist-msix\verify-unpacked'

if ($Remove) {
    Get-AppxPackage *TypoZen* | Remove-AppxPackage
    if (Test-Path $dir) { Remove-Item $dir -Recurse -Force }
    "removed; packages left: $(@(Get-AppxPackage *TypoZen*).Count)"
    return
}

$makeappx = Get-ChildItem "C:\Program Files (x86)\Windows Kits\10\bin" -Recurse -Filter makeappx.exe -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match '\\x64\\' } | Sort-Object FullName -Descending | Select-Object -First 1
if (-not $makeappx) { throw "makeappx.exe not found. Install the Windows 10/11 SDK." }
if (Test-Path $dir) { Remove-Item $dir -Recurse -Force }
& $makeappx.FullName unpack /p (Join-Path $root 'dist-msix\TypoZen.msix') /d $dir /o | Out-Null
if ($LASTEXITCODE -ne 0) { throw "unpack failed $LASTEXITCODE" }
# Loose registration wants a plain folder layout, not the packed-only metadata.
foreach ($f in 'AppxBlockMap.xml', 'AppxSignature.p7x', '[Content_Types].xml') {
    $p = Join-Path $dir $f; if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Force }
}
Add-AppxPackage -Register (Join-Path $dir 'AppxManifest.xml') -ForceUpdateFromAnyVersion
$pkg = Get-AppxPackage *TypoZen*
"registered: $($pkg.Name) $($pkg.Version) $($pkg.PackageFamilyName)"
"exe version: " + (Get-Item (Join-Path $dir 'TypoZen.exe')).VersionInfo.FileVersion

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
[ComImport, Guid("2e941141-7f97-4756-ba1d-9decde894a3d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IApplicationActivationManager {
    int ActivateApplication([MarshalAs(UnmanagedType.LPWStr)] string appUserModelId, [MarshalAs(UnmanagedType.LPWStr)] string arguments, int options, out uint processId);
    int ActivateForFile(IntPtr a, IntPtr b, [MarshalAs(UnmanagedType.LPWStr)] string c, out uint d);
    int ActivateForProtocol(IntPtr a, IntPtr b, out uint c);
}
[ComImport, Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")]
public class ApplicationActivationManager { }
public static class TzActivator {
    public static uint Run(string aumid, string args) {
        var m = (IApplicationActivationManager)new ApplicationActivationManager();
        uint pid; int hr = m.ActivateApplication(aumid, args, 0, out pid);
        if (hr != 0) throw new Exception("ActivateApplication hr=0x" + hr.ToString("X8"));
        return pid;
    }
}
'@
$book = Join-Path $root 'tests\alices-adventures-in-wonderland3.epub'
$appPid = [TzActivator]::Run("$($pkg.PackageFamilyName)!TypoZen", "--debug `"$book`"")
"launched pid $appPid"
