FROM node:22-alpine
WORKDIR /app
COPY backend/server.mjs ./backend/server.mjs
COPY site/ ./site/
EXPOSE 4000
CMD ["node","backend/server.mjs"]
