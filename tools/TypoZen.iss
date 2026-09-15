; TypoZen installer (Inno Setup 6).
;
; Built by tools\Build-Installer.ps1, which passes AppVersion and checks that dist\
; actually holds that build. Source is dist\ -- the same portable payload the zip
; ships, assembled by Build-Portable.ps1 from the project root.
;
; PER-USER on purpose (PrivilegesRequired=lowest). It installs into
; %LocalAppData%\Programs\TypoZen, so there is no UAC prompt. The app is unsigned:
; Windows already shows "Windows protected your PC" on first run, and asking for
; administrator on top of that is a second reason to abandon the install. Nothing here
; needs machine-wide rights -- TypoZen writes only to its own profile folder.
;
; ASCII only. Windows PowerShell 5.1 reads a BOM-less file as ANSI, and the build
; wrapper is a .ps1.

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif

#define AppName "TypoZen"
#define AppPublisher "Zen Development"
#define AppURL "https://github.com/ec928/TypoZen"
#define AppExe "TypoZen.exe"

[Setup]
; Stable across versions: this GUID is how Windows recognises an upgrade rather than
; a second copy. Never change it.
AppId={{8E5C0A4C-3D8E-4C2B-9B1A-7F2D6E4A55C1}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppURL}
AppSupportURL={#AppURL}/issues
AppUpdatesURL={#AppURL}/releases
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
; The exe is AnyCPU with Prefer32Bit off, but the WebView2Loader.dll beside it is x64
; only -- so a 32-bit Windows would install happily and then fail to start the browser
; host. Refuse the install instead. x64compatible also covers ARM64, which runs it
; through emulation.
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
LicenseFile=..\LICENSE
OutputDir=..\dist-installer
OutputBaseFilename=TypoZen-Setup-{#AppVersion}
SetupIconFile=..\TypoZen.ico
UninstallDisplayIcon={app}\{#AppExe}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
; Windows 10 1809, the same floor the MSIX package declares.
MinVersion=10.0.17763

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; GroupDescription: "Shortcuts:"; Flags: unchecked
Name: "assocmd"; Description: "Open .md and .markdown files with TypoZen"; GroupDescription: "File associations:"
Name: "assocepub"; Description: "Open .epub books with TypoZen"; GroupDescription: "File associations:"

[Files]
; Everything the app reads at runtime: css\, js\, fonts\, the template, themes, the
; dictionary and thesaurus. Excludes are per-run artefacts and debug symbols.
Source: "..\dist\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs; \
  Excludes: "debug.log,perf.log,TypoZen_Template.runtime.html,TypoZen_Template_Test.html,TypoZen.pdb"

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\{#AppExe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; Tasks: desktopicon

[Registry]
; HKA resolves to HKCU for a per-user install, so these need no admin rights and are
; removed with the app. Windows still asks the user before changing a default handler.
Root: HKA; Subkey: "Software\Classes\TypoZen.Document"; ValueType: string; ValueName: ""; ValueData: "Markdown Document"; Flags: uninsdeletekey; Tasks: assocmd
Root: HKA; Subkey: "Software\Classes\TypoZen.Document\DefaultIcon"; ValueType: string; ValueName: ""; ValueData: "{app}\{#AppExe},0"; Tasks: assocmd
Root: HKA; Subkey: "Software\Classes\TypoZen.Document\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\{#AppExe}"" ""%1"""; Tasks: assocmd
Root: HKA; Subkey: "Software\Classes\.md\OpenWithProgids"; ValueType: string; ValueName: "TypoZen.Document"; ValueData: ""; Flags: uninsdeletevalue; Tasks: assocmd
Root: HKA; Subkey: "Software\Classes\.markdown\OpenWithProgids"; ValueType: string; ValueName: "TypoZen.Document"; ValueData: ""; Flags: uninsdeletevalue; Tasks: assocmd

Root: HKA; Subkey: "Software\Classes\TypoZen.Book"; ValueType: string; ValueName: ""; ValueData: "ePub Book"; Flags: uninsdeletekey; Tasks: assocepub
Root: HKA; Subkey: "Software\Classes\TypoZen.Book\DefaultIcon"; ValueType: string; ValueName: ""; ValueData: "{app}\{#AppExe},0"; Tasks: assocepub
Root: HKA; Subkey: "Software\Classes\TypoZen.Book\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\{#AppExe}"" ""%1"""; Tasks: assocepub
Root: HKA; Subkey: "Software\Classes\.epub\OpenWithProgids"; ValueType: string; ValueName: "TypoZen.Book"; ValueData: ""; Flags: uninsdeletevalue; Tasks: assocepub

[Run]
Filename: "{app}\{#AppExe}"; Description: "Start TypoZen"; Flags: nowait postinstall skipifsilent

; No [UninstallDelete]. Settings, themes, bookmarks and reading positions live in
; %LocalAppData%\TypoZen_Cache_Portable and are deliberately left behind: uninstalling
; to reinstall must not throw away where somebody was in a book.
