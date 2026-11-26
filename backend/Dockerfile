FROM node:22-alpine
WORKDIR /app
COPY backend/*.mjs ./backend/
COPY site/ ./site/
EXPOSE 4000
CMD ["node","backend/server.mjs"]
