# The Cloudroom VPS service (ADR 0319). Build with `pnpm image` from this folder.
FROM node:24-slim
WORKDIR /app
COPY dist/main.js /app/main.js
ENV NODE_ENV=production
CMD ["node", "/app/main.js"]
