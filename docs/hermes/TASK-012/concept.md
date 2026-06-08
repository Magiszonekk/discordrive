# [TASK-012] dashboard pokazuje uploaded files jako unnamed

## Opis taska
Zdiagnozować i naprawić problem w DiscordDrive, gdzie po uploadzie pliki na dashboardzie pokazują się jako "unnamed" zamiast prawidłowej nazwy pliku.

## Objaw
- Po wgraniu plików w DiscordDrive dashboard pokazuje je jako `unnamed`.

## Pytania do koncepcji / diagnozy
- Czy problem dotyczy tylko dashboardu/listingu, czy również zapisanego metadata payloadu?
- W którym miejscu ginie nazwa pliku: frontend upload, API, DB, czy frontend render?
- Czy problem dotyczy wszystkich uploadów czy tylko części / konkretnego flow?
