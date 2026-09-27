# Update-CodeMirror.ps1 -- bundle the parts of CodeMirror 6 that Source mode uses into
# js\vendor\codemirror\codemirror.js (one classic script, window.TzCM). ASCII only.
#
#   npm install --save-dev --save-exact @codemirror/view@<version> ...   (see package.json)
#   .\tools\Update-CodeMirror.ps1
#
# The entry point is tools\cm-entry.mjs: only what TypoZen imports is bundled. Licence
# comments are kept at the end of the file; THIRD-PARTY-NOTICES.txt carries the notices.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$esbuild = Join-Path $root 'node_modules\.bin\esbuild.cmd'
if (-not (Test-Path $esbuild)) { throw "esbuild is not installed - run: npm install" }
$entry = Join-Path $root 'tools\cm-entry.mjs'
$dstDir = Join-Path $root 'js\vendor\codemirror'
$dst = Join-Path $dstDir 'codemirror.js'
if (-not (Test-Path $dstDir)) { New-Item -ItemType Directory -Path $dstDir | Out-Null }
& $esbuild $entry --bundle --format=iife --global-name=TzCM --minify --target=chrome120 --legal-comments=eof "--outfile=$dst"
if ($LASTEXITCODE -ne 0) { throw "esbuild failed ($LASTEXITCODE)" }
$v = (Get-Content (Join-Path $root 'node_modules\@codemirror\view\package.json') -Raw | ConvertFrom-Json).version
Write-Host ("@codemirror/view " + $v + " -> js\vendor\codemirror\codemirror.js  (" + [math]::Round((Get-Item $dst).Length / 1KB) + " KB)")
