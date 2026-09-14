# Собирается с контекстом сборки = корень репозитория (Render: Root
# Directory оставить пустым/корень, Dockerfile Path = server/Dockerfile).
FROM node:20-slim

# Системные библиотеки, нужные headless Chrome (Puppeteer) для рендера
# превью объявлений — без них Chromium падает при запуске в контейнере.
# Chromium ставим здесь же системным пакетом (apt), а не даём Puppeteer
# докачивать его отдельно со своего CDN — эта докачка стабильно рвалась
# на середине в билд-окружении Render (IncompleteInstallationError), даже
# после полной очистки кеша. Системный пакет идёт из debian-репозитория и
# тянется вместе с остальными apt-пакетами за один RUN.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates fonts-liberation libasound2 libatk-bridge2.0-0 libatk1.0-0 \
    libc6 libcairo2 libcups2 libdbus-1-3 libexpat1 libfontconfig1 libgbm1 \
    libgcc1 libglib2.0-0 libgtk-3-0 libnspr4 libnss3 libpango-1.0-0 \
    libpangocairo-1.0-0 libstdc++6 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 \
    libxcursor1 libxdamage1 libxext6 libxfixes3 libxi6 libxrandr2 libxrender1 \
    libxss1 libxtst6 lsb-release wget xdg-utils chromium \
    && rm -rf /var/lib/apt/lists/*

# Puppeteer использует этот бинарник вместо попытки скачать свой — код
# snapshotInspect.js не трогаем, puppeteer.launch() сам подхватывает
# PUPPETEER_EXECUTABLE_PATH, если explicit executablePath не передан.
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app/server

COPY server/package*.json ./
RUN npm install --omit=dev

COPY server/. .
COPY public /app/public

EXPOSE 3000
CMD ["node", "index.js"]
