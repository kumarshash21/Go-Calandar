FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY server/ ./server/
COPY public/ ./public/
COPY scripts/ ./scripts/
COPY db/ ./db/
RUN addgroup -S goapp && adduser -S goapp -G goapp
RUN mkdir -p credentials && chown -R goapp:goapp /app
USER goapp
EXPOSE 3000
CMD ["node", "server/server.js"]
