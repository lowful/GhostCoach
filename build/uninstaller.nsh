; Occlara uninstall cleanup.
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
    ; The current profile folder.
    RMDir /r "$APPDATA\Occlara\sessions"
    RMDir /r "$APPDATA\Occlara\match-summaries"
    Delete "$APPDATA\Occlara\performance.json"
    Delete "$APPDATA\Occlara\debug.log"
    RMDir /r "$APPDATA\Occlara\Cache"
    RMDir /r "$APPDATA\Occlara\Code Cache"
    RMDir /r "$APPDATA\Occlara\GPUCache"
    RMDir /r "$APPDATA\Occlara\DawnGraphiteCache"
    RMDir /r "$APPDATA\Occlara\DawnWebGPUCache"
    RMDir /r "$APPDATA\Occlara\blob_storage"
    RMDir /r "$APPDATA\Occlara\Local Storage"
    RMDir /r "$APPDATA\Occlara\Session Storage"
    RMDir /r "$APPDATA\Occlara\Shared Dictionary"
    RMDir /r "$APPDATA\Occlara\Dictionaries"
    RMDir /r "$APPDATA\Occlara\logs"

    ; And the pre-rename one. A player who uninstalls without ever having
    ; launched a build new enough to migrate still has everything under the
    ; old name, and uninstall should not strand it on their disk.
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
