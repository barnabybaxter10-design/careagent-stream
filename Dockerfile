FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY server.js live.js ./
USER node
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]
