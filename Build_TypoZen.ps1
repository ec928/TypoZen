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
    # Keep the jsdom fixture equal to the shipping code before anything runs, otherwise
    # the suites pin themselves to whatever TypoZen_Template_Test.html last contained.
    & node (Join-Path $appDir "tests\build-test-template.mjs")
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[ERROR] Could not regenerate TypoZen_Template_Test.html" -ForegroundColor Red
        exit 1
    }

    # Naming convention:
    #   *-pending.mjs  assert behaviour that is genuinely not built yet (Phase 4 column
    #                  anchoring). Opt in with RUN_PENDING_E2E=1. Never gate on these.
    #   everything else, including *-browser.mjs, gates the build.
    #
    # The browser suites are slow (they drive headless Chrome) but they are not optional.
    # 2-column mode shipped broken behind a fully green jsdom suite: the class was applied
    # and the resolver logic was right, but the CSS gated columns on .reader-mode so the
    # computed column-count stayed 'auto'. jsdom has no layout engine and cannot tell those
    # apart. Excluding the one suite that could see it is what let the bug through.
    # *-app.mjs launch TypoZen.exe itself and need a desktop session, so they are not part
    # of the build gate; run them with RUN_APP_E2E=1 .\tests\run-tests.ps1. app-harness.mjs
    # is their helper, not a suite.
    $helpers = @('app-harness.mjs', 'build-test-template.mjs', 'engine-source.mjs', 'settle.mjs', 'epub-zip.mjs')
    $suites = @(Get-ChildItem (Join-Path $appDir "tests\*.mjs") -ErrorAction SilentlyContinue |
                Where-Object { $_.Name -notlike "*-pending.mjs" -and $_.Name -notlike "*-app.mjs" `
                               -and ($helpers -notcontains $_.Name) } | Sort-Object Name)
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

# TypoZen.xaml is parsed at runtime by XamlReader, so markup errors are invisible to the
# compiler and surface as a crash on launch instead. Parse it here and fail the build.
Write-Host "[0b/4] Parsing TypoZen.xaml..." -ForegroundColor Yellow
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase
$xamlPath = Join-Path $appDir "TypoZen.xaml"
try {
    $xamlStream = [System.IO.File]::OpenRead($xamlPath)
    try { $parsedWindow = [System.Windows.Markup.XamlReader]::Load($xamlStream) }
    finally { $xamlStream.Close() }
    Write-Host "  XAML parsed cleanly." -ForegroundColor Green
}
catch {
    Write-Host "[ERROR] TypoZen.xaml failed to parse - the app would crash on launch:" -ForegroundColor Red
    Write-Host ("        " + $_.Exception.Message) -ForegroundColor Red
    if ($_.Exception.InnerException) {
        Write-Host ("        " + $_.Exception.InnerException.Message) -ForegroundColor Red
    }
    exit 1
}

Write-Host "[1/4] Checking dependencies..." -ForegroundColor Yellow
# The WinForms flavour only. The control is hosted in a WindowsFormsHost, nothing imports
# Microsoft.Web.WebView2.Wpf, and neither Core nor WinForms references it -- it was carried
# for its own sake. Keep in step with the <Reference> list in TypoZen.csproj.
$dlls = @("Microsoft.Web.WebView2.Core.dll", "Microsoft.Web.WebView2.WinForms.dll", "WebView2Loader.dll")

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
    # Separate .cs files (partials + EpubReader). Compile as files, not one concatenated
    # string — joining sources puts a second file's `using` inside the first namespace.
    $csFiles = @(Get-ChildItem (Join-Path $appDir "*.cs") -File | Sort-Object Name | ForEach-Object { $_.FullName })
    if ($csFiles.Count -eq 0) {
        Write-Host "[ERROR] No .cs files found to compile." -ForegroundColor Red
        exit 1
    }
    Write-Host ("  Sources: " + (($csFiles | ForEach-Object { Split-Path $_ -Leaf }) -join ", ")) -ForegroundColor Gray
    $exeFile = Join-Path $appDir "TypoZen.exe"
    if (Test-Path $exeFile) { 
        try { Remove-Item $exeFile -Force -ErrorAction SilentlyContinue } catch {} 
    }

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
        # carries the real diagnostics. FromFile keeps partials and per-file usings valid.
        $provider = New-Object Microsoft.CSharp.CSharpCodeProvider
        $result = $provider.CompileAssemblyFromFile($cp, [string[]]$csFiles)
        $errors = @($result.Errors | Where-Object { -not $_.IsWarning })
        if ($errors.Count -gt 0) {
            Write-Host "[ERROR] Compilation failed with $($errors.Count) error(s):" -ForegroundColor Red
            foreach ($e in ($errors | Select-Object -First 15)) {
                Write-Host ("  " + $e.FileName + "(" + $e.Line + "): " + $e.ErrorNumber + " " + $e.ErrorText) -ForegroundColor Yellow
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
