FROM node:22-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY server ./server
USER node
EXPOSE 3000
CMD ["node", "server/index.mjs"]
