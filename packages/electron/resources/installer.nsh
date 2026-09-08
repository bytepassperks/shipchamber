; Custom NSIS hooks for the ShipChamber Windows installer.

!macro customInit
  ; An ARM64-only installer on an x64 machine would write the uninstaller and
  ; silently skip the app payload. Stop early with a pointer to the right build.
  !ifdef APP_ARM64_NAME
    !ifndef APP_64_NAME
      ${IfNot} ${IsNativeARM64}
        MessageBox MB_OK|MB_ICONSTOP "This installer is for Windows on ARM64.$\r$\n$\r$\nYour PC needs the Windows (x64) installer from https://shipchamber.pages.dev/download"
        Quit
      ${EndIf}
    !endif
  !endif
!macroend
