FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

COPY --chown=node:node public ./public
COPY package*.json ./
RUN npm install --omit=dev

COPY --chown=node:node server.js ./
RUN mkdir -p /app/uploads && chown -R node:node /app

USER node

EXPOSE 3000

CMD ["npm", "start"]