$ErrorActionPreference = "Continue"
$appDir = $PSScriptRoot
Set-Location $appDir

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "        Building TypoZen (.exe)" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan

# Terminate running instances of TypoZen to release file locks.
# A fixed sleep used to race the lock: the process was gone but the exe was still held,
# so the compile failed with a misleading "compilation errors occurred" and the stale
# binary stayed on disk. Wait for the handle to actually release instead.
$exePath = Join-Path $appDir "TypoZen.exe"

function Test-ExeWritable {
    param([string]$Path)
    if (-not (Test-Path $Path)) { return $true }
    try {
        $fs = [System.IO.File]::Open($Path, 'Open', 'Write', 'None')
        $fs.Close()
        return $true
    } catch {
        return $false
    }
}

$running = @(Get-Process -Name "TypoZen" -ErrorAction SilentlyContinue)
if ($running.Count -gt 0) {
    Write-Host "Closing running instance of TypoZen..." -ForegroundColor Yellow
    $running | Stop-Process -Force -ErrorAction SilentlyContinue
}

$deadline = (Get-Date).AddSeconds(15)
while ((Get-Date) -lt $deadline) {
    $still = @(Get-Process -Name "TypoZen" -ErrorAction SilentlyContinue)
    if ($still.Count -eq 0 -and (Test-ExeWritable -Path $exePath)) { break }
    Start-Sleep -Milliseconds 200
}
if (-not (Test-ExeWritable -Path $exePath)) {
    Write-Host "[ERROR] TypoZen.exe is still locked after 15s - close it and retry." -ForegroundColor Red
    exit 1
}

# [0] Regression self-tests (serialize + list Backspace)
Write-Host "[0/4] Running regression self-tests..." -ForegroundColor Yellow
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    Write-Host "  [WARN] node not found - skipping JS self-tests" -ForegroundColor Yellow
}
else {
    # Gate on every suite, not just regression-selftest.mjs -- the others (undo,
    # backspace, multiselect, inline markdown, tabs) were never actually running.
    # *-browser.mjs are puppeteer suites: slow, and they assert against Phase 4 column
    # behaviour that is still in progress. Run them with .\tests\run-tests.ps1 after
    # setting RUN_BROWSER_E2E=1; they are not part of the build gate.
    $suites = @(Get-ChildItem (Join-Path $appDir "tests\*.mjs") -ErrorAction SilentlyContinue |
                Where-Object { $_.Name -notlike "*-browser.mjs" } | Sort-Object Name)
    if ($suites.Count -eq 0) {
        Write-Host "  [WARN] no tests\*.mjs found - skip" -ForegroundColor Yellow
    }
    else {
        # stderr goes to a temp file, never to the success stream. Merging it with 2>&1
        # makes PowerShell 5.1 wrap each line in a NativeCommandError and trip
        # $ErrorActionPreference, which reported phantom build failures for suites that
        # merely printed a diagnostic to stderr and exited 0. Gate on exit code alone.
        $failedSuites = @()
        $errFile = [System.IO.Path]::GetTempFileName()
        foreach ($suite in $suites) {
            & cmd /c "node `"$($suite.FullName)`" 2>`"$errFile`"" | Out-Null
            if ($LASTEXITCODE -ne 0) {
                $failedSuites += $suite.Name
                Write-Host ("  --- " + $suite.Name + " ---") -ForegroundColor Red
                Get-Content $errFile -ErrorAction SilentlyContinue | ForEach-Object { Write-Host ("      " + $_) }
            }
        }
        Remove-Item $errFile -Force -ErrorAction SilentlyContinue
        if ($failedSuites.Count -gt 0) {
            Write-Host ("[ERROR] Self-tests failed: " + ($failedSuites -join ", ")) -ForegroundColor Red
            Write-Host "        Run .\tests\run-tests.ps1 for details." -ForegroundColor Yellow
            exit 1
        }
        Write-Host ("  Self-tests passed (" + $suites.Count + " suites).") -ForegroundColor Green
    }
}

Write-Host "[1/4] Checking dependencies..." -ForegroundColor Yellow
$dlls = @("Microsoft.Web.WebView2.Core.dll", "Microsoft.Web.WebView2.Wpf.dll", "Microsoft.Web.WebView2.WinForms.dll", "WebView2Loader.dll")

# The WebView2 DLLs normally sit next to this script. Only go looking in the sibling
# 'Text Search' project for the ones that are actually missing -- the build used to
# abort outright when that unrelated folder was absent, even with every DLL present.
$missing = @($dlls | Where-Object { -not (Test-Path (Join-Path $appDir $_)) })
if ($missing.Count -gt 0) {
    Write-Host ("  Missing locally: " + ($missing -join ", ")) -ForegroundColor Gray
    $textSearchDir = Join-Path $appDir "Text Search"
    if (-not (Test-Path $textSearchDir)) {
        $textSearchDir = Join-Path (Split-Path $appDir -Parent) "Text Search"
    }
    if (Test-Path $textSearchDir) {
        Write-Host "  Sourcing them from: $textSearchDir" -ForegroundColor Gray
        foreach ($dll in $missing) {
            $src = Join-Path $textSearchDir $dll
            if (Test-Path $src) {
                try { Copy-Item -Path $src -Destination (Join-Path $appDir $dll) -Force -ErrorAction SilentlyContinue } catch {}
            }
        }
    }
    $stillMissing = @($dlls | Where-Object { -not (Test-Path (Join-Path $appDir $_)) })
    if ($stillMissing.Count -gt 0) {
        Write-Host ("[ERROR] Required WebView2 DLLs not found: " + ($stillMissing -join ", ")) -ForegroundColor Red
        Write-Host "        Copy them next to TypoZen_App.cs, or install the WebView2 SDK." -ForegroundColor Yellow
        exit 1
    }
}
Write-Host "  All WebView2 dependencies present." -ForegroundColor Gray

