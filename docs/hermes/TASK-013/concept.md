# [TASK-013] share flow — fix 401 on shared download and add share link revocation

## Status
Koncepcja rozpoczęta.

## Cel
Naprawić pobieranie plików przez share link tak, aby działało bez sesyjnego logowania (bez `Blob body fetch failed: 401` w incognito), oraz dodać możliwość revokowania aktywnych share linków z dashboardu.

## Zakres
1. Shared download ma działać na publicznym share flow opartym o capability token, bez wymagania bearer auth użytkownika.
2. Użytkownik ma móc zobaczyć istniejące share linki dla pliku i cofnąć (revoke) wybrany link.
3. Po revoke link przestaje działać natychmiast.

## Wstępne ustalenia techniczne
- Obecny bug 401 wynika z tego, że `fetchBlobBody(...)` uderza w endpoint blob wymagający zwykłego auth tokena.
- W incognito share page nie ma sesji usera, więc blob fetch kończy się 401 mimo że sam accessShare działa.
- W kodzie backendu istnieje już logika share (`accessShare`, prawdopodobnie też `revokeShare`), więc revoke feature może wymagać głównie dokończenia integracji API + UI.

## Oczekiwany efekt końcowy
- Link otwarty w incognito pozwala pobrać plik bez 401.
- Dashboard pozwala cofnąć aktywny share link.
- Revoked link przestaje działać od razu.
