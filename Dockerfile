FROM node:22-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY server ./server
COPY client ./client
COPY .onyx ./.onyx
COPY migrations ./migrations
COPY schema ./schema
COPY scripts ./scripts
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:3000/health/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "server/index.mjs"]