Write-Host "[2/4] Compiling TypoZen.exe..." -ForegroundColor Yellow
$compiled = $false

# Try MSBuild if available
$msbuild = Get-Command "msbuild" -ErrorAction SilentlyContinue
if ($null -ne $msbuild) {
    Write-Host "Using MSBuild..." -ForegroundColor Gray
    try {
        & msbuild TypoZen.csproj /p:Configuration=Release /verbosity:minimal
        if ($LASTEXITCODE -eq 0) { $compiled = $true }
    } catch {}
}

if (-not $compiled) {
    Write-Host "Using .NET PowerShell Compiler..." -ForegroundColor Gray
    $csFile = Join-Path $appDir "TypoZen_App.cs"
    $epubFile = Join-Path $appDir "EpubExtractor.cs"
    $exeFile = Join-Path $appDir "TypoZen.exe"
    if (Test-Path $exeFile) { 
        try { Remove-Item $exeFile -Force -ErrorAction SilentlyContinue } catch {} 
    }

    $code = (Get-Content $csFile -Raw -Encoding UTF8) + "`n" + (Get-Content $epubFile -Raw -Encoding UTF8)
    
    $wpfAssemblies = @(
        "System", "System.Core", "System.Drawing", "System.Windows.Forms",
        "Microsoft.VisualBasic",
        "System.IO.Compression", "System.IO.Compression.FileSystem",
        "System.Xml", "System.Xaml", "WindowsBase", "PresentationCore",
        "PresentationFramework", "WindowsFormsIntegration"
    )
    
    $refPaths = [System.Collections.ArrayList]::new()
    foreach ($asm in $wpfAssemblies) {
        try {
            $loaded = [System.Reflection.Assembly]::LoadWithPartialName($asm)
            if ($loaded -and $loaded.Location) { [void]$refPaths.Add($loaded.Location) }
            else { [void]$refPaths.Add($asm + ".dll") }
        } catch { [void]$refPaths.Add($asm + ".dll") }
    }
    
    [void]$refPaths.Add((Join-Path $appDir "Microsoft.Web.WebView2.Core.dll"))
    [void]$refPaths.Add((Join-Path $appDir "Microsoft.Web.WebView2.Wpf.dll"))
    [void]$refPaths.Add((Join-Path $appDir "Microsoft.Web.WebView2.WinForms.dll"))

    try {
        $cp = New-Object System.CodeDom.Compiler.CompilerParameters
        $cp.GenerateExecutable = $true
        $cp.OutputAssembly = $exeFile
        $cp.CompilerOptions = "/target:winexe /optimize"
        foreach ($ref in $refPaths) { [void]$cp.ReferencedAssemblies.Add($ref) }

        $icoPath = Join-Path $appDir "TypoZen.ico"
        if (Test-Path $icoPath) {
            $cp.CompilerOptions += " /win32icon:`"$icoPath`""
        }

        # Compile through the provider rather than Add-Type: Add-Type collapses every
        # failure into "Cannot add type. Compilation errors occurred." with no file, line
        # or reason - which made a mere file lock look like broken source. CompilerResults
        # carries the real diagnostics.
        $provider = New-Object Microsoft.CSharp.CSharpCodeProvider
        $result = $provider.CompileAssemblyFromSource($cp, $code)
        $errors = @($result.Errors | Where-Object { -not $_.IsWarning })
        if ($errors.Count -gt 0) {
            Write-Host "[ERROR] Compilation failed with $($errors.Count) error(s):" -ForegroundColor Red
            foreach ($e in ($errors | Select-Object -First 15)) {
                Write-Host ("  TypoZen_App.cs(" + $e.Line + "): " + $e.ErrorNumber + " " + $e.ErrorText) -ForegroundColor Yellow
            }
            exit 1
        }
        if (-not (Test-Path $exeFile)) {
            Write-Host "[ERROR] Compiler reported success but produced no exe." -ForegroundColor Red
            exit 1
        }
        Write-Host "Compilation successful!" -ForegroundColor Green
        $compiled = $true
    } catch {
        Write-Host "[ERROR] Compilation failed:" -ForegroundColor Red
        Write-Host $_.Exception.Message -ForegroundColor Yellow
        exit 1
    }
}

Write-Host "`n[4/4] Build Complete! TypoZen.exe is ready." -ForegroundColor Green
Write-Host "You can now run TypoZen.exe directly or open TypoZen.csproj in Visual Studio." -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
