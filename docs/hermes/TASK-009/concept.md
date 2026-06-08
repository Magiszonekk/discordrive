# [TASK-009] dodać hermes.cikowice.pl w strefie DNS i podpiąć pod port 8787 z SSL

## Opis taska
Użytkownik chce dodać subdomenę `hermes.cikowice.pl` w strefie DNS, skierować ją na usługę dostępną przez port `8787`, a następnie skonfigurować certyfikat SSL przez certbot i podpiąć go do reverse proxy.

## Wymagania
- dodać rekord DNS dla `hermes.cikowice.pl`
- ruch z domeny ma trafiać do usługi na porcie `8787`
- dodać konfigurację certbota
- podpiąć certyfikat SSL do hosta
- na końcu zweryfikować działanie HTTP/HTTPS
