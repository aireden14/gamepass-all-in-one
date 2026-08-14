# YouTube Downloader Guide

## Текущая причина блокировки

На Render YouTube может блокировать датацентровый IP ещё на этапе проверки metadata.
Типичный ответ `yt-dlp`:

```text
Sign in to confirm you're not a bot. Use --cookies-from-browser or --cookies for the authentication.
```

В коде уже есть fallback по разным YouTube clients, EJS/Node runtime, логирование ошибок и protected debug endpoint.
Если Render отвечает `youtube_cookies=no` и `youtube_proxy=no`, скачивание таких роликов всё равно может не работать.

## Cookies через Render env

1. В браузере, где есть рабочая YouTube-сессия, экспортировать cookies в формате Netscape `cookies.txt`.
2. Закодировать файл в base64:

```bash
base64 -i youtube-cookies.txt | pbcopy
```

3. В Render добавить environment variable:

```text
YOUTUBE_COOKIES_BASE64=<base64 value>
```

4. Redeploy сервиса.
5. Проверить в Telegram:

```text
/version
```

Ожидаемо:

```text
Cookies: да
```

## Proxy fallback

Если cookies не помогают или YouTube продолжает резать Render IP, добавить proxy:

```text
YOUTUBE_PROXY=http://user:pass@host:port
```

Proxy должен быть разрешённым для такого использования и иметь нормальную репутацию IP.

## Проверка health/version

Публичный health:

```bash
curl https://tg-transcriber-bot-feka.onrender.com
```

Он показывает версию и безопасные флаги:

```text
youtube_cookies=yes/no
youtube_proxy=yes/no
```

## Protected debug endpoint

Endpoint использует тот же secret, что Telegram webhook:

```text
/youtube-debug/<TELEGRAM_WEBHOOK_SECRET или derived secret>
```

Пример:

```bash
curl "https://tg-transcriber-bot-feka.onrender.com/youtube-debug/<secret>?url=https%3A%2F%2Fyoutu.be%2FVIDEO_ID&format=mp3&download=1"
```

Он запускает тот же `yt-dlp` внутри Render и возвращает JSON с:

- `ok`
- `version`
- `cookies`
- `proxy`
- `stage`
- `error_id`
- `message`

Не публиковать secret и не коммитить cookies/proxy значения в репозиторий.
