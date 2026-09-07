# Обучение и контроль персонала ресторана

Telegram-бот для сотрудников и веб-админка для владельца. Один процесс: Fastify + grammY + SQLite.

Дизайн: `docs/superpowers/specs/2026-09-07-restaurant-staff-design.md`.

## Запуск в Docker

1. Создать бота у @BotFather, получить токен.
2. `cp .env.example .env`, заполнить `BOT_TOKEN`, `OWNER_PHONE` (свой номер), `SESSION_SECRET` (длинная случайная строка), `PUBLIC_URL` (адрес админки).
3. `docker compose up -d --build`.
4. Написать боту `/start` и поделиться номером: это привяжет владельца.
5. Открыть `PUBLIC_URL`, нажать «Получить код», ввести код из бота.

Данные лежат в `./data` (база и загруженные файлы). Бэкап: копия этой папки при остановленном контейнере.

## Разработка

```bash
npm install
cp .env.example .env   # заполнить
set -a; source .env; set +a; npm run dev   # сервер на :3000
npm run dev:admin                          # админка на :5173 с прокси на :3000
npm test
npm run typecheck
```
