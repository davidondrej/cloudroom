; Windows installer hooks (electron-builder NSIS).
!macro customHeader
  ; Without DPI awareness Windows stretches the installer on scaled displays, so text is blurry.
  ; XPStyle loads modern common controls, which the "still running" task dialog needs.
  ManifestDPIAware true
  XPStyle on
  ; For install-timing.json: how long setup waited for Cloudroom.exe to unlock, and how often it asked the user.
  Var cloudroomLockWaitMs
  Var cloudroomPrompts
  !include FileFunc.nsh
!macroend

; .next and .old are ours only with this file in them, so a user's own "Cloudroom.next" or "Cloudroom.old" is never
; deleted, filled, or moved (#2535 review).
!macro cloudroomRemoveOwned DIR
  ${If} ${FileExists} "${DIR}\.cloudroom-owned"
    RMDir /r "${DIR}"
    ; RMDir deletes the marker first, so a locked file left behind must not turn the rest into a user's folder.
    ${If} ${FileExists} "${DIR}"
      FileOpen $R2 "${DIR}\.cloudroom-owned" w
      FileClose $R2
    ${EndIf}
  ${EndIf}
!macroend

; Staged updates (#2525), like Squirrel.Mac: while Cloudroom runs, the app starts the downloaded installer with
; --cloudroom-stage, which only unpacks the new version to "<install dir>.next" and exits. Restart to update runs the
; installer as before; with a matching stage it swaps the two folders instead of uninstalling and unpacking again.
!macro cloudroomStageIfAsked
  !ifndef BUILD_UNINSTALLER
    ${GetParameters} $R0
    ClearErrors
    ${GetOptions} $R0 "--cloudroom-stage" $R1
    ${IfNot} ${Errors}
      SetSilent silent
      InitPluginsDir
      !insertmacro cloudroomRemoveOwned "$INSTDIR.next"
      ; A folder or file we don't own: never fill it.
      ${If} ${FileExists} "$INSTDIR.next"
        SetErrorLevel 2
        Quit
      ${EndIf}
      ClearErrors
      CreateDirectory "$INSTDIR.next"
      FileOpen $R2 "$INSTDIR.next\.cloudroom-owned" w
      FileClose $R2
      ${If} ${Errors}
        RMDir "$INSTDIR.next"
        SetErrorLevel 2
        Quit
      ${EndIf}
      ; Same data as the install section's copy, so makensis stores the package once.
      !ifdef COMPRESS
        SetCompress off
      !endif
      File /oname=$PLUGINSDIR\app-64.7z "${APP_64}"
      !ifdef COMPRESS
        SetCompress "${COMPRESS}"
      !endif
      SetOutPath "$INSTDIR.next"
      Nsis7z::Extract "$PLUGINSDIR\app-64.7z"
      SetOutPath $TEMP
      ; Nsis7z reports no errors, so check the result: every file the build packed (resources\cloudroom-files.txt,
      ; written by afterPack) and at least 99% of the unpacked size electron-builder measured. The marker keeps the
      ; file count and size; the swap re-checks them, so a file lost since (antivirus) is caught.
      ${GetSize} "$INSTDIR.next" "/S=0K" $R3 $R4 $R5
      IntOp $R5 ${APP_64_UNPACKED_SIZE} * 99
      IntOp $R5 $R5 / 100
      StrCpy $R6 ""
      ClearErrors
      FileOpen $R2 "$INSTDIR.next\resources\cloudroom-files.txt" r
      FileRead $R2 $R6
      FileClose $R2
      ${If} $R6 == ""
        StrCpy $R6 999999
      ${EndIf}
      ; .cloudroom-owned isn't in the build's count.
      IntOp $R6 $R6 + 1
      ; Also give up if Cloudroom was uninstalled meanwhile (its uninstaller deletes .next, maybe mid-unpack).
      ${If} $R3 < $R5
      ${OrIf} $R4 < $R6
      ${OrIfNot} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
        !insertmacro cloudroomRemoveOwned "$INSTDIR.next"
        SetErrorLevel 2
        Quit
      ${EndIf}
      ; Written last: without it, Restart to update does the full install.
      ClearErrors
      FileOpen $R2 "$INSTDIR.next\.cloudroom-staged" w
      FileWrite $R2 "${VERSION} $R4 $R3"
      FileClose $R2
      ${If} ${Errors}
        !insertmacro cloudroomRemoveOwned "$INSTDIR.next"
        SetErrorLevel 2
      ${Else}
        SetErrorLevel 0
      ${EndIf}
      Quit
    ${EndIf}
  !endif
!macroend

; Runs once our app check stopped Cloudroom. Any failure leaves the old folder in place for the full install.
!macro cloudroomSwapStaged
  !ifndef BUILD_UNINSTALLER
  ${If} ${isUpdated}
  ${AndIf} ${FileExists} "$INSTDIR.next\.cloudroom-staged"
  ${AndIf} ${FileExists} "$INSTDIR.next\.cloudroom-owned"
    ClearErrors
    FileOpen $R2 "$INSTDIR.next\.cloudroom-staged" r
    FileRead $R2 $R3
    FileClose $R2
    ; The marker is "<version> <files> <KB>"; the folder must still match it (the marker itself is one more file).
    Delete "$INSTDIR.next\.cloudroom-staged"
    ${GetSize} "$INSTDIR.next" "/S=0K" $R5 $R6 $R7
    ${If} $R3 == "${VERSION} $R6 $R5"
      System::Call 'kernel32::GetTickCount()i .s'
      Pop $R4
      ; The uninstaller comes from this installer, so the stage never needs it.
      ClearErrors
      File "/oname=$INSTDIR.next\${UNINSTALL_FILENAME}" "${UNINSTALLER_OUT_FILE}"
      ; Windows can't rename a folder that is a process's working folder, ours included.
      SetOutPath $TEMP
      ${IfNot} ${Errors}
        !insertmacro cloudroomRemoveOwned "$INSTDIR.old"
        ClearErrors
        ${If} ${FileExists} "$INSTDIR.old\*.*"
          SetErrors
        ${Else}
          FileOpen $R2 "$INSTDIR\.cloudroom-owned" w
          FileClose $R2
          ; Without the marker, a cut-off swap could never be restored.
          ${IfNot} ${Errors}
            Rename "$INSTDIR" "$INSTDIR.old"
          ${EndIf}
        ${EndIf}
      ${EndIf}
      ${IfNot} ${Errors}
        Rename "$INSTDIR.next" "$INSTDIR"
        ${If} ${Errors}
          ; Put the old version back. If even that fails, the full install below fills the folder, and the next
          ; installer run finds .old (cloudroomRecoverSwap).
          ClearErrors
          Rename "$INSTDIR.old" "$INSTDIR"
        ${ElseIfNot} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
          Rename "$INSTDIR" "$INSTDIR.next"
          Rename "$INSTDIR.old" "$INSTDIR"
        ${Else}
          !insertmacro registryAddInstallInfo
          !insertmacro copyFile "$EXEPATH" "$LOCALAPPDATA\${APP_INSTALLER_STORE_FILE}"
          System::Call 'kernel32::GetTickCount()i .s'
          Pop $R0
          IntOp $R4 $R0 - $R4
          IntOp $R0 $R0 - $cloudroomInstallStart
          IntOp $cloudroomLockWaitMs $cloudroomLockWaitMs + 0
          IntOp $cloudroomPrompts $cloudroomPrompts + 0
          FileOpen $R2 "$INSTDIR\install-timing.json" w
          FileWrite $R2 '{"ms":$R0,"update":true,"staged":true,"swap_ms":$R4,"lock_wait_ms":$cloudroomLockWaitMs,"prompts":$cloudroomPrompts}'
          FileClose $R2
          ${If} ${isForceRun}
            HideWindow
            ; Like the full install's StartApp: through the Start Menu shortcut, which carries the app's taskbar ID.
            StrCpy $R1 "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
            ${If} ${FileExists} "$newStartMenuLink"
              StrCpy $R1 "$newStartMenuLink"
            ${EndIf}
            ${StdUtils.ExecShellAsUser} $0 "$R1" "open" "--updated"
          ${EndIf}
          !insertmacro cloudroomRemoveOwned "$INSTDIR.old"
          SetErrorLevel 0
          Quit
        ${EndIf}
      ${EndIf}
    ${EndIf}
  ${EndIf}
  ; A stage that can't be used is stale.
  !insertmacro cloudroomRemoveOwned "$INSTDIR.next"
  !endif
!macroend

; A swap cut off between its two renames leaves no app in the install folder but a whole one in .old: put it back.
; Runs first in every installer start, staging included.
!macro cloudroomRecoverSwap
  !ifndef BUILD_UNINSTALLER
  ${IfNot} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  ${AndIf} ${FileExists} "$INSTDIR.old\${APP_EXECUTABLE_FILENAME}"
  ${AndIf} ${FileExists} "$INSTDIR.old\.cloudroom-owned"
    SetOutPath $TEMP
    RMDir /r "$INSTDIR"
    Rename "$INSTDIR.old" "$INSTDIR"
  ${EndIf}
  !endif
!macroend

; The detached cloud preview helper runs the bundled python.exe from the install folder and keeps it locked,
; so stop it before an install, update or uninstall replaces files. The next app launch restarts it.
!macro stopPreviewHelper
  ; A fresh install has no folder yet, so nothing runs from it: skip starting PowerShell.
  ${IfNot} ${FileExists} "$INSTDIR\*.*"
    Goto cloudroomHelperStopped
  ${EndIf}
  ; Ask it to exit: `pause` waits up to 10 s and keeps the device paired (`stop` is for sign-out).
  ; Not from an elevated setup: files it writes there would belong to Administrators, and the normal app couldn't
  ; open them (#2459). The force-stop below still ends the helper.
  System::Call 'shell32::IsUserAnAdmin()i .r0'
  ${If} $0 == 0
  ${AndIf} ${FileExists} "$INSTDIR\resources\app.asar.unpacked\node_modules\bb-app\server\dist\assets\python\python.exe"
  ${AndIf} ${FileExists} "$PROFILE\.gui-cloudroom\cloudroom-preview\client.py"
    nsExec::Exec `"$INSTDIR\resources\app.asar.unpacked\node_modules\bb-app\server\dist\assets\python\python.exe" -B -E -s "$PROFILE\.gui-cloudroom\cloudroom-preview\client.py" pause "$PROFILE\.gui-cloudroom\cloudroom-preview"`
    Pop $0
    DetailPrint "Preview helper pause exit code: $0"
  ${EndIf}
  ; Then force-stop any python*.exe still running from here (another data dir, or a helper that didn't exit),
  ; and wait until none is left. PowerShell reads the folder from the environment, so no character in the
  ; path can break its quoting. Exit code 1: one survived 10 s.
  ; electron-builder's own check misses a lone process: in Windows PowerShell 5.1 its (...).Count is empty for one match.
  System::Call 'Kernel32::SetEnvironmentVariable(t "CLOUDROOM_INSTALL_DIR", t "$INSTDIR\")i'
  nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "$$left = { @(Get-CimInstance Win32_Process | ? { $$_.Name -like 'python*.exe' -and $$_.ExecutablePath -and $$_.ExecutablePath.StartsWith($$env:CLOUDROOM_INSTALL_DIR, 'OrdinalIgnoreCase') }) }; & $$left | % { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }; for ($$i = 0; $$i -lt 20 -and @(& $$left).Count -gt 0; $$i++) { Start-Sleep -Milliseconds 500 }; if (@(& $$left).Count -gt 0) { exit 1 }; exit 0"`
  Pop $0
  ${If} $0 == 1
    MessageBox MB_OK|MB_ICONSTOP "Cloudroom's preview helper (python.exe) is still running, so Cloudroom can't be updated or removed. End it in Task Manager, then try again." /SD IDOK
    Quit
  ${EndIf}
  cloudroomHelperStopped:
!macroend

!macro cloudroomAppCheck
  ; Lists this install's processes; with CLOUDROOM_STOP_APP it kills them on every pass, so one started during the
  ; wait (an agent restarting a Cloudroom helper) is stopped too. Exit 1 prints the survivors.
  nsExec::ExecToStack `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "trap { exit 2 }; $$me = (Get-CimInstance Win32_Process -Filter ('ProcessId=' + $$PID) -ErrorAction Stop).ParentProcessId; $$left = { @(Get-CimInstance Win32_Process -ErrorAction Stop | ? { $$_.ProcessId -ne $$me -and $$_.ExecutablePath -and $$_.ExecutablePath.StartsWith($$env:CLOUDROOM_INSTALL_DIR, 'OrdinalIgnoreCase') }) }; for ($$i = 0; ($$p = @(& $$left)).Count -gt 0 -and $$env:CLOUDROOM_STOP_APP -and $$i -lt 20; $$i++) { $$p | % { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }; Start-Sleep -Milliseconds 500 }; if ($$p.Count -gt 0) { try { ($$p | % { $$_.Name + ' (PID ' + $$_.ProcessId + ')' }) -join ', ' } catch {}; exit 1 }; exit 0"`
  Pop $0
  Pop $R1
  ; An elevated Cloudroom has no path in that list and can't be killed, but its running exe can't be opened for
  ; writing: that fails with a sharing violation (32), unlike a read-only file or a denied ACL (5).
  ; Windows keeps the exe locked for a moment after a Cloudroom that just quit or was killed leaves that list,
  ; so the lock must outlast 10 s before it counts.
  ${If} $0 == 0
    ${For} $R2 1 40
      System::Call 'kernel32::CreateFileW(w "$INSTDIR\${APP_EXECUTABLE_FILENAME}", i 0x40000000, i 7, p 0, i 3, i 0x80, p 0) p .R1 ?e'
      Pop $0
      ${If} $R1 != -1
        System::Call 'kernel32::CloseHandle(p R1)'
      ${EndIf}
      ${If} $R1 != -1
      ${OrIf} $0 != 32
        ${ExitFor}
      ${EndIf}
      Sleep 250
      IntOp $cloudroomLockWaitMs $cloudroomLockWaitMs + 250
    ${Next}
    ${If} $R1 == -1
    ${AndIf} $0 == 32
      StrCpy $0 1
      StrCpy $R1 "${APP_EXECUTABLE_FILENAME}, probably running as administrator$\r$\n"
    ${Else}
      StrCpy $0 0
      StrCpy $R1 ""
    ${EndIf}
  ${EndIf}
!macroend

!macro customCheckAppRunning
  ; Same here: with no folder, none of our processes can be running.
  ${IfNot} ${FileExists} "$INSTDIR\*.*"
    Goto cloudroomAppChecked
  ${EndIf}
  System::Call 'Kernel32::SetEnvironmentVariable(t "CLOUDROOM_INSTALL_DIR", t "$INSTDIR\")i'
  System::Call 'Kernel32::SetEnvironmentVariable(t "CLOUDROOM_STOP_APP", t "")i'
  !insertmacro cloudroomAppCheck
  ${If} $0 == 1
  ${AndIfNot} ${isUpdated}
    MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDOK IDOK +2
    Quit
  ${EndIf}
  ${If} $0 == 1
    System::Call 'Kernel32::SetEnvironmentVariable(t "CLOUDROOM_STOP_APP", t "1")i'
    cloudroomStopApp:
    !insertmacro cloudroomAppCheck
    ${If} $0 == 1
      IntOp $cloudroomPrompts $cloudroomPrompts + 1
      ${If} ${Silent}
        Quit
      ${EndIf}
      ; A task dialog has a heading and Retry/Cancel; the plain message box is the fallback if it can't open.
      ; Pass the text by register: it holds apostrophes that would break the quoted call.
      StrCpy $R2 "Still running: $R1$\nEnd it in Task Manager (Details tab), then click Retry. If it won't end, restart Windows and run the update again."
      StrCpy $R3 0
      System::Call 'comctl32::TaskDialog(p $HWNDPARENT, p 0, w "Cloudroom Setup", w "Cloudroom is still running", w R2, i 0x18, p 0xFFFF, *i .R3) i .R4'
      ${If} $R4 != 0
        MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "Cloudroom is still running.$\n$\n$R2" IDRETRY cloudroomStopApp
        Quit
      ${EndIf}
      ${If} $R3 == 4
        Goto cloudroomStopApp
      ${EndIf}
      Quit
    ${EndIf}
  ${EndIf}
  ${If} $0 != 0
  ${AndIf} $0 != 1
    nsExec::Exec `"$SYSDIR\taskkill.exe" /F /IM "${APP_EXECUTABLE_FILENAME}"`
    Pop $0
    Sleep 1000
  ${EndIf}
  cloudroomAppChecked:
  !insertmacro cloudroomSwapStaged
!macroend

!macro customInit
  !insertmacro cloudroomRecoverSwap
  ; Staging runs while Cloudroom is open, so it must not stop the preview helper below.
  !insertmacro cloudroomStageIfAsked
  ; Start the install timer first (see customInstall). GetTickCount wraps every 49 days; the difference still comes out right.
  Var /GLOBAL cloudroomInstallStart
  System::Call 'kernel32::GetTickCount()i .s'
  Pop $cloudroomInstallStart
  !insertmacro stopPreviewHelper
!macroend

!macro customInstall
  ; How long this install took, fresh or update, and the lock wait and prompts above. The app reports it on its next start, then deletes the file
  ; (setup-telemetry.ts). We had no real-world numbers for the Windows install.
  System::Call 'kernel32::GetTickCount()i .s'
  Pop $R0
  IntOp $R0 $R0 - $cloudroomInstallStart
  StrCpy $R1 "false"
  ${If} ${isUpdated}
    StrCpy $R1 "true"
  ${EndIf}
  IntOp $cloudroomLockWaitMs $cloudroomLockWaitMs + 0
  IntOp $cloudroomPrompts $cloudroomPrompts + 0
  FileOpen $R2 "$INSTDIR\install-timing.json" w
  FileWrite $R2 '{"ms":$R0,"update":$R1,"lock_wait_ms":$cloudroomLockWaitMs,"prompts":$cloudroomPrompts}'
  FileClose $R2
  ClearErrors
!macroend

!macro customUnInit
  !insertmacro stopPreviewHelper
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    !insertmacro cloudroomRemoveOwned "$INSTDIR.next"
    !insertmacro cloudroomRemoveOwned "$INSTDIR.old"
  ${endIf}
!macroend
