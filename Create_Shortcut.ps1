$WshShell = New-Object -ComObject WScript.Shell
$DesktopPath = [Environment]::GetFolderPath('Desktop')
$ShortcutPath = Join-Path $DesktopPath "TypoZen.lnk"

$ExePath = Join-Path $PSScriptRoot "TypoZen.exe"
$IcoPath = Join-Path $PSScriptRoot "TypoZen.ico"

if (-not (Test-Path $ExePath)) {
    Write-Host "TypoZen.exe not found in $PSScriptRoot. Please build the application first." -ForegroundColor Red
    exit 1
}

$Shortcut = $WshShell.CreateShortcut($ShortcutPath)
$Shortcut.TargetPath = $ExePath
$Shortcut.WorkingDirectory = $PSScriptRoot
if (Test-Path $IcoPath) {
    $Shortcut.IconLocation = "$IcoPath, 0"
} else {
    $Shortcut.IconLocation = "$ExePath, 0"
}
$Shortcut.Description = "TypoZen - Modern WYSIWYG Markdown & Text Editor"
$Shortcut.Save()

Write-Host "Desktop shortcut created successfully at: $ShortcutPath" -ForegroundColor Green
