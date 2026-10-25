; Uninstall: the disk in the system (Cloud Files sync root) is taken down with its placeholders; files the user
; put in %USERPROFILE%\discordrive stay. An update (the installer run with --updated) keeps it.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    IfFileExists "$INSTDIR\resources\ddn-cf.exe" 0 +2
      ExecWait '"$INSTDIR\resources\ddn-cf.exe" unregister "$PROFILE\discordrive"'
  ${endIf}
!macroend
