; GhostCoach 2.0 uninstall cleanup.
; Deletes the player's local data (coached sessions, performance history,
; match summaries, logs, and Electron caches) but deliberately KEEPS the
; config file, which holds the license, the Riot ID, and the cached Valorant
; tracker profile, so a reinstall picks up right where the player left off.
;
; The ${isUpdated} guard matters: NSIS runs this uninstaller during every
; auto-update too, and an update must NEVER touch the player's data. Only a
; real uninstall cleans up.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    RMDir /r "$APPDATA\GhostCoach 2.0\sessions"
    RMDir /r "$APPDATA\GhostCoach 2.0\match-summaries"
    Delete "$APPDATA\GhostCoach 2.0\performance.json"
    Delete "$APPDATA\GhostCoach 2.0\debug.log"
    RMDir /r "$APPDATA\GhostCoach 2.0\Cache"
    RMDir /r "$APPDATA\GhostCoach 2.0\Code Cache"
    RMDir /r "$APPDATA\GhostCoach 2.0\GPUCache"
    RMDir /r "$APPDATA\GhostCoach 2.0\DawnGraphiteCache"
    RMDir /r "$APPDATA\GhostCoach 2.0\DawnWebGPUCache"
    RMDir /r "$APPDATA\GhostCoach 2.0\blob_storage"
    RMDir /r "$APPDATA\GhostCoach 2.0\Local Storage"
    RMDir /r "$APPDATA\GhostCoach 2.0\Session Storage"
    RMDir /r "$APPDATA\GhostCoach 2.0\Shared Dictionary"
    RMDir /r "$APPDATA\GhostCoach 2.0\Dictionaries"
    RMDir /r "$APPDATA\GhostCoach 2.0\logs"
  ${endIf}
!macroend
