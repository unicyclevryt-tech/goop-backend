FROM node:22-alpine
WORKDIR /app
COPY backend/package.json backend/package-lock.json ./backend/
RUN npm ci --prefix ./backend --omit=dev --omit=optional --ignore-scripts --no-audit --no-fund
COPY backend/*.mjs ./backend/
COPY site/ ./site/
EXPOSE 4000
CMD ["node","backend/server.mjs"]
