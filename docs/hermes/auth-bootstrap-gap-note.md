# DiscordDrive auth/bootstrap gap note

## Co już jest pokryte
- `register` zapisuje `wrappedARKByPassword`, `wrappedARKByRecovery` oraz pełne pola `argon2Params` do `UserCrypto` (`apps/api/src/resolvers/auth.ts`).
- `register` zwraca `AuthResponse` z osadzonym `user.crypto`, a `login` zwraca ten sam zestaw bootstrap fields dla istniejącego użytkownika.
- `changePassword` rewrapuje tylko `wrappedARKByPassword` i aktualizuje `argon2Params` + `lastPasswordChangeAt`, co jest zgodne z kierunkiem ARK-centric zamiast per-file FEK rewrap.
- GraphQL schema ma już typy `Argon2Params`, `UserCrypto`, `AuthResponse` oraz mutacje `register`, `login`, `changePassword` z odpowiednim secure-files shape.

## Czego brakuje do formalnego odhaczenia gate'a
- Brakuje dedykowanego testu integracyjnego lub unit/integration gate, który wprost dowodzi, że `register -> login` zachowuje spójny crypto bootstrap contract.
- Brakuje testu potwierdzającego, że login zwraca dokładnie ten sam persisted bootstrap material, a nie tylko „jakiś poprawny shape”.
- Brakuje testu pokazującego, że GraphQL auth contract jest zgodny z consumer contract dla `User.crypto`, a nie przypadkowo przechodzi tylko na poziomie resolvera.
- Brakuje testu dla `changePassword`, który potwierdza update `wrappedARKByPassword` / `argon2Params` bez naruszania recovery wrappera.
- `login` nadal przyjmuje argument `password`, ale go nie używa; to nie blokuje obecnego secure bootstrap gate, ale wymaga świadomego potraktowania w smoke scenariuszu jako kontrakt transportowy, nie realna weryfikacja hasła.
