; QuickCut Windows Inno Setup Script
#ifndef MyAppVersion
  #define MyAppVersion "2.7.43"
#endif
#ifndef SourceDir
  #define SourceDir "D:\QuickCut-win-pack\QuickCut-Windows-2.7.43"
#endif

#define MyAppName "快剪"
#define MyAppPublisher "HX"
#define MyAppURL "https://github.com/nuosishizi/quick_cut"
#define MyAppExeName "快剪.exe"

[Setup]
AppId={{D548261F-E9C4-41A8-8F6A-3F98A7B5F03A}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppURL}
DefaultDirName={autopf}\QuickCut
DisableProgramGroupPage=yes
OutputBaseFilename=QuickCut-Windows-{#MyAppVersion}-Setup
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
UninstallDisplayIcon={app}\{#MyAppExeName}

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "附加快捷方式:"

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "安装完成，立即运行快剪"; Flags: nowait postinstall skipifsilent
