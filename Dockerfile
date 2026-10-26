FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
USER node
EXPOSE 3000
CMD ["node", "src/server.js"]
