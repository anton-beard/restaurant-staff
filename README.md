# Обучение и контроль персонала ресторана

Telegram-бот для сотрудников и веб-админка для владельца. Один процесс: Fastify + grammY + SQLite.

Дизайн: `docs/superpowers/specs/2026-09-07-restaurant-staff-design.md`.

## Требования

Node.js ≥ 24 (для разработки), Docker и Docker Compose — для запуска в контейнере.

## Запуск в Docker

1. Создать бота у @BotFather, получить токен.
2. `cp .env.example .env`, заполнить `BOT_TOKEN`, `OWNER_PHONE` (свой номер), `SESSION_SECRET` (длинная случайная строка), `PUBLIC_URL` (адрес админки), `TZ` (часовой пояс ресторана, влияет на расписания).
3. На Linux папка `./data` должна быть доступна пользователю с uid 1000, от которого работает контейнер: `mkdir -p data && sudo chown 1000:1000 data`.
4. `docker compose up -d --build`.
5. Написать боту `/start` и поделиться номером: это привяжет владельца.
6. Открыть `PUBLIC_URL`, нажать «Получить код», ввести код из бота.

Данные лежат в `./data` (база и загруженные файлы). Бэкап: копия этой папки после `docker compose down`.

## Разработка

```bash
npm install
cp .env.example .env   # заполнить
set -a; source .env; set +a; npm run dev   # сервер на :3000
npm run dev:admin                          # админка на :5173 с прокси на :3000
npm test
npm run typecheck
```
