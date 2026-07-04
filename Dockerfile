FROM node:20-alpine

# Native build tools voor better-sqlite3 + tijdzonebestanden
RUN apk add --no-cache python3 make g++ tzdata
ENV TZ=Europe/Brussels

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY server.js ./
COPY public/ ./public/

RUN mkdir -p /data

EXPOSE 3000
ENV PORT=3000
ENV DB_PATH=/data/zomerbar.db
ENV NODE_ENV=production

CMD ["node", "server.js"]
