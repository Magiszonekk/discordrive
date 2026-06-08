# TASK-009 attempt log

## 2026-05-12 11:36 UTC
- Sprawdzono konfigurację VPS `cikowice`.
- Nginx ma już gotowy vhost `/etc/nginx/sites-enabled/hermes` dla `hermes.cikowice.pl`.
- Reverse proxy kieruje na `http://10.8.0.4:8787`.
- Upstream odpowiada na `HEAD` jako `HermesWebUI/0.50.126-dirty Python/3.12.3`, więc usługa za portem 8787 działa.
- Publiczny DNS dla `hermes.cikowice.pl` nie istnieje (`dig +short A hermes.cikowice.pl` zwraca pusty wynik).
- Obecna konfiguracja SSL używa certyfikatu `/etc/letsencrypt/live/cikowice.pl/fullchain.pem`, który obejmuje tylko `cikowice.pl`, więc jest nieprawidłowy dla `hermes.cikowice.pl`.
- Na serwerze brak odnalezionych lokalnie dostępnych credentiali OVH potrzebnych do modyfikacji strefy DNS.
- Task zablokowany do czasu uzyskania dostępu do OVH lub ręcznego dodania rekordu DNS.

## 2026-05-12 11:40 UTC
- Dostarczone credentiale OVH działają dla odczytu: `GET /me`, `GET /domain`, `GET /domain/zone/cikowice.pl/record?...` zwracają 200.
- Próba `POST /domain/zone/cikowice.pl/record` oraz `POST /domain/zone/cikowice.pl/refresh` zwraca `403 This call has not been granted`.
- Wniosek: obecny `consumer_key` nie ma grantów do zapisu DNS; potrzebny nowy credential z prawami POST/PUT/DELETE dla `/domain/zone/*`.

## 2026-05-12 11:42 UTC
- Nowy `consumer_key` działa do zapisu DNS.
- Dodano rekord `A hermes.cikowice.pl -> 146.59.126.32` z TTL 300.
- `POST /domain/zone/cikowice.pl/refresh` zwrócił 200.
- OVH zwróciło rekord `id=5414093257` i późniejszy odczyt potwierdził jego obecność.

## 2026-05-12 11:52 UTC
- `certbot --nginx -d hermes.cikowice.pl --non-interactive --agree-tos -m magiszonekxd@gmail.com --redirect` zakończył się sukcesem.
- Certyfikat zapisano w `/etc/letsencrypt/live/hermes.cikowice.pl/` z ważnością do `2026-08-10`.
- Certbot zdeployował certyfikat do `/etc/nginx/sites-enabled/hermes`.
- Weryfikacja TLS potwierdziła SAN `DNS:hermes.cikowice.pl`.
- `http://hermes.cikowice.pl` przekierowuje do `https://hermes.cikowice.pl/`.
- `https://hermes.cikowice.pl` odpowiada końcowo statusem 200 przez nginx.
