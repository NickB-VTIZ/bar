FROM node:20-alpine

# Install build tools for better-sqlite3 native module
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install --production

# Copy server and frontend
COPY server.js ./
COPY public/ ./public/

# Create data directory for SQLite database
RUN mkdir -p /data

EXPOSE 3000

ENV PORT=3000
ENV DB_PATH=/data/zomerbar.db
ENV NODE_ENV=production

CMD ["node", "server.js"]
