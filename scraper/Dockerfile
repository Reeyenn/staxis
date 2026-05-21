FROM mcr.microsoft.com/playwright:v1.58.2-jammy
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
# Audit Batch 3 (F-01): drop to the non-root pwuser baked into the
# Playwright base image. Microsoft's image creates this UID at build
# time with the right perms for chromium / fonts. Without USER, the
# scraper runs as root inside the container — fine on Railway's
# microVM but pointless privilege; this matches the cua-service
# Dockerfile pattern.
RUN chown -R pwuser:pwuser /app
USER pwuser
CMD ["node", "scraper.js"]
