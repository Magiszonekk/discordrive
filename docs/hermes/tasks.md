# Hermes Task Manager — discordrive

## [TASK-013] share flow — fix 401 on shared download and add share link revocation
- Status: implementacja
- Utworzony: 2026-05-26 13:35
- Ostatnia aktualizacja: 2026-05-26 13:40
- Próby naprawy: 0/3
- Opis: Naprawić pobieranie plików przez share link bez sesyjnego auth (bug `Blob body fetch failed: 401` w incognito) oraz dodać możliwość revokowania aktywnych share linków z dashboardu.

## [TASK-012] dashboard pokazuje uploaded files jako unnamed
- Status: DONE
- Utworzony: 2026-05-26 07:40
- Ostatnia aktualizacja: 2026-05-26
- Próby naprawy: 0/3
- Opis: Panel postępu uploadu (`UploadProgress.tsx`) wyświetlał `upload.fileId` (UUID/placeholder) zamiast nazwy pliku, bo `UploadProgress` type nie miał pola `fileName`. Naprawiono przez: dodanie `fileName?: string` do interfejsu `UploadProgress` w `@ddv4/types`, przekazanie `file.name` do `store.addUpload()` w `upload.ts`, i wyświetlanie `upload.fileName ?? upload.fileId` w `UploadProgress.tsx`. Pliki w tabeli po zakończeniu uploadu zawsze miały prawidłową nazwę (z DB).
