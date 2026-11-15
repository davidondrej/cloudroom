; Cloudroom's Windows installer hooks (see electron-builder.config.json, nsis.include).
;
; The preview helper is a detached Python process that keeps python.exe open after
; Cloudroom quits. Setup, update, repair and uninstall stop it before the installer
; replaces or removes files, or Windows keeps the old files locked.

!include LogicLib.nsh

; The install path can contain spaces, quotes and non-ASCII characters, so it
; reaches the scripts through the environment instead of being pasted into code.
!macro cloudroomSetInstallDir
  Push $0
  System::Call 'Kernel32::SetEnvironmentVariable(t, t) i("CLOUDROOM_INSTALL_DIR", "$INSTDIR") .r0'
  Pop $0
!macroend

; Ask the helper to pause, then force-stop any python.exe still running from this
; install folder. The pause writes status.json and clears the helper's pid file; the
; stop is the fallback for a helper that is wedged or still starting.
!macro cloudroomPausePreviewHelper
  ${If} ${FileExists} "$INSTDIR\resources\app.asar.unpacked\node_modules\bb-app\server\dist\assets\python\python.exe"
  ${AndIf} ${FileExists} "$INSTDIR\resources\app.asar.unpacked\node_modules\bb-app\server\dist\assets\cloudroom-preview\client.py"
  ${AndIf} ${FileExists} "$PROFILE\.gui-cloudroom\cloudroom-preview\config.json"
    nsExec::ExecToLog '"$INSTDIR\resources\app.asar.unpacked\node_modules\bb-app\server\dist\assets\python\python.exe" -B -E -s "$INSTDIR\resources\app.asar.unpacked\node_modules\bb-app\server\dist\assets\cloudroom-preview\client.py" pause "$PROFILE\.gui-cloudroom\cloudroom-preview"'
    Pop $0
  ${EndIf}
!macroend

; PowerShell 5.1 unrolls a single pipeline result to one object, so the count goes
; through @(...). The path arrives as $env:CLOUDROOM_INSTALL_DIR: splicing $INSTDIR
; into -Command breaks on quotes and backslashes.
!macro cloudroomStopPython
  !insertmacro cloudroomSetInstallDir
  nsExec::ExecToStack `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$left = { Get-CimInstance Win32_Process | Where-Object { $$_.Name -eq 'python.exe' -and $$_.ExecutablePath -and $$_.ExecutablePath.StartsWith($$env:CLOUDROOM_INSTALL_DIR, 'OrdinalIgnoreCase') } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue } }; @(& $$left).Count | Out-Null"`
  Pop $0
  Pop $1
!macroend

!macro stopPreviewHelper
  !insertmacro cloudroomPausePreviewHelper
  !insertmacro cloudroomStopPython
!macroend

!macro customInit
  !insertmacro stopPreviewHelper
!macroend

!macro customUnInit
  !insertmacro stopPreviewHelper
!macroend

; electron-builder's default check looks for a window by name and misses a hidden
; process. Compare executable paths instead, again through the environment.
!macro cloudroomAppCheck
  !insertmacro cloudroomSetInstallDir
  nsExec::ExecToStack `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$left = { Get-CimInstance Win32_Process | Where-Object { $$_.Name -eq 'Cloudroom.exe' -and $$_.ExecutablePath -and $$_.ExecutablePath.StartsWith($$env:CLOUDROOM_INSTALL_DIR, 'OrdinalIgnoreCase') } }; if (@(& $$left).Count -gt 0) { exit 1 } else { exit 0 }"`
  Pop $0
  Pop $1
  ${If} $0 == 1
    MessageBox MB_OK|MB_ICONEXCLAMATION "Cloudroom is still running. Close it, then run the installer again." /SD IDOK
    Abort
  ${EndIf}
!macroend

!macro customCheckAppRunning
  !insertmacro cloudroomAppCheck
!macroend
